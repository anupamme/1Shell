'use strict';

// Claude Code stream-json 适配器：以长驻子进程方式驱动 claude CLI，
// 解析双向 stream-json 事件并归一化（与 acp-client 输出同一套事件词汇）。
//
//   claude -p --input-format stream-json --output-format stream-json \
//          --verbose --include-partial-messages [--permission-prompt-tool stdio]
//
// 权限请求走 control_request(can_use_tool) 通道；老版本 CLI 不认
// --permission-prompt-tool 时自动降级重启（审批交回 CLI 自身 permission-mode）。

const { spawn } = require('child_process');
const crypto = require('crypto');
const { createNdjsonReader, writeNdjson } = require('./ndjson');
const { buildSpawnCommand, killProcessTree } = require('./spawn-command');
const { extractToolLocations } = require('./tool-locations');

function createClaudeStreamAgent({
  binary = 'claude',
  cwd = process.cwd(),
  env = process.env,
  model = '',
  permissionMode = '',
  // 思考程度（claude CLI ≥2.1 的 --effort low|medium|high|xhigh|max），
  // CLI 参数在 spawn 时定死——变更由服务层杀进程重建（--resume 保留上下文）
  effort = '',
  resumeSessionId = '',
  logger = console,
  // ({ toolName, input, suggestions }) => Promise<{ behavior:'allow'|'deny', updatedInput?, message? }>
  onPermissionRequest,
  onEvent,
  onExit,
}) {
  let child = null;
  let reader = null;
  let exited = false;
  let nativeSessionId = resumeSessionId || '';
  let currentTurn = null; // { resolve, reject }
  let permissionPromptEnabled = true;
  let effortEnabled = Boolean(effort);
  let stderrTail = '';
  const openToolInputs = new Map(); // tool_use_id -> { name, input }

  function emit(event) {
    try { onEvent?.(event); } catch (err) { logger.error?.(`[claude-stream] onEvent 处理失败: ${err.message}`); }
  }

  function buildArgs() {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (permissionPromptEnabled && onPermissionRequest) args.push('--permission-prompt-tool', 'stdio');
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (model) args.push('--model', model);
    if (effortEnabled) args.push('--effort', effort);
    if (nativeSessionId) args.push('--resume', nativeSessionId);
    return args;
  }

  function start() {
    exited = false;
    stderrTail = '';
    const spawnSpec = buildSpawnCommand(binary, buildArgs());
    child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });

    reader = createNdjsonReader(child.stdout, {
      onMessage: handleMessage,
      onError: (err) => logger.error?.(`[claude-stream] 读取失败: ${err.message}`),
    });

    child.on('exit', (code, signal) => {
      exited = true;
      // 老版本 CLI 不支持 --effort：先降级 effort 重启一次
      if (code !== 0 && effortEnabled && /--effort|unknown option.*effort/i.test(stderrTail) && !currentTurn) {
        effortEnabled = false;
        logger.warn?.('[claude-stream] CLI 不支持 --effort，忽略思考程度设置');
        start();
        return;
      }
      // 老版本 CLI 不支持 --permission-prompt-tool：降级重启一次
      if (code !== 0 && permissionPromptEnabled && /permission-prompt-tool|unknown option/i.test(stderrTail) && !currentTurn) {
        permissionPromptEnabled = false;
        logger.warn?.('[claude-stream] CLI 不支持 --permission-prompt-tool，降级为 CLI 自管权限');
        start();
        return;
      }
      if (currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        turn.reject(new Error(`claude 进程退出 (code=${code}${stderrTail ? `): ${stderrTail.slice(-500)}` : ')'}`));
      }
      onExit?.({ code, signal });
    });
    child.on('error', (err) => {
      exited = true;
      if (currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        turn.reject(err);
      }
      onExit?.({ code: null, signal: null, error: err });
    });
  }

  // ── stream-json 事件解析 ─────────────────────────────────────────

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          nativeSessionId = msg.session_id || nativeSessionId;
          emit({ type: 'init', nativeSessionId, model: msg.model || '', tools: msg.tools || [] });
        }
        return;
      case 'stream_event':
        handleStreamEvent(msg.event || {});
        return;
      case 'assistant':
        handleAssistantMessage(msg.message || {});
        return;
      case 'user':
        handleUserMessage(msg.message || {});
        return;
      case 'result':
        handleResult(msg);
        return;
      case 'control_request':
        handleControlRequest(msg).catch((err) => {
          respondControl(msg.request_id, { subtype: 'error', error: err?.message || 'internal error' });
        });
        return;
      default:
    }
  }

  function handleStreamEvent(event) {
    if (event.type !== 'content_block_delta') return;
    const delta = event.delta || {};
    if (delta.type === 'text_delta' && delta.text) emit({ type: 'text_delta', text: delta.text });
    else if (delta.type === 'thinking_delta' && delta.thinking) emit({ type: 'thinking_delta', text: delta.thinking });
  }

  function handleAssistantMessage(message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        emit({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        openToolInputs.set(block.id, { name: block.name, input: block.input });
        emit({
          type: 'tool_start',
          toolCallId: block.id,
          title: block.name || 'tool',
          kind: 'other',
          status: 'in_progress',
          input: block.input ?? null,
          locations: extractToolLocations(block.input),
        });
      }
    }
  }

  function handleUserMessage(message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const known = openToolInputs.get(block.tool_use_id);
      openToolInputs.delete(block.tool_use_id);
      emit({
        type: 'tool_update',
        toolCallId: block.tool_use_id || '',
        status: block.is_error ? 'failed' : 'completed',
        content: toolResultText(block.content),
        toolName: known?.name || '',
        locations: extractToolLocations(known?.input),
      });
    }
  }

  function handleResult(msg) {
    nativeSessionId = msg.session_id || nativeSessionId;
    const turn = currentTurn;
    currentTurn = null;
    const isError = msg.subtype && msg.subtype !== 'success';
    if (isError) {
      const errText = msg.result || msg.error || `claude result: ${msg.subtype}`;
      emit({ type: 'error', message: String(errText).slice(0, 2000) });
      turn?.resolve({ stopReason: msg.subtype, isError: true, nativeSessionId, usage: msg.usage || null });
      return;
    }
    emit({
      type: 'done',
      stopReason: msg.subtype || 'success',
      nativeSessionId,
      usage: msg.usage || null,
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      durationMs: msg.duration_ms || null,
    });
    turn?.resolve({ stopReason: 'success', isError: false, nativeSessionId, usage: msg.usage || null });
  }

  async function handleControlRequest(msg) {
    const request = msg.request || {};
    if (request.subtype !== 'can_use_tool') {
      respondControl(msg.request_id, { subtype: 'error', error: `unsupported control request: ${request.subtype}` });
      return;
    }
    let decision = { behavior: 'deny', message: '无审批通道' };
    if (onPermissionRequest) {
      decision = await onPermissionRequest({
        toolName: request.tool_name || '',
        input: request.input || {},
        suggestions: request.permission_suggestions || [],
      });
    }
    const response = decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: decision.updatedInput ?? request.input ?? {} }
      : { behavior: 'deny', message: decision.message || '用户拒绝' };
    respondControl(msg.request_id, { subtype: 'success', response });
  }

  function respondControl(requestId, response) {
    writeNdjson(child.stdin, { type: 'control_response', response: { request_id: requestId, ...response } });
  }

  function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((item) => (item?.type === 'text' ? String(item.text || '') : ''))
      .filter(Boolean)
      .join('\n');
  }

  // ── 对外 API ────────────────────────────────────────────────────

  function prompt({ text, attachments = [] }) {
    if (exited || !child) return Promise.reject(new Error('claude 进程不可用'));
    if (currentTurn) return Promise.reject(new Error('上一轮尚未结束'));
    const blocks = [{ type: 'text', text: String(text || '') }];
    for (const att of attachments) {
      if (att?.path) blocks[0].text += `\n\n[附件] ${att.path}`;
    }
    return new Promise((resolve, reject) => {
      currentTurn = { resolve, reject };
      const ok = writeNdjson(child.stdin, {
        type: 'user',
        message: { role: 'user', content: blocks },
      });
      if (!ok && child.stdin.destroyed) {
        currentTurn = null;
        reject(new Error('claude stdin 不可写'));
      }
    });
  }

  function cancel() {
    if (exited || !child) return;
    const requestId = crypto.randomUUID();
    writeNdjson(child.stdin, { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    const timer = setTimeout(() => {
      if (currentTurn && !exited) { try { child.kill('SIGINT'); } catch { /* ignore */ } }
    }, 2000);
    timer.unref?.();
  }

  function kill() {
    reader?.close();
    if (child && !exited) {
      try { child.stdin.end(); } catch { /* ignore */ }
      killProcessTree(child);
    }
  }

  start();

  return {
    prompt,
    cancel,
    kill,
    get nativeSessionId() { return nativeSessionId; },
    get pid() { return child?.pid || null; },
    get alive() { return Boolean(child) && !exited; },
    get busy() { return Boolean(currentTurn); },
  };
}

module.exports = { createClaudeStreamAgent };
