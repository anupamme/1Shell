'use strict';

// Codex app-server 协议接入回归测试（全程 mock，无外部依赖）：
//   Part 1  codex-adapter 直连：initialize / thread/start / turn/start 往返，
//           归一化事件序列（thinking/text/tool/done）、审批往返（accept/decline）、
//           未知服务端请求宽容、turn/interrupt 取消、thread/resume 恢复。
//   Part 2  protocol-agent.service 全链路：codex 事件 → ide:* 事件形状
//           （与 1Shell AI / ACP 一致）、审批挂起/应答、会话持久化三元组、
//           服务重启后 thread/resume 恢复。
// 真实 codex CLI 冒烟见 scripts/test-protocol-agent-codex.js（不进 npm test）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCodexAppServerAgent } = require('../src/agents/protocol/codex-adapter');
const { createProtocolAgentService } = require('../src/agents/protocol/protocol-agent.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');
const { extractToolLocations } = require('../src/agents/protocol/tool-locations');

const MOCK_AGENT = path.join(__dirname, 'fixtures', 'mock-codex-app-server.js');
const silentLogger = { info() {}, warn() {}, error() {} };

const watchdog = setTimeout(() => {
  console.error('✗ test-codex-adapter 超时');
  process.exit(1);
}, 60 * 1000);
watchdog.unref?.();

// codex fileChange / claude 文件工具入参 → locations 提取（纯函数，无需 mock 流程）
function testToolLocations() {
  assert.deepStrictEqual(
    extractToolLocations({ changes: [{ path: '/tmp/a.js', kind: 'edit' }, { path: '/tmp/a.js' }, { file: 'b.md' }] }),
    [{ path: '/tmp/a.js' }, { path: 'b.md' }],
    'codex fileChange.changes 应提取并去重',
  );
  assert.deepStrictEqual(
    extractToolLocations({ file_path: 'C:\\proj\\x.ts' }),
    [{ path: 'C:\\proj\\x.ts' }],
    'claude 风格 file_path 入参应提取（Windows 路径）',
  );
  assert.deepStrictEqual(extractToolLocations({ path: '/tmp' }), [], 'path 键是目录语义，不收');
  assert.deepStrictEqual(extractToolLocations(null), [], '空入参应返回空数组');
}

