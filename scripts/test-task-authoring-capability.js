'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../src/config/env');
const { createAgentRuntime } = require('../src/agent-runtime/runtime');
const { checkCapabilities } = require('../src/harness/capabilities');
const { createIdeAgentPolicy } = require('../src/ide/ide.agent-kernel');

const taskTools = ['preview_ai_task', 'create_ai_task', 'update_ai_task', 'get_ai_task'];

for (const toolName of taskTools) {
  const coreVerdict = checkCapabilities(toolName, {}, ['read_only', 'exec_command', 'agent_control']);
  assert.strictEqual(coreVerdict.allow, false, `${toolName} must not be allowed in core capabilities`);

  const taskVerdict = checkCapabilities(toolName, {}, ['read_only', 'exec_command', 'agent_control', 'task_authoring']);
  assert.strictEqual(taskVerdict.allow, true, `${toolName} must be allowed in task_authoring capabilities`);
}

const corePolicy = createIdeAgentPolicy({ tools: [], entry: 'core' });
assert.ok(!corePolicy.capabilities.includes('task_authoring'), 'core policy must not include task_authoring');

const taskPolicy = createIdeAgentPolicy({ tools: [], entry: 'task' });
assert.ok(taskPolicy.capabilities.includes('task_authoring'), 'task policy must include task_authoring');

const taskRunPolicy = createIdeAgentPolicy({ tools: [], entry: 'task_run' });
assert.ok(!taskRunPolicy.capabilities.includes('task_authoring'), 'task_run policy must not include task_authoring by default');
assert.strictEqual(taskRunPolicy.approvalMode, 'delegated', 'task_run policy must default to delegated approval mode');
assert.strictEqual(taskRunPolicy.approvalPolicy, 'none', 'task_run policy must not request interactive side-effect approvals');

const taskRepairPolicy = createIdeAgentPolicy({
  tools: [],
  entry: 'task_run',
  taskRepair: { authorized: true, taskId: 'task-demo', runId: 1 },
});
assert.ok(taskRepairPolicy.capabilities.includes('task_authoring'), 'task_run repair policy must temporarily include task_authoring');
assert.strictEqual(taskRepairPolicy.approvalMode, 'delegated', 'task_run repair policy must remain delegated');

const delegatedPolicy = createIdeAgentPolicy({ tools: [], entry: 'core', approvalMode: 'delegated' });
assert.strictEqual(delegatedPolicy.approvalPolicy, 'none', 'delegated IDE mode must not request interactive side-effect approvals');

const fullAccessPolicy = createIdeAgentPolicy({ tools: [], entry: 'core', approvalMode: 'full_access' });
assert.strictEqual(fullAccessPolicy.approvalPolicy, 'none', 'full access IDE mode must not request interactive side-effect approvals');

const ideServiceSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ide', 'ide.service.js'), 'utf8');
const useIdeChatSource = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'composables', 'useIdeChat.ts'), 'utf8');
assert.ok(ideServiceSource.includes('ctx.taskAuthoring'), '/task entry must be inferred from taskAuthoring context even if the frontend entry payload is missing');
assert.ok(ideServiceSource.includes('ctx.taskRun'), 'task_run entry must be inferred from taskRun context');
assert.ok(ideServiceSource.includes('taskRepairAuthorized'), 'task_run repair authorization must be carried through IDE context');
assert.ok(ideServiceSource.includes("const repairToolNames = new Set(['preview_ai_task', 'update_ai_task', 'get_ai_task'])"), 'task_run repair must expose only the minimal task repair tool set');
assert.ok(ideServiceSource.includes('const effectiveEntry = normalizePromptEntry(entry, context, message)'), 'IDE message handling must resolve an effective entry before creating the session');
assert.ok(ideServiceSource.includes('entry: session.entry'), 'AgentRun policy must use the normalized session entry');
assert.ok(ideServiceSource.includes('approvalMode: session.approvalMode'), 'AgentRun policy must use the normalized session approval mode');
assert.ok(ideServiceSource.includes('taskRepair: session.taskRepair'), 'AgentRun policy must receive per-run task repair authorization');
// /task authoring is read-only exploration (A boundary); the evidence-gate / packaging machinery is gone.
assert.ok(taskPolicy.capabilities.includes('read_only'), 'task authoring must keep read-only exploration');
assert.ok(!taskPolicy.capabilities.includes('exec_command'), 'task authoring must drop exec_command so it cannot make real changes');
assert.ok(taskRunPolicy.capabilities.includes('exec_command'), 'task_run execution must keep full exec capability');
assert.strictEqual(checkCapabilities('execute_command', { command: 'ls -la /etc' }, taskPolicy.capabilities).allow, true, 'read-only command must be allowed during authoring');
assert.strictEqual(checkCapabilities('execute_command', { command: 'rm -rf /tmp/x' }, taskPolicy.capabilities).allow, false, 'mutating command must be denied during authoring');
assert.strictEqual(checkCapabilities('write_remote_file', { path: '/etc/x' }, taskPolicy.capabilities).allow, false, 'write tools must be denied during authoring');
assert.ok(!ideServiceSource.includes('requireTaskAuthoringEvidence'), '/task authoring must not gate saving behind a practice/evidence wall');
assert.ok(!ideServiceSource.includes('createTaskPackagingRequiredObservation'), '/task authoring must not force packaging via synthetic observations');
assert.ok(useIdeChatSource.includes('buildOutgoingMessagePayload'), 'IDE frontend must snapshot entry/context before socket connection latency can reset /task state');
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

  console.log('task-authoring capability checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
