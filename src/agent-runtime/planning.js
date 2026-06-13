'use strict';

function createRuntimePlanState() {
  return {
    schemaVersion: 1,
    status: 'empty',
    intent: '',
    objective: '',
    turn: null,
    steps: [],
    blockers: [],
    evidenceNeeded: [],
    updatedAt: '',
  };
}

function createRuntimeRecoveryState() {
  return {
    schemaVersion: 1,
    status: 'idle',
    attemptCount: 0,
    maxAttempts: null,
    exhausted: false,
    repeatFailureCount: 0,
    maxRepeatedFailures: null,
    lastFailureSignature: '',
    recoveryType: '',
    reason: '',
    failedToolNames: [],
    failedObservationIds: [],
    strategy: '',
    nextSteps: [],
    verifierRequired: false,
    updatedAt: '',
  };
}

function applyRuntimePlanToState(state = {}, update = {}) {
  const runtimeState = ensureRuntimeState(state);
  const current = runtimeState.plan && typeof runtimeState.plan === 'object' && !Array.isArray(runtimeState.plan)
    ? runtimeState.plan
    : createRuntimePlanState();
  const now = update.updatedAt || new Date().toISOString();
  const next = {
    ...current,
    schemaVersion: 1,
    status: String(update.status || current.status || 'empty'),
    intent: String(update.intent || current.intent || ''),
    objective: compactText(update.objective !== undefined ? update.objective : current.objective, 1000),
    turn: update.turn === undefined ? current.turn : nullableNumber(update.turn),
    steps: Array.isArray(update.steps) ? update.steps.map(normalizePlanStep).filter(Boolean) : normalizePlanSteps(current.steps),
    blockers: normalizeStringArray(update.blockers !== undefined ? update.blockers : current.blockers),
    evidenceNeeded: normalizeStringArray(update.evidenceNeeded !== undefined ? update.evidenceNeeded : update.evidence_needed !== undefined ? update.evidence_needed : current.evidenceNeeded),
    updatedAt: now,
  };
  runtimeState.plan = next;
  appendRuntimeHistory(runtimeState, 'planHistory', next, 30);
  const memory = ensureRuntimeMemory(state);
  memory.plans.push({
    status: next.status,
    intent: next.intent,
    turn: next.turn,
    stepCount: next.steps.length,
    blockers: next.blockers,
    updatedAt: now,
  });
  memory.plans = memory.plans.slice(-50);
  return next;
}

