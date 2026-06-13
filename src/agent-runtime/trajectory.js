'use strict';

function createTrajectoryEvaluationState() {
  return {
    schemaVersion: 1,
    status: 'not_evaluated',
    ok: true,
    reasons: [],
    checks: [],
    counts: {},
    evaluatedAt: '',
  };
}

function applyTrajectoryEvaluationToState(state = {}, evaluation = {}) {
  const runtimeState = ensureRuntimeState(state);
  const now = evaluation.evaluatedAt || new Date().toISOString();
  const item = {
    schemaVersion: 1,
    status: String(evaluation.status || (evaluation.ok === false ? 'failed' : 'passed')),
    ok: evaluation.ok !== false,
    reasons: normalizeStringArray(evaluation.reasons),
    checks: normalizeChecks(evaluation.checks),
    counts: normalizeObject(evaluation.counts),
    evaluatedAt: now,
  };
  runtimeState.trajectory = item;
  if (!Array.isArray(runtimeState.trajectoryHistory)) runtimeState.trajectoryHistory = [];
  runtimeState.trajectoryHistory.push(item);
  runtimeState.trajectoryHistory = runtimeState.trajectoryHistory.slice(-50);

  const memory = ensureRuntimeMemory(state);
  memory.trajectoryEvaluations.push({
    status: item.status,
    ok: item.ok,
    reasons: item.reasons,
    counts: item.counts,
    evaluatedAt: item.evaluatedAt,
  });
  memory.trajectoryEvaluations = memory.trajectoryEvaluations.slice(-50);
  return item;
}

function evaluateAgentTrajectory(state = {}, options = {}) {
  const result = normalizeObject(options.result || state.result);
  const finalText = String(options.finalText || result.report || result.content || result.text || '').trim();
  const resultStatus = normalizeTaskStatus(result.taskStatus || result.status, 'unknown');
  const hasResultIntent = Boolean(result.status || result.report || result.content || result.text || result.title || state?.result?.status || state?.result?.report || state?.result?.title);
  const explicitNonSuccess = options.explicitNonSuccess === true
    || ['failed', 'blocked', 'unverified', 'partial'].includes(resultStatus)
    || /\b(failed|blocked|unverified|partial)\b/i.test(finalText);
  const successIntent = explicitNonSuccess !== true && ['success', 'verified', 'unknown'].includes(resultStatus);

  const runtimeState = state?.runtimeState || {};
  const world = runtimeState.worldState || {};
  const toolCalls = Array.isArray(state.toolCalls) ? state.toolCalls : [];
  const observations = Array.isArray(state.observations) ? state.observations : [];
  const transitions = Array.isArray(runtimeState.transitions) ? runtimeState.transitions : [];
  const decisionReviews = Array.isArray(runtimeState.decisionReviewHistory) ? runtimeState.decisionReviewHistory : [];
  const pendingInterrupts = (Array.isArray(state.interrupts) ? state.interrupts : []).filter((item) => item?.status === 'pending');
  const resolvedInterrupts = (Array.isArray(state.interrupts) ? state.interrupts : []).filter((item) => item?.status && item.status !== 'pending');
  const sideEffects = Array.isArray(world.sideEffects) ? world.sideEffects : [];
  const failures = Array.isArray(world.failures) ? world.failures : [];
  const verifier = runtimeState.verifier || world.verificationPlan || {};

  const checks = [];
  pushCheck(checks, 'runtime_owner', runtimeState.owner === 'AgentRun' && runtimeState.controller === 'AgentRunController', 'trajectory_runtime_owner_missing');
  pushCheck(checks, 'run_started', hasEvent(state, 'agent:run-started') || transitions.length > 0 || toolCalls.length > 0, 'trajectory_run_not_started');
  pushCheck(checks, 'valid_transitions', !transitions.some((item) => item?.valid === false), 'trajectory_invalid_transition');
  pushCheck(checks, 'pending_interrupts', pendingInterrupts.length === 0, 'trajectory_pending_interrupt');

  if (successIntent && hasResultIntent) {
    pushCheck(checks, 'decision_review_present', decisionReviews.length > 0, 'trajectory_decision_review_missing');
  }

  if (successIntent && toolCalls.length > 0) {
    const missingObservation = toolCalls
      .filter((toolCall) => ['completed', 'failed'].includes(toolCall?.status))
      .filter((toolCall) => !observations.some((item) => item.toolCallId === toolCall.id || item.providerToolUseId === toolCall.providerToolUseId));
    pushCheck(checks, 'tool_results_observed', missingObservation.length === 0, 'trajectory_tool_result_missing_observation', {
      missingToolCallIds: missingObservation.map((item) => item.id).filter(Boolean),
    });
  }

  if (successIntent && resolvedInterrupts.length > 0) {
    const missingResolutionObservation = resolvedInterrupts
      .filter((interrupt) => !observations.some((item) => (
        String(item.kind || '') === 'interrupt_resolution'
        && String(item.data?.interruptId || '') === String(interrupt.id || '')
      )));
    pushCheck(checks, 'interrupt_resolutions_observed', missingResolutionObservation.length === 0, 'trajectory_interrupt_resolution_missing_observation', {
      interruptIds: missingResolutionObservation.map((item) => item.id).filter(Boolean),
      interruptTypes: missingResolutionObservation.map((item) => item.type).filter(Boolean),
    });
  }

  if (successIntent) {
    const unrecoveredFailures = failures.filter((item) => item && item.status !== 'recovered');
    pushCheck(checks, 'failures_recovered', unrecoveredFailures.length === 0, 'trajectory_unrecovered_failure', {
      failureIds: unrecoveredFailures.map((item) => item.id).filter(Boolean),
      failedTools: unrecoveredFailures.map((item) => item.toolName).filter(Boolean),
    });
  }

  if (successIntent) {
    const unverifiedSideEffects = sideEffects.filter((item) => item?.requiresVerification === true && item?.ok !== false && item?.verified !== true);
    pushCheck(checks, 'side_effects_verified', unverifiedSideEffects.length === 0, 'trajectory_side_effect_unverified', {
      sideEffectIds: unverifiedSideEffects.map((item) => item.id).filter(Boolean),
      tools: unverifiedSideEffects.map((item) => item.toolName).filter(Boolean),
    });
  }

  if (successIntent && verifier?.required === true) {
    pushCheck(checks, 'verifier_satisfied', verifier.ok === true, `trajectory_verifier_${verifier.status || 'not_satisfied'}`, {
      verifierStatus: verifier.status || '',
      verifierReasons: Array.isArray(verifier.reasons) ? verifier.reasons : [],
    });
  }

  const failedChecks = checks.filter((item) => item.ok !== true);
  const reasons = uniqueStrings(failedChecks.flatMap((item) => item.reasons));
  return {
    schemaVersion: 1,
    status: failedChecks.length === 0 ? 'passed' : 'failed',
    ok: failedChecks.length === 0,
    reasons,
    checks,
    counts: {
      turns: Array.isArray(state.turns) ? state.turns.length : 0,
      transitions: transitions.length,
      decisionReviews: decisionReviews.length,
      toolCalls: toolCalls.length,
      observations: observations.length,
      pendingInterrupts: pendingInterrupts.length,
      resolvedInterrupts: resolvedInterrupts.length,
      sideEffects: sideEffects.length,
      failures: failures.length,
    },
    evaluatedAt: new Date().toISOString(),
  };
}

