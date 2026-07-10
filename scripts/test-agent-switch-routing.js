'use strict';

// 双向 agent 切换（1Shell AI ↔ 协议 agent）：
//   1. socket 路由编排：按消息 agentId 双向分流 + 切换时让出对侧 live 会话
//   2. 模型 API 消息投影：协议时期的历史块回传 1Shell AI 模型前的只读归一化
//   3. ide.service releaseLiveSession 的非 live 快速路径

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { registerIdeSocketHandlers } = require('../src/sockets/registerIdeSocketHandlers');
const { createIdeService, __private } = require('../src/ide/ide.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const { projectMessagesForModelApi } = __private;

// ── 1. socket 路由编排 ──────────────────────────────────────────────

function createHarness({ owns = false, ideRelease = { ok: true }, protocolRelease = { ok: true } } = {}) {
  const calls = [];
  const emitted = [];
  const ideService = {
    releaseLiveSession: (id) => { calls.push(['ide.release', id]); return ideRelease; },
    handleMessage: async (args) => { calls.push(['ide.handle', args.sessionId]); },
    detachSessionsForSocket: () => {},
    cancelSession: () => true,
  };
  const protocolAgentService = {
    ownsSession: () => owns,
    hasSession: () => false,
    releaseSessionToOneshell: (id) => { calls.push(['protocol.release', id]); return protocolRelease; },
    handleMessage: async (args) => { calls.push(['protocol.handle', args.sessionId, args.agentId]); },
    detachSessionsForSocket: () => {},
    resolveApproval: () => false,
    cancelSession: () => true,
    deleteSession: () => {},
    reattachSession: () => ({ ok: true }),
  };
  let onConnection = null;
  const io = { on: (event, cb) => { if (event === 'connection') onConnection = cb; } };
  registerIdeSocketHandlers(io, { ideService, ideTools: null, localMcpService: null, mcpRegistry: null, protocolAgentService });
  const handlers = new Map();
  const socket = {
    id: 'sock-switch-routing',
    on: (event, cb) => handlers.set(event, cb),
    emit: (event, payload) => emitted.push({ event, payload }),
  };
  onConnection(socket);
  const send = async (payload) => {
    const ack = await new Promise((resolve) => handlers.get('ide:message')(payload, resolve));
    await new Promise((resolve) => setImmediate(resolve)); // 分流走 Promise.resolve().then
    return ack;
  };
  return { calls, emitted, send };
}

async function testRouting() {
  // oneshell → 协议：先让 1Shell AI 侧落盘让出，再交协议层（带 agentId）
  let h = createHarness();
  await h.send({ sessionId: 's1', message: 'go', agentId: 'claude-code' });
  assert.deepStrictEqual(h.calls, [['ide.release', 's1'], ['protocol.handle', 's1', 'claude-code']], `oneshell→协议编排不符: ${JSON.stringify(h.calls)}`);

  // 1Shell AI 侧回合运行中：拒绝切换并回 ide:error，不打扰协议层
  h = createHarness({ ideRelease: { ok: false, error: '当前回合仍在运行' } });
  await h.send({ sessionId: 's2', message: 'go', agentId: 'codex' });
  assert.deepStrictEqual(h.calls, [['ide.release', 's2']], '让出失败后不应继续分发');
  assert.ok(h.emitted.some((e) => e.event === 'ide:error'), '让出失败应回 ide:error');

  // 协议 → oneshell：先让协议层交还（杀进程 + 翻转归属），再交 1Shell AI
  h = createHarness({ owns: true });
  await h.send({ sessionId: 's3', message: 'back', agentId: 'oneshell' });
  assert.deepStrictEqual(h.calls, [['protocol.release', 's3'], ['ide.handle', 's3']], `协议→oneshell 编排不符: ${JSON.stringify(h.calls)}`);

  // 协议层交还失败（回合运行中）：回 ide:error，不落到 1Shell AI
  h = createHarness({ owns: true, protocolRelease: { ok: false, error: '上一轮尚未结束' } });
  await h.send({ sessionId: 's4', message: 'back', agentId: 'oneshell' });
  assert.deepStrictEqual(h.calls, [['protocol.release', 's4']], '交还失败后不应继续分发');
  assert.ok(h.emitted.some((e) => e.event === 'ide:error'), '交还失败应回 ide:error');

  // 旧客户端（无 agentId）：按会话归属兜底
  h = createHarness({ owns: true });
  await h.send({ sessionId: 's5', message: 'legacy' });
  assert.deepStrictEqual(h.calls, [['ide.release', 's5'], ['protocol.handle', 's5', '']], '无 agentId 且协议层认领 → 协议层');

  h = createHarness({ owns: false });
  await h.send({ sessionId: 's6', message: 'legacy' });
  assert.deepStrictEqual(h.calls, [['ide.handle', 's6']], '无 agentId 且无人认领 → 1Shell AI，不触发任何 release');

  // 显式 oneshell 且协议层不认领：直接 1Shell AI
  h = createHarness({ owns: false });
  await h.send({ sessionId: 's7', message: 'plain', agentId: 'oneshell' });
  assert.deepStrictEqual(h.calls, [['ide.handle', 's7']], '显式 oneshell 无需交还时直接处理');
}

// ── 2. 模型 API 消息投影 ────────────────────────────────────────────

function testProjection() {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'doing things' },
        // ACP 风格：tool_use.name 是任意标题（带空格/中文），还挂 locations
        { type: 'tool_use', id: 't1', name: '读取文件 config.json', input: { path: '/x' }, locations: [{ path: '/x' }] },
        // claude 风格：名字合法但挂了 locations 附加字段
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' }, locations: [{ path: '/y' }] },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'note' },
        { type: 'tool_result', tool_use_id: 't1', content: 'data', is_error: false },
        { type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: false, extra: 'x' },
      ],
    },
  ];
  const snapshot = JSON.stringify(messages);
  const projected = projectMessagesForModelApi(messages);

  // 源数组不被改动（时间线 / 文件 chips 依赖 locations）
  assert.strictEqual(JSON.stringify(messages), snapshot, '投影必须只读，不得改动 session.messages');

  const asst = projected[1].content;
  assert.strictEqual(asst[1].type, 'text', '非法名字的 tool_use 应转文本');
  assert.ok(asst[1].text.includes('读取文件 config.json'), '转写文本应保留工具标题');
  assert.strictEqual(asst[2].type, 'tool_use', '合法名字的 tool_use 应保留');
  assert.deepStrictEqual(Object.keys(asst[2]).sort(), ['id', 'input', 'name', 'type'], '保留的 tool_use 应剥离附加字段');

  const user = projected[2].content;
  assert.strictEqual(user[0].type, 'tool_result', '存留的 tool_result 应重排到 user 消息最前');
  assert.strictEqual(user[0].tool_use_id, 't2');
  assert.deepStrictEqual(Object.keys(user[0]).sort(), ['content', 'is_error', 'tool_use_id', 'type'], 'tool_result 应剥离附加字段');
  assert.ok(user.some((b) => b.type === 'text' && b.text.includes('data')), '被转写 tool_use 的结果应一并转文本');
  assert.strictEqual(user.filter((b) => b.type === 'tool_result').length, 1, 't1 的 tool_result 不应残留');

  // 纯 1Shell AI 历史：原样返回（引用不变，零开销路径）
  const clean = [
    { role: 'user', content: 'plain string' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'host_exec', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok', is_error: false }] },
  ];
  const cleanProjected = projectMessagesForModelApi(clean);
  assert.strictEqual(cleanProjected[0], clean[0], '纯字符串消息应原引用返回');
  assert.strictEqual(cleanProjected[1], clean[1], '合法 assistant 消息应原引用返回');
  assert.strictEqual(cleanProjected[2], clean[2], '合法 tool_result 消息应原引用返回');

  // 消息级附加字段（附件落盘元数据）不属于模型 API 形状，请求边界剥离
  const withMeta = [
    { role: 'user', content: [{ type: 'text', text: 'see image' }], attachments: [{ path: '/x/shot.png', name: 'shot.png' }] },
  ];
  const metaSnapshot = JSON.stringify(withMeta);
  const metaProjected = projectMessagesForModelApi(withMeta);
  assert.deepStrictEqual(Object.keys(metaProjected[0]).sort(), ['content', 'role'], '消息级 attachments 字段应被剥离');
  assert.strictEqual(JSON.stringify(withMeta), metaSnapshot, '剥离必须只读，不得改动源消息');
}

// ── 3. ide.service releaseLiveSession（非 live 快速路径）────────────

function testIdeRelease(tmpDir) {
  const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
  const ideService = createIdeService({ ideSessionRepository: repo });
  assert.deepStrictEqual(ideService.releaseLiveSession('agent-not-live'), { ok: true, live: false }, '非 live 会话直接放行');
}

(async () => {
  const tmpDir = path.join(os.tmpdir(), `1shell-agent-switch-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    await testRouting();
    console.log('✓ socket 路由双向分流测试通过');
    console.log('  - oneshell→协议 / 协议→oneshell 的 release 编排与失败短路');
    console.log('  - 旧客户端（无 agentId）按归属兜底');

    testProjection();
    console.log('✓ 模型 API 消息投影测试通过');
    console.log('  - 外来 tool_use 转文本 / 附加字段剥离 / tool_result 重排，且只读不动源');

    testIdeRelease(tmpDir);
    console.log('✓ ide.service releaseLiveSession 测试通过');
    process.exit(0);
  } catch (err) {
    console.error(`✗ test-agent-switch-routing 失败: ${err.stack || err.message}`);
    process.exit(1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
