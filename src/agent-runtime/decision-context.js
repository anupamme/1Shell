'use strict';

function buildAgentDecisionContext(state = {}, options = {}) {
  if (!state || typeof state !== 'object') return '';
  const snapshot = buildAgentDecisionSnapshot(state, options);
  return [
    '',
    '## AgentRun Decision Context',
    'The following JSON is runtime state for the next agent decision. Treat it as observed state, not user prose.',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
  ].join('\n');
}

function buildAgentDecisionSnapshot(state = {}, options = {}) {
  const maxObservations = toPositiveInt(options.maxObservations, 6);
  const maxFailures = toPositiveInt(options.maxFailures, 5);
  const maxSideEffects = toPositiveInt(options.maxSideEffects, 6);
  const runtimeState = state.runtimeState || {};
  const worldState = runtimeState.worldState || {};
  const verifier = runtimeState.verifier || worldState.verificationPlan || null;
  return {
    schemaVersion: 1,
    run: {
      runId: state.runId || '',
      source: state.source || '',
      goal: compactText(state.goal || '', 500),
      runnerStatus: state.runnerStatus || '',
      taskStatus: state.taskStatus || '',
      currentTurn: state.currentTurn ?? null,
      currentPhase: state.currentPhase || '',
    },
    graph: {
      currentNode: runtimeState.currentNode || '',
      previousNode: runtimeState.previousNode || '',
      status: runtimeState.status || '',
      transitionCount: Number(runtimeState.transitionCount || 0),
      lastCommand: summarizeCommand(runtimeState.lastCommand),
    },
    cognition: summarizeCognition(runtimeState.cognition),
    decisionReview: summarizeDecisionReview(runtimeState.decisionReview),
    replay: summarizeReplay(runtimeState.replay),
    trajectory: summarizeTrajectory(runtimeState.trajectory),
    plan: summarizePlan(runtimeState.plan),
    recovery: summarizeRecovery(runtimeState.recovery),
    budget: summarizeBudget(state.budget),
    pendingInterrupts: summarizeInterrupts(state.interrupts),
    recentInterrupts: summarizeRecentInterrupts(state.interrupts),
    verifier: summarizeVerifier(verifier),
    world: {
      facts: summarizeFacts(worldState.facts, 8),
      failures: summarizeFailures(worldState.failures, maxFailures),
      sideEffects: summarizeSideEffects(worldState.sideEffects, maxSideEffects),
      openQuestions: summarizeOpenQuestions(worldState.openQuestions, 6),
    },
    recentObservations: summarizeObservations(state.observations, maxObservations),
  };
}

function summarizeDecisionReview(review = null) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return { status: 'not_reviewed', kind: '', reasons: [], originalCommand: null, effectiveCommand: null };
  }
  return {
    status: review.status || '',
    kind: review.kind || '',
    turn: review.turn ?? null,
    reasons: normalizeStringArray(review.reasons).slice(0, 10),
    originalCommand: summarizeCommand(review.originalCommand || review.original_command),
    effectiveCommand: summarizeCommand(review.effectiveCommand || review.effective_command),
    message: compactText(review.message || '', 500),
  };
}

function summarizeCognition(cognition = null) {
  if (!cognition || typeof cognition !== 'object' || Array.isArray(cognition)) {
    return {
      status: 'empty',
      objective: '',
      successCriteria: [],
      knownFacts: [],
      unknowns: [],
      assumptions: [],
      constraints: [],
      risks: [],
      candidateActions: [],
      selectedAction: null,
      evidenceNeeded: [],
      blockers: [],
      decisionBasis: '',
    };
  }
  return {
    status: cognition.status || '',
    objective: compactText(cognition.objective || '', 500),
    successCriteria: summarizeCognitionItems(cognition.successCriteria, 8),
    knownFacts: summarizeCognitionItems(cognition.knownFacts, 12),
    unknowns: summarizeCognitionItems(cognition.unknowns, 8),
    assumptions: summarizeCognitionItems(cognition.assumptions, 8),
    constraints: summarizeCognitionItems(cognition.constraints, 8),
    risks: summarizeCognitionItems(cognition.risks, 8),
    candidateActions: summarizeCognitionItems(cognition.candidateActions, 8),
    selectedAction: cognition.selectedAction ? {
      type: cognition.selectedAction.type || '',
      toolNames: Array.isArray(cognition.selectedAction.toolNames) ? cognition.selectedAction.toolNames.slice(0, 8) : [],
      summary: compactText(cognition.selectedAction.summary || '', 500),
      reviewStatus: cognition.selectedAction.reviewStatus || '',
      reviewKind: cognition.selectedAction.reviewKind || '',
    } : null,
    evidenceNeeded: summarizeCognitionItems(cognition.evidenceNeeded, 8),
    blockers: summarizeCognitionItems(cognition.blockers, 8),
    decisionBasis: compactText(cognition.decisionBasis || '', 500),
    updatedBy: cognition.updatedBy || '',
    updatedAt: cognition.updatedAt || '',
  };
}

