'use strict';

const { getVerificationResult, normalizeAgentTaskStatus } = require('./outcome');
const { evaluateAgentTrajectory } = require('./trajectory');
const { evaluateVerifierPlan } = require('./verifiers');

function evaluateAgentFinalGate(state = {}, options = {}) {
  const repairCount = toNonNegativeInteger(options.repairCount, 0);
  const maxRepairs = toNonNegativeInteger(options.maxRepairs, 2);
  const result = normalizeObject(options.result || state.result);
  const resultStatus = normalizeAgentTaskStatus(result.taskStatus || result.status, 'unknown');
  const finalText = String(options.finalText || result.report || result.content || result.text || '').trim();
  const explicitNonSuccess = ['failed', 'blocked', 'unverified', 'partial'].includes(resultStatus)
    || /\b(failed|blocked|unverified|partial)\b/i.test(finalText)
    || hasIncompleteOrWaitingFinalText(finalText);

  const reasons = [];
  const trajectoryEvaluation = evaluateAgentTrajectory(state, { result, finalText, explicitNonSuccess });
  const pendingInterrupts = (Array.isArray(state.interrupts) ? state.interrupts : [])
    .filter((interrupt) => interrupt?.status === 'pending');
  if (pendingInterrupts.length > 0) reasons.push('pending_interrupt');

  const runningTools = (Array.isArray(state.toolCalls) ? state.toolCalls : [])
    .filter((toolCall) => toolCall?.status === 'running' || toolCall?.status === 'pending');
  if (runningTools.length > 0) reasons.push('tool_call_incomplete');

  const requiredPhases = Object.values(normalizeObject(state.phases))
    .filter((phase) => phase?.required === true);
  const incompleteRequiredPhases = requiredPhases
    .filter((phase) => !['done', 'failed', 'skipped'].includes(String(phase.status || '')));
  if (incompleteRequiredPhases.length > 0) {
    reasons.push(...incompleteRequiredPhases.map((phase) => `required_phase_incomplete:${phase.id}`));
  }

  const verification = getVerificationResult(state);
  const verifierPlan = evaluateVerifierPlan(state);
  if (verifierPlan.required && verifierPlan.ok !== true) {
    reasons.push(...verifierPlan.reasons);
  }

  if (verification && verification.ok !== true && !explicitNonSuccess) {
    reasons.push(`verification_not_resolved:${verification.status || 'failed'}`);
  }

  if (hasRecentUnrecoveredFailure(state) && !explicitNonSuccess) {
    reasons.push('recent_tool_failure_requires_recovery');
  }

  if (trajectoryEvaluation.ok !== true && !explicitNonSuccess) {
    reasons.push(...trajectoryEvaluation.reasons);
  }

  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  if (uniqueReasons.length === 0) return { shouldContinue: false, reasons: [], verifierPlan, trajectoryEvaluation };

  const canStopAsBlocked = pendingInterrupts.length > 0 || explicitNonSuccess || repairCount >= maxRepairs;
  if (canStopAsBlocked) {
    return {
      shouldContinue: false,
      reasons: uniqueReasons,
      forcedStatus: forcedStatusForReasons(uniqueReasons, resultStatus),
      verifierPlan,
      trajectoryEvaluation,
    };
  }

  return {
    shouldContinue: true,
    reasons: uniqueReasons,
    message: buildRuntimeGateMessage(uniqueReasons, finalText, verifierPlan, trajectoryEvaluation),
    verifierPlan,
    trajectoryEvaluation,
  };
}

function buildRuntimeGateMessage(reasons, finalText = '', verifierPlan = null, trajectoryEvaluation = null) {
  const lines = [
    '[AGENT_RUNTIME_GATE]',
    `reasons=${reasons.join(',')}`,
    'The AgentRun cannot finish yet. Continue the agent loop by observing missing evidence, repairing failed actions, requesting input/approval, or verifying side effects.',
    'If the work is genuinely impossible, publish failed/blocked/unverified with evidence instead of implying success.',
  ];
  if (verifierPlan?.required && verifierPlan.ok !== true) {
    lines.push(
      `verifier_status=${verifierPlan.status}`,
      `verifier_requirements=${verifierPlan.requirements.map((item) => item.id || item.source || item.type).filter(Boolean).join(',')}`,
    );
  }
  if (trajectoryEvaluation?.ok === false) {
    lines.push(
      `trajectory_status=${trajectoryEvaluation.status || 'failed'}`,
      `trajectory_reasons=${trajectoryEvaluation.reasons.join(',')}`,
    );
  }
  if (finalText) lines.push(`Previous final text excerpt:\n${finalText.slice(0, 1200)}`);
  return lines.join('\n');
}

function hasIncompleteOrWaitingFinalText(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  return /你可以.*继续|让我继续|请.*(?:确认|提供|补充|选择)|需要你.*(?:确认|提供|补充|选择|审批)|等待你|如果你.*继续/.test(value)
    || /还未|尚未|未实际|没有真正|缺少|无法|不能|不完整|未验证|未部署|未执行|需要.*(?:输入|参数|确认|审批|Secret|凭据)/.test(value);
}

function hasRecentUnrecoveredFailure(state = {}) {
  const worldFailures = Array.isArray(state?.runtimeState?.worldState?.failures)
    ? state.runtimeState.worldState.failures
    : [];
  if (worldFailures.some((item) => item && item.status !== 'recovered')) return true;
  if (worldFailures.length > 0) return false;

  const observations = Array.isArray(state.observations) ? state.observations : [];
  const lastFailureIndex = findLastIndex(observations, (item) => !isRuntimeDirectiveObservation(item) && (item?.isError === true || item?.ok === false));
  if (lastFailureIndex < 0) return false;
  const later = observations.slice(lastFailureIndex + 1);
  return !later.some((item) => !isRuntimeDirectiveObservation(item) && item?.ok === true);
}

function isRuntimeDirectiveObservation(item = {}) {
  const kind = String(item?.kind || '').trim();
  const toolName = String(item?.toolName || '').trim();
  return kind === 'runtime_gate'
    || kind === 'runtime_recovery'
    || kind === 'verify'
    || toolName === 'agent_final_gate'
    || toolName === 'agent_recovery_planner'
    || toolName === 'agent_controller';
}

function forcedStatusForReasons(reasons, fallback = 'unverified') {
  if (reasons.some((reason) => reason === 'pending_interrupt')) return 'blocked';
  if (reasons.some((reason) => reason.startsWith('verification_failed') || reason.startsWith('verification_not_resolved:failed'))) return 'failed';
  if (reasons.some((reason) => (
    reason.includes('required_phase_incomplete')
    || reason.includes('require_verification')
    || reason.startsWith('verification_required')
    || reason === 'verification_missing'
    || reason === 'verification_unsupported'
    || reason.startsWith('trajectory_side_effect_unverified')
    || reason.startsWith('trajectory_verifier_')
  ))) return 'unverified';
  if (reasons.some((reason) => reason.startsWith('trajectory_'))) return 'blocked';
  return normalizeAgentTaskStatus(fallback, 'unverified');
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

module.exports = {
  evaluateAgentFinalGate,
};
