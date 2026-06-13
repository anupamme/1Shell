'use strict';

const { runAgentControllerLoop } = require('./controller');
const { evaluateAgentRunOutcome, normalizeAgentTaskStatus } = require('./outcome');

function createAgentRunner(defaults = {}) {
  return {
    async run(spec, options = {}) {
      return runAgentTask({ ...defaults, ...options, spec });
    },
  };
}

async function runAgentTask({
  runtime,
  spec = null,
  runId = '',
  modelAdapter,
  verify = null,
  endRun = true,
  runnerStatus = 'completed',
  taskStatus = null,
  fallbackTaskStatus = 'unverified',
  publishResult = false,
  maxTurns = null,
  checkpointTurns = false,
  interruptOn = null,
  dispatchOptionsForAction = null,
  additionalFinalGates = [],
  onStarted = null,
  onEnded = null,
  logger = null,
} = {}) {
  if (!runtime?.getState && !runtime?.startRun) throw new Error('Agent runtime is not configured');

  const initial = getOrStartState(runtime, spec, runId);
  await callHook(onStarted, { state: initial, runId: initial.runId, spec: initial.spec });

  try {
    const turnLoop = await runAgentTurnLoop({
      runtime,
      runId: initial.runId,
      initial,
      modelAdapter,
      maxTurns,
      checkpointTurns,
      interruptOn,
      dispatchOptionsForAction,
      additionalFinalGates,
    });
    const result = turnLoop.result;

    if (publishResult) publishModelResultIfNeeded(runtime, initial.runId, result);
    if (typeof verify === 'function') {
      await verify({
        runId: initial.runId,
        state: runtime.getState?.(initial.runId) || initial,
        result,
        turns: turnLoop.turns,
        observations: turnLoop.observations,
      });
    }

    const state = runtime.getState?.(initial.runId) || initial;
    const effectiveTaskStatus = taskStatus || turnLoop.finalGate?.forcedStatus || null;
    const outcome = resolveOutcome(state, { taskStatus: effectiveTaskStatus, fallbackTaskStatus });
    const finalRunnerStatus = turnLoop.runnerStatus || runnerStatus;
    if (endRun) {
      runtime.endRun(initial.runId, {
        runnerStatus: finalRunnerStatus,
        taskStatus: outcome.taskStatus,
        result: buildEndResult(state, outcome, result),
      });
    }
    await callHook(onEnded, { runId: initial.runId, state: runtime.getState?.(initial.runId) || state, result, outcome, error: null });
    return {
      runId: initial.runId,
      state: runtime.getState?.(initial.runId) || state,
      result,
      outcome,
      turns: turnLoop.turns,
      observations: turnLoop.observations,
      interrupt: turnLoop.interrupt,
      finalGate: turnLoop.finalGate,
    };
  } catch (err) {
    const state = runtime.getState?.(initial.runId) || initial;
    const errorTaskStatus = typeof taskStatus === 'function' ? taskStatus(err, { state }) : taskStatus;
    const errorFallback = typeof fallbackTaskStatus === 'function' ? fallbackTaskStatus(err, { state }) : fallbackTaskStatus;
    const outcome = resolveOutcome(state, { taskStatus: errorTaskStatus, fallbackTaskStatus: errorFallback || 'failed' });
    if (endRun) {
      runtime.endRun(initial.runId, {
        runnerStatus: runnerStatus === 'completed' ? 'failed' : runnerStatus,
        taskStatus: outcome.taskStatus,
        result: buildEndResult(state, outcome, { status: 'failed', text: err.message }),
        error: err.message,
      });
    }
    await callHook(onEnded, { runId: initial.runId, state: runtime.getState?.(initial.runId) || state, result: null, outcome, error: err });
    logger?.warn?.('[agent-runtime] agent run failed', { runId: initial.runId, error: err.message });
    throw err;
  }
}