function summarizeReplay(replay = null) {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) {
    return { status: 'not_evaluated', ok: true, reasons: [], recommendedTaskStatus: '' };
  }
  return {
    status: replay.status || '',
    ok: replay.ok !== false,
    reasons: normalizeStringArray(replay.reasons).slice(0, 10),
    recommendedTaskStatus: replay.recommendedTaskStatus || replay.recommended_task_status || '',
  };
}

function summarizeTrajectory(trajectory = null) {
  if (!trajectory || typeof trajectory !== 'object' || Array.isArray(trajectory)) {
    return { status: 'not_evaluated', ok: true, reasons: [], counts: {} };
  }
  return {
    status: trajectory.status || '',
    ok: trajectory.ok !== false,
    reasons: normalizeStringArray(trajectory.reasons).slice(0, 10),
    counts: trajectory.counts && typeof trajectory.counts === 'object' ? { ...trajectory.counts } : {},
    failedChecks: (Array.isArray(trajectory.checks) ? trajectory.checks : [])
      .filter((item) => item?.ok !== true)
      .slice(0, 10)
      .map((item) => ({
        id: item.id || '',
        reasons: normalizeStringArray(item.reasons).slice(0, 5),
      })),
  };
}

function summarizePlan(plan = null) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { status: 'empty', intent: '', steps: [], blockers: [], evidenceNeeded: [] };
  }
  return {
    status: plan.status || '',
    intent: plan.intent || '',
    objective: compactText(plan.objective || '', 500),
    turn: plan.turn ?? null,
    blockers: normalizeStringArray(plan.blockers).slice(0, 10),
    evidenceNeeded: normalizeStringArray(plan.evidenceNeeded || plan.evidence_needed).slice(0, 10),
    steps: (Array.isArray(plan.steps) ? plan.steps : []).slice(0, 10).map((item) => ({
      id: item?.id || '',
      status: item?.status || '',
      kind: item?.kind || item?.type || '',
      toolName: item?.toolName || item?.tool_name || '',
      summary: compactText(item?.summary || item?.text || '', 500),
    })),
  };
}

function summarizeRecovery(recovery = null) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    return { status: 'idle', attemptCount: 0, recoveryType: '', failedToolNames: [], nextSteps: [] };
  }
  return {
    status: recovery.status || '',
    attemptCount: Number(recovery.attemptCount || 0),
    maxAttempts: recovery.maxAttempts ?? recovery.max_attempts ?? null,
    exhausted: recovery.exhausted === true,
    repeatFailureCount: Number(recovery.repeatFailureCount || recovery.repeat_failure_count || 0),
    maxRepeatedFailures: recovery.maxRepeatedFailures ?? recovery.max_repeated_failures ?? null,
    recoveryType: recovery.recoveryType || recovery.recovery_type || '',
    reason: compactText(recovery.reason || '', 500),
    lastFailureSignature: compactText(recovery.lastFailureSignature || recovery.last_failure_signature || '', 300),
    failedToolNames: normalizeStringArray(recovery.failedToolNames || recovery.failed_tool_names).slice(0, 10),
    failedObservationIds: normalizeStringArray(recovery.failedObservationIds || recovery.failed_observation_ids).slice(0, 10),
    strategy: compactText(recovery.strategy || '', 500),
    nextSteps: normalizeStringArray(recovery.nextSteps || recovery.next_steps).slice(0, 10),
    verifierRequired: recovery.verifierRequired === true || recovery.verifier_required === true,
  };
}

function summarizeBudget(budget = {}) {
  if (!budget || typeof budget !== 'object') return {};
  return {
    usedToolCalls: Number(budget.usedToolCalls || 0),
    maxToolCalls: budget.maxToolCalls ?? null,
    usedCommands: Number(budget.usedCommands || 0),
    maxCommands: budget.maxCommands ?? null,
    maxRuntimeMs: budget.maxRuntimeMs ?? null,
  };
}