async function testAdapterDirect() {
  const events = [];
  let approvalSeen = null;
  let approvalBehavior = 'allow';

  const agent = createCodexAppServerAgent({
    binary: process.execPath,
    args: [MOCK_AGENT],
    cwd: __dirname,
    logger: silentLogger,
    onPermissionRequest: async (payload) => {
      approvalSeen = payload;
      return { behavior: approvalBehavior };
    },
    onEvent: (event) => events.push(event),
  });

  try {
    // ── 第一轮：文本 + 命令执行（审批 allow）───────────────────────
    const first = await agent.prompt({ text: 'hello codex' });
    assert.strictEqual(first.stopReason, 'completed');
    assert.strictEqual(first.isError, false);
    assert.strictEqual(agent.nativeSessionId, 'th-mock-1');

    const types = events.map((e) => e.type);
    assert.deepStrictEqual(types, [
      'init',
      'thinking_delta',
      'text_delta', 'text_delta', 'text',
      'tool_start', 'tool_update', 'tool_update',
      'done',
    ], `事件序列不符: ${types.join(',')}`);

    assert.strictEqual(events.find((e) => e.type === 'init').nativeSessionId, 'th-mock-1');
    assert.strictEqual(events.find((e) => e.type === 'text').text, 'Hello codex.');

    const toolStart = events.find((e) => e.type === 'tool_start');
    assert.strictEqual(toolStart.toolCallId, 'cmd-1');
    assert.strictEqual(toolStart.title, 'echo hi');
    assert.strictEqual(toolStart.kind, 'execute');
    assert.strictEqual(toolStart.input.command, 'echo hi');
    assert.deepStrictEqual(toolStart.locations, [], '命令执行不涉及文件，locations 应为空数组');

    const updates = events.filter((e) => e.type === 'tool_update');
    assert.strictEqual(updates[0].status, 'in_progress', '命令输出流应为 in_progress 更新');
    assert.strictEqual(updates[0].content, 'hi\n');
    assert.strictEqual(updates[1].status, 'completed');
    assert.ok(updates[1].content.includes('hi'), '完成态应带聚合输出');
    assert.ok(updates[1].content.includes('exit code: 0'), '完成态应带退出码');

    assert.ok(approvalSeen, '应触发审批回调');
    assert.strictEqual(approvalSeen.input.command, 'echo hi');

    const done = events.find((e) => e.type === 'done');
    assert.strictEqual(done.stopReason, 'success');
    assert.strictEqual(done.usage.totalTokens, 42, 'tokenUsage 应透传到 done 事件');

    // ── 第二轮：审批 deny → 工具失败 ──────────────────────────────
    events.length = 0;
    approvalBehavior = 'deny';
    await agent.prompt({ text: 'try again' });
    const denyUpdate = events.filter((e) => e.type === 'tool_update').pop();
    assert.strictEqual(denyUpdate.status, 'failed', '被拒绝的命令应标记 failed');

    // ── 第三轮：turn/interrupt 取消 ───────────────────────────────
    events.length = 0;
    const cancelPromise = agent.prompt({ text: 'cancelme' });
    await new Promise((r) => setTimeout(r, 200));
    agent.cancel();
    const cancelled = await cancelPromise;
    assert.strictEqual(cancelled.stopReason, 'interrupted');
    const cancelDone = events.find((e) => e.type === 'done');
    assert.strictEqual(cancelDone.stopReason, 'cancelled', '中断回合的 done 应标记 cancelled');

    // ── 第四轮：默认策略传参（mindfs 同款完全放行）─────────────────
    events.length = 0;
    approvalBehavior = 'allow';
    await agent.prompt({ text: 'showparams' });
    const dump = JSON.parse(events.find((e) => e.type === 'text').text);
    assert.strictEqual(dump.thread.approvalPolicy, 'never', 'thread/start 默认应带 approvalPolicy=never');
    assert.strictEqual(dump.thread.sandbox, 'danger-full-access', 'thread/start 默认应带全量沙箱');
    assert.strictEqual(dump.turn.approvalPolicy, 'never');
    assert.strictEqual(dump.turn.sandboxPolicy.type, 'dangerFullAccess');
    assert.strictEqual(dump.turn.effort, null, '未设置思考程度时不应传 effort');
    assert.strictEqual(dump.turn.serviceTier, null, '未开 fast 档时不应传 serviceTier');

    // ── 第五轮：MCP 权限申请审批（item/permissions/requestApproval）──
    events.length = 0;
    await agent.prompt({ text: 'mcpperm' });
    let mcpEnd = events.filter((e) => e.type === 'tool_update').pop();
    assert.strictEqual(mcpEnd.status, 'completed');
    assert.strictEqual(mcpEnd.content, 'granted', 'permissions 审批 allow 应原样回授申请的 profile');
    assert.ok(approvalSeen.input.permissions, 'permissions 审批载荷应带申请的权限');

    events.length = 0;
    approvalBehavior = 'deny';
    await agent.prompt({ text: 'mcpperm' });
    mcpEnd = events.filter((e) => e.type === 'tool_update').pop();
    assert.strictEqual(mcpEnd.status, 'failed', '被拒绝的 MCP 权限申请应标记 failed');
    assert.strictEqual(mcpEnd.content, 'denied');
  } finally {
    agent.kill();
  }

  // ── 会话设置传参：ask 审批 + effort + fast 档 ─────────────────────
  const cfgEvents = [];
  const cfgAgent = createCodexAppServerAgent({
    binary: process.execPath,
    args: [MOCK_AGENT],
    cwd: __dirname,
    logger: silentLogger,
    sessionSettings: () => ({ approvalMode: 'ask', effort: 'high', fast: true }),
    onPermissionRequest: async () => ({ behavior: 'allow' }),
    onEvent: (event) => cfgEvents.push(event),
  });
  try {
    await cfgAgent.prompt({ text: 'showparams' });
    const dump = JSON.parse(cfgEvents.find((e) => e.type === 'text').text);
    assert.strictEqual(dump.thread.approvalPolicy, 'on-request', 'ask 模式 thread/start 应带 on-request');
    assert.strictEqual(dump.thread.sandbox, 'workspace-write');
    assert.strictEqual(dump.turn.approvalPolicy, 'on-request');
    assert.strictEqual(dump.turn.sandboxPolicy.type, 'workspaceWrite');
    assert.strictEqual(dump.turn.effort, 'high', '思考程度应逐回合下发');
    assert.strictEqual(dump.turn.serviceTier, 'fast', 'fast 档应映射为 serviceTier=fast');
  } finally {
    cfgAgent.kill();
  }

  // ── thread/resume：新进程凭 threadId 恢复 ────────────────────────
  const resumeEvents = [];
  const resumedAgent = createCodexAppServerAgent({
    binary: process.execPath,
    args: [MOCK_AGENT],
    cwd: __dirname,
    resumeThreadId: 'th-mock-1',
    logger: silentLogger,
    onPermissionRequest: async () => ({ behavior: 'allow' }),
    onEvent: (event) => resumeEvents.push(event),
  });
  try {
    await resumedAgent.prompt({ text: 'continue' });
    assert.strictEqual(resumedAgent.nativeSessionId, 'th-mock-1', 'resume 后 thread id 应保持');
    const text = resumeEvents.find((e) => e.type === 'text');
    assert.ok(text.text.startsWith('[resumed]'), `应走 thread/resume 恢复，实际: ${text.text}`);
  } finally {
    resumedAgent.kill();
  }
}

