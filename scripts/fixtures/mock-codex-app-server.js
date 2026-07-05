'use strict';

// Mock codex app-server：scripts/test-codex-adapter.js 的测试替身。
// 覆盖 thread/turn/item 协议要素：initialize / thread/start / thread/resume /
// turn/start / turn/interrupt、agentMessage 与 reasoning delta、commandExecution
// item 生命周期（含 requestApproval 审批往返与 outputDelta）、tokenUsage、
// 未知服务端请求的宽容处理。thread/resume 后首个回复带 [resumed] 前缀供断言。

const readline = require('readline');

let resumed = false;
let interrupted = false;
let turnSeq = 0;
let nextOutId = 9000;
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

  // 用户消息回显（适配器应忽略）
  notify('item/started', { threadId, turnId, item: { type: 'userMessage', id: 'um-1', content: [{ type: 'text', text }] } });
  notify('item/completed', { threadId, turnId, item: { type: 'userMessage', id: 'um-1', content: [{ type: 'text', text }] } });

  // 思考流
  notify('item/started', { threadId, turnId, item: { type: 'reasoning', id: 'rs-1' } });
  notify('item/reasoning/textDelta', { threadId, turnId, itemId: 'rs-1', contentIndex: 0, delta: 'pondering' });
  notify('item/completed', { threadId, turnId, item: { type: 'reasoning', id: 'rs-1' } });

  // 文本流 + 定稿
  const greeting = resumed ? '[resumed] Hello codex.' : 'Hello codex.';
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
      respond(msg.id, { thread: { id: THREAD_ID, sessionId: THREAD_ID, status: { type: 'idle' } }, model: 'mock-gpt' });
      return;
    case 'thread/resume':
      resumed = true;
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
