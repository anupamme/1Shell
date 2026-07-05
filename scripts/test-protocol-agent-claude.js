'use strict';

// 真实 claude CLI 冒烟测试（M1 验收项 2/3）：
//   - 一轮对话 + 一次工具调用，事件序列符合映射表；
//   - 进程重建后凭 native_session_id --resume 继续对话。
//
// 需要本机安装并登录 claude CLI。未检测到二进制时跳过（exit 0），
// 因此不进 npm test 固定链（外部依赖 + 网络耗时），按需手动执行：
//   node scripts/test-protocol-agent-claude.js

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

if (!claudeSpec?.binaryPath) {
  console.log('⚠ SKIP: 未检测到 claude CLI，跳过真实冒烟（安装后手动运行本脚本）');
  process.exit(0);
}

const watchdog = setTimeout(() => {
  console.error('✗ test-protocol-agent-claude 超时（180s）');
  process.exit(1);
}, 180 * 1000);
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

(async () => {
  const tmpDir = path.join(os.tmpdir(), `1shell-claude-smoke-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
    const sessionId = 'claude-smoke-session';

    // ── 回合 1：对话 + 工具调用 ────────────────────────────────────
    const emitted = [];
    const service = createProtocolAgentService({ catalog, ideSessionRepository: repo, logger: console });
    const socket = createFakeSocket(emitted, service);

    await service.handleMessage({
      socket,
      sessionId,
      message: '用 Bash 工具执行 `echo oneshell-smoke` 并告诉我输出。除此之外不要做任何事。',
      agentId: 'claude-code',
      cwd: tmpDir,
    });

    const legacySeq = emitted.filter((e) => e.event !== 'ide:event').map((e) => e.event);
    console.log(`  事件序列: ${legacySeq.join(' → ')}`);

    const errorEvent = emitted.find((e) => e.event === 'ide:error');
    assert.ok(!errorEvent, `不应出错: ${errorEvent?.payload?.error}`);
    assert.ok(legacySeq.includes('ide:tool-start'), '应出现工具调用');
    assert.ok(legacySeq.includes('ide:tool-end'), '工具调用应闭合');
    assert.ok(legacySeq[legacySeq.length - 1] === 'ide:done', '回合应以 ide:done 结束');

    const toolEnd = emitted.find((e) => e.event === 'ide:tool-end')?.payload;
    assert.ok(String(toolEnd?.result || '').includes('oneshell-smoke'), '工具结果应包含 echo 输出');

    const record = repo.getSession(sessionId);
    assert.ok(record?.nativeSessionId, '应记录 claude 原生 session_id');
    assert.strictEqual(record.agentId, 'claude-code');
    console.log(`✓ 回合 1 通过（native_session_id=${record.nativeSessionId.slice(0, 8)}…, 工具调用闭合）`);

    // ── 回合 2：杀进程后 --resume 恢复 ─────────────────────────────
    service.shutdown();
    const emitted2 = [];
    const service2 = createProtocolAgentService({ catalog, ideSessionRepository: repo, logger: console });
    const socket2 = createFakeSocket(emitted2, service2);

    await service2.handleMessage({
      socket: socket2,
      sessionId,
      message: '我上一条消息让你 echo 的字符串是什么？只回答字符串本身。',
    });

    const finalText = emitted2
      .filter((e) => e.event === 'ide:text' || e.event === 'ide:text-delta')
      .map((e) => e.payload.text || e.payload.delta || '')
      .join('');
    assert.ok(finalText.includes('oneshell-smoke'), `--resume 后应记得上下文，实际回复: ${finalText.slice(0, 200)}`);
    console.log('✓ 回合 2 通过（--resume 恢复原生会话，上下文保留）');

    service2.shutdown();
    console.log('✓ protocol-agent claude 冒烟全部通过');
    process.exit(0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(`✗ test-protocol-agent-claude 失败: ${err.stack || err.message}`);
  process.exit(1);
});