function applyRuntimeRecoveryToState(state = {}, update = {}) {
  const runtimeState = ensureRuntimeState(state);
  const current = runtimeState.recovery && typeof runtimeState.recovery === 'object' && !Array.isArray(runtimeState.recovery)
    ? runtimeState.recovery
    : createRuntimeRecoveryState();
  const now = update.updatedAt || new Date().toISOString();
  const next = {
    ...current,
    schemaVersion: 1,
    status: String(update.status || current.status || 'idle'),
    attemptCount: Number.isFinite(Number(update.attemptCount)) ? Number(update.attemptCount) : Number(current.attemptCount || 0),
    maxAttempts: update.maxAttempts === undefined && update.max_attempts === undefined ? (current.maxAttempts ?? null) : nullableNumber(update.maxAttempts ?? update.max_attempts),
    exhausted: update.exhausted === undefined ? current.exhausted === true : update.exhausted === true,
    repeatFailureCount: Number.isFinite(Number(update.repeatFailureCount ?? update.repeat_failure_count))
      ? Number(update.repeatFailureCount ?? update.repeat_failure_count)
      : Number(current.repeatFailureCount || 0),
    maxRepeatedFailures: update.maxRepeatedFailures === undefined && update.max_repeated_failures === undefined ? (current.maxRepeatedFailures ?? null) : nullableNumber(update.maxRepeatedFailures ?? update.max_repeated_failures),
    lastFailureSignature: compactText(update.lastFailureSignature !== undefined ? update.lastFailureSignature : update.last_failure_signature !== undefined ? update.last_failure_signature : current.lastFailureSignature, 1000),
    recoveryType: String(update.recoveryType || update.recovery_type || current.recoveryType || ''),
    reason: compactText(update.reason !== undefined ? update.reason : current.reason, 1000),
    failedToolNames: normalizeStringArray(update.failedToolNames !== undefined ? update.failedToolNames : update.failed_tool_names !== undefined ? update.failed_tool_names : current.failedToolNames),
    failedObservationIds: normalizeStringArray(update.failedObservationIds !== undefined ? update.failedObservationIds : update.failed_observation_ids !== undefined ? update.failed_observation_ids : current.failedObservationIds),
    strategy: compactText(update.strategy !== undefined ? update.strategy : current.strategy, 1000),
    nextSteps: normalizeStringArray(update.nextSteps !== undefined ? update.nextSteps : update.next_steps !== undefined ? update.next_steps : current.nextSteps),
    verifierRequired: update.verifierRequired === undefined ? current.verifierRequired === true : update.verifierRequired === true,
    updatedAt: now,
  };
  runtimeState.recovery = next;
  appendRuntimeHistory(runtimeState, 'recoveryHistory', next, 30);
  const memory = ensureRuntimeMemory(state);
  memory.recoveries.push({
    status: next.status,
    attemptCount: next.attemptCount,
    repeatFailureCount: next.repeatFailureCount,
    recoveryType: next.recoveryType,
    reason: next.reason,
    failedToolNames: next.failedToolNames,
    updatedAt: now,
  });
  memory.recoveries = memory.recoveries.slice(-50);
  return next;
}

function buildPreDecisionPlan(state = {}, { turn = null, observations = [] } = {}) {
  const runtimeState = state.runtimeState || {};
  const world = runtimeState.worldState || {};
  const verifier = runtimeState.verifier || world.verificationPlan || {};
  const failures = (Array.isArray(world.failures) ? world.failures : []).filter((item) => item?.status !== 'recovered');
  const pendingInterrupts = (Array.isArray(state.interrupts) ? state.interrupts : []).filter((item) => item?.status === 'pending');
  const evidenceNeeded = [];
  if (verifier?.required === true && verifier.ok !== true) evidenceNeeded.push('runtime_verification');
  if ((Array.isArray(world.sideEffects) ? world.sideEffects : []).some((item) => item?.requiresVerification && item?.verified !== true)) evidenceNeeded.push('side_effect_verification');
  return {
    status: failures.length > 0 ? 'needs_recovery' : 'planning',
    intent: failures.length > 0 ? 'open_failure_recorded' : 'await_model_decision',
    objective: state.goal || state.spec?.goal || '',
    turn,
    steps: [
      {
        id: `turn-${turn || 'next'}-observe`,
        status: observations.length > 0 ? 'done' : 'pending',
        kind: 'observe',
        summary: observations.length > 0 ? `Observed ${observations.length} new result(s).` : 'No new observation in this turn.',
      },
      {
        id: `turn-${turn || 'next'}-decide`,
        status: 'pending',
        kind: failures.length > 0 ? 'recover' : 'decide',
        summary: failures.length > 0 ? 'Open failure before next model decision.' : 'Model decision pending.',
      },
    ],
    blockers: [
      ...failures.map((item) => `failure:${item.toolName || item.id || 'unknown'}`),
      ...pendingInterrupts.map((item) => `interrupt:${item.type || item.id || 'pending'}`),
    ],
    evidenceNeeded,
  };
}

