'use strict';

const DEFAULT_IDE_AGENT_LIMITS = Object.freeze({
  maxTurns: null,
  maxToolCalls: 200,
  maxCommands: 80,
  maxRuntimeMs: 6 * 60 * 60 * 1000,
  maxOutputCharsPerCommand: 8000,
});

const IDE_AGENT_PHASE_DEFINITIONS = [
  { id: 'understand', label: 'Understand goal' },
  { id: 'context', label: 'Gather context' },
  { id: 'act', label: 'Act' },
  { id: 'verify', label: 'Verify' },
  { id: 'result', label: 'Publish result' },
];

function createIdeAgentPolicy({ tools = [], entry = 'core', remotePolicy = null, goalProfile = null } = {}) {
  const toolNames = uniqueStrings(tools.map((tool) => tool?.name));
  return {
    allowedTools: toolNames,
    deniedTools: [],
    approvalPolicy: 'agent_side_effects',
    budgetMode: 'runtime_policy',
    capabilities: ['read_only', 'exec_command', 'agent_control'],
    maxTurns: DEFAULT_IDE_AGENT_LIMITS.maxTurns,
    maxToolCalls: DEFAULT_IDE_AGENT_LIMITS.maxToolCalls,
    maxCommands: DEFAULT_IDE_AGENT_LIMITS.maxCommands,
    maxRuntimeMs: DEFAULT_IDE_AGENT_LIMITS.maxRuntimeMs,
    maxOutputCharsPerCommand: DEFAULT_IDE_AGENT_LIMITS.maxOutputCharsPerCommand,
    maxRecoveryAttempts: null,
    maxRepeatedFailures: 3,
    readOnly: false,
    entry: String(entry || 'core'),
    remotePolicy: remotePolicy ? summarizeRemotePolicy(remotePolicy) : undefined,
    goalProfile: goalProfile || undefined,
    legacyFlagsIgnored: ['safeMode', 'unlimitedTurns'],
  };
}

function filterToolsForAgent(tools = [], policy = {}) {
  const allowed = new Set(Array.isArray(policy.allowedTools) ? policy.allowedTools : []);
  const denied = new Set(Array.isArray(policy.deniedTools) ? policy.deniedTools : []);
  return tools.filter((tool) => {
    const name = String(tool?.name || '').trim();
    if (!name || denied.has(name)) return false;
    return allowed.size === 0 || allowed.has(name);
  });
}

function shouldRequestAgentApproval(toolName, { readonlyTools, sideEffectTools, controlTools } = {}) {
  const name = String(toolName || '').trim();
  if (!name) return false;
  if (controlTools?.has?.(name)) return false;
  if (name === 'execute_command' || name === 'host_exec') return false;
  if (readonlyTools?.has?.(name)) return false;
  if (sideEffectTools?.has?.(name)) return true;
  return false;
}

function createIdeAgentGoalProfile({ entry = 'core' } = {}) {
  return {
    intent: '',
    goalKind: '',
    entry: String(entry || 'core').trim().toLowerCase(),
  };
}

function evaluateIdeAgentProfileToolUse(_goalProfile, toolName) {
  const name = String(toolName || '').trim();
  if (!name) return { allow: false, reason: 'toolName is required', kind: 'invalid_tool' };
  return { allow: true };
}

function normalizeIdeAgentToolInput(_goalProfile, _toolName, input = {}) {
  return input;
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function summarizeRemotePolicy(policy = {}) {
  return {
    gatewayMode: policy.gatewayMode || '',
    allowedTools: Array.isArray(policy.allowedTools) ? policy.allowedTools : [],
    allowedHosts: Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [],
  };
}

module.exports = {
  DEFAULT_IDE_AGENT_LIMITS,
  IDE_AGENT_PHASE_DEFINITIONS,
  createIdeAgentPolicy,
  createIdeAgentGoalProfile,
  evaluateIdeAgentProfileToolUse,
  filterToolsForAgent,
  normalizeIdeAgentToolInput,
  shouldRequestAgentApproval,
};
