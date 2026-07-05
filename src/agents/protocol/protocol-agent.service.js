'use strict';

// 协议 agent 会话管理器：把第三方 agent（claude stream-json / ACP）的归一化
// 事件翻译成与 1Shell AI 完全相同的 ide:* 事件形状，前端时间线零改动复用。
//
// 职责：
//   - 会话生命周期：创建 / 继续（--resume、session/load）/ 停止 / detach / reattach
//   - 事件翻译：适配器归一化事件 → emitIdeEvent（legacy + 统一 ide:event 双发）
//   - 权限请求挂起/应答：ide:approve-request ↔ ide:approve-response
//   - 会话持久化：ide_sessions 表（agent_id / cwd / native_session_id 绑定三元组）
//
// 与 ide.service.js（1Shell AI）的分工见 docs/oneshell-4.7-protocol-agent-ide-plan.md。

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { emitIdeEvent } = require('../../ide/ide.events');
const { createAcpClient } = require('./acp-client');
const { createClaudeStreamAgent } = require('./claude-stream-adapter');
const { createCodexAppServerAgent } = require('./codex-adapter');
const { normalizeLocations } = require('./tool-locations');
const { redactCredentialPatterns, redactPotentialSecrets } = require('../../../lib/secret-redaction');

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_FILES_MAX = 200;

const ONESHELL_AGENT_ID = 'oneshell';

