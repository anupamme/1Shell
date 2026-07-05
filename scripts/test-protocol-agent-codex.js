'use strict';

// 真实 codex CLI 冒烟测试：
//   - 一轮对话 + 一次命令执行，事件序列符合映射表；
//   - 进程重建后凭 native_session_id（thread id）thread/resume 继续对话。
//
// 需要本机安装并登录 codex CLI（≥0.141，含 app-server 子命令）。
// 未检测到二进制时跳过（exit 0），不进 npm test 固定链（外部依赖 +
// 网络耗时），按需手动执行：
//   node scripts/test-protocol-agent-codex.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createProtocolAgentCatalog } = require('../src/agents/protocol/agent-catalog');
const { createProtocolAgentService } = require('../src/agents/protocol/protocol-agent.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const catalog = createProtocolAgentCatalog();
const codexSpec = catalog.getAgent('codex');

if (!codexSpec?.binaryPath) {
  console.log('⚠ SKIP: 未检测到 codex CLI，跳过真实冒烟（安装后手动运行本脚本）');
  process.exit(0);
}

const watchdog = setTimeout(() => {
  console.error('✗ test-protocol-agent-codex 超时（240s）');
  process.exit(1);
}, 240 * 1000);
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
  const tmpDir = path.join(os.tmpdir(), `1shell-codex-smoke-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
    const sessionId = 'codex-smoke-session';

    // ── 回合 1：对话 + 命令执行 ────────────────────────────────────
    const emitted = [];
    const service = createProtocolAgentService({ catalog, ideSessionRepository: repo, logger: console });
    const socket = createFakeSocket(emitted, service);

    await service.handleMessage({
      socket,
      sessionId,
      message: '执行 shell 命令 `echo oneshell-smoke` 并告诉我输出。除此之外不要做任何事。',
      agentId: 'codex',
      cwd: tmpDir,
    });

    const legacySeq = emitted.filter((e) => e.event !== 'ide:event').map((e) => e.event);
    console.log(`  事件序列: ${legacySeq.join(' → ')}`);

    const errorEvent = emitted.find((e) => e.event === 'ide:error');
    assert.ok(!errorEvent, `不应出错: ${errorEvent?.payload?.error}`);
    assert.ok(legacySeq.includes('ide:tool-start'), '应出现命令执行工具卡');
    assert.ok(legacySeq.includes('ide:tool-end'), '工具调用应闭合');
    assert.ok(legacySeq[legacySeq.length - 1] === 'ide:done', '回合应以 ide:done 结束');

    const toolEnd = emitted.find((e) => e.event === 'ide:tool-end')?.payload;
    assert.ok(String(toolEnd?.result || '').includes('oneshell-smoke'), '命令聚合输出应包含 echo 结果');

    const record = repo.getSession(sessionId);
    assert.ok(record?.nativeSessionId, '应记录 codex thread id');
    assert.strictEqual(record.agentId, 'codex');
    console.log(`✓ 回合 1 通过（thread_id=${record.nativeSessionId.slice(0, 8)}…, 命令执行闭合）`);

    // ── 回合 2：杀进程后 thread/resume 恢复 ────────────────────────
    service.shutdown();
    const emitted2 = [];
    const service2 = createProtocolAgentService({ catalog, ideSessionRepository: repo, logger: console });
    const socket2 = createFakeSocket(emitted2, service2);

    await service2.handleMessage({
      socket: socket2,
      sessionId,
      message: '我上一条消息让你 echo 的字符串是什么？只回答字符串本身，不要执行任何命令。',
    });

    const finalText = emitted2
      .filter((e) => e.event === 'ide:text' || e.event === 'ide:text-delta')
      .map((e) => e.payload.text || e.payload.delta || '')
      .join('');
    assert.ok(finalText.includes('oneshell-smoke'), `thread/resume 后应记得上下文，实际回复: ${finalText.slice(0, 200)}`);
    console.log('✓ 回合 2 通过（thread/resume 恢复原生会话，上下文保留）');

    service2.shutdown();
    console.log('✓ protocol-agent codex 冒烟全部通过');
    process.exit(0);
  } finally {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 19) {
          console.warn(`  (清理临时目录失败，忽略: ${err.message})`);
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
})().catch((err) => {
  console.error(`✗ test-protocol-agent-codex 失败: ${err.stack || err.message}`);
  process.exit(1);
});
