'use strict';

// ACP（Agent Client Protocol）客户端：JSON-RPC 2.0 over ndjson stdio。
// 1Shell 扮演 Client，第三方 agent（gemini --experimental-acp 等）扮演 Agent。
//
// 职责边界：本文件只做协议往返与事件归一化，不关心 1Shell 会话/持久化，
// 归一化事件交给 protocol-agent.service.js 翻译成 ide:event。

const { spawn } = require('child_process');
const { createNdjsonReader, writeNdjson } = require('./ndjson');
const { buildSpawnCommand, killProcessTree } = require('./spawn-command');

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;

function createAcpClient({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  logger = console,
  // ({ acpSessionId, toolCall, options }) => Promise<{ optionId } | { cancelled: true }>
  onPermissionRequest,
  // (normalizedEvent) => void
  onEvent,
  // ({ code, signal }) => void
  onExit,
  // 文件系统能力委托：{ readTextFile({path,line,limit}), writeTextFile({path,content}) }
  fsDelegate = null,
}) {
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer }
  let child = null;
  let reader = null;
  let exited = false;
  let initializeResult = null;

  function emit(event) {
    try { onEvent?.(event); } catch (err) { logger.error?.(`[acp] onEvent 处理失败: ${err.message}`); }
  }

  function start() {
    const spawnSpec = buildSpawnCommand(command, args);
    child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logger.warn?.(`[acp:${command}] stderr: ${text.slice(0, 2000)}`);
    });

    reader = createNdjsonReader(child.stdout, {
      onMessage: handleMessage,
      onError: (err) => logger.error?.(`[acp:${command}] 读取失败: ${err.message}`),
    });

    child.on('exit', (code, signal) => {
      exited = true;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`agent 进程退出 (code=${code}, signal=${signal || 'none'})`));
      }
      pending.clear();
      onExit?.({ code, signal });
    });
    child.on('error', (err) => {
      exited = true;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
      onExit?.({ code: null, signal: null, error: err });
    });
  }

  function request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (exited || !child) return Promise.reject(new Error('agent 进程不可用'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP 请求超时: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const ok = writeNdjson(child.stdin, { jsonrpc: '2.0', id, method, params });
      if (!ok && child.stdin.destroyed) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('agent stdin 不可写'));
      }
    });
  }

  function respond(id, result, error) {
    const message = { jsonrpc: '2.0', id };
    if (error) message.error = error;
    else message.result = result ?? null;
    writeNdjson(child.stdin, message);
  }

  function notify(method, params) {
    writeNdjson(child.stdin, { jsonrpc: '2.0', method, params });
  }

  // ── 入站消息分发 ────────────────────────────────────────────────

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || `ACP error ${msg.error.code}`));
      else entry.resolve(msg.result);
      return;
    }
    // agent → client 请求
    if (msg.id !== undefined && typeof msg.method === 'string') {
      handleAgentRequest(msg).catch((err) => {
        respond(msg.id, null, { code: -32603, message: err?.message || 'internal error' });
      });
      return;
    }
    // 通知
    if (typeof msg.method === 'string') {
      handleNotification(msg);
    }
  }

  async function handleAgentRequest(msg) {
    const params = msg.params || {};
    switch (msg.method) {
      case 'session/request_permission': {
        const result = await resolvePermission(params);
        respond(msg.id, result);
        return;
      }
      case 'fs/read_text_file': {
        if (!fsDelegate?.readTextFile) throw new Error('客户端未开放文件读取能力');
        const content = await fsDelegate.readTextFile(params);
        respond(msg.id, { content });
        return;
      }
      case 'fs/write_text_file': {
        if (!fsDelegate?.writeTextFile) throw new Error('客户端未开放文件写入能力');
        await fsDelegate.writeTextFile(params);
        respond(msg.id, null);
        return;
      }
      default:
        respond(msg.id, null, { code: -32601, message: `Method not supported: ${msg.method}` });
    }
  }

  async function resolvePermission(params) {
    const options = Array.isArray(params.options) ? params.options : [];
    if (!onPermissionRequest) {
      // 无审批通道时保守拒绝
      const reject = options.find((o) => /reject|deny|cancel/i.test(o.kind || o.optionId || ''));
      return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
    }
    const decision = await onPermissionRequest({
      acpSessionId: params.sessionId,
      toolCall: params.toolCall || {},
      options,
    });
    if (!decision || decision.cancelled) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: decision.optionId } };
  }

  function handleNotification(msg) {
    if (msg.method !== 'session/update') return;
    const params = msg.params || {};
    const update = params.update || {};
    const acpSessionId = params.sessionId || '';
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        emit({ type: 'text_delta', acpSessionId, text: contentText(update.content) });
        return;
      case 'agent_thought_chunk':
        emit({ type: 'thinking_delta', acpSessionId, text: contentText(update.content) });
        return;
      case 'tool_call':
        emit({
          type: 'tool_start',
          acpSessionId,
          toolCallId: update.toolCallId || '',
          title: update.title || update.toolCallId || 'tool',
          kind: update.kind || 'other',
          status: update.status || 'pending',
          input: update.rawInput ?? null,
          locations: Array.isArray(update.locations) ? update.locations : [],
        });
        return;
      case 'tool_call_update':
        emit({
          type: 'tool_update',
          acpSessionId,
          toolCallId: update.toolCallId || '',
          status: update.status || '',
          content: toolContentText(update.content),
          locations: Array.isArray(update.locations) ? update.locations : [],
        });
        return;
      case 'plan':
        emit({ type: 'plan', acpSessionId, entries: Array.isArray(update.entries) ? update.entries : [] });
        return;
      case 'current_mode_update':
        emit({ type: 'mode', acpSessionId, modeId: update.currentModeId || '' });
        return;
      default:
        // 未知更新类型宽容跳过，保持对各家 ACP 实现的兼容
        return;
    }
  }

  function contentText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (content.type === 'text') return String(content.text || '');
    return '';
  }

  function toolContentText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .map((item) => {
        if (item?.type === 'content') return contentText(item.content);
        if (item?.type === 'diff') {
          return `--- ${item.path || ''}\n${String(item.newText || '').slice(0, 4000)}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  // ── 对外 API ────────────────────────────────────────────────────

  async function initialize() {
    initializeResult = await request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: Boolean(fsDelegate?.readTextFile),
          writeTextFile: Boolean(fsDelegate?.writeTextFile),
        },
      },
    });
    return initializeResult;
  }

  async function newSession({ cwd: sessionCwd, mcpServers = [] } = {}) {
    const result = await request('session/new', {
      cwd: sessionCwd || cwd,
      mcpServers,
    });
    return { acpSessionId: result?.sessionId || '' };
  }

  async function loadSession({ acpSessionId, cwd: sessionCwd, mcpServers = [] }) {
    await request('session/load', {
      sessionId: acpSessionId,
      cwd: sessionCwd || cwd,
      mcpServers,
    });
    return { acpSessionId };
  }

  async function prompt({ acpSessionId, text, attachments = [] }) {
    const blocks = [{ type: 'text', text: String(text || '') }];
    for (const att of attachments) {
      if (att?.path) blocks.push({ type: 'resource_link', uri: `file://${att.path}`, name: att.name || att.path });
    }
    const result = await request(
      'session/prompt',
      { sessionId: acpSessionId, prompt: blocks },
      { timeoutMs: PROMPT_TIMEOUT_MS },
    );
    return { stopReason: result?.stopReason || 'end_turn' };
  }

  function cancel(acpSessionId) {
    notify('session/cancel', { sessionId: acpSessionId });
  }

  function kill() {
    reader?.close();
    if (child && !exited) killProcessTree(child);
  }

  start();

  return {
    initialize,
    newSession,
    loadSession,
    prompt,
    cancel,
    kill,
    get capabilities() { return initializeResult?.agentCapabilities || {}; },
    get authMethods() { return initializeResult?.authMethods || []; },
    get pid() { return child?.pid || null; },
    get alive() { return Boolean(child) && !exited; },
  };
}

module.exports = { createAcpClient, ACP_PROTOCOL_VERSION };
