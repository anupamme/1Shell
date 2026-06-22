const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createIdeAgentPolicy } = require('../src/ide/ide.agent-kernel');
const { evaluateAgentToolPolicy } = require('../src/agent-runtime/tool-policy');

const tools = [
  { name: 'list_hosts' },
  { name: 'execute_command' },
  { name: 'read_remote_file' },
];

const scopedPolicy = createIdeAgentPolicy({
  tools,
  entry: 'core',
  approvalMode: 'manual',
  remotePolicy: {
    source: 'agent_workspace',
    gatewayMode: 'execute',
    allowedHosts: ['vps-a'],
  },
});

assert.deepStrictEqual(scopedPolicy.hostScope, ['vps-a'], 'Agent workspace policy should become AgentRun hostScope');

const scopedState = {
  spec: {
    policy: scopedPolicy,
    context: { hostId: 'vps-a' },
  },
};

assert.strictEqual(
  evaluateAgentToolPolicy(scopedState, 'execute_command', { hostId: 'vps-a', command: 'pwd' }, { scope: { hostId: 'vps-a' } }).allow,
  true,
  'current workspace host should be allowed',
);

const denied = evaluateAgentToolPolicy(scopedState, 'execute_command', { hostId: 'vps-b', command: 'pwd' }, { scope: { hostId: 'vps-a' } });
assert.strictEqual(denied.allow, false, 'cross-host command should be rejected');
assert.strictEqual(denied.kind, 'host_scope', 'cross-host rejection should be a host_scope policy result');

const missingHost = evaluateAgentToolPolicy(scopedState, 'read_remote_file', { path: '/etc/hosts' }, { scope: { hostId: 'vps-a' } });
assert.strictEqual(missingHost.allow, true, 'missing hostId should resolve through current workspace scope');

const wildcardPolicy = createIdeAgentPolicy({
  tools,
  entry: 'core',
  approvalMode: 'manual',
  remotePolicy: {
    source: 'agent_workspace',
    gatewayMode: 'execute',
    allowedHosts: ['*'],
  },
});

assert.strictEqual(wildcardPolicy.hostScope, undefined, 'all-host workspace should not create a hostScope lock');

const multiPolicy = createIdeAgentPolicy({
  tools,
  entry: 'core',
  approvalMode: 'manual',
  remotePolicy: {
    source: 'agent_workspace',
    gatewayMode: 'execute',
    allowedHosts: ['vps-a', 'vps-b'],
  },
});
assert.deepStrictEqual(multiPolicy.hostScope, ['vps-a', 'vps-b'], 'multi-host workspace should preserve all selected hosts');
const multiState = { spec: { policy: multiPolicy, context: { hostId: 'all', workspaceHostIds: ['vps-a', 'vps-b'] } } };
assert.strictEqual(
  evaluateAgentToolPolicy(multiState, 'execute_command', { hostId: 'vps-b', command: 'pwd' }, { scope: { hostId: 'all' } }).allow,
  true,
  'multi-host workspace should allow any selected host',
);
assert.strictEqual(
  evaluateAgentToolPolicy(multiState, 'execute_command', { hostId: 'vps-c', command: 'pwd' }, { scope: { hostId: 'all' } }).allow,
  false,
  'multi-host workspace should reject hosts outside the selected set',
);

const root = path.resolve(__dirname, '..');
const ideServiceSource = fs.readFileSync(path.join(root, 'src/ide/ide.service.js'), 'utf8');
assert.ok(
  ideServiceSource.includes('applySessionHostScopeToInput(toolName, args || {}, session)'),
  'IDE tool dispatch should default missing hostId from the session workspace',
);
assert.ok(
  ideServiceSource.includes("policy.source === 'agent_workspace' ? 'Agent 工作区'"),
  'Agent workspace policy should not surface as Remote MCP Token errors',
);

const agentViewSource = fs.readFileSync(path.join(root, 'frontend/src/views/AgentView.vue'), 'utf8');
assert.ok(agentViewSource.includes("source: 'agent_workspace'"), 'Agent page should send workspace policy');
assert.ok(agentViewSource.includes("allowedHosts: ['*']"), 'Agent page should explicitly clear host lock for all-host mode');
assert.ok(agentViewSource.includes('allowedHosts: ids'), 'Agent page should lock policy to the selected workspace hosts');
assert.ok(agentViewSource.includes('workspaceHostIds:'), 'Agent page should carry workspaceHostIds in session context');

const idePanelSource = fs.readFileSync(path.join(root, 'frontend/src/components/main/IdePanel.vue'), 'utf8');
assert.ok(idePanelSource.includes("source: 'agent_workspace'"), 'Main IDE panel should send workspace policy for the active terminal host');

const railSource = fs.readFileSync(path.join(root, 'frontend/src/components/AgentSessionRail.vue'), 'utf8');
assert.ok(railSource.includes('chatGroups'), 'Agent history rail should group sessions by workspace');
assert.ok(railSource.includes('workspaceLabel'), 'Agent history rail should label workspace groups');

console.log('agent host scope tests passed');
