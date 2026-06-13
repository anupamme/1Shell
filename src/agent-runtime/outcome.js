'use strict';

function evaluateAgentRunOutcome(state, { fallbackTaskStatus = 'unverified' } = {}) {
  if (!state || typeof state !== 'object') {
    return { taskStatus: fallbackTaskStatus, reasons: ['agent_state_missing'] };
  }

  const reasons = [];
  const currentStatus = normalizeAgentTaskStatus(state.taskStatus, 'unknown');
  if (['blocked', 'failed'].includes(currentStatus)) {
    return { taskStatus: currentStatus, reasons: [`task_status_${currentStatus}`] };
  }

  const phases = Object.values(normalizeObject(state.phases));
  const requiredPhases = phases.filter((phase) => phase?.required === true);
  const failedRequiredPhases = requiredPhases.filter((phase) => phase.status === 'failed');
  if (failedRequiredPhases.length > 0) {
    return {
      taskStatus: 'failed',
      reasons: failedRequiredPhases.map((phase) => `required_phase_failed:${phase.id}`),
    };
  }

  const failedOptionalPhases = phases.filter((phase) => phase?.required !== true && phase?.status === 'failed');
  if (failedOptionalPhases.length > 0) {
    reasons.push(...failedOptionalPhases.map((phase) => `optional_phase_failed:${phase.id}`));
  }
  const unresolvedToolFailure = getUnresolvedFailedToolObservation(state);
  if (unresolvedToolFailure) {
    reasons.push(formatToolFailureReason(unresolvedToolFailure));
  }

  const incompleteRequiredPhases = requiredPhases.filter((phase) => !['done'].includes(phase.status));
  if (incompleteRequiredPhases.length > 0) {
    reasons.push(...incompleteRequiredPhases.map((phase) => `required_phase_incomplete:${phase.id}`));
  }

  const budgetReason = getBudgetBlockedReason(state);
  if (budgetReason) {
    return { taskStatus: 'blocked', reasons: [budgetReason, ...reasons] };
  }

  const resultStatus = normalizeAgentTaskStatus(state.result?.status, 'unknown');
  if (['blocked', 'failed', 'partial'].includes(resultStatus)) {
    return { taskStatus: resultStatus, reasons: [`result_status_${resultStatus}`, ...reasons] };
  }
  const verification = getVerificationResult(state);

  if (reasons.some((reason) => reason.startsWith('required_phase_incomplete:'))) {
    return { taskStatus: 'unverified', reasons };
  }

  const verifierPlan = getVerifierPlanResult(state);
  if (verifierPlan?.required === true) {
    const verifierReasons = verifierPlan.reasons.length > 0
      ? verifierPlan.reasons
      : [`verification_${verifierPlan.status || 'required'}`];
    if (verifierPlan.status === 'passed' || verifierPlan.ok === true) {
      return { taskStatus: 'verified', reasons: ['verify_passed', ...verifierReasons, ...reasons] };
    }
    if (verifierPlan.status === 'failed') {
      return { taskStatus: 'failed', reasons: ['verify_failed', ...verifierReasons, ...reasons] };
    }
    if (verifierPlan.status === 'unsupported') {
      return { taskStatus: 'unverified', reasons: ['verify_unsupported', ...verifierReasons, ...reasons] };
    }
    return { taskStatus: 'unverified', reasons: ['verify_required', ...verifierReasons, ...reasons] };
  }

  const sideEffectLedger = getSideEffectLedger(state);
  const sideEffectsRequireVerify = sideEffectLedger.hasSideEffects === true || sideEffectLedger.requiresVerification === true;
  if (sideEffectsRequireVerify) {
    const sideEffectReasons = [
      'side_effects_require_verification',
      ...normalizeStringArray(sideEffectLedger.reasons),
    ];
    if (!verification) {
      return { taskStatus: 'unverified', reasons: [...sideEffectReasons, 'verify_required'] };
    }
    if (verification.ok) {
      return { taskStatus: 'verified', reasons: ['verify_passed', ...sideEffectReasons, ...reasons] };
    }
    if (verification.status === 'unsupported') {
      return { taskStatus: 'unverified', reasons: ['verify_unsupported', ...sideEffectReasons, ...verification.reasons] };
    }
    return { taskStatus: 'failed', reasons: ['verify_failed', ...sideEffectReasons, ...verification.reasons] };
  }

  if (reasons.some((reason) => reason.startsWith('optional_phase_failed:'))) {
    return { taskStatus: 'partial', reasons };
  }

  if (unresolvedToolFailure) {
    return { taskStatus: 'partial', reasons };
  }

  if (currentStatus === 'verified') {
    return { taskStatus: 'verified', reasons: ['task_status_verified'] };
  }

  const outputContract = normalizeObject(state.spec?.outputContract);
  const success = normalizeObject(outputContract.success);
  const verifyItems = Array.isArray(outputContract.verify) ? outputContract.verify : [];
  const requiredBySuccess = normalizeStringArray(success.requiresPhases || success.requires_phases);
  const missingSuccessPhases = requiredBySuccess.filter((phaseId) => state.phases?.[phaseId]?.status !== 'done');
  if (missingSuccessPhases.length > 0) {
    return { taskStatus: 'unverified', reasons: missingSuccessPhases.map((phaseId) => `success_phase_incomplete:${phaseId}`) };
  }

  const requiresVerify = success.requiresVerify === true || success.requires_verify === true || verifyItems.length > 0;
  if (requiresVerify) {
    const verification = getVerificationResult(state);
    if (!verification) return { taskStatus: 'unverified', reasons: ['verify_required'] };
    if (verification.ok) return { taskStatus: 'verified', reasons: ['verify_passed', ...reasons] };
    else if (verification.status === 'unsupported') {
      return { taskStatus: 'unverified', reasons: ['verify_unsupported', ...verification.reasons] };
    } else {
      return { taskStatus: 'failed', reasons: ['verify_failed', ...verification.reasons] };
    }
  }

  const hasResult = Boolean(state.result && (state.result.report || state.result.title || state.result.status));
  if (resultStatus === 'verified') return { taskStatus: 'verified', reasons: ['result_status_verified'] };
  if (resultStatus === 'success' && verification?.ok === true) return { taskStatus: 'verified', reasons: ['result_status_success', 'verify_passed'] };
  if (resultStatus === 'success') return { taskStatus: 'success', reasons: ['result_status_success'] };
  if (hasResult) return { taskStatus: 'unverified', reasons: ['result_published_without_success_status'] };

  return { taskStatus: normalizeAgentTaskStatus(fallbackTaskStatus, 'unverified'), reasons: ['no_final_result'] };
}

