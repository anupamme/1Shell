'use strict';

const { evaluateAgentFinalGate } = require('./final-gate');
const { evaluateAgentRunOutcome, normalizeAgentTaskStatus } = require('./outcome');
const { cloneAgentState } = require('./store');
const { evaluateAgentTrajectory } = require('./trajectory');
const { evaluateVerifierPlan } = require('./verifiers');

function createReplayEvaluationState() {
  return {
    schemaVersion: 1,
    status: 'not_evaluated',
    ok: true,
    reasons: [],
    checks: [],
    recommendedTaskStatus: '',
    evaluatedAt: '',
  };
}

function evaluateAgentRunReplay(state = {}, options = {}) {
  const snapshot = cloneAgentState(state);
  const result = normalizeObject(options.result || snapshot.result);
  const finalText = String(options.finalText || result.report || result.content || result.text || '').trim();
  const trajectory = evaluateAgentTrajectory(snapshot, { result, finalText });
  const verifierPlan = evaluateVerifierPlan(snapshot);
  const outcome = evaluateAgentRunOutcome(snapshot, {
    fallbackTaskStatus: options.fallbackTaskStatus || options.fallback_task_status || 'unverified',
  });
  const finalGate = evaluateAgentFinalGate(snapshot, {
    result,
    finalText,
    repairCount: Number.isFinite(Number(options.repairCount ?? options.repair_count)) ? Number(options.repairCount ?? options.repair_count) : 0,
  });

  const checks = [];
  pushCheck(checks, 'trajectory_ok', trajectory.ok === true, trajectory.reasons.length ? trajectory.reasons : ['replay_trajectory_failed']);
  pushCheck(checks, 'final_gate_closed', finalGate.shouldContinue !== true, finalGate.reasons?.length ? finalGate.reasons : ['replay_final_gate_open']);
  if (verifierPlan.required === true) {
    pushCheck(checks, 'verifier_ok', verifierPlan.ok === true, verifierPlan.reasons.length ? verifierPlan.reasons : [`replay_verifier_${verifierPlan.status || 'not_satisfied'}`]);
  }
  if (isSuccessLike(snapshot.taskStatus) || isSuccessLike(result.status)) {
    pushCheck(checks, 'success_status_supported', trajectory.ok === true && (verifierPlan.required !== true || verifierPlan.ok === true), ['replay_success_not_supported_by_runtime_evidence']);
  }

  const failed = checks.filter((item) => item.ok !== true);
  const reasons = uniqueStrings(failed.flatMap((item) => item.reasons));
  const recommendedTaskStatus = recommendTaskStatus({ state: snapshot, result, trajectory, verifierPlan, outcome, finalGate });
  return {
    schemaVersion: 1,
    status: failed.length === 0 ? 'passed' : 'failed',
    ok: failed.length === 0,
    reasons,
    checks,
    recommendedTaskStatus,
    trajectory,
    verifierPlan: summarizeVerifierPlan(verifierPlan),
    outcome,
    finalGate: summarizeFinalGate(finalGate),
    evaluatedAt: new Date().toISOString(),
  };
}