function createProtocolAgentService({ catalog, ideSessionRepository, logger = console } = {}) {
  const sessions = new Map(); // sessionId -> session
  const approvals = new Map(); // requestId -> { session, finish }

  // ── 会话状态 ─────────────────────────────────────────────────────

  function getOrCreateSession(sessionId, { agentId, cwd }) {
    let session = sessions.get(sessionId);
    if (session) return session;

    const record = ideSessionRepository?.getSession?.(sessionId) || null;
    const recordAgentId = record?.agentId && record.agentId !== ONESHELL_AGENT_ID ? record.agentId : '';
    session = {
      sessionId,
      agentId: recordAgentId || agentId || '',
      cwd: record?.cwd || cwd || '',
      nativeSessionId: record?.nativeSessionId || '',
      messages: Array.isArray(record?.messages) ? [...record.messages] : [],
      files: Array.isArray(record?.files) ? [...record.files] : [],
      firstUserMessage: record?.title || '',
      client: null,
      protocol: '',
      acpReady: null, // Promise：ACP initialize + session/new|load 完成
      loading: false, // session/load 历史重放屏蔽窗口
      socket: null,
      socketId: null,
      detachedAt: null,
      detachReason: '',
      currentRunId: null,
      cancelled: false,
      turn: null, // { runId, textBuffer, blocks, openTools: Map }
      idleTimer: null,
    };
    sessions.set(sessionId, session);
    return session;
  }

  function emitToSession(session, event, payload) {
    const target = session?.socket;
    if (!target) return;
    try { emitIdeEvent(target, event, payload); } catch { /* ignore */ }
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function touchIdle(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!sessions.has(session.sessionId)) return; // 已删除的会话不再续期
    session.idleTimer = setTimeout(() => {
      if (session.turn || session.currentRunId) {
        touchIdle(session);
        return;
      }
      logger.info?.(`[protocol-agent] 会话 ${session.sessionId} 空闲回收（进程退出，可 resume）`);
      destroySession(session, { keepRecord: true });
    }, IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  }

  function destroySession(session, { keepRecord = true } = {}) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    rejectPendingApprovals(session, 'session_closed');
    try { session.client?.kill?.(); } catch { /* ignore */ }
    session.client = null;
    sessions.delete(session.sessionId);
    if (!keepRecord) {
      try { ideSessionRepository?.deleteSession?.(session.sessionId); } catch { /* ignore */ }
    }
  }

  // ── 持久化 ───────────────────────────────────────────────────────

  function previewFromMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i]?.content;
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
      for (const block of blocks) {
        if (block?.type === 'text' && String(block.text || '').trim()) {
          return String(block.text).replace(/\s+/g, ' ').trim().slice(0, 160);
        }
      }
    }
    return '';
  }

  function persistSession(session) {
    try {
      if (!ideSessionRepository?.upsertSession || session.messages.length === 0) return;
      const spec = catalog?.getAgent?.(session.agentId);
      ideSessionRepository.upsertSession({
        id: session.sessionId,
        title: redactCredentialPatterns(String(session.firstUserMessage || '').slice(0, 60)) || spec?.name || session.agentId,
        entry: 'core',
        hostId: '',
        workspaceHostIds: [],
        modelLabel: spec?.name || session.agentId,
        messages: redactPotentialSecrets(session.messages),
        preview: redactCredentialPatterns(previewFromMessages(session.messages)),
        agentId: session.agentId,
        cwd: session.cwd,
        nativeSessionId: session.nativeSessionId || '',
        files: session.files,
      });
    } catch (err) {
      logger.warn?.(`[protocol-agent] 会话持久化失败: ${err.message}`);
    }
  }

  // 会话涉及文件：完成的 tool 调用触碰的文件路径聚合（IDE 壳的文件↔会话关联）。
  // 最近触碰的排最前、同路径去重（line 取最新），超上限丢最旧的。
  function mergeSessionFiles(session, locations) {
    const incoming = normalizeLocations(locations);
    if (!incoming.length) return;
    const touched = new Set(incoming.map((loc) => loc.path));
    const rest = session.files.filter((f) => f && !touched.has(f.path));
    session.files = [...incoming, ...rest].slice(0, SESSION_FILES_MAX);
  }

  // ── 权限请求挂起/应答 ────────────────────────────────────────────

  function requestApproval(session, { toolName, title, detail, input, options = [], toolUseId = '' }) {
    return new Promise((resolve) => {
      const requestId = `pa-${crypto.randomUUID()}`;
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        approvals.delete(requestId);
        resolve(decision || { action: 'deny', reason: 'no_decision' });
      };
      const timer = setTimeout(() => finish({ action: 'deny', reason: 'approval_timeout' }), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      approvals.set(requestId, { session, finish });

      emitToSession(session, 'ide:approve-request', {
        sessionId: session.sessionId,
        runId: session.currentRunId,
        requestId,
        toolUseId,
        toolName: toolName || 'tool',
        title: title || `${toolName || '工具'} 请求授权`,
        detail: detail || '',
        input: input ?? null,
        approval: {
          title: title || '',
          toolName: toolName || '',
          input: input ?? null,
          // ACP 的多选项（allow_once/allow_always/reject_once…）原样透出，
          // M2 的审批卡片按此渲染动作组；M1 前端只用 allow/deny。
          options: options.map((o) => ({ optionId: o.optionId || '', name: o.name || '', kind: o.kind || '' })),
        },
      });
    });
  }

  function resolveApproval(payload = {}) {
    const requestId = String(payload.requestId || '').trim();
    if (!requestId || !approvals.has(requestId)) return false;
    const { finish } = approvals.get(requestId);
    // optionId：前端审批卡直接选择 ACP 选项（allow_always 等）时透传
    finish({
      action: payload.action === 'allow' ? 'allow' : (payload.action === 'custom' ? 'custom' : 'deny'),
      optionId: String(payload.optionId || ''),
      text: String(payload.text || ''),
    });
    return true;
  }

  function rejectPendingApprovals(session, reason) {
    for (const [requestId, entry] of approvals) {
      if (entry.session !== session) continue;
      approvals.delete(requestId);
      entry.finish({ action: 'deny', reason });
    }
  }

  function pickAcpOption(options, wantAllow) {
    const kinds = wantAllow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    for (const kind of kinds) {
      const hit = options.find((o) => o.kind === kind);
      if (hit) return hit.optionId;
    }
    const prefix = wantAllow ? 'allow' : 'reject';
    const loose = options.find((o) => String(o.kind || '').startsWith(prefix));
    return loose ? loose.optionId : '';
  }

  // ── 归一化事件 → ide:event 翻译 ──────────────────────────────────

  function ensureTurn(session) {
    if (!session.turn) {
      session.turn = { runId: session.currentRunId, textBuffer: '', blocks: [], openTools: new Map() };
    }
    return session.turn;
  }

  function flushTextBlock(session, { emitFinal = false } = {}) {
    const turn = session.turn;
    if (!turn || !turn.textBuffer) return;
    const text = turn.textBuffer;
    turn.textBuffer = '';
    turn.blocks.push({ type: 'text', text });
    if (emitFinal) {
      emitToSession(session, 'ide:text', { sessionId: session.sessionId, runId: turn.runId, text });
    }
  }

  function flushAssistantMessage(session) {
    const turn = session.turn;
    if (!turn) return;
    flushTextBlock(session);
    if (turn.blocks.length) {
      session.messages.push({ role: 'assistant', content: turn.blocks });
      turn.blocks = [];
    }
  }

  function closeDanglingTools(session) {
    const turn = session.turn;
    if (!turn || turn.openTools.size === 0) return;
    for (const [toolCallId, tool] of turn.openTools) {
      flushAssistantMessage(session);
      session.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCallId, content: '', is_error: false }],
      });
      emitToSession(session, 'ide:tool-end', {
        sessionId: session.sessionId,
        runId: turn.runId,
        toolUseId: toolCallId,
        name: tool.name || 'tool',
        result: '',
        is_error: false,
        locations: tool.locations || [],
      });
    }
    turn.openTools.clear();
  }

  function finalizeTurn(session, outcome) {
    const turn = session.turn;
    if (!turn) return;
    const { sessionId } = session;
    const runId = turn.runId;
    closeDanglingTools(session);
    // 剩余流式文本定稿（claude 的 text 事件已定稿过的场景 buffer 为空）
    flushTextBlock(session, { emitFinal: outcome.kind === 'done' && !session.cancelled });
    flushAssistantMessage(session);
    session.turn = null;
    if (session.currentRunId === runId) session.currentRunId = null;
    persistSession(session);
    touchIdle(session);

    if (session.cancelled || outcome.kind === 'cancelled') {
      emitToSession(session, 'ide:cancelled', { sessionId, runId });
      return;
    }
    if (outcome.kind === 'error') {
      emitToSession(session, 'ide:error', { sessionId, runId, error: outcome.error || '协议 agent 执行失败' });
      return;
    }
    emitToSession(session, 'ide:done', { sessionId, runId, taskStatus: 'done' });
  }

  function handleAgentEvent(session, event) {
    // session/load 期间 agent 会重放历史（ACP 规范），这些事件不属于当前
    // 回合——历史已在持久化记录里，直接丢弃避免重复。
    if (session.loading) return;
    const turn = session.turn;
    const { sessionId } = session;
    switch (event.type) {
      case 'init':
        if (event.nativeSessionId) session.nativeSessionId = event.nativeSessionId;
        return;
      case 'text_delta': {
        if (!turn || !event.text) return;
        turn.textBuffer += event.text;
        emitToSession(session, 'ide:text-delta', { sessionId, runId: turn.runId, delta: event.text });
        return;
      }
      case 'thinking_delta':
        if (!turn) return;
        emitToSession(session, 'ide:thinking', { sessionId, runId: turn.runId, text: event.text || '' });
        return;
      case 'text': {
        // claude：assistant 消息 text block 定稿，替换此前的流式 delta
        if (!turn) return;
        turn.textBuffer = '';
        if (event.text) {
          turn.blocks.push({ type: 'text', text: event.text });
          emitToSession(session, 'ide:text', { sessionId, runId: turn.runId, text: event.text });
        }
        return;
      }
      case 'tool_start': {
        if (!turn) return;
        // 工具卡片出现前，把已流出的文本段定稿，保持时间线顺序
        flushTextBlock(session, { emitFinal: true });
        const locations = normalizeLocations(event.locations);
        const block = { type: 'tool_use', id: event.toolCallId, name: event.title || 'tool', input: event.input ?? {} };
        // locations 只挂在协议会话的展示记录上；这些 messages 不回传给任何模型 API
        if (locations.length) block.locations = locations;
        turn.blocks.push(block);
        turn.openTools.set(event.toolCallId, { name: event.title || 'tool', locations });
        emitToSession(session, 'ide:tool-start', {
          sessionId,
          runId: turn.runId,
          toolUseId: event.toolCallId,
          name: event.title || 'tool',
          input: event.input ?? null,
          locations,
        });
        return;
      }
      case 'tool_update': {
        if (!turn) return;
        const isFinal = event.status === 'completed' || event.status === 'failed';
        const known = turn.openTools.get(event.toolCallId);
        // ACP 的 tool_call_update 可能中途才带出 locations（如 pending 时还没定位到文件）
        if (known && Array.isArray(event.locations) && event.locations.length) {
          known.locations = normalizeLocations([...(known.locations || []), ...event.locations]);
        }
        if (!isFinal) {
          if (event.content) {
            emitToSession(session, 'ide:tool-delta', {
              sessionId,
              runId: turn.runId,
              toolUseId: event.toolCallId,
              name: known?.name || event.toolName || 'tool',
              stream: 'stdout',
              text: event.content,
            });
          }
          return;
        }
        turn.openTools.delete(event.toolCallId);
        const locations = normalizeLocations([...(known?.locations || []), ...(event.locations || [])]);
        if (event.status === 'completed') mergeSessionFiles(session, locations);
        flushAssistantMessage(session);
        session.messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: event.toolCallId,
            content: String(event.content || ''),
            is_error: event.status === 'failed',
          }],
        });
        emitToSession(session, 'ide:tool-end', {
          sessionId,
          runId: turn.runId,
          toolUseId: event.toolCallId,
          name: known?.name || event.toolName || 'tool',
          result: String(event.content || ''),
          is_error: event.status === 'failed',
          locations,
        });
        return;
      }
      case 'plan':
        // ACP plan：暂无 legacy 对应 UI，走统一事件流供 M2 消费
        emitToSession(session, 'ide:plan', { sessionId, runId: turn?.runId || session.currentRunId, entries: event.entries || [] });
        return;
      case 'done':
        // claude 适配器的回合定稿事件；ACP 走 prompt() resolve 分支
        if (event.nativeSessionId) session.nativeSessionId = event.nativeSessionId;
        finalizeTurn(session, { kind: 'done' });
        return;
      case 'error':
        finalizeTurn(session, { kind: 'error', error: event.message });
        return;
      case 'mode':
      default:
        // 未知事件宽容跳过，保持对各家实现的兼容
    }
  }

  // ── 协议客户端装配 ───────────────────────────────────────────────

  function buildClaudeClient(session, spec) {
    return createClaudeStreamAgent({
      binary: spec.binaryPath,
      cwd: session.cwd,
      resumeSessionId: session.nativeSessionId || '',
      logger,
      onPermissionRequest: async ({ toolName, input }) => {
        const decision = await requestApproval(session, {
          toolName,
          title: `Claude Code 请求使用 ${toolName}`,
          detail: '',
          input,
        });
        if (decision.action === 'allow') return { behavior: 'allow' };
        return { behavior: 'deny', message: decision.text || (decision.reason === 'approval_timeout' ? '审批超时' : '用户拒绝') };
      },
      onEvent: (event) => handleAgentEvent(session, event),
      onExit: ({ code }) => {
        session.client = null;
        session.acpReady = null;
        if (session.turn) {
          finalizeTurn(session, { kind: 'error', error: `claude 进程意外退出 (code=${code})` });
        }
      },
    });
  }

  function buildCodexClient(session, spec) {
    return createCodexAppServerAgent({
      binary: spec.binaryPath,
      args: spec.args || ['app-server'],
      cwd: session.cwd,
      resumeThreadId: session.nativeSessionId || '',
      logger,
      onPermissionRequest: async ({ toolName, input }) => {
        const decision = await requestApproval(session, {
          toolName,
          title: `Codex 请求授权：${toolName}`,
          detail: '',
          input,
        });
        if (decision.action === 'allow') return { behavior: 'allow' };
        return { behavior: 'deny', message: decision.text || (decision.reason === 'approval_timeout' ? '审批超时' : '用户拒绝') };
      },
      onEvent: (event) => handleAgentEvent(session, event),
      onExit: ({ code }) => {
        session.client = null;
        session.acpReady = null;
        if (session.turn) {
          finalizeTurn(session, { kind: 'error', error: `codex 进程意外退出 (code=${code})` });
        }
      },
    });
  }

  function buildAcpClient(session, spec) {
    return createAcpClient({
      command: spec.binaryPath,
      args: spec.args || [],
      cwd: session.cwd,
      logger,
      onPermissionRequest: async ({ toolCall, options }) => {
        const decision = await requestApproval(session, {
          toolName: toolCall.title || toolCall.kind || 'tool',
          title: `${spec.name} 请求授权：${toolCall.title || '工具调用'}`,
          detail: '',
          input: toolCall.rawInput ?? null,
          options,
          toolUseId: toolCall.toolCallId || '',
        });
        // 前端直接选中某个 ACP 选项（如 allow_always）时按选项应答
        if (decision.optionId && options.some((o) => o.optionId === decision.optionId)) {
          return { optionId: decision.optionId };
        }
        if (decision.action === 'allow') {
          const optionId = pickAcpOption(options, true);
          return optionId ? { optionId } : { cancelled: true };
        }
        const optionId = pickAcpOption(options, false);
        return optionId ? { optionId } : { cancelled: true };
      },
      onEvent: (event) => handleAgentEvent(session, event),
      onExit: ({ code }) => {
        session.client = null;
        session.acpReady = null;
        if (session.turn) {
          finalizeTurn(session, { kind: 'error', error: `${spec.name} 进程意外退出 (code=${code})` });
        }
      },
    });
  }

  async function ensureClient(session, spec) {
    if (session.client?.alive) {
      if (session.protocol === 'acp' && session.acpReady) await session.acpReady;
      return;
    }
    session.protocol = spec.protocol;
    if (spec.protocol === 'claude-stream') {
      session.client = buildClaudeClient(session, spec);
      return;
    }
    if (spec.protocol === 'codex-app-server') {
      // 回合定稿与 claude 同模式：适配器 emit done/error，handleAgentEvent 收口
      session.client = buildCodexClient(session, spec);
      return;
    }
    if (spec.protocol === 'acp') {
      const client = buildAcpClient(session, spec);
      session.client = client;
      session.acpReady = (async () => {
        await client.initialize();
        const canLoad = Boolean(client.capabilities?.loadSession);
        if (session.nativeSessionId && canLoad) {
          session.loading = true;
          try {
            await client.loadSession({ acpSessionId: session.nativeSessionId, cwd: session.cwd });
          } finally {
            session.loading = false;
          }
        } else {
          const { acpSessionId } = await client.newSession({ cwd: session.cwd });
          session.nativeSessionId = acpSessionId;
        }
      })();
      try {
        await session.acpReady;
      } catch (err) {
        // 初始化失败的进程不可复用：清掉引用让下一条消息重新拉起
        session.acpReady = null;
        session.client = null;
        try { client.kill(); } catch { /* ignore */ }
        throw err;
      }
      return;
    }
    throw new Error(`不支持的协议: ${spec.protocol}`);
  }

  // ── 对外 API ────────────────────────────────────────────────────

  async function handleMessage({ socket, sessionId, message, agentId = '', cwd = '', attachments = [] }) {
    const session = getOrCreateSession(sessionId, {
      agentId: String(agentId || '').trim(),
      cwd: String(cwd || '').trim(),
    });
    session.socket = socket || session.socket;
    session.socketId = socket?.id || session.socketId;
    session.detachedAt = null;
    session.detachReason = '';

    const fail = (error) => {
      emitToSession(session, 'ide:error', { sessionId, runId: session.currentRunId, error });
    };

    if (!session.agentId || session.agentId === ONESHELL_AGENT_ID) {
      return fail('缺少 agentId：协议会话必须指定第三方 agent');
    }
    const spec = catalog?.getAgent?.(session.agentId);
    if (!spec) return fail(`未知的协议 agent: ${session.agentId}`);
    if (!spec.binaryPath) return fail(`未检测到 ${spec.name} 可执行文件（${spec.binary}），请先安装或在 Agent 接入页指定路径`);

    if (!session.cwd) session.cwd = os.homedir();
    if (!fs.existsSync(session.cwd)) return fail(`工作目录不存在: ${session.cwd}`);

    if (session.turn) return fail('上一轮尚未结束，请等待或先停止');

    const runId = newRunId();
    session.currentRunId = runId;
    session.cancelled = false;
    ensureTurn(session);
    touchIdle(session);

    if (!session.firstUserMessage) session.firstUserMessage = String(message).slice(0, 200);
    session.messages.push({ role: 'user', content: [{ type: 'text', text: String(message) }] });

    emitToSession(session, 'ide:thinking', { sessionId, runId });

    try {
      await ensureClient(session, spec);
      if (session.protocol === 'acp') {
        const { stopReason } = await session.client.prompt({
          acpSessionId: session.nativeSessionId,
          text: message,
          attachments,
        });
        finalizeTurn(session, { kind: stopReason === 'cancelled' ? 'cancelled' : 'done' });
      } else {
        // claude-stream / codex-app-server：回合定稿事件（done/error）在 handleAgentEvent 中处理
        await session.client.prompt({ text: message, attachments });
      }
    } catch (err) {
      if (session.turn && session.turn.runId === runId) {
        finalizeTurn(session, { kind: session.cancelled ? 'cancelled' : 'error', error: err?.message || '协议 agent 执行失败' });
      }
    }
  }

  function cancelSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.turn) return false;
    session.cancelled = true;
    rejectPendingApprovals(session, 'cancelled');
    try {
      if (session.protocol === 'acp') session.client?.cancel?.(session.nativeSessionId);
      else session.client?.cancel?.();
    } catch { /* ignore */ }
    return true;
  }

  function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.cancelled = true;
    destroySession(session, { keepRecord: true });
    return true;
  }

  function detachSessionsForSocket(socketId, reason = 'socket_disconnect') {
    let detached = 0;
    for (const session of sessions.values()) {
      if (session.socketId !== socketId) continue;
      session.socket = null;
      session.socketId = null;
      session.detachedAt = new Date().toISOString();
      session.detachReason = reason;
      detached += 1;
    }
    return detached;
  }

  function reattachSession(sessionId, socket) {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session 不存在' };
    session.socket = socket;
    session.socketId = socket.id;
    session.detachedAt = null;
    session.detachReason = '';
    if (session.currentRunId && !session.cancelled) {
      emitIdeEvent(socket, 'ide:thinking', { sessionId, runId: session.currentRunId });
    }
    return { ok: true, running: Boolean(session.currentRunId) && !session.cancelled, runId: session.currentRunId };
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  // 会话归属：live 会话，或持久化记录标记了第三方 agent
  function ownsSession(sessionId) {
    if (sessions.has(sessionId)) return true;
    try {
      const record = ideSessionRepository?.getSession?.(sessionId);
      return Boolean(record?.agentId && record.agentId !== ONESHELL_AGENT_ID);
    } catch {
      return false;
    }
  }

  function listAgents() {
    return catalog?.listAgents?.() || [];
  }

  function shutdown() {
    for (const session of [...sessions.values()]) {
      destroySession(session, { keepRecord: true });
    }
  }

  return {
    handleMessage,
    cancelSession,
    deleteSession,
    detachSessionsForSocket,
    reattachSession,
    hasSession,
    ownsSession,
    resolveApproval,
    listAgents,
    shutdown,
  };
}

module.exports = { createProtocolAgentService };