function buildDecisionPlanUpdate(command = {}, result = {}, { turn = null, state = {} } = {}) {
  const type = String(command?.type || '').trim() || 'continue';
  const actions = Array.isArray(command.actions) ? command.actions : [];
  const verifier = state?.runtimeState?.verifier || state?.runtimeState?.worldState?.verificationPlan || {};
  const steps = [];
  if (type === 'act') {
    steps.push(...actions.map((action, index) => ({
      id: action.id || `action-${index + 1}`,
      status: 'pending',
      kind: 'tool',
      toolName: action.toolName || '',
      summary: summarizeAction(action),
    })));
  } else {
    steps.push({
      id: `turn-${turn || 'current'}-${type}`,
      status: type === 'finalize' ? 'proposed' : 'pending',
      kind: type,
      summary: compactText(command.text || result.text || result.report || result.content || type, 700),
    });
  }
  return {
    status: statusForCommand(type),
    intent: intentForCommand(type),
    objective: state?.goal || state?.spec?.goal || '',
    turn,
    steps,
    blockers: [],
    evidenceNeeded: verifier?.required === true && verifier.ok !== true ? ['runtime_verification'] : [],
  };
}

function buildObservationPlanUpdate(observations = [], { turn = null, state = {} } = {}) {
  const failed = (Array.isArray(observations) ? observations : []).filter((item) => item?.isError === true || item?.ok === false);
  const succeeded = (Array.isArray(observations) ? observations : []).filter((item) => item?.ok === true && item?.isError !== true);
  const verifier = state?.runtimeState?.verifier || state?.runtimeState?.worldState?.verificationPlan || {};
  return {
    status: failed.length > 0 ? 'needs_recovery' : 'observed',
    intent: failed.length > 0 ? 'recover_failed_observation' : 'continue_after_observation',
    objective: state?.goal || state?.spec?.goal || '',
    turn,
    steps: [
      ...succeeded.map((item, index) => ({
        id: item.id || `observed-ok-${index + 1}`,
        status: 'done',
        kind: 'observation',
        toolName: item.toolName || '',
        summary: compactText(item.content || item.stdoutExcerpt || '', 500),
      })),
      ...failed.map((item, index) => ({
        id: item.id || `observed-failed-${index + 1}`,
        status: 'failed',
        kind: 'observation',
        toolName: item.toolName || '',
        summary: compactText(item.error || item.stderrExcerpt || item.content || '', 500),
      })),
    ],
    blockers: failed.map((item) => `failure:${item.toolName || item.id || 'unknown'}`),
    evidenceNeeded: verifier?.required === true && verifier.ok !== true ? ['runtime_verification'] : [],
  };
}

function buildRecoveryPolicyUpdate(recovery = {}, { state = {} } = {}) {
  const current = state?.runtimeState?.recovery || {};
  const verifierPlan = recovery?.data?.verifierPlan || state?.runtimeState?.verifier || {};
  const failedObservationIds = Array.isArray(recovery?.observations)
    ? recovery.observations.map((item) => item?.id).filter(Boolean)
    : [];
  return {
    status: recovery.shouldRecover ? 'required' : 'idle',
    ...(recovery.recoveryExhausted ? { status: 'exhausted' } : {}),
    attemptCount: Number(current.attemptCount || 0) + (recovery.shouldRecover ? 1 : 0),
    maxAttempts: recovery.maxAttempts ?? recovery.max_attempts,
    exhausted: recovery.recoveryExhausted === true,
    repeatFailureCount: Number.isFinite(Number(recovery.repeatFailureCount ?? recovery.repeat_failure_count)) ? Number(recovery.repeatFailureCount ?? recovery.repeat_failure_count) : 0,
    maxRepeatedFailures: recovery.maxRepeatedFailures ?? recovery.max_repeated_failures,
    lastFailureSignature: recovery.failureSignature || recovery.failure_signature || '',
    recoveryType: recovery.recoveryType || 'tool_failure',
    reason: recovery.reason || '',
    failedToolNames: recovery.failedToolNames || [],
    failedObservationIds,
    strategy: '',
    nextSteps: [],
    verifierRequired: verifierPlan?.required === true,
  };
}

