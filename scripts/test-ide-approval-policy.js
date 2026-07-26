'use strict';

// IDE 审批策略与运行时闸门（原 test-task-authoring-capability 的通用部分；
// AI 任务板块 4.7.5 退役后，任务专属断言删除，这些通用不变量保留）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../src/config/env');
const { createAgentRuntime } = require('../src/agent-runtime/runtime');
const { createIdeAgentPolicy } = require('../src/ide/ide.agent-kernel');

const corePolicy = createIdeAgentPolicy({ tools: [], entry: 'core' });
assert.deepStrictEqual(
  corePolicy.capabilities,
  ['read_only', 'exec_command', 'agent_control'],
  'core policy must expose exactly the core capability set'
);
assert.strictEqual(corePolicy.approvalMode, 'manual', 'core policy defaults to manual approval');
assert.strictEqual(corePolicy.approvalPolicy, 'agent_side_effects', 'manual mode requests side-effect approvals');

const delegatedPolicy = createIdeAgentPolicy({ tools: [], entry: 'core', approvalMode: 'delegated' });
assert.strictEqual(delegatedPolicy.approvalPolicy, 'none', 'delegated IDE mode must not request interactive side-effect approvals');

const fullAccessPolicy = createIdeAgentPolicy({ tools: [], entry: 'core', approvalMode: 'full_access' });
assert.strictEqual(fullAccessPolicy.approvalPolicy, 'none', 'full access IDE mode must not request interactive side-effect approvals');

const ideServiceSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ide', 'ide.service.js'), 'utf8');
const useIdeChatSource = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'composables', 'useIdeChat.ts'), 'utf8');
assert.ok(ideServiceSource.includes('const effectiveEntry = normalizePromptEntry(entry, context, message)'), 'IDE message handling must resolve an effective entry before creating the session');
assert.ok(useIdeChatSource.includes('buildOutgoingMessagePayload'), 'IDE frontend must snapshot context before socket connection latency can reset state');
assert.ok(useIdeChatSource.includes('const payload = buildOutgoingMessagePayload()'), 'IDE sendMessage must capture outgoing payload at send time');
assert.ok(ideServiceSource.includes("cancelSession(sessionId, 'superseded by new user message')"), 'new IDE messages must cancel any still-running previous run before starting a replacement');
assert.ok(ideServiceSource.includes('emitCancelledOnce(session, sessionId, session.socket, runId)'), 'cancelSession must emit cancellation with the cancelled runId');
assert.ok(ideServiceSource.includes('const safeAuditMessage = redactPotentialSecrets'), 'IDE user message audit entries must be redacted before logging');
assert.ok(!ideServiceSource.includes("auditService?.log?.({ action: 'ide_message', sessionId, message"), 'IDE user message audit must not log raw message text');

function makeStore() {
  const runs = new Map();
  return {
    saveRun(state) {
      runs.set(state.runId, state);
      return state;
    },
    getRun(runId) {
      return runs.get(runId) || null;
    },
    listRuns() {
      return [...runs.values()];
    },
  };
}

function makeRuntime(guardVerdict) {
  return createAgentRuntime({
    harness: {
      guard: { check: () => guardVerdict },
      buildContext: (_source, overrides = {}) => ({
        source: 'ide-ai',
        hostId: 'local',
        capabilities: ['exec_command'],
        ...overrides,
      }),
      dispatch: async () => ({ content: 'harness-dispatch', is_error: false }),
    },
    store: makeStore(),
  });
}

async function runRuntimeApprovalProbe(mode, guardVerdict) {
  const runtime = makeRuntime(guardVerdict);
  const state = runtime.startRun({
    source: 'ide',
    goal: 'approval mode probe',
    tools: [{ name: 'execute_command' }],
    policy: {
      allowedTools: ['execute_command'],
      capabilities: ['exec_command'],
      approvalPolicy: 'none',
      approvalMode: mode,
    },
  }, { runId: `probe-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}` });
  let called = false;
  const result = await runtime.dispatchTool(state.runId, 'execute_command', { command: 'mkdir demo', hostId: 'local' }, {
    approvalMode: mode,
    allowApproval: false,
    preApproved: mode === 'full_access',
    executeTool: async () => {
      called = true;
      return { content: 'ok', is_error: false };
    },
  });
  return { result, called };
}

(async () => {
  let probe = await runRuntimeApprovalProbe('delegated', {
    allow: true,
    needApproval: true,
    approvalRequired: false,
    risk: { risky: true },
  });
  assert.strictEqual(probe.called, false, 'delegated mode should reject needApproval-only operations instead of auto-approving them');
  assert.strictEqual(probe.result.is_error, true, 'delegated needApproval-only operations should fail closed');

  probe = await runRuntimeApprovalProbe('delegated', {
    allow: true,
    needApproval: true,
    approvalRequired: true,
    riskReason: 'required approval',
  });
  assert.strictEqual(probe.called, false, 'delegated mode should reject approvalRequired operations');
  assert.strictEqual(probe.result.is_error, true, 'delegated approvalRequired operations should fail closed');

  probe = await runRuntimeApprovalProbe('full_access', {
    allow: true,
    needApproval: true,
    approvalRequired: true,
    riskReason: 'required approval',
  });
  assert.strictEqual(probe.called, true, 'full_access mode should preapprove approvalRequired operations');
  assert.strictEqual(probe.result.is_error, false, 'full_access preapproved operations should succeed');

  probe = await runRuntimeApprovalProbe('full_access', {
    allow: false,
    reason: 'hard deny',
  });
  assert.strictEqual(probe.called, false, 'full_access mode must not bypass hard guard denial');
  assert.strictEqual(probe.result.is_error, true, 'hard guard denial must remain fail-closed');

  console.log('ide approval policy checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
