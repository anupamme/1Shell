'use strict';

// 真实 CLI 冒烟：会话内 1Shell AI ↔ 协议 agent 无缝切换。
//   1. 预置一段 1Shell AI 历史（含暗号）→ claude-code 领养：应凭补课提示
//      读会话日志答出暗号；
//   2. releaseSessionToOneshell：记录归属翻转、绑定保留；
//   3. 模拟 oneshell 继续对话（第二个暗号）→ codex 领养：应答出新暗号。
//
// 需要本机安装并登录 claude / codex CLI；未检测到时跳过对应环节。
// 外部依赖 + 网络耗时，不进 npm test 固定链，按需手动执行：
//   node scripts/test-agent-switch-real.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createProtocolAgentCatalog } = require('../src/agents/protocol/agent-catalog');
const { createProtocolAgentService } = require('../src/agents/protocol/protocol-agent.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const catalog = createProtocolAgentCatalog();
const claudeSpec = catalog.getAgent('claude-code');
const codexSpec = catalog.getAgent('codex');

if (!claudeSpec?.binaryPath && !codexSpec?.binaryPath) {
  console.log('⚠ SKIP: 未检测到 claude / codex CLI，跳过真实切换冒烟');
  process.exit(0);
}

const watchdog = setTimeout(() => {
  console.error('✗ test-agent-switch-real 超时（300s）');
  process.exit(1);
}, 300 * 1000);
watchdog.unref?.();

function createFakeSocket(sink, service) {
  return {
    id: `sock-${crypto.randomBytes(3).toString('hex')}`,
    emit(event, payload) {
      sink.push({ event, payload });
      if (event === 'ide:approve-request' && payload?.requestId) {
        setImmediate(() => service.resolveApproval({ requestId: payload.requestId, action: 'allow' }));
      }
    },
  };
}

function replyText(emitted, from = 0) {
  return emitted.slice(from)
    .filter((e) => e.event === 'ide:text' || e.event === 'ide:text-delta')
    .map((e) => e.payload.text || e.payload.delta || '')
    .join('');
}

(async () => {
  const tmpDir = path.join(os.tmpdir(), `1shell-switch-smoke-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
    const sessionId = 'agent-switch-smoke';

    // ── 预置 1Shell AI 历史（记录归属 oneshell，含暗号）────────────
    repo.upsertSession({
      id: sessionId,
      title: '切换冒烟',
      entry: 'core',
      hostId: 'local',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '记住：我们的暗号是 pineapple-42，后面会考你。' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好的，暗号 pineapple-42 我记住了。' }] },
      ],
      preview: '好的，暗号 pineapple-42 我记住了。',
    });
    assert.strictEqual(repo.getSession(sessionId).agentId, 'oneshell');

    // dataDir 必须传给 service：补课日志写在 <dataDir>/agent-session-logs
    const service = createProtocolAgentService({ catalog, ideSessionRepository: repo, dataDir: tmpDir, logger: console });

    // ── 环节 1：claude 领养 oneshell 会话，凭补课日志答暗号 ────────
    if (claudeSpec?.binaryPath) {
      const emitted = [];
      const socket = createFakeSocket(emitted, service);
      await service.handleMessage({
        socket,
        sessionId,
        message: '按交接提示读完会话记录后回答：我之前定的暗号是什么？只回答暗号本身，不要做别的事。',
        agentId: 'claude-code',
        cwd: tmpDir,
      });
      const err = emitted.find((e) => e.event === 'ide:error');
      assert.ok(!err, `claude 领养不应出错: ${err?.payload?.error}`);
      const text = replyText(emitted);
      assert.ok(text.includes('pineapple-42'), `claude 应读日志答出暗号，实际: ${text.slice(0, 300)}`);
      const record = repo.getSession(sessionId);
      assert.strictEqual(record.agentId, 'claude-code', '领养后归属应翻转');
      assert.ok(record.nativeSessionId, '应记录 claude 原生 session id');
      console.log('✓ 环节 1：claude 领养 oneshell 会话，补课日志生效，暗号答对');

      // ── 环节 2：交还 1Shell AI ───────────────────────────────────
      const released = service.releaseSessionToOneshell(sessionId);
      assert.strictEqual(released.ok, true, `交还应成功: ${released.error || ''}`);
      const flipped = repo.getSession(sessionId);
      assert.strictEqual(flipped.agentId, 'oneshell', '交还后归属应为 oneshell');
      assert.ok(flipped.agentBindings['claude-code']?.nativeSessionId, 'claude 绑定应保留（回切可 --resume）');
      console.log('✓ 环节 2：交还 1Shell AI，归属翻转、绑定保留');
    } else {
      console.log('⚠ 跳过 claude 环节（未检测到 claude CLI）');
    }

    // ── 环节 3：模拟 oneshell 轮次后由 codex 领养 ──────────────────
    if (codexSpec?.binaryPath) {
      const before = repo.getSession(sessionId);
      repo.upsertSession({
        id: sessionId,
        title: before.title,
        entry: 'core',
        hostId: 'local',
        messages: [
          ...before.messages,
          { role: 'user', content: [{ type: 'text', text: '第二个暗号是 mango-77，也记住。' }] },
          { role: 'assistant', content: [{ type: 'text', text: '第二个暗号 mango-77 收到。' }] },
        ],
        preview: '第二个暗号 mango-77 收到。',
      });

      const emitted = [];
      const socket = createFakeSocket(emitted, service);
      await service.handleMessage({
        socket,
        sessionId,
        message: '按交接提示读完会话记录后回答：第二个暗号是什么？只回答暗号本身，不要做别的事。',
        agentId: 'codex',
        cwd: tmpDir,
      });
      const err = emitted.find((e) => e.event === 'ide:error');
      assert.ok(!err, `codex 领养不应出错: ${err?.payload?.error}`);
      const text = replyText(emitted);
      assert.ok(text.includes('mango-77'), `codex 应读日志答出新暗号，实际: ${text.slice(0, 300)}`);
      assert.strictEqual(repo.getSession(sessionId).agentId, 'codex', '领养后归属应翻转为 codex');
      console.log('✓ 环节 3：codex 领养（含 oneshell 新增轮次），补课日志生效');
    } else {
      console.log('⚠ 跳过 codex 环节（未检测到 codex CLI）');
    }

    service.shutdown();
    console.log('✓ agent 切换真实冒烟全部通过');
    process.exit(0);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch((err) => {
  console.error(`✗ test-agent-switch-real 失败: ${err.stack || err.message}`);
  process.exit(1);
});
