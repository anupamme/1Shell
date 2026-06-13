'use strict';

const { normalizeAgentStateDelta } = require('./cognition');

const AGENT_COMMAND_TYPES = Object.freeze([
  'continue',
  'act',
  'ask_user',
  'request_approval',
  'request_secret',
  'verify',
  'recover',
  'finalize',
  'block',
]);

function normalizeAgentCommand(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : { text: String(value || '') };
  const toolCalls = firstToolCallArray(source).map(normalizeAgentAction).filter(Boolean);
  const interrupt = normalizeInterrupt(source.interrupt || source.interruptRequest || source.interrupt_request);
  const data = normalizeObject(source.data);
  const protocol = normalizeObject(data.protocol);
  const explicitCommandType = typeof protocol.explicitCommandType === 'boolean'
    ? protocol.explicitCommandType
    : Boolean(String(source.command || source.type || source.kind || '').trim());
  const explicitFinalSignal = typeof protocol.explicitFinalSignal === 'boolean'
    ? protocol.explicitFinalSignal
    : (source.final === true
      || source.done === true
      || source.stop === true
      || String(source.finishReason || source.finish_reason || '').toLowerCase() === 'stop');
  let type = String(source.command || source.type || source.kind || '').trim();

  if (!type && toolCalls.length > 0) type = 'act';
  if (!type && interrupt) type = interrupt.type;
  if (!type && (source.needsApproval === true || source.needs_approval === true)) type = 'request_approval';
  if (!type && (source.final === true || source.done === true || source.stop === true)) type = 'finalize';
  if (!type && String(source.finishReason || source.finish_reason || '').toLowerCase() === 'stop') type = 'finalize';
  if (!type) type = toolCalls.length > 0 ? 'act' : 'finalize';

  type = normalizeCommandType(type);
  const inferredFinalization = type === 'finalize' && !explicitCommandType && !explicitFinalSignal && toolCalls.length === 0 && !interrupt;
  data.protocol = {
    ...protocol,
    explicitCommandType,
    explicitFinalSignal,
    inferredCommandType: !explicitCommandType,
    inferredFinalization: protocol.inferredFinalization === true || inferredFinalization,
    protocolFallback: source.protocolFallback === true
      || source.protocol_fallback === true
      || data.protocolFallback === true
      || data.protocol_fallback === true
      || protocol.fallback === true
      || protocol.protocolFallback === true,
  };
  return {
    type,
    actions: type === 'act' ? toolCalls : [],
    interrupt: interrupt || normalizeApprovalInterrupt(source),
    final: type === 'finalize' || source.final === true || source.done === true || source.stop === true,
    text: compactText(source.text || source.report || source.content || source.output || source.message || '', 4000),
    status: String(source.status || source.taskStatus || source.task_status || '').trim(),
    reason: String(source.reason || '').trim(),
    stateDelta: normalizeAgentStateDelta(source.stateDelta || source.state_delta || source.agentStateDelta || source.agent_state_delta || source.cognition || source.mind),
    data,
    raw: source,
  };
}

function normalizeCommandType(value) {
  const text = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (text === 'tool' || text === 'tools' || text === 'call_tool' || text === 'call_tools') return 'act';
  if (text === 'approval' || text === 'approve') return 'request_approval';
  if (text === 'secret') return 'request_secret';
  if (text === 'ask' || text === 'question') return 'ask_user';
  if (text === 'done' || text === 'finish' || text === 'final') return 'finalize';
  if (text === 'blocked' || text === 'failed') return 'block';
  return AGENT_COMMAND_TYPES.includes(text) ? text : 'continue';
}

function firstToolCallArray(source = {}) {
  const array = [source.toolCalls, source.tool_calls, source.tools, source.actions]
    .find((item) => Array.isArray(item));
  if (array) return array;
  const single = source.toolCall || source.tool_call || source.functionCall || source.function_call;
  return single ? [single] : [];
}

function normalizeAgentAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fn = value.function && typeof value.function === 'object' ? value.function : {};
  const toolName = String(value.toolName || value.tool_name || value.name || value.tool || fn.name || '').trim();
  if (!toolName) return null;
  return {
    id: String(value.id || value.callId || value.call_id || `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    toolName,
    args: normalizeToolArgs(value, toolName, fn),
    options: normalizeToolOptions(value),
  };
}

function normalizeToolArgs(value, toolName, fn = {}) {
  const raw = value.args ?? value.arguments ?? value.input ?? value.parameters ?? fn.arguments ?? {};
  const args = parseToolArgs(raw, toolName);
  if (value.command !== undefined && args.command === undefined) args.command = String(value.command || '');
  if (value.hostId !== undefined && args.hostId === undefined) args.hostId = String(value.hostId || '');
  if (value.timeout !== undefined && args.timeout === undefined) args.timeout = value.timeout;
  return args;
}

function parseToolArgs(value, toolName) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  const text = String(value || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...parsed };
  } catch { /* text fallback */ }
  return ['execute_command', 'host_exec'].includes(toolName) ? { command: text } : { input: text };
}

function normalizeToolOptions(value) {
  const options = normalizeObject(value.options);
  const scope = normalizeObject(value.scope);
  if (value.hostId !== undefined && scope.hostId === undefined) scope.hostId = String(value.hostId || '');
  if (Object.keys(scope).length > 0) options.scope = { ...normalizeObject(options.scope), ...scope };
  return options;
}

function normalizeInterrupt(value) {
  if (!value) return null;
  if (typeof value === 'string') return { type: 'ask_user', reason: value, message: value, payload: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = normalizeCommandType(value.type || value.kind || 'ask_user');
  return {
    type: ['ask_user', 'request_secret', 'request_approval'].includes(type) ? type : 'ask_user',
    reason: String(value.reason || value.message || value.type || 'interrupt_requested'),
    message: String(value.message || value.reason || ''),
    scope: normalizeObject(value.scope),
    payload: normalizeObject(value.payload || value.data),
    taskStatus: value.taskStatus || value.task_status,
    runnerStatus: value.runnerStatus || value.runner_status,
  };
}

function normalizeApprovalInterrupt(source = {}) {
  if (source.needsApproval !== true && source.needs_approval !== true) return null;
  return {
    type: 'request_approval',
    reason: source.reason || 'approval_required',
    message: source.message || source.text || '',
    payload: normalizeObject(source.approval || source.data),
  };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

module.exports = {
  AGENT_COMMAND_TYPES,
  normalizeAgentAction,
  normalizeAgentCommand,
  normalizeCommandType,
};
