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
//        item/fileChange/requestApproval → { decision: 'accept'|'decline' }；
//        item/permissions/requestApproval（MCP 调用等触发的权限申请）→
//        { permissions: <granted>, scope }。未接住的审批方法会被 codex 视为
//        拒绝——4.7.0 里 MCP 调用审批就是这样被"拦截"的，务必宽接。
//   权限策略：thread/start|resume 传 approvalPolicy + sandbox；turn/start 可
//        逐回合覆盖 approvalPolicy / sandboxPolicy / effort / serviceTier / model。
//   thread id 即原生会话 id，rollout 落盘 ~/.codex/sessions，可跨重启 resume。

const { spawn } = require('child_process');
const { createNdjsonReader, writeNdjson } = require('./ndjson');
const { buildSpawnCommand, killProcessTree } = require('./spawn-command');
const { extractToolLocations } = require('./tool-locations');

const CLIENT_INFO = { name: '1shell', title: '1Shell Agent', version: '4.7.0' };

// 审批/沙箱策略组合：auto = mindfs 同款完全放行（approval never + 全量沙箱），
// ask = codex 主动请求审批（on-request）+ 工作区写沙箱，审批卡交给前端。
function approvalPlan(approvalMode) {
  if (approvalMode === 'ask') {
    return {
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
    };
  }
  return {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

function createCodexAppServerAgent({
  binary = 'codex',
  args = ['app-server'],
  cwd = process.cwd(),
  env = process.env,
  model = '',
  resumeThreadId = '',
  logger = console,
  // () => { approvalMode:'auto'|'ask', effort:'', fast:false }：每回合取最新会话设置
  sessionSettings = null,
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

  function currentSettings() {
    try { return sessionSettings?.() || {}; } catch { return {}; }
  }

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await request('initialize', { clientInfo: CLIENT_INFO });
        const plan = approvalPlan(currentSettings().approvalMode);
        const startParams = {
          cwd,
          model: model || null,
          approvalPolicy: plan.approvalPolicy,
          sandbox: plan.sandboxMode,
        };
        let started = null;
        if (resumeThreadId) {
          try {
            started = await request('thread/resume', { threadId: resumeThreadId, ...startParams });
          } catch (err) {
            logger.warn?.(`[codex] thread/resume 失败（${err.message}），改为新建会话`);
          }
        }
        if (!started) {
          started = await request('thread/start', startParams);
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
    // MCP 调用等触发的权限申请（文件系统/网络扩权）。响应形状与其余审批
    // 不同：允许 = 原样授予申请的 profile（会话级），拒绝 = 空授予。
    if (msg.method === 'item/permissions/requestApproval') {
      const decision = await askPermission({
        toolName: '权限申请',
        kind: 'permissions',
        input: { reason: params.reason || '', permissions: params.permissions || {} },
      });
      if (decision.behavior === 'allow') {
        respond(msg.id, { permissions: params.permissions || {}, scope: 'session' });
      } else {
        respond(msg.id, { permissions: {} });
      }
      return;
    }
    // 未知审批方法兜底：宽接为一次审批（codex 对 error 响应按拒绝处理，
    // 4.7.0 的 MCP 拦截问题就来自这里）。响应形状按 accept/decline 猜测，
    // 若 codex 不认会在其侧报错，但不会静默卡死回合。
    if (/requestApproval|Approval$/.test(msg.method)) {
      logger.warn?.(`[codex] 未知审批方法 ${msg.method}，按通用审批处理`);
      const decision = await askPermission({
        toolName: msg.method,
        kind: 'other',
        input: params,
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

  async function prompt({ text }) {
    if (exited || !child) throw new Error('codex 进程不可用');
    if (currentTurn) throw new Error('上一轮尚未结束');
    await ensureReady();
    // 附件已由 service 层落盘并把路径拼进 text，这里不再单独处理
    const content = String(text || '');
    // 逐回合覆盖：审批/沙箱/思考程度/fast 档随会话设置即时生效，无需重启进程
    const settings = currentSettings();
    const plan = approvalPlan(settings.approvalMode);
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: content }],
      approvalPolicy: plan.approvalPolicy,
      sandboxPolicy: plan.sandboxPolicy,
      effort: String(settings.effort || '').trim() || null,
      serviceTier: settings.fast ? 'fast' : null,
    };
    return new Promise((resolve, reject) => {
      currentTurn = { resolve, reject, turnId: '', usage: null, lastError: '' };
      request('turn/start', turnParams)
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
