'use strict';
// Codex app-server 适配器：以长驻子进程方式驱动 `codex app-server`（JSON-RPC
// 2.0 over ndjson stdio），把 thread/turn/item 事件归一化为与 acp-client /
// claude-stream-adapter 同一套事件词汇。
//
// 协议要点（实测 codex-cli 0.141.0，schema 由 `codex app-server
// generate-json-schema` 导出）：
//   initialize → thread/start（或 thread/resume {threadId}）→ turn/start
//   通知：item/started、item/agentMessage/delta、item/reasoning/textDelta、
//        item/commandExecution/outputDelta、item/completed、
//        thread/tokenUsage/updated、turn/completed、error
//   审批（服务端请求）：item/commandExecution/requestApproval、
//        item/fileChange/requestApproval → { decision: 'accept'|'decline' }
//   thread id 即原生会话 id，rollout 落盘 ~/.codex/sessions，可跨重启 resume。

const { spawn } = require('child_process');
const { createNdjsonReader, writeNdjson } = require('./ndjson');
const { buildSpawnCommand, killProcessTree } = require('./spawn-command');
const { extractToolLocations } = require('./tool-locations');

const CLIENT_INFO = { name: '1shell', title: '1Shell Agent', version: '4.7.0' };

function createCodexAppServerAgent({
  binary = 'codex',
  args = ['app-server'],
  cwd = process.cwd(),
  env = process.env,
  model = '',
  resumeThreadId = '',
  logger = console,
  // ({ toolName, kind, input }) => Promise<{ behavior:'allow'|'deny', message? }>
  onPermissionRequest,
  onEvent,
  onExit,
}) {
  let child = null;
  let reader = null;
  let exited = false;
  let nextRequestId = 1;
  const pending = new Map(); // requestId -> { resolve, reject, method }

  let threadId = '';
  let readyPromise = null;
  let currentTurn = null; // { resolve, reject, turnId, usage }

  function emit(event) {
    try { onEvent?.(event); } catch (err) { logger.error?.(`[codex] onEvent 处理失败: ${err.message}`); }
  }

  function request(method, params) {
    if (exited || !child) return Promise.reject(new Error('codex 进程不可用'));
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      const ok = writeNdjson(child.stdin, { jsonrpc: '2.0', id, method, params });
      if (!ok && child.stdin.destroyed) {
        pending.delete(id);
        reject(new Error('codex stdin 不可写'));
      }
    });
  }

  function respond(id, result) {
    writeNdjson(child.stdin, { jsonrpc: '2.0', id, result });
  }

  function respondError(id, message) {
    writeNdjson(child.stdin, { jsonrpc: '2.0', id, error: { code: -32601, message } });
  }

  function start() {
    exited = false;
    const spawnSpec = buildSpawnCommand(binary, args);
    child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });

    reader = createNdjsonReader(child.stdout, {
      onMessage: handleMessage,
      onError: (err) => logger.error?.(`[codex] 读取失败: ${err.message}`),
    });

    child.on('exit', (code, signal) => {
      exited = true;
      const err = new Error(`codex 进程退出 (code=${code}${stderrTail ? `): ${stderrTail.slice(-500)}` : ')'}`);
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      if (currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        turn.reject(err);
      }
      onExit?.({ code, signal });
    });
    child.on('error', (err) => {
      exited = true;
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      if (currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        turn.reject(err);
      }
      onExit?.({ code: null, signal: null, error: err });
    });
  }

  // ── 会话就绪（initialize + thread/start|resume）──────────────────

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await request('initialize', { clientInfo: CLIENT_INFO });
        let started = null;
        if (resumeThreadId) {
          try {
            started = await request('thread/resume', { threadId: resumeThreadId, cwd, model: model || null });
          } catch (err) {
            logger.warn?.(`[codex] thread/resume 失败（${err.message}），改为新建会话`);
          }
        }
        if (!started) {
          started = await request('thread/start', { cwd, model: model || null });
        }
        threadId = started?.thread?.id || started?.thread?.sessionId || '';
        if (!threadId) throw new Error('codex thread/start 未返回 thread id');
        emit({ type: 'init', nativeSessionId: threadId, model: started?.model || '', tools: [] });
        return threadId;
      })();
      readyPromise.catch(() => { readyPromise = null; });
    }
    return readyPromise;
  }

  // ── 通知 / 服务端请求处理 ────────────────────────────────────────

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // 响应
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result);
      return;
    }
    // 服务端请求（审批等）
    if (msg.id !== undefined && msg.method) {
      handleServerRequest(msg).catch((err) => {
        logger.error?.(`[codex] 服务端请求处理失败: ${err.message}`);
        respondError(msg.id, err.message || 'internal error');
      });
      return;
    }
    // 通知
    if (msg.method) handleNotification(msg.method, msg.params || {});
  }

  async function handleServerRequest(msg) {
    const params = msg.params || {};
    if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'execCommandApproval') {
      const decision = await askPermission({
        toolName: '命令执行',
        kind: 'execute',
        input: { command: params.command || '', cwd: params.cwd || '' },
      });
      respond(msg.id, { decision: decision.behavior === 'allow' ? 'accept' : 'decline' });
      return;
    }
    if (msg.method === 'item/fileChange/requestApproval' || msg.method === 'applyPatchApproval') {
      const decision = await askPermission({
        toolName: '文件修改',
        kind: 'edit',
        input: { reason: params.reason || '', grantRoot: params.grantRoot || '' },
      });
      respond(msg.id, { decision: decision.behavior === 'allow' ? 'accept' : 'decline' });
      return;
    }
    respondError(msg.id, `unsupported server request: ${msg.method}`);
  }

  async function askPermission(payload) {
    if (!onPermissionRequest) return { behavior: 'deny', message: '无审批通道' };
    try {
      return await onPermissionRequest(payload) || { behavior: 'deny' };
    } catch (err) {
      logger.error?.(`[codex] 审批回调失败: ${err.message}`);
      return { behavior: 'deny', message: err.message };
    }
  }

  function handleNotification(method, params) {
    switch (method) {
      case 'item/agentMessage/delta':
        if (params.delta) emit({ type: 'text_delta', text: params.delta });
        return;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (params.delta) emit({ type: 'thinking_delta', text: params.delta });
        return;
      case 'item/started':
        handleItemStarted(params.item || {});
        return;
      case 'item/completed':
        handleItemCompleted(params.item || {});
        return;
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        if (params.delta) {
          emit({ type: 'tool_update', toolCallId: params.itemId || '', status: 'in_progress', content: String(params.delta) });
        }
        return;
      case 'turn/plan/updated': {
        const entries = (params.plan?.steps || params.plan || []);
        if (Array.isArray(entries) && entries.length) {
          emit({
            type: 'plan',
            entries: entries.map((e) => ({
              content: String(e.step || e.content || e.text || ''),
              status: String(e.status || 'pending'),
            })),
          });
        }
        return;
      }
      case 'thread/tokenUsage/updated':
        if (currentTurn) currentTurn.usage = params.tokenUsage?.last || params.tokenUsage?.total || null;
        return;
      case 'error':
        // willRetry=true 的错误 codex 会自行重试；最终失败以 turn/completed(failed) 收口
        if (!params.willRetry && currentTurn) {
          currentTurn.lastError = params.error?.message || '';
        }
        return;
      case 'turn/completed':
        handleTurnCompleted(params.turn || {});
        return;
      default:
        // thread/started、thread/status/changed、mcpServer/* 等：宽容跳过
    }
  }

  // item 类型 → 工具卡片：除消息/思考/计划外的 item 一律映射成工具卡，
  // 未来 codex 新增 item 类型也能出现在时间线上而不是静默丢失。
  const NON_TOOL_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'hookPrompt', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode']);

  function toolTitle(item) {
    switch (item.type) {
      case 'commandExecution': return String(item.command || '命令执行');
      case 'fileChange': return `文件修改（${(item.changes || []).length} 处）`;
      case 'mcpToolCall': return `${item.server || 'mcp'}.${item.tool || 'tool'}`;
      case 'webSearch': return `Web 搜索${item.query ? `：${item.query}` : ''}`;
      default: return String(item.type || 'tool');
    }
  }

  function toolKind(item) {
    switch (item.type) {
      case 'commandExecution': return 'execute';
      case 'fileChange': return 'edit';
      case 'webSearch': return 'search';
      case 'mcpToolCall': return 'other';
      default: return 'other';
    }
  }

  function toolInput(item) {
    switch (item.type) {
      case 'commandExecution': return { command: item.command || '', cwd: item.cwd || '' };
      case 'fileChange': return { changes: item.changes || [] };
      case 'mcpToolCall': return item.arguments ?? null;
      case 'webSearch': return { query: item.query || '' };
      default: {
        const { id, type, ...rest } = item;
        return Object.keys(rest).length ? rest : null;
      }
    }
  }

  function toolResult(item) {
    switch (item.type) {
      case 'commandExecution': {
        const output = String(item.aggregatedOutput || '');
        const exit = item.exitCode !== null && item.exitCode !== undefined ? `\n[exit code: ${item.exitCode}]` : '';
        return `${output}${exit}`.trim();
      }
      case 'fileChange':
        return (item.changes || [])
          .map((c) => String(c.path || c.file || JSON.stringify(c)).trim())
          .filter(Boolean)
          .join('\n');
      case 'mcpToolCall': {
        if (item.error) return String(item.error.message || JSON.stringify(item.error));
        const content = item.result?.content;
        if (Array.isArray(content)) {
          return content.map((c) => (c?.type === 'text' ? String(c.text || '') : '')).filter(Boolean).join('\n');
        }
        return item.result ? JSON.stringify(item.result).slice(0, 4000) : '';
      }
      default:
        return '';
    }
  }

  function isToolFailed(item) {
    const status = String(item.status || '').toLowerCase();
    if (['failed', 'error', 'declined', 'rejected'].includes(status)) return true;
    if (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0) return true;
    if (item.type === 'mcpToolCall' && item.error) return true;
    return false;
  }

  function handleItemStarted(item) {
    if (!item.id || NON_TOOL_ITEMS.has(item.type)) return;
    const input = toolInput(item);
    emit({
      type: 'tool_start',
      toolCallId: item.id,
      title: toolTitle(item),
      kind: toolKind(item),
      status: 'in_progress',
      input,
      locations: extractToolLocations(input),
    });
  }

  function handleItemCompleted(item) {
    if (item.type === 'agentMessage') {
      // 定稿文本：替换此前的流式 delta（与 claude 适配器同语义）
      emit({ type: 'text', text: String(item.text || '') });
      return;
    }
    if (!item.id || NON_TOOL_ITEMS.has(item.type)) return;
    emit({
      type: 'tool_update',
      toolCallId: item.id,
      status: isToolFailed(item) ? 'failed' : 'completed',
      content: toolResult(item),
      toolName: toolTitle(item),
      locations: extractToolLocations(toolInput(item)),
    });
  }

  function handleTurnCompleted(turn) {
    const turnEntry = currentTurn;
    currentTurn = null;
    const status = String(turn.status || 'completed');
    if (status === 'failed') {
      const message = turn.error?.message || turnEntry?.lastError || 'codex 回合失败';
      emit({ type: 'error', message: String(message).slice(0, 2000) });
      turnEntry?.resolve({ stopReason: 'error', isError: true, nativeSessionId: threadId, usage: turnEntry?.usage || null });
      return;
    }
    emit({
      type: 'done',
      stopReason: status === 'interrupted' ? 'cancelled' : 'success',
      nativeSessionId: threadId,
      usage: turnEntry?.usage || null,
      costUsd: null,
      durationMs: turn.durationMs || null,
    });
    turnEntry?.resolve({ stopReason: status, isError: false, nativeSessionId: threadId, usage: turnEntry?.usage || null });
  }

  // ── 对外 API ────────────────────────────────────────────────────

  async function prompt({ text, attachments = [] }) {
    if (exited || !child) throw new Error('codex 进程不可用');
    if (currentTurn) throw new Error('上一轮尚未结束');
    await ensureReady();
    let content = String(text || '');
    for (const att of attachments) {
      if (att?.path) content += `\n\n[附件] ${att.path}`;
    }
    return new Promise((resolve, reject) => {
      currentTurn = { resolve, reject, turnId: '', usage: null, lastError: '' };
      request('turn/start', { threadId, input: [{ type: 'text', text: content }] })
        .then((result) => {
          if (currentTurn) currentTurn.turnId = result?.turn?.id || '';
        })
        .catch((err) => {
          if (currentTurn) {
            const turn = currentTurn;
            currentTurn = null;
            turn.reject(err);
          }
        });
    });
  }

  function cancel() {
    if (exited || !child || !currentTurn) return;
    const params = { threadId, turnId: currentTurn.turnId || '' };
    request('turn/interrupt', params).catch((err) => {
      logger.warn?.(`[codex] turn/interrupt 失败: ${err.message}`);
    });
  }

  function kill() {
    reader?.close();
    if (child && !exited) {
      try { child.stdin.end(); } catch { /* ignore */ }
      killProcessTree(child);
    }
  }

  start();
  ensureReady().catch((err) => logger.warn?.(`[codex] 会话初始化失败: ${err.message}`));

  return {
    prompt,
    cancel,
    kill,
    get nativeSessionId() { return threadId; },
    get pid() { return child?.pid || null; },
    get alive() { return Boolean(child) && !exited; },
    get busy() { return Boolean(currentTurn); },
  };
}

module.exports = { createCodexAppServerAgent };