function normalizeAgentTaskStatus(status, fallback = 'unknown') {
  const value = String(status || '').trim().toLowerCase();
  if (['verified', 'passed', 'validated'].includes(value)) return 'verified';
  if (['success', 'succeeded', 'done', 'completed', 'complete'].includes(value)) return 'success';
  if (['failed', 'failure', 'error'].includes(value)) return 'failed';
  if (['partial', 'warning', 'warn'].includes(value)) return 'partial';
  if (['blocked', 'waiting_approval', 'interrupted'].includes(value)) return 'blocked';
  if (['unverified', 'unknown'].includes(value)) return value;
  return fallback;
}

function getBudgetBlockedReason(state) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const exceeded = events.find((event) => event?.type === 'agent:budget-exceeded');
  if (exceeded) return `budget_exceeded:${exceeded.payload?.kind || 'unknown'}`;
  return '';
}

function getVerificationResult(state) {
  if (state?.verification && typeof state.verification === 'object') {
    return normalizeVerificationResult(state.verification);
  }
  if (state?.memory?.verification && typeof state.memory.verification === 'object') {
    return normalizeVerificationResult(state.memory.verification);
  }
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
  const artifact = [...artifacts].reverse().find((item) => (
    item?.type === 'verification_result'
    || item?.id === 'agent-verify-result'
    || item?.id === 'ide-verification-result'
  ));
  if (!artifact) return null;
  return normalizeVerificationResult(artifact.data);
}

function getVerifierPlanResult(state) {
  const plan = state?.runtimeState?.verifier || state?.runtimeState?.worldState?.verificationPlan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  return {
    required: plan.required === true,
    status: String(plan.status || (plan.ok === true ? 'passed' : 'missing')).trim() || 'missing',
    ok: plan.ok === true,
    reasons: normalizeStringArray(plan.reasons),
    requirementIds: Array.isArray(plan.requirements)
      ? plan.requirements.map((item) => String(item?.id || item?.source || item?.type || '').trim()).filter(Boolean)
      : [],
  };
}

function normalizeVerificationResult(value) {
  const data = normalizeObject(value);
  const status = String(data.status || (data.ok === true ? 'passed' : 'failed')).trim() || 'failed';
  const reasons = normalizeStringArray(data.reasons);
  return {
    ok: data.ok === true || status === 'passed',
    status,
    taskStatus: String(data.taskStatus || data.task_status || ''),
    reasons: reasons.length ? reasons : [status],
  };
}

function getSideEffectLedger(state) {
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
  const artifact = [...artifacts].reverse().find((item) => item?.type === 'agent_run_ledger' || item?.id === 'ide-agent-run-ledger');
  const data = normalizeObject(artifact?.data);
  const sideEffects = Array.isArray(data.sideEffects) ? data.sideEffects : [];
  const runtimeSideEffects = Array.isArray(state?.runtimeState?.worldState?.sideEffects)
    ? state.runtimeState.worldState.sideEffects
    : [];
  const allSideEffects = [...sideEffects, ...runtimeSideEffects];
  const runtimeRequiresVerification = runtimeSideEffects.some((item) => item?.requiresVerification === true && item?.ok !== false && item?.verified !== true);
  return {
    hasSideEffects: data.hasSideEffects === true || allSideEffects.length > 0,
    requiresVerification: data.requiresVerification === true || runtimeRequiresVerification,
    reasons: normalizeStringArray(data.reasons),
    sideEffects: allSideEffects,
  };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function getUnresolvedFailedToolObservation(state) {
  const observations = Array.isArray(state?.observations) ? state.observations : [];
  const indexedFailures = observations
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isFailedToolObservation(item));
  if (indexedFailures.length === 0) return null;
  const lastFailure = indexedFailures[indexedFailures.length - 1];
  const laterSuccess = observations
    .slice(lastFailure.index + 1)
    .some((item) => item?.ok === true && item?.isError !== true && item?.is_error !== true);
  return laterSuccess ? null : lastFailure.item;
}

function isFailedToolObservation(item) {
  if (!item || typeof item !== 'object') return false;
  const kind = String(item.kind || item.type || '').trim();
  if (kind && kind !== 'tool_result') return false;
  return item.isError === true || item.is_error === true || item.ok === false;
}

function formatToolFailureReason(observation = {}) {
  const toolName = String(observation.toolName || observation.tool_name || 'unknown').trim() || 'unknown';
  const exitCode = Number.isFinite(Number(observation.exitCode)) ? `:exit_${Number(observation.exitCode)}` : '';
  return `tool_result_failed:${toolName}${exitCode}`;
}

module.exports = {
  evaluateAgentRunOutcome,
  getSideEffectLedger,
  getVerifierPlanResult,
  getVerificationResult,
  normalizeAgentTaskStatus,
};
