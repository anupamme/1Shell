'use strict';

// Mock ACP agent：scripts/test-acp-client.js 的测试替身。
// 覆盖 ACP 全事件类型：agent_thought_chunk / agent_message_chunk / plan /
// tool_call / tool_call_update / session/request_permission / fs/read_text_file /
// session/cancel。会话恢复（session/load）后首个回复带 [resumed] 前缀供断言。

const readline = require('readline');

let loaded = false;
let cancelled = false;
let nextOutId = 1000;
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

async function handlePrompt(msg) {
  const sessionId = msg.params?.sessionId || '';
  const text = (msg.params?.prompt || []).map((b) => b?.text || '').join('');
  const upd = (update) => notify('session/update', { sessionId, update });

  if (text.includes('cancelme')) {
    cancelled = false;
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } });
    await waitFor(() => cancelled, 5000);
    respond(msg.id, { stopReason: 'cancelled' });
    return;
  }

  upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } });
  upd({ sessionUpdate: 'plan', entries: [{ content: 'step 1', status: 'pending', priority: 'medium' }] });
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: loaded ? '[resumed] Hello ' : 'Hello ' } });
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world.' } });
  upd({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'read_file',
    kind: 'read',
    status: 'in_progress',
    rawInput: { path: '/tmp/demo.txt' },
    locations: [{ path: '/tmp/demo.txt' }],
  });

  const perm = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'tc-1', title: 'read_file', rawInput: { path: '/tmp/demo.txt' } },
    options: [
      { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const allowed = perm?.outcome?.outcome === 'selected' && perm.outcome.optionId === 'opt-allow';

  let fsContent = '';
  try {
    const r = await request('fs/read_text_file', { sessionId, path: '/tmp/demo.txt' });
    fsContent = r?.content || '';
  } catch {
    fsContent = '(no fs capability)';
  }

  upd({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: 'reading...' } }],
  });
  upd({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: allowed ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: allowed ? `content=${fsContent}` : 'denied' } }],
  });
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' done.' } });

  respond(msg.id, { stopReason: 'end_turn' });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // 自己发出的请求（request_permission / fs）的响应
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
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
      respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
      return;
    case 'session/new':
      respond(msg.id, { sessionId: 'acp-mock-session' });
      return;
    case 'session/load':
      loaded = true;
      respond(msg.id, null);
      return;
    case 'session/cancel':
      cancelled = true;
      return;
    case 'session/prompt':
      handlePrompt(msg).catch((err) => respond(msg.id, null, { code: -32603, message: err.message }));
      return;
    default:
      if (msg.id !== undefined) respond(msg.id, null, { code: -32601, message: `Method not found: ${msg.method}` });
  }
});
