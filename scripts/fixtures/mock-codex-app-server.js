'use strict';

// Mock codex app-server：scripts/test-codex-adapter.js 的测试替身。
// 覆盖 thread/turn/item 协议要素：initialize / thread/start / thread/resume /
// turn/start / turn/interrupt、agentMessage 与 reasoning delta、commandExecution
// item 生命周期（含 requestApproval 审批往返与 outputDelta）、tokenUsage、
// 未知服务端请求的宽容处理。thread/resume 后首个回复带 [resumed] 前缀供断言。
// 特殊触发词：
//   showparams —— 回复 JSON：{ thread: thread/start|resume 参数, turn: 本回合
//                 approvalPolicy/sandboxPolicy/effort/serviceTier }（策略传参断言）
//   mcpperm    —— 发起 item/permissions/requestApproval，按响应回 granted/denied
//   文本含 [会话交接] / [目标 VPS] —— 回复前缀 [handoff-seen] / [targets-seen]
//                 （service 层的 prompt 注入断言）

const readline = require('readline');

let resumed = false;
let interrupted = false;
let turnSeq = 0;
let nextOutId = 9000;
let lastThreadParams = null;
const pendingOut = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result ?? null;
  send(msg);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function request(method, params) {
  const id = nextOutId++;
  return new Promise((resolve, reject) => {
    pendingOut.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate() || Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}

const THREAD_ID = 'th-mock-1';

async function handleTurnStart(msg) {
  const threadId = msg.params?.threadId || THREAD_ID;
  const text = (msg.params?.input || []).map((b) => b?.text || '').join('');
  const turnId = `turn-${++turnSeq}`;
  respond(msg.id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } });

  if (text.includes('cancelme')) {
    interrupted = false;
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'msg-c', text: '' } });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-c', delta: 'working...' });
    await waitFor(() => interrupted, 5000);
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'interrupted', error: null } });
    return;
  }

  // 策略传参断言：把收到的 thread/turn 策略参数原样回给测试
  if (text.includes('showparams')) {
    const dump = JSON.stringify({
      thread: lastThreadParams,
      turn: {
        approvalPolicy: msg.params?.approvalPolicy ?? null,
        sandboxPolicy: msg.params?.sandboxPolicy ?? null,
        effort: msg.params?.effort ?? null,
        serviceTier: msg.params?.serviceTier ?? null,
      },
    });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `msg-p-${turnId}`, text: dump } });
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } });
    return;
  }

  // MCP 权限申请审批往返：响应形状与 command/file 审批不同（granted profile）
  if (text.includes('mcpperm')) {
    const requested = { network: { enabled: true } };
    notify('item/started', { threadId, turnId, item: { type: 'mcpToolCall', id: 'mcp-1', server: '1shell', tool: 'host_exec' } });
    let grant = null;
    try {
      grant = await request('item/permissions/requestApproval', {
        threadId,
        turnId,
        itemId: 'mcp-1',
        cwd: '/tmp',
        permissions: requested,
        reason: 'mcp needs network',
        startedAtMs: Date.now(),
      });
    } catch {
      grant = null;
    }
    const granted = Boolean(grant?.permissions?.network?.enabled);
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: '1shell',
        tool: 'host_exec',
        status: granted ? 'completed' : 'declined',
        result: { content: [{ type: 'text', text: granted ? 'granted' : 'denied' }] },
      },
    });
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } });
    return;
  }

  // 用户消息回显（适配器应忽略）
  notify('item/started', { threadId, turnId, item: { type: 'userMessage', id: 'um-1', content: [{ type: 'text', text }] } });
  notify('item/completed', { threadId, turnId, item: { type: 'userMessage', id: 'um-1', content: [{ type: 'text', text }] } });

  // 思考流
  notify('item/started', { threadId, turnId, item: { type: 'reasoning', id: 'rs-1' } });
  notify('item/reasoning/textDelta', { threadId, turnId, itemId: 'rs-1', contentIndex: 0, delta: 'pondering' });
  notify('item/completed', { threadId, turnId, item: { type: 'reasoning', id: 'rs-1' } });

  // 文本流 + 定稿（service 层注入的交接/目标提示以前缀标记回显，供断言）
  const marks = [];
  if (resumed) marks.push('[resumed]');
  if (text.includes('[会话交接]')) marks.push('[handoff-seen]');
  if (text.includes('[目标 VPS]')) marks.push('[targets-seen]');
  const greeting = `${marks.join(' ')}${marks.length ? ' ' : ''}Hello codex.`;
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'msg-1', text: '', phase: 'final_answer' } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: greeting.slice(0, 6) });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: greeting.slice(6) });
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'msg-1', text: greeting, phase: 'final_answer' } });

  // 命令执行 item + 审批往返
  notify('item/started', {
    threadId,
    turnId,
    item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: '/tmp', status: 'inProgress' },
  });
  let decision = null;
  try {
    decision = await request('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      itemId: 'cmd-1',
      approvalId: null,
      command: 'echo hi',
      cwd: '/tmp',
    });
  } catch {
    decision = { decision: 'decline' };
  }
  const accepted = decision?.decision === 'accept' || decision?.decision === 'acceptForSession';

  if (accepted) {
    notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: 'cmd-1', delta: 'hi\n' });
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: '/tmp', status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0 },
    });
  } else {
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: '/tmp', status: 'declined', aggregatedOutput: '', exitCode: null },
    });
  }

  // 未知服务端请求：适配器应回 JSON-RPC error 而不是挂死
  try {
    await request('item/tool/requestUserInput', { threadId, turnId, itemId: 'q-1', prompt: 'unused' });
  } catch { /* 预期走到这里 */ }

  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: { total: { totalTokens: 42, inputTokens: 30, outputTokens: 12 }, last: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } },
  });
  notify('thread/status/changed', { threadId, status: { type: 'idle' } });
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null, durationMs: 7 } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // 自己发出的请求（requestApproval 等）的响应
  if (msg.id !== undefined && msg.method === undefined) {
    const entry = pendingOut.get(msg.id);
    if (entry) {
      pendingOut.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'error'));
      else entry.resolve(msg.result);
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { userAgent: 'mock-codex/0.0.1', codexHome: '/tmp/.codex' });
      return;
    case 'thread/start':
      resumed = false;
      lastThreadParams = msg.params || null;
      respond(msg.id, { thread: { id: THREAD_ID, sessionId: THREAD_ID, status: { type: 'idle' } }, model: 'mock-gpt' });
      return;
    case 'thread/resume':
      resumed = true;
      lastThreadParams = msg.params || null;
      respond(msg.id, { thread: { id: msg.params?.threadId || THREAD_ID, status: { type: 'idle' } }, model: 'mock-gpt' });
      return;
    case 'turn/start':
      handleTurnStart(msg).catch((err) => respond(msg.id, null, { code: -32603, message: err.message }));
      return;
    case 'turn/interrupt':
      interrupted = true;
      respond(msg.id, {});
      return;
    default:
      if (msg.id !== undefined) respond(msg.id, null, { code: -32601, message: `Method not found: ${msg.method}` });
  }
});