async function resumeAgentTask({
  runtime,
  runId = '',
  checkpointId = '',
  interruptId = '',
  resolution = {},
  modelAdapter,
  verify = null,
  endRun = true,
  runnerStatus = 'completed',
  taskStatus = null,
  fallbackTaskStatus = 'unverified',
  publishResult = false,
  maxTurns = null,
  checkpointTurns = false,
  interruptOn = null,
  dispatchOptionsForAction = null,
  additionalFinalGates = [],
  onResumed = null,
  onEnded = null,
  logger = null,
} = {}) {
  if (!runtime?.resumeRun || !runtime?.getState) throw new Error('Agent runtime resume is not configured');
  const id = String(runId || '').trim();
  if (!id) throw new Error('runId is required');

  const resumed = runtime.resumeRun(id, { checkpointId, interruptId, resolution });
  const initial = resumed.state || runtime.getState(id);
  if (!initial) throw new Error(`Agent run not found: ${id}`);
  await callHook(onResumed, { runId: id, state: initial, checkpoint: resumed.checkpoint, interrupt: resumed.interrupt, resolution });

  try {
    const resumeContext = createResumeContext(resumed.checkpoint, resumed.interrupt, resolution);
    const turnLoop = await runAgentTurnLoop({
      runtime,
      runId: id,
      initial,
      modelAdapter,
      maxTurns,
      checkpointTurns,
      interruptOn,
      dispatchOptionsForAction,
      additionalFinalGates,
      ...resumeContext,
    });
    const result = turnLoop.result;

    if (publishResult) publishModelResultIfNeeded(runtime, id, result);
    if (typeof verify === 'function') {
      await verify({
        runId: id,
        state: runtime.getState?.(id) || initial,
        result,
        turns: turnLoop.turns,
        observations: turnLoop.observations,
        resumed,
      });
    }

    const state = runtime.getState?.(id) || initial;
    const effectiveTaskStatus = taskStatus || turnLoop.finalGate?.forcedStatus || null;
    const outcome = resolveOutcome(state, { taskStatus: effectiveTaskStatus, fallbackTaskStatus });
    const finalRunnerStatus = turnLoop.runnerStatus || runnerStatus;
    if (endRun) {
      runtime.endRun(id, {
        runnerStatus: finalRunnerStatus,
        taskStatus: outcome.taskStatus,
        result: buildEndResult(state, outcome, result),
      });
    }
    await callHook(onEnded, { runId: id, state: runtime.getState?.(id) || state, result, outcome, error: null, resumed });
    return {
      runId: id,
      state: runtime.getState?.(id) || state,
      result,
      outcome,
      turns: turnLoop.turns,
      observations: turnLoop.observations,
      interrupt: turnLoop.interrupt,
      finalGate: turnLoop.finalGate,
      resumed,
    };
  } catch (err) {
    const state = runtime.getState?.(id) || initial;
    const errorTaskStatus = typeof taskStatus === 'function' ? taskStatus(err, { state }) : taskStatus;
    const errorFallback = typeof fallbackTaskStatus === 'function' ? fallbackTaskStatus(err, { state }) : fallbackTaskStatus;
    const outcome = resolveOutcome(state, { taskStatus: errorTaskStatus, fallbackTaskStatus: errorFallback || 'failed' });
    if (endRun) {
      runtime.endRun(id, {
        runnerStatus: runnerStatus === 'completed' ? 'failed' : runnerStatus,
        taskStatus: outcome.taskStatus,
        result: buildEndResult(state, outcome, { status: 'failed', text: err.message }),
        error: err.message,
      });
    }
    await callHook(onEnded, { runId: id, state: runtime.getState?.(id) || state, result: null, outcome, error: err, resumed });
    logger?.warn?.('[agent-runtime] agent resume failed', { runId: id, error: err.message });
    throw err;
  }
}

async function runAgentTurnLoop({
  runtime,
  runId,
  initial,
  modelAdapter,
  maxTurns = null,
  checkpointTurns = false,
  interruptOn = null,
  initialTurns = [],
  initialObservations = [],
  startTurn = 0,
  resume = null,
  dispatchOptionsForAction = null,
  additionalFinalGates = [],
} = {}) {
  return runAgentControllerLoop({
    runtime,
    runId,
    initial,
    modelAdapter,
    maxTurns,
    checkpointTurns,
    interruptOn,
    initialTurns,
    initialObservations,
    startTurn,
    resume,
    dispatchOptionsForAction,
    additionalFinalGates,
  });
}

function normalizeModelToolCalls(result = {}) {
  const calls = firstToolCallArray(result);
  return calls.map(normalizeToolCallRequest).filter(Boolean);
}

function firstToolCallArray(result = {}) {
  const array = [result.toolCalls, result.tool_calls, result.tools, result.actions]
    .find((value) => Array.isArray(value));
  if (array) return array;
  const single = result.toolCall || result.tool_call || result.functionCall || result.function_call;
  return single ? [single] : [];
}

function normalizeToolCallRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const fn = value.function && typeof value.function === 'object' ? value.function : {};
  const toolName = String(value.toolName || value.tool_name || value.name || value.tool || fn.name || '').trim();
  if (!toolName) return null;
  const args = normalizeToolArgs(value, toolName, fn);
  const options = normalizeToolOptions(value);
  return {
    id: String(value.id || value.callId || value.call_id || `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    toolName,
    args,
    options,
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
  } catch { /* keep text fallback */ }
  return ['execute_command', 'host_exec'].includes(toolName) ? { command: text } : { input: text };
}

function normalizeToolOptions(value) {
  const options = normalizeObject(value.options);
  const scope = normalizeObject(value.scope);
  if (value.hostId !== undefined && scope.hostId === undefined) scope.hostId = String(value.hostId || '');
  if (Object.keys(scope).length > 0) options.scope = { ...normalizeObject(options.scope), ...scope };
  return options;
}

function summarizeInterrupt(interrupt = {}) {
  return {
    id: interrupt.id || '',
    type: interrupt.type || 'manual',
    status: interrupt.status || 'pending',
    reason: interrupt.reason || '',
    message: interrupt.message || '',
    turn: interrupt.turn ?? null,
  };
}

function createResumeContext(checkpoint = null, interrupt = null, resolution = {}) {
  const turn = normalizeCheckpointTurn(checkpoint?.data?.turn);
  const initialTurns = turn ? [turn] : [];
  const initialObservations = turn?.observations || [];
  const startTurn = Number.isFinite(Number(checkpoint?.turn))
    ? Number(checkpoint.turn)
    : initialTurns.length;
  return {
    initialTurns,
    initialObservations,
    startTurn,
    resume: {
      checkpoint: checkpoint ? summarizeCheckpoint(checkpoint) : null,
      interrupt: interrupt ? summarizeInterrupt(interrupt) : null,
      resolution: normalizeObject(resolution),
    },
  };
}

function normalizeCheckpointTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const index = toNonNegativeInteger(value.index, toNonNegativeInteger(Number(value.turn) - 1, 0));
  const turn = toPositiveInteger(value.turn, index + 1);
  return {
    index,
    turn,
    result: normalizeObject(value.result),
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.map(normalizePlainObject).filter(Boolean) : [],
    observations: normalizeObservationArray(value.observations),
  };
}

function normalizeObservationArray(value) {
  return Array.isArray(value) ? value.map(normalizePlainObject).filter(Boolean) : [];
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}

function summarizeCheckpoint(checkpoint = {}) {
  return {
    id: checkpoint.id || '',
    reason: checkpoint.reason || '',
    label: checkpoint.label || '',
    turn: checkpoint.turn ?? null,
    createdAt: checkpoint.createdAt || '',
  };
}

function getOrStartState(runtime, spec, runId) {
  const existing = runId ? runtime.getState?.(runId) : null;
  if (existing) return existing;
  if (!runtime?.startRun) throw new Error(`Agent run not found: ${runId || '(missing)'}`);
  if (!spec) throw new Error('AgentRunSpec is required');
  return runtime.startRun(spec);
}

function resolveOutcome(state, { taskStatus = null, fallbackTaskStatus = 'unverified' } = {}) {
  if (taskStatus) {
    const status = typeof taskStatus === 'function' ? taskStatus(null, { state }) : taskStatus;
    return { taskStatus: normalizeAgentTaskStatus(status, 'unverified'), reasons: [`explicit_${status}`] };
  }
  return evaluateAgentRunOutcome(state, { fallbackTaskStatus });
}

function publishModelResultIfNeeded(runtime, runId, result) {
  if (!runtime?.publishResult || !result || typeof result !== 'object') return null;
  const text = result.report || result.content || result.text || '';
  if (!text) return null;
  const state = runtime.getState?.(runId);
  if (state?.result) return state.result;
  return runtime.publishResult(runId, {
    title: result.title || '',
    status: result.status || 'unknown',
    content: text,
  });
}

function buildEndResult(state, outcome, modelResult = null) {
  const outcomeReasons = outcome.reasons || [];
  const normalized = normalizeEndModelResult(modelResult, outcome);
  if (state?.result && normalized) {
    return {
      ...state.result,
      ...normalized,
      summary: normalized.summary.length > 0 ? normalized.summary : (state.result.summary || []),
      data: { ...(state.result.data || {}), ...(normalized.data || {}) },
      outcomeReasons,
    };
  }
  if (state?.result) return { ...state.result, outcomeReasons };
  return normalized ? { ...normalized, outcomeReasons } : null;
}

function normalizeEndModelResult(modelResult, outcome = {}) {
  if (!modelResult || typeof modelResult !== 'object') return null;
  const report = String(modelResult.report || modelResult.content || modelResult.text || modelResult.output || '').trim();
  const title = String(modelResult.title || '').trim();
  if (!report && !title && !modelResult.status && !modelResult.data) return null;
  return {
    title,
    status: String(modelResult.status || outcome.taskStatus || 'unknown'),
    summary: Array.isArray(modelResult.summary) ? modelResult.summary : [],
    report,
    data: normalizeObject(modelResult.data),
    publishedAt: new Date().toISOString(),
  };
}

async function callHook(hook, payload) {
  if (typeof hook !== 'function') return null;
  return hook(payload);
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

module.exports = {
  createAgentRunner,
  normalizeModelToolCalls,
  resumeAgentTask,
  runAgentTask,
  runAgentTurnLoop,
};