function pushCheck(checks, id, ok, reason, data = {}) {
  checks.push({
    id,
    ok: ok === true,
    reasons: ok === true ? [] : [reason],
    data: normalizeObject(data),
  });
}

function hasEvent(state = {}, type = '') {
  return (Array.isArray(state.events) ? state.events : []).some((event) => event?.type === type);
}

function normalizeChecks(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    id: String(item?.id || ''),
    ok: item?.ok === true,
    reasons: normalizeStringArray(item?.reasons),
    data: normalizeObject(item?.data),
  }));
}

function normalizeTaskStatus(status, fallback = 'unknown') {
  const value = String(status || '').trim().toLowerCase();
  if (['verified', 'passed', 'validated'].includes(value)) return 'verified';
  if (['success', 'succeeded', 'done', 'completed', 'complete'].includes(value)) return 'success';
  if (['failed', 'failure', 'error'].includes(value)) return 'failed';
  if (['partial', 'warning', 'warn'].includes(value)) return 'partial';
  if (['blocked', 'waiting_approval', 'interrupted'].includes(value)) return 'blocked';
  if (['unverified', 'unknown'].includes(value)) return value;
  return fallback;
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean)));
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function ensureRuntimeState(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) state.runtimeState = {};
  if (!state.runtimeState.trajectory || typeof state.runtimeState.trajectory !== 'object' || Array.isArray(state.runtimeState.trajectory)) {
    state.runtimeState.trajectory = createTrajectoryEvaluationState();
  }
  if (!Array.isArray(state.runtimeState.trajectoryHistory)) state.runtimeState.trajectoryHistory = [];
  return state.runtimeState;
}

function ensureRuntimeMemory(state) {
  if (!state.memory || typeof state.memory !== 'object' || Array.isArray(state.memory)) state.memory = {};
  if (!Array.isArray(state.memory.trajectoryEvaluations)) state.memory.trajectoryEvaluations = [];
  return state.memory;
}

module.exports = {
  applyTrajectoryEvaluationToState,
  createTrajectoryEvaluationState,
  evaluateAgentTrajectory,
};