function applyReplayEvaluationToState(state = {}, evaluation = {}) {
  const runtimeState = ensureRuntimeState(state);
  const now = evaluation.evaluatedAt || new Date().toISOString();
  const item = {
    schemaVersion: 1,
    status: String(evaluation.status || (evaluation.ok === false ? 'failed' : 'passed')),
    ok: evaluation.ok !== false,
    reasons: normalizeStringArray(evaluation.reasons),
    checks: normalizeChecks(evaluation.checks),
    recommendedTaskStatus: String(evaluation.recommendedTaskStatus || evaluation.recommended_task_status || ''),
    trajectory: normalizeObject(evaluation.trajectory),
    verifierPlan: normalizeObject(evaluation.verifierPlan || evaluation.verifier_plan),
    outcome: normalizeObject(evaluation.outcome),
    finalGate: normalizeObject(evaluation.finalGate || evaluation.final_gate),
    evaluatedAt: now,
  };
  runtimeState.replay = item;
  if (!Array.isArray(runtimeState.replayHistory)) runtimeState.replayHistory = [];
  runtimeState.replayHistory.push(item);
  runtimeState.replayHistory = runtimeState.replayHistory.slice(-50);

  const memory = ensureRuntimeMemory(state);
  memory.replayEvaluations.push({
    status: item.status,
    ok: item.ok,
    reasons: item.reasons,
    recommendedTaskStatus: item.recommendedTaskStatus,
    evaluatedAt: item.evaluatedAt,
  });
  memory.replayEvaluations = memory.replayEvaluations.slice(-50);
  return item;
}

function recommendTaskStatus({ state = {}, result = {}, trajectory = {}, verifierPlan = {}, outcome = {}, finalGate = {} } = {}) {
  const current = normalizeAgentTaskStatus(state.taskStatus || result.taskStatus || result.status, 'unknown');
  if (finalGate.forcedStatus) return normalizeAgentTaskStatus(finalGate.forcedStatus, 'unverified');
  if (trajectory.ok !== true) {
    const reasons = Array.isArray(trajectory.reasons) ? trajectory.reasons : [];
    if (reasons.some((reason) => reason === 'trajectory_side_effect_unverified' || reason.startsWith('trajectory_verifier_'))) return 'unverified';
    return 'blocked';
  }
  if (verifierPlan.required === true && verifierPlan.ok !== true) {
    if (verifierPlan.status === 'failed') return 'failed';
    return 'unverified';
  }
  if (verifierPlan.required === true && verifierPlan.ok === true) return 'verified';
  if (current === 'verified') return 'verified';
  if (current === 'success') return 'success';
  return normalizeAgentTaskStatus(outcome.taskStatus, current || 'unverified');
}

function pushCheck(checks, id, ok, reasons = [], data = {}) {
  checks.push({
    id,
    ok: ok === true,
    reasons: ok === true ? [] : normalizeStringArray(reasons),
    data: normalizeObject(data),
  });
}

function isSuccessLike(status = '') {
  return ['success', 'verified'].includes(normalizeAgentTaskStatus(status, 'unknown'));
}

function summarizeVerifierPlan(plan = {}) {
  return {
    required: plan.required === true,
    ok: plan.ok === true,
    status: plan.status || '',
    reasons: normalizeStringArray(plan.reasons),
    requirementIds: Array.isArray(plan.requirements)
      ? plan.requirements.map((item) => String(item?.id || '').trim()).filter(Boolean)
      : [],
  };
}

function summarizeFinalGate(gate = {}) {
  return {
    shouldContinue: gate.shouldContinue === true,
    forcedStatus: gate.forcedStatus || '',
    reasons: normalizeStringArray(gate.reasons),
  };
}

function normalizeChecks(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    id: String(item?.id || ''),
    ok: item?.ok === true,
    reasons: normalizeStringArray(item?.reasons),
    data: normalizeObject(item?.data),
  }));
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
  if (!state.runtimeState.replay || typeof state.runtimeState.replay !== 'object' || Array.isArray(state.runtimeState.replay)) {
    state.runtimeState.replay = createReplayEvaluationState();
  }
  if (!Array.isArray(state.runtimeState.replayHistory)) state.runtimeState.replayHistory = [];
  return state.runtimeState;
}

function ensureRuntimeMemory(state) {
  if (!state.memory || typeof state.memory !== 'object' || Array.isArray(state.memory)) state.memory = {};
  if (!Array.isArray(state.memory.replayEvaluations)) state.memory.replayEvaluations = [];
  return state.memory;
}

module.exports = {
  applyReplayEvaluationToState,
  createReplayEvaluationState,
  evaluateAgentRunReplay,
};
