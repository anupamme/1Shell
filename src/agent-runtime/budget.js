'use strict';

const { COMMAND_TOOL_NAMES } = require('./constants');

function canUseTool(state, toolName, now = new Date()) {
  const policy = state?.spec?.policy || {};
  const budget = state?.budget || {};
  const name = String(toolName || '').trim();

  if (!name) return { allow: false, reason: 'toolName is required', kind: 'invalid_tool' };

  if (Array.isArray(policy.deniedTools) && policy.deniedTools.includes(name)) {
    return { allow: false, reason: `Tool ${name} is denied by policy`, kind: 'denied_tool' };
  }

  if (Array.isArray(policy.allowedTools) && policy.allowedTools.length > 0 && !policy.allowedTools.includes(name)) {
    return { allow: false, reason: `Tool ${name} is not in allowedTools`, kind: 'disallowed_tool' };
  }

  if (budget.maxToolCalls && budget.usedToolCalls + 1 > budget.maxToolCalls) {
    return { allow: false, reason: `Tool call budget exceeded (${budget.usedToolCalls}/${budget.maxToolCalls})`, kind: 'max_tool_calls' };
  }

  if (isCommandTool(name) && budget.maxCommands && budget.usedCommands + 1 > budget.maxCommands) {
    return { allow: false, reason: `Command budget exceeded (${budget.usedCommands}/${budget.maxCommands})`, kind: 'max_commands' };
  }

  if (budget.maxRuntimeMs) {
    const elapsed = getRuntimeElapsedMs(state, now);
    if (elapsed > budget.maxRuntimeMs) {
      return { allow: false, reason: `Runtime budget exceeded (${elapsed}/${budget.maxRuntimeMs} ms)`, kind: 'max_runtime_ms' };
    }
  }

  return { allow: true };
}

function recordToolUsage(state, toolName) {
  if (!state || typeof state !== 'object') return state;
  if (!state.budget || typeof state.budget !== 'object') state.budget = {};
  state.budget.usedToolCalls = Number(state.budget.usedToolCalls || 0) + 1;
  if (isCommandTool(toolName)) {
    state.budget.usedCommands = Number(state.budget.usedCommands || 0) + 1;
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

function isCommandTool(toolName) {
  return COMMAND_TOOL_NAMES.includes(String(toolName || '').trim());
}

function getRuntimeElapsedMs(state, now = new Date()) {
  const startedAt = Date.parse(state?.createdAt || state?.startedAt || '');
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, new Date(now).getTime() - startedAt);
}

function createBudgetExceededResult(reason, kind = 'budget_exceeded') {
  return {
    ok: false,
    content: `[agent-runtime] ${reason}`,
    is_error: true,
    error: reason,
    kind,
  };
}

module.exports = {
  canUseTool,
  createBudgetExceededResult,
  getRuntimeElapsedMs,
  isCommandTool,
  recordToolUsage,
};
