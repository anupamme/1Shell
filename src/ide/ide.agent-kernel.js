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

function normalizeIdeApprovalMode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['manual', 'user', 'ask', 'ask_user', 'ask_for_approval'].includes(text)) return 'manual';
  if (['delegated', 'approve_for_me', 'auto_review', 'auto', 'agent'].includes(text)) return 'delegated';
  if (['full_access', 'full', 'danger_full_access', 'unrestricted'].includes(text)) return 'full_access';
  return 'manual';
}

function approvalPolicyForMode(approvalMode) {
  return approvalMode === 'manual' ? 'agent_side_effects' : 'none';
}

function createIdeAgentPolicy({ tools = [], entry = 'core', approvalMode = null, remotePolicy = null, goalProfile = null } = {}) {
  const toolNames = uniqueStrings(tools.map((tool) => tool?.name));
  const normalizedEntry = String(entry || 'core').trim().toLowerCase().replace(/[-\s]+/g, '_') || 'core';
  const normalizedApprovalMode = normalizeIdeApprovalMode(approvalMode);
  const hostScope = hostScopeForRemotePolicy(remotePolicy);
  return {
    allowedTools: toolNames,
    deniedTools: [],
    approvalPolicy: approvalPolicyForMode(normalizedApprovalMode),
    approvalMode: normalizedApprovalMode,
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
    entry: normalizedEntry,
    hostScope,
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

const GATEWAY_WRITE_TOOLS = new Set([
  'execute_command',
  'run_script', 'save_script', 'write_remote_file', 'create_directory', 'delete_path', 'rename_path',
  'upload_file', 'download_file', 'add_mcp_server',
  'remove_mcp_server', 'deploy_local_mcp', 'ack_probe_alert', 'install_probe_agent',
  'restart_probe_agent', 'uninstall_probe_agent', 'invoke_claude_code',
]);

/**
 * MCP 网关模式（ask_1shell_ai 的 answer/plan/execute）下的写工具门禁。
 * answer/plan 是"只读探查"档：execute_command 放行只读命令（探查服务器的
 * 核心手段），其余写工具一刀切拒绝；execute 不设此门禁。
 */
function evaluateGatewayWriteToolPolicy(gatewayMode, toolName, command = '') {
  const mode = String(gatewayMode || '').trim().toLowerCase();
  if (mode !== 'answer' && mode !== 'plan') return null;
  if (!GATEWAY_WRITE_TOOLS.has(toolName)) return null;
  if (toolName !== 'execute_command') {
    return { allow: false, reason: `mode=${mode} 不允许执行变更型工具: ${toolName}` };
  }
  const { isReadonlyCommand } = require('../harness/capabilities');
  if (!isReadonlyCommand(String(command || ''))) {
    return { allow: false, reason: `mode=${mode} 只允许只读命令（探查服务器），当前命令包含写/变更动作。需要变更请用 mode=execute` };
  }
  return null;
}

function normalizeIdeGoalStatus(value) {
  const text = String(value || '').trim();
  return ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(text)
    ? text
    : 'active';
}

function createIdeAgentGoalProfile({ message = '', context = null, entry = 'core' } = {}) {
  const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const threadGoal = ctx.threadGoal && typeof ctx.threadGoal === 'object' && !Array.isArray(ctx.threadGoal)
    ? ctx.threadGoal
    : {};
  const objective = String(threadGoal.objective || ctx.agentGoal || ctx.goal || '').replace(/\r\n/g, '\n').trim();
  const status = objective ? normalizeIdeGoalStatus(threadGoal.status || ctx.goalStatus) : '';
  return {
    intent: String(message || '').trim().slice(0, 500),
    objective: objective.slice(0, 4000),
    status,
    active: Boolean(objective && status === 'active'),
    goalKind: objective ? 'thread_goal' : '',
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

function hostScopeForRemotePolicy(policy = {}) {
  const allowedHosts = uniqueStrings(policy?.allowedHosts);
  if (allowedHosts.length === 0 || allowedHosts.includes('*')) return undefined;
  return allowedHosts;
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
  evaluateGatewayWriteToolPolicy,
  filterToolsForAgent,
  normalizeIdeApprovalMode,
  normalizeIdeAgentToolInput,
  shouldRequestAgentApproval,
};