function statusForCommand(type) {
  if (type === 'act') return 'acting';
  if (type === 'verify') return 'verifying';
  if (type === 'recover') return 'recovering';
  if (type === 'finalize') return 'finalization_proposed';
  if (type === 'block') return 'blocking';
  if (['ask_user', 'request_secret', 'request_approval'].includes(type)) return 'waiting_input';
  return 'deciding';
}

function intentForCommand(type) {
  if (type === 'act') return 'execute_tool_actions';
  if (type === 'verify') return 'verify_runtime_outcome';
  if (type === 'recover') return 'perform_recovery';
  if (type === 'finalize') return 'propose_final_outcome';
  if (type === 'block') return 'stop_as_blocked';
  if (type === 'ask_user') return 'collect_user_input';
  if (type === 'request_secret') return 'collect_secret_reference';
  if (type === 'request_approval') return 'collect_approval';
  return 'continue_decision_loop';
}

function summarizeAction(action = {}) {
  const args = action.args && typeof action.args === 'object' ? action.args : {};
  if (args.command) return `${action.toolName || 'tool'}: ${String(args.command).slice(0, 300)}`;
  return action.toolName || 'tool action';
}

function ensureRuntimeState(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) state.runtimeState = {};
  if (!state.runtimeState.plan || typeof state.runtimeState.plan !== 'object' || Array.isArray(state.runtimeState.plan)) {
    state.runtimeState.plan = createRuntimePlanState();
  }
  if (!state.runtimeState.recovery || typeof state.runtimeState.recovery !== 'object' || Array.isArray(state.runtimeState.recovery)) {
    state.runtimeState.recovery = createRuntimeRecoveryState();
  }
  return state.runtimeState;
}

function ensureRuntimeMemory(state) {
  if (!state.memory || typeof state.memory !== 'object' || Array.isArray(state.memory)) state.memory = {};
  if (!Array.isArray(state.memory.plans)) state.memory.plans = [];
  if (!Array.isArray(state.memory.recoveries)) state.memory.recoveries = [];
  return state.memory;
}

function appendRuntimeHistory(runtimeState, key, item, limit) {
  if (!Array.isArray(runtimeState[key])) runtimeState[key] = [];
  if (key === 'recoveryHistory') {
    runtimeState[key].push({
      status: item.status,
      attemptCount: item.attemptCount,
      maxAttempts: item.maxAttempts,
      exhausted: item.exhausted === true,
      repeatFailureCount: item.repeatFailureCount,
      maxRepeatedFailures: item.maxRepeatedFailures,
      recoveryType: item.recoveryType,
      reason: item.reason,
      failedToolNames: item.failedToolNames,
      failedObservationIds: item.failedObservationIds,
      strategy: item.strategy,
      nextSteps: item.nextSteps,
      verifierRequired: item.verifierRequired === true,
      updatedAt: item.updatedAt,
    });
  } else {
    runtimeState[key].push({
      status: item.status,
      intent: item.intent,
      objective: item.objective,
      turn: item.turn,
      blockers: item.blockers,
      evidenceNeeded: item.evidenceNeeded,
      updatedAt: item.updatedAt,
    });
  }
  runtimeState[key] = runtimeState[key].slice(-limit);
}

function normalizePlanSteps(value) {
  return Array.isArray(value) ? value.map(normalizePlanStep).filter(Boolean) : [];
}

function normalizePlanStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id || '').trim();
  return {
    id: id || `step-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: String(value.status || 'pending'),
    kind: String(value.kind || value.type || ''),
    toolName: String(value.toolName || value.tool_name || ''),
    summary: compactText(value.summary || value.text || '', 700),
  };
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function nullableNumber(value) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

module.exports = {
  applyRuntimePlanToState,
  applyRuntimeRecoveryToState,
  buildDecisionPlanUpdate,
  buildObservationPlanUpdate,
  buildPreDecisionPlan,
  buildRecoveryPolicyUpdate,
  createRuntimePlanState,
  createRuntimeRecoveryState,
};
