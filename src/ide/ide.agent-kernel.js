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

function normalizeIdeApprovalMode(value, { entry = 'core' } = {}) {
  const normalizedEntry = String(entry || 'core').trim().toLowerCase().replace(/[-\s]+/g, '_') || 'core';
  const text = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['manual', 'user', 'ask', 'ask_user', 'ask_for_approval'].includes(text)) return 'manual';
  if (['delegated', 'approve_for_me', 'auto_review', 'auto', 'agent'].includes(text)) return 'delegated';
  if (['full_access', 'full', 'danger_full_access', 'unrestricted'].includes(text)) return 'full_access';
  return normalizedEntry === 'task_run' ? 'delegated' : 'manual';
}

function approvalPolicyForMode(approvalMode) {
  return approvalMode === 'manual' ? 'agent_side_effects' : 'none';
}

function createIdeAgentPolicy({ tools = [], entry = 'core', approvalMode = null, remotePolicy = null, goalProfile = null, taskRepair = null } = {}) {
  const toolNames = uniqueStrings(tools.map((tool) => tool?.name));
  const normalizedEntry = String(entry || 'core').trim().toLowerCase().replace(/[-\s]+/g, '_') || 'core';
  const normalizedApprovalMode = normalizeIdeApprovalMode(approvalMode, { entry: normalizedEntry });
  const taskRepairAuthorized = isTaskRepairAuthorized(taskRepair);
  const hostScope = hostScopeForRemotePolicy(remotePolicy);
  // /task 创作模式只做只读探索 + 推演，不执行真正的变更：去掉 exec_command，
  // 变更/高危工具与非只读命令由 Harness capability 直接拒绝（A 边界）。
  // task_run 默认只执行任务；只有用户在失败后明确授权修复本任务时，才临时授予
  // task_authoring，让 agent 可用 update_ai_task 修正该任务定义。
  let capabilities;
  if (normalizedEntry === 'task') {
    capabilities = ['read_only', 'agent_control', 'task_authoring'];
  } else if (normalizedEntry === 'task_run') {
    capabilities = taskRepairAuthorized
      ? ['read_only', 'exec_command', 'agent_control', 'task_authoring']
      : ['read_only', 'exec_command', 'agent_control'];
  } else {
    capabilities = ['read_only', 'exec_command', 'agent_control'];
  }
  return {
    allowedTools: toolNames,
    deniedTools: [],
    approvalPolicy: approvalPolicyForMode(normalizedApprovalMode),
    approvalMode: normalizedApprovalMode,
    budgetMode: 'runtime_policy',
    capabilities,
    maxTurns: DEFAULT_IDE_AGENT_LIMITS.maxTurns,
    maxToolCalls: DEFAULT_IDE_AGENT_LIMITS.maxToolCalls,
    maxCommands: DEFAULT_IDE_AGENT_LIMITS.maxCommands,
    maxRuntimeMs: DEFAULT_IDE_AGENT_LIMITS.maxRuntimeMs,
    maxOutputCharsPerCommand: DEFAULT_IDE_AGENT_LIMITS.maxOutputCharsPerCommand,
    maxRecoveryAttempts: null,
    maxRepeatedFailures: 3,
    readOnly: false,
    entry: normalizedEntry,
    taskRepairAuthorized,
    hostScope,
    remotePolicy: remotePolicy ? summarizeRemotePolicy(remotePolicy) : undefined,
    goalProfile: goalProfile || undefined,
    legacyFlagsIgnored: ['safeMode', 'unlimitedTurns'],
  };
}

function isTaskRepairAuthorized(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.authorized === true
    || value.taskRepairAuthorized === true
    || value.task_repair_authorized === true
    || value.taskRepair === true
    || value.task_repair === true;
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
  filterToolsForAgent,
  isTaskRepairAuthorized,
  normalizeIdeApprovalMode,
  normalizeIdeAgentToolInput,
  shouldRequestAgentApproval,
};