function createFakeSocket(sink, id = 'sock-codex-test') {
  return {
    id,
    emit(event, payload) {
      sink.push({ event, payload });
    },
  };
}

function createMockCatalog() {
  const base = {
    name: 'Mock Codex',
    protocol: 'codex-app-server',
    binary: 'node',
    binaryPath: process.execPath,
    args: [MOCK_AGENT],
    supportsResume: true,
  };
  // 两个同协议 agent：mock-codex-b 用于会话内切换 agent 的用例
  const specs = {
    'mock-codex': { ...base, id: 'mock-codex' },
    'mock-codex-b': { ...base, id: 'mock-codex-b', name: 'Mock Codex B' },
  };
  return {
    getAgent: (agentId) => (specs[agentId] ? { ...specs[agentId] } : null),
    listAgents: () => Object.values(specs).map((spec) => ({ ...spec, installed: true })),
  };
}

async function testProtocolAgentService() {
  const tmpDir = path.join(os.tmpdir(), `1shell-codex-adapter-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
    const catalog = createMockCatalog();
    const sessionId = 'agent-codex-test';

    // ── 首轮：事件形状 + 审批 + 持久化（ask 模式保留审批卡链路）─────
    const emitted = [];
    const service = createProtocolAgentService({ catalog, ideSessionRepository: repo, dataDir: tmpDir, logger: silentLogger });
    const socket = createFakeSocket(emitted);
    const origPush = emitted.push.bind(emitted);
    emitted.push = (entry) => {
      const r = origPush(entry);
      if (entry.event === 'ide:approve-request') {
        setImmediate(() => service.resolveApproval({ requestId: entry.payload.requestId, action: 'allow' }));
      }
      return r;
    };

    await service.handleMessage({ socket, sessionId, message: 'hi there', agentId: 'mock-codex', cwd: tmpDir, settings: { approvalMode: 'ask' } });

    const legacy = emitted.filter((e) => e.event !== 'ide:event');
    const legacySeq = legacy.map((e) => e.event);
    assert.deepStrictEqual(legacySeq, [
      'ide:thinking',        // 回合开始
      'ide:thinking',        // reasoning delta
      'ide:text-delta',
      'ide:text-delta',
      'ide:text',            // agentMessage 定稿
      'ide:tool-start',
      'ide:approve-request',
      'ide:tool-delta',      // 命令输出流
      'ide:tool-end',
      'ide:done',
    ], `legacy 事件序列不符: ${legacySeq.join(',')}`);

    const unifiedTypes = emitted.filter((e) => e.event === 'ide:event').map((e) => e.payload.type);
    assert.deepStrictEqual(unifiedTypes, [
      'thinking', 'thinking', 'text_delta', 'text_delta', 'text',
      'tool_start', 'approval_request', 'tool_delta', 'tool_end', 'done',
    ], `统一事件序列不符: ${unifiedTypes.join(',')}`);

    const approve = legacy.find((e) => e.event === 'ide:approve-request').payload;
    assert.ok(approve.requestId, '审批请求应带 requestId');
    assert.strictEqual(approve.toolName, '命令执行');
    assert.strictEqual(approve.input.command, 'echo hi', '审批载荷应带命令');

    const toolEnd = legacy.find((e) => e.event === 'ide:tool-end').payload;
    assert.strictEqual(toolEnd.is_error, false);
    assert.ok(String(toolEnd.result).includes('hi'), '命令聚合输出应回流');

    // 持久化：绑定三元组 + 消息结构 + 设置 + 会话日志
    const record = repo.getSession(sessionId);
    assert.ok(record, '会话应已持久化');
    assert.strictEqual(record.agentId, 'mock-codex');
    assert.strictEqual(record.cwd, tmpDir);
    assert.strictEqual(record.nativeSessionId, 'th-mock-1');
    assert.strictEqual(record.messages.length, 3, 'user + assistant(text/tool_use) + tool_result');
    assert.strictEqual(record.messages[1].content.find((b) => b.type === 'tool_use').id, 'cmd-1');
    assert.strictEqual(record.messages[2].content[0].type, 'tool_result');
    assert.strictEqual(record.agentSettings.approvalMode, 'ask', '会话设置应随消息持久化');

    const logPath = path.join(tmpDir, 'agent-session-logs', `${sessionId}.log`);
    assert.ok(fs.existsSync(logPath), '会话日志应已写盘');
    assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 3, '日志应每条消息一行');

    // ── 第二轮：目标 VPS 注入（targets 变化时注入一次）─────────────
    const beforeTargets = emitted.length;
    await service.handleMessage({
      socket,
      sessionId,
      message: 'do vps stuff',
      agentId: 'mock-codex',
      workspaceHostIds: ['h1'],
      hosts: [{ id: 'h1', name: 'Alpha', host: '1.2.3.4' }],
    });
    const targetsText = emitted.slice(beforeTargets)
      .filter((e) => e.event === 'ide:text')
      .map((e) => e.payload.text)
      .join('');
    assert.ok(targetsText.includes('[targets-seen]'), `目标 VPS 提示应注入 prompt，实际: ${targetsText}`);
    const recordTargets = repo.getSession(sessionId);
    assert.deepStrictEqual(recordTargets.workspaceHostIds, ['h1'], '目标 VPS 应持久化');
    assert.strictEqual(recordTargets.messages[3].content[0].text, 'do vps stuff', '注入提示不应进入会话展示记录');

    // 同一目标再次发消息：不重复注入
    const beforeRepeat = emitted.length;
    await service.handleMessage({
      socket,
      sessionId,
      message: 'again',
      agentId: 'mock-codex',
      workspaceHostIds: ['h1'],
      hosts: [{ id: 'h1', name: 'Alpha', host: '1.2.3.4' }],
    });
    const repeatText = emitted.slice(beforeRepeat)
      .filter((e) => e.event === 'ide:text')
      .map((e) => e.payload.text)
      .join('');
    assert.ok(!repeatText.includes('[targets-seen]'), '目标未变化时不应重复注入');

    // ── 第三轮：会话内切换 agent（mindfs 模式）──────────────────────
    const beforeSwitch = emitted.length;
    await service.handleMessage({ socket, sessionId, message: 'switch please', agentId: 'mock-codex-b', cwd: tmpDir });
    const switchText = emitted.slice(beforeSwitch)
      .filter((e) => e.event === 'ide:text')
      .map((e) => e.payload.text)
      .join('');
    assert.ok(switchText.includes('[handoff-seen]'), `切换 agent 应注入会话交接提示，实际: ${switchText}`);
    assert.ok(switchText.includes('[targets-seen]'), '切换 agent 后目标提示应重新注入');

    const recordSwitch = repo.getSession(sessionId);
    assert.strictEqual(recordSwitch.agentId, 'mock-codex-b', '会话应换绑到新 agent');
    assert.strictEqual(recordSwitch.agentBindings['mock-codex'].nativeSessionId, 'th-mock-1', '旧 agent 原生会话应登记在绑定表');
    assert.strictEqual(recordSwitch.agentBindings['mock-codex'].ctxSeq, 9, '旧 agent 上下文水位应保留');
    assert.strictEqual(recordSwitch.agentBindings['mock-codex-b'].ctxSeq, 12, '新 agent 收口后水位应推进');
    assert.strictEqual(recordSwitch.messages[9].content[0].text, 'switch please', '交接提示不应进入会话展示记录');

    service.shutdown();

    // ── 重启恢复：新 service 实例按持久化记录 thread/resume ────────
    const emitted2 = [];
    const service2 = createProtocolAgentService({ catalog, ideSessionRepository: repo, dataDir: tmpDir, logger: silentLogger });
    const socket2 = createFakeSocket(emitted2, 'sock-codex-test-2');
    const origPush2 = emitted2.push.bind(emitted2);
    emitted2.push = (entry) => {
      const r = origPush2(entry);
      if (entry.event === 'ide:approve-request') {
        setImmediate(() => service2.resolveApproval({ requestId: entry.payload.requestId, action: 'allow' }));
      }
      return r;
    };

    assert.ok(service2.ownsSession(sessionId), '重启后应凭持久化记录认领会话');
    await service2.handleMessage({ socket: socket2, sessionId, message: 'continue' });

    const resumedText = emitted2
      .filter((e) => e.event === 'ide:text')
      .map((e) => e.payload.text)
      .join('');
    assert.ok(resumedText.includes('[resumed]'), `重启后应走 thread/resume 恢复，实际: ${resumedText}`);

    const record2 = repo.getSession(sessionId);
    assert.strictEqual(record2.messages.length, 15, '第五轮消息应追加到历史');
    assert.strictEqual(record2.agentId, 'mock-codex-b', '重启后仍应是切换后的 agent');
    assert.strictEqual(record2.nativeSessionId, 'th-mock-1', '原生会话绑定应保持');

    service2.shutdown();
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
}

(async () => {
  testToolLocations();
  console.log('✓ tool-locations 提取测试通过');
  console.log('  - codex fileChange.changes / claude file_path / 目录键排除');

  await testAdapterDirect();
  console.log('✓ codex-adapter 直连测试通过');
  console.log('  - initialize / thread/start / turn/start 往返与事件归一化');
  console.log('  - 命令执行审批 accept/decline、输出流、退出码');
  console.log('  - 默认完全放行策略（approval never + 全量沙箱）与 ask 模式传参');
  console.log('  - effort / serviceTier(fast) 逐回合下发');
  console.log('  - MCP 权限申请（item/permissions/requestApproval）allow/deny 往返');
  console.log('  - 未知服务端请求宽容、turn/interrupt 取消、thread/resume 恢复');

  await testProtocolAgentService();
  console.log('✓ protocol-agent.service codex 全链路测试通过');
  console.log('  - ide:* 事件形状与 1Shell AI / ACP 一致');
  console.log('  - 审批挂起/应答与持久化（含 agentSettings / workspaceHostIds）');
  console.log('  - 目标 VPS 提示注入（变化时一次，不进展示记录）');
  console.log('  - 会话内切换 agent：绑定表 / 交接补课提示 / 会话日志');
  console.log('  - 服务重启后 thread/resume 恢复并续写历史');
  process.exit(0);
})().catch((err) => {
  console.error(`✗ test-codex-adapter 失败: ${err.stack || err.message}`);
  process.exit(1);
});