function summarizeInterrupts(interrupts = []) {
  return (Array.isArray(interrupts) ? interrupts : [])
    .filter((item) => item?.status === 'pending')
    .slice(-5)
    .map((item) => ({
      id: item.id || '',
      type: item.type || '',
      reason: compactText(item.reason || item.message || '', 300),
      createdAt: item.createdAt || '',
    }));
}

function summarizeRecentInterrupts(interrupts = []) {
  return (Array.isArray(interrupts) ? interrupts : [])
    .slice(-5)
    .map((item) => ({
      id: item.id || '',
      type: item.type || '',
      status: item.status || '',
      reason: compactText(item.reason || item.message || '', 300),
      resolutionStatus: item.resolution?.status || '',
      resolvedAt: item.resolvedAt || '',
      createdAt: item.createdAt || '',
    }));
}

function summarizeVerifier(verifier = null) {
  if (!verifier || typeof verifier !== 'object' || Array.isArray(verifier)) {
    return { required: false, status: 'not_required', ok: true, reasons: [], requirements: [] };
  }
  return {
    required: verifier.required === true,
    status: verifier.status || '',
    ok: verifier.ok === true,
    reasons: normalizeStringArray(verifier.reasons),
    requirements: (Array.isArray(verifier.requirements) ? verifier.requirements : []).slice(0, 10).map((item) => ({
      id: item.id || '',
      source: item.source || '',
      type: item.type || '',
      toolName: item.toolName || '',
      summary: compactText(item.summary || '', 500),
    })),
  };
}

function summarizeFacts(facts = [], limit = 8) {
  return (Array.isArray(facts) ? facts : []).slice(-limit).map((item) => ({
    id: item.id || '',
    type: item.factType || item.kind || '',
    toolName: item.toolName || '',
    text: compactText(item.text || '', 300),
  }));
}

function summarizeFailures(failures = [], limit = 5) {
  return (Array.isArray(failures) ? failures : []).slice(-limit).map((item) => ({
    id: item.id || '',
    status: item.status || '',
    toolName: item.toolName || '',
    error: compactText(item.error || item.text || '', 500),
  }));
}

function summarizeSideEffects(sideEffects = [], limit = 6) {
  return (Array.isArray(sideEffects) ? sideEffects : []).slice(-limit).map((item) => ({
    id: item.id || '',
    toolName: item.toolName || '',
    ok: item.ok === true,
    requiresVerification: item.requiresVerification === true,
    verified: item.verified === true,
    summary: compactText(item.summary || item.text || '', 500),
  }));
}

function summarizeOpenQuestions(openQuestions = [], limit = 6) {
  return (Array.isArray(openQuestions) ? openQuestions : []).slice(-limit).map((item) => (
    typeof item === 'string'
      ? compactText(item, 300)
      : {
        id: item?.id || '',
        question: compactText(item?.question || item?.text || '', 300),
      }
  ));
}

function summarizeObservations(observations = [], limit = 6) {
  return (Array.isArray(observations) ? observations : []).slice(-limit).map((item) => ({
    id: item.id || '',
    turn: item.turn ?? null,
    kind: item.kind || '',
    toolName: item.toolName || '',
    ok: item.ok === true,
    isError: item.isError === true,
    content: compactText(item.content || item.stdoutExcerpt || item.stderrExcerpt || item.error || '', 700),
  }));
}

function summarizeCognitionItems(items = [], limit = 8) {
  return (Array.isArray(items) ? items : []).slice(-limit).map((item) => {
    if (typeof item === 'string') return compactText(item, 300);
    return {
      id: item?.id || '',
      type: item?.type || item?.kind || '',
      text: compactText(item?.text || item?.summary || item?.content || '', 300),
      source: item?.source || '',
      confidence: item?.confidence || '',
    };
  }).filter((item) => typeof item === 'string' ? Boolean(item) : Boolean(item.text || item.id));
}

function summarizeCommand(command = null) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  return {
    type: command.type || command.commandType || '',
    status: command.status || '',
    final: command.final === true,
    text: compactText(command.text || '', 300),
  };
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

module.exports = {
  buildAgentDecisionContext,
  buildAgentDecisionSnapshot,
};
