'use strict';

// ACP 协议接入回归测试（全程 mock agent，无外部依赖）：
//   Part 1  acp-client 直连：initialize / session/new / prompt 往返，
//           归一化事件序列、权限请求回调、fs 委托、session/cancel。
//   Part 2  protocol-agent.service 全链路：mock agent 事件 → ide:* 事件形状
//           （与 1Shell AI 一致）、审批挂起/应答、会话持久化三元组、
//           服务重启后 session/load 恢复。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createAcpClient } = require('../src/agents/protocol/acp-client');
const { createProtocolAgentService } = require('../src/agents/protocol/protocol-agent.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const MOCK_AGENT = path.join(__dirname, 'fixtures', 'mock-acp-agent.js');
const silentLogger = { info() {}, warn() {}, error() {} };

const watchdog = setTimeout(() => {
  console.error('✗ test-acp-client 超时');
  process.exit(1);
}, 60 * 1000);
watchdog.unref?.();

async function testAcpClientDirect() {
  const events = [];
  let permissionSeen = null;
  let fsDelegateCalled = false;

  const client = createAcpClient({
    command: process.execPath,
    args: [MOCK_AGENT],
    cwd: __dirname,
    logger: silentLogger,
    onPermissionRequest: async ({ toolCall, options }) => {
      permissionSeen = { toolCall, options };
      return { optionId: 'opt-allow' };
    },
    onEvent: (event) => events.push(event),
    fsDelegate: {
      readTextFile: async () => {
        fsDelegateCalled = true;
        return 'DELEGATED';
      },
    },
  });

  try {
    const init = await client.initialize();
    assert.strictEqual(init.protocolVersion, 1, 'initialize 应返回协议版本');
    assert.strictEqual(client.capabilities.loadSession, true, '应上报 loadSession 能力');

    const { acpSessionId } = await client.newSession({ cwd: __dirname });
    assert.strictEqual(acpSessionId, 'acp-mock-session');

    const { stopReason } = await client.prompt({ acpSessionId, text: 'hello' });
    assert.strictEqual(stopReason, 'end_turn');

    const types = events.map((e) => e.type);
    const expected = ['thinking_delta', 'plan', 'text_delta', 'text_delta', 'tool_start', 'tool_update', 'tool_update', 'text_delta'];
    assert.deepStrictEqual(types, expected, `事件序列不符: ${types.join(',')}`);

    const toolStart = events.find((e) => e.type === 'tool_start');
    assert.strictEqual(toolStart.toolCallId, 'tc-1');
    assert.strictEqual(toolStart.title, 'read_file');
    assert.deepStrictEqual(toolStart.locations, [{ path: '/tmp/demo.txt' }], 'tool_call.locations 应透传');

    const finalUpdate = events.filter((e) => e.type === 'tool_update').pop();
    assert.strictEqual(finalUpdate.status, 'completed');
    assert.ok(finalUpdate.content.includes('content=DELEGATED'), 'fs 委托内容应回流到工具结果');

    assert.ok(permissionSeen, '应触发权限请求回调');
    assert.strictEqual(permissionSeen.options.length, 2);
    assert.ok(fsDelegateCalled, '应调用 fs delegate');

    // session/cancel 往返
    const cancelPromise = client.prompt({ acpSessionId, text: 'cancelme' });
    await new Promise((r) => setTimeout(r, 200));
    client.cancel(acpSessionId);
    const cancelledResult = await cancelPromise;
    assert.strictEqual(cancelledResult.stopReason, 'cancelled', 'cancel 后应返回 cancelled');
  } finally {
    client.kill();
  }
}

function createFakeSocket(sink, id = 'sock-test') {
  return {
    id,
    emit(event, payload) {
      sink.push({ event, payload });
    },
  };
}

function createMockCatalog(cwd) {
  const spec = {
    id: 'mock-acp',
    name: 'Mock ACP',
    protocol: 'acp',
    binary: 'node',
    binaryPath: process.execPath,
    args: [MOCK_AGENT],
    supportsResume: true,
  };
  return {
    getAgent: (agentId) => (agentId === 'mock-acp' ? { ...spec, cwd } : null),
    listAgents: () => [{ ...spec, installed: true }],
  };
}

async function testProtocolAgentService() {
  const tmpDir = path.join(os.tmpdir(), `1shell-protocol-agent-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
    const catalog = createMockCatalog(tmpDir);
    const sessionId = 'agent-protocol-test';

    // ── 首轮：事件形状 + 审批 + 持久化 ─────────────────────────────
    const emitted = [];
    const service = createProtocolAgentService({ catalog, ideSessionRepository: repo, logger: silentLogger });
    const socket = createFakeSocket(emitted);
    // 前端行为替身：收到审批请求后应答 allow
    const origPush = emitted.push.bind(emitted);
    emitted.push = (entry) => {
      const r = origPush(entry);
      if (entry.event === 'ide:approve-request') {
        setImmediate(() => service.resolveApproval({ requestId: entry.payload.requestId, action: 'allow' }));
      }
      return r;
    };

    assert.strictEqual(service.ownsSession(sessionId), false, '未创建前不应认领会话');
    await service.handleMessage({ socket, sessionId, message: 'hi there', agentId: 'mock-acp', cwd: tmpDir });

    const legacy = emitted.filter((e) => e.event !== 'ide:event');
    const legacySeq = legacy.map((e) => e.event);
    assert.deepStrictEqual(legacySeq, [
      'ide:thinking',        // 回合开始
      'ide:thinking',        // agent_thought_chunk
      'ide:plan',
      'ide:text-delta',
      'ide:text-delta',
      'ide:text',            // 工具卡片前文本段定稿
      'ide:tool-start',
      'ide:approve-request',
      'ide:tool-delta',
      'ide:tool-end',
      'ide:text-delta',
      'ide:text',            // 回合末文本段定稿
      'ide:done',
    ], `legacy 事件序列不符: ${legacySeq.join(',')}`);

    // 统一事件流（ide:event）与 legacy 一一对应
    const unifiedTypes = emitted.filter((e) => e.event === 'ide:event').map((e) => e.payload.type);
    assert.deepStrictEqual(unifiedTypes, [
      'thinking', 'thinking', 'plan', 'text_delta', 'text_delta', 'text',
      'tool_start', 'approval_request', 'tool_delta', 'tool_end',
      'text_delta', 'text', 'done',
    ], `统一事件序列不符: ${unifiedTypes.join(',')}`);

    const approve = legacy.find((e) => e.event === 'ide:approve-request').payload;
    assert.ok(approve.requestId, '审批请求应带 requestId');
    assert.strictEqual(approve.toolName, 'read_file');
    assert.strictEqual(approve.approval.options.length, 2, 'ACP 审批选项应透出');

    const toolStartEvt = legacy.find((e) => e.event === 'ide:tool-start').payload;
    assert.deepStrictEqual(toolStartEvt.locations, [{ path: '/tmp/demo.txt' }], 'tool-start 事件应带 locations');

    const toolEnd = legacy.find((e) => e.event === 'ide:tool-end').payload;
    assert.strictEqual(toolEnd.is_error, false);
    assert.ok(String(toolEnd.result).includes('content='), '工具结果应回流');
    assert.deepStrictEqual(toolEnd.locations, [{ path: '/tmp/demo.txt' }], 'tool-end 事件应带 locations');

    const textFinal = legacy.filter((e) => e.event === 'ide:text').map((e) => e.payload.text);
    assert.deepStrictEqual(textFinal, ['Hello world.', ' done.']);

    // 持久化：绑定三元组 + 消息结构（可被 projectMessagesToTimeline 投影）
    const record = repo.getSession(sessionId);
    assert.ok(record, '会话应已持久化');
    assert.strictEqual(record.agentId, 'mock-acp');
    assert.strictEqual(record.cwd, tmpDir);
    assert.strictEqual(record.nativeSessionId, 'acp-mock-session');
    assert.strictEqual(record.messages.length, 4, 'user + assistant(tool_use) + tool_result + assistant');
    const toolUseBlock = record.messages[1].content.find((b) => b.type === 'tool_use');
    assert.strictEqual(toolUseBlock.id, 'tc-1');
    assert.deepStrictEqual(toolUseBlock.locations, [{ path: '/tmp/demo.txt' }], 'tool_use 块应带 locations 供时间线投影');
    assert.strictEqual(record.messages[2].content[0].type, 'tool_result');
    // 文件↔会话关联：完成的 tool 触碰的文件收割进 files
    assert.deepStrictEqual(record.files, [{ path: '/tmp/demo.txt' }], '完成 tool 的 locations 应收割进会话 files');

    assert.ok(service.ownsSession(sessionId), 'live 会话应被认领');
    service.shutdown();

    // ── 重启恢复：新 service 实例按持久化记录 session/load ─────────
    const emitted2 = [];
    const service2 = createProtocolAgentService({ catalog, ideSessionRepository: repo, logger: silentLogger });
    const socket2 = createFakeSocket(emitted2, 'sock-test-2');
    const origPush2 = emitted2.push.bind(emitted2);
    emitted2.push = (entry) => {
      const r = origPush2(entry);
      if (entry.event === 'ide:approve-request') {
        setImmediate(() => service2.resolveApproval({ requestId: entry.payload.requestId, action: 'allow' }));
      }
      return r;
    };

    assert.ok(service2.ownsSession(sessionId), '重启后应凭持久化记录认领会话');
    // 不带 agentId/cwd：应从记录恢复
    await service2.handleMessage({ socket: socket2, sessionId, message: 'continue' });

    const resumedText = emitted2
      .filter((e) => e.event === 'ide:text')
      .map((e) => e.payload.text)
      .join('');
    assert.ok(resumedText.includes('[resumed]'), `重启后应走 session/load 恢复，实际: ${resumedText}`);

    const record2 = repo.getSession(sessionId);
    assert.strictEqual(record2.messages.length, 8, '第二轮消息应追加到历史');
    assert.strictEqual(record2.nativeSessionId, 'acp-mock-session', '原生会话绑定应保持');
    assert.deepStrictEqual(record2.files, [{ path: '/tmp/demo.txt' }], '重启续写后 files 应去重保持');

    service2.shutdown();
  } finally {
    // Windows 下 agent 子进程（cwd 在 tmpDir 内）退出有延迟，且 kill() 的
    // SIGKILL 兜底定时器需要事件循环运转，故用异步间隔重试删除
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
}

(async () => {
  await testAcpClientDirect();
  console.log('✓ acp-client 直连测试通过');
  console.log('  - initialize / session/new / prompt 往返');
  console.log('  - 全事件类型归一化序列正确');
  console.log('  - 权限请求 / fs 委托 / cancel 往返');

  await testProtocolAgentService();
  console.log('✓ protocol-agent.service 全链路测试通过');
  console.log('  - ide:* 事件形状与 1Shell AI 一致（legacy + 统一流）');
  console.log('  - 审批挂起/应答与 ACP 选项映射');
  console.log('  - 会话持久化 (agent_id, cwd, native_session_id) 三元组');
  console.log('  - tool 事件 locations 透出 + 触碰文件收割进 files');
  console.log('  - 服务重启后 session/load 恢复并续写历史');
  process.exit(0);
})().catch((err) => {
  console.error(`✗ test-acp-client 失败: ${err.stack || err.message}`);
  process.exit(1);
});
