'use strict';

const { cloneAgentState } = require('./store');

const ACTIVE_RUNNER_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'interrupted']);

function listAgentRuns(runtime, filter = {}) {
  if (!runtime?.listRuns) throw new Error('Agent runtime listRuns is not configured');
  return runtime
    .listRuns()
    .filter((state) => matchesRunFilter(state, filter))
    .map(summarizeAgentRun)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getAgentRun(runtime, runId, { includeEvents = true } = {}) {
  const state = requireAgentRun(runtime, runId);
  const snapshot = cloneAgentState(state);
  if (!includeEvents) snapshot.events = [];
  return snapshot;
}

function getAgentRunTimeline(runtime, runId) {
  const state = requireAgentRun(runtime, runId);
  return normalizeTimelineItems(state).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

function requestAgentApproval(runtime, runId, interruptId = '', resolution = {}) {
  if (!runtime?.resumeRun) throw new Error('Agent runtime resumeRun is not configured');
  const normalized = normalizeObject(resolution);
  const checkpointId = String(normalized.checkpointId || '').trim();
  delete normalized.checkpointId;
  return runtime.resumeRun(runId, {
    checkpointId,
    interruptId,
    resolution: {
      status: normalized.status || 'approved',
      ...normalized,
    },
    runnerStatus: 'running',
  });
}

function cancelAgentRun(runtime, runId, options = {}) {
  if (!runtime?.cancelRun) throw new Error('Agent runtime cancelRun is not configured');
  const normalized = typeof options === 'string' ? { reason: options } : normalizeObject(options);
  return runtime.cancelRun(runId, normalized);
}

function summarizeAgentRun(state = {}) {
  const pendingInterrupts = Array.isArray(state.interrupts)
    ? state.interrupts.filter((interrupt) => interrupt.status === 'pending')
    : [];
  return {
    runId: state.runId || '',
    source: state.source || '',
    goal: state.goal || '',
    runnerStatus: state.runnerStatus || 'unknown',
    taskStatus: state.taskStatus || 'unknown',
    currentPhase: state.currentPhase || '',
    active: ACTIVE_RUNNER_STATUSES.has(state.runnerStatus),
    waitingApproval: state.runnerStatus === 'waiting_approval' || pendingInterrupts.some((item) => ['approval', 'request_approval'].includes(item.type)),
    pendingInterruptCount: pendingInterrupts.length,
    checkpointCount: Array.isArray(state.checkpoints) ? state.checkpoints.length : 0,
    artifactCount: Array.isArray(state.artifacts) ? state.artifacts.length : 0,
    toolCallCount: Array.isArray(state.toolCalls) ? state.toolCalls.length : 0,
    turnCount: Array.isArray(state.turns) ? state.turns.length : 0,
    observationCount: Array.isArray(state.observations) ? state.observations.length : 0,
    currentNode: state.runtimeState?.currentNode || '',
    transitionCount: Number(state.runtimeState?.transitionCount || 0),
    decisionReviewStatus: state.runtimeState?.decisionReview?.status || '',
    decisionReviewKind: state.runtimeState?.decisionReview?.kind || '',
    replayStatus: state.runtimeState?.replay?.status || '',
    replayOk: state.runtimeState?.replay?.ok !== false,
    replayRecommendedTaskStatus: state.runtimeState?.replay?.recommendedTaskStatus || '',
    trajectoryStatus: state.runtimeState?.trajectory?.status || '',
    trajectoryOk: state.runtimeState?.trajectory?.ok !== false,
    planStatus: state.runtimeState?.plan?.status || '',
    planIntent: state.runtimeState?.plan?.intent || '',
    recoveryStatus: state.runtimeState?.recovery?.status || '',
    recoveryType: state.runtimeState?.recovery?.recoveryType || '',
    recoveryAttemptCount: Number(state.runtimeState?.recovery?.attemptCount || 0),
    recoveryRepeatFailureCount: Number(state.runtimeState?.recovery?.repeatFailureCount || 0),
    recoveryExhausted: state.runtimeState?.recovery?.exhausted === true,
    verificationStatus: state.verification?.status || state.memory?.verification?.status || '',
    createdAt: state.createdAt || '',
    updatedAt: state.updatedAt || '',
    metadata: normalizeObject(state.spec?.metadata),
  };
}

function matchesRunFilter(state = {}, filter = {}) {
  const source = String(filter.source || '').trim();
  if (source && state.source !== source) return false;
  const runnerStatus = String(filter.runnerStatus || filter.runner_status || '').trim();
  if (runnerStatus && state.runnerStatus !== runnerStatus) return false;
  const taskStatus = String(filter.taskStatus || filter.task_status || '').trim();
  if (taskStatus && state.taskStatus !== taskStatus) return false;
  if (filter.active === true && !ACTIVE_RUNNER_STATUSES.has(state.runnerStatus)) return false;
  if (filter.active === false && ACTIVE_RUNNER_STATUSES.has(state.runnerStatus)) return false;
  const query = String(filter.query || filter.search || '').trim().toLowerCase();
  if (query) {
    const haystack = `${state.runId || ''} ${state.goal || ''} ${state.source || ''}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function normalizeTimelineItems(state = {}) {
  const items = [];
  for (const event of Array.isArray(state.events) ? state.events : []) {
    items.push({
      kind: 'event',
      type: event.type || '',
      runId: event.runId || state.runId || '',
      source: event.source || state.source || '',
      at: event.at || '',
      payload: normalizeObject(event.payload),
    });
  }
  for (const checkpoint of Array.isArray(state.checkpoints) ? state.checkpoints : []) {
    items.push({
      kind: 'checkpoint',
      type: 'agent:checkpoint-created',
      runId: state.runId || '',
      at: checkpoint.createdAt || '',
      checkpoint: summarizeCheckpoint(checkpoint),
    });
  }
  for (const interrupt of Array.isArray(state.interrupts) ? state.interrupts : []) {
    items.push({
      kind: 'interrupt',
      type: 'agent:interrupt-created',
      runId: state.runId || '',
      at: interrupt.createdAt || interrupt.resolvedAt || '',
      interrupt: summarizeInterrupt(interrupt),
    });
  }
  for (const turn of Array.isArray(state.turns) ? state.turns : []) {
    items.push({
      kind: 'turn',
      type: 'agent:turn-updated',
      runId: state.runId || '',
      at: turn.endedAt || turn.startedAt || '',
      turn: summarizeTurn(turn),
    });
  }
  for (const transition of Array.isArray(state.runtimeState?.transitions) ? state.runtimeState.transitions : []) {
    items.push({
      kind: 'transition',
      type: 'agent:runtime-transition',
      runId: state.runId || '',
      at: transition.at || '',
      transition: summarizeTransition(transition),
    });
  }
  for (const review of Array.isArray(state.runtimeState?.decisionReviewHistory) ? state.runtimeState.decisionReviewHistory : []) {
    items.push({
      kind: 'decision_review',
      type: 'agent:decision-reviewed',
      runId: state.runId || '',
      at: review.updatedAt || '',
      decisionReview: summarizeDecisionReview(review),
    });
  }
  for (const replay of Array.isArray(state.runtimeState?.replayHistory) ? state.runtimeState.replayHistory : []) {
    items.push({
      kind: 'replay',
      type: 'agent:replay-evaluated',
      runId: state.runId || '',
      at: replay.evaluatedAt || '',
      replay: summarizeReplay(replay),
    });
  }
  for (const trajectory of Array.isArray(state.runtimeState?.trajectoryHistory) ? state.runtimeState.trajectoryHistory : []) {
    items.push({
      kind: 'trajectory',
      type: 'agent:trajectory-evaluated',
      runId: state.runId || '',
      at: trajectory.evaluatedAt || '',
      trajectory: summarizeTrajectory(trajectory),
    });
  }
  for (const plan of Array.isArray(state.runtimeState?.planHistory) ? state.runtimeState.planHistory : []) {
    items.push({
      kind: 'plan',
      type: 'agent:runtime-plan-updated',
      runId: state.runId || '',
      at: plan.updatedAt || '',
      plan: summarizePlan(plan),
    });
  }
  for (const recovery of Array.isArray(state.runtimeState?.recoveryHistory) ? state.runtimeState.recoveryHistory : []) {
    items.push({
      kind: 'recovery',
      type: 'agent:recovery-policy-updated',
      runId: state.runId || '',
      at: recovery.updatedAt || '',
      recovery: summarizeRecovery(recovery),
    });
  }
  for (const observation of Array.isArray(state.observations) ? state.observations : []) {
    items.push({
      kind: 'observation',
      type: 'agent:observation-recorded',
      runId: state.runId || '',
      at: observation.observedAt || '',
      observation: summarizeObservation(observation),
    });
  }
  if (state.verification || state.memory?.verification) {
    const verification = state.verification || state.memory.verification;
    items.push({
      kind: 'verification',
      type: 'agent:verification-recorded',
      runId: state.runId || '',
      at: verification.checkedAt || '',
      verification: summarizeVerification(verification),
    });
  }
  return items;
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

function summarizeInterrupt(interrupt = {}) {
  return {
    id: interrupt.id || '',
    type: interrupt.type || '',
    status: interrupt.status || '',
    reason: interrupt.reason || '',
    message: interrupt.message || '',
    turn: interrupt.turn ?? null,
    resolutionStatus: interrupt.resolution?.status || '',
    resolutionReason: interrupt.resolution?.reason || '',
    createdAt: interrupt.createdAt || '',
    resolvedAt: interrupt.resolvedAt || '',
  };
}

function summarizeTurn(turn = {}) {
  return {
    id: turn.id || '',
    turn: turn.turn ?? null,
    index: turn.index ?? null,
    status: turn.status || '',
    stage: turn.stage || '',
    startedAt: turn.startedAt || '',
    endedAt: turn.endedAt || '',
    actionCount: Array.isArray(turn.actions) ? turn.actions.length : 0,
    observationCount: Array.isArray(turn.observations) ? turn.observations.length : 0,
    decision: turn.decision || null,
  };
}

function summarizeObservation(observation = {}) {
  return {
    id: observation.id || '',
    turn: observation.turn ?? null,
    kind: observation.kind || '',
    toolName: observation.toolName || '',
    toolCallId: observation.toolCallId || '',
    ok: observation.ok === true,
    exitCode: observation.exitCode,
    content: compactText(observation.content || observation.stdoutExcerpt || observation.stderrExcerpt || observation.error || '', 1000),
    observedAt: observation.observedAt || '',
  };
}

function summarizeTransition(transition = {}) {
  return {
    id: transition.id || '',
    turn: transition.turn ?? null,
    from: transition.from || '',
    to: transition.to || '',
    valid: transition.valid !== false,
    status: transition.status || '',
    reason: transition.reason || '',
    command: transition.command || null,
    at: transition.at || '',
  };
}

function summarizeDecisionReview(review = {}) {
  return {
    status: review.status || '',
    kind: review.kind || '',
    turn: review.turn ?? null,
    reasons: Array.isArray(review.reasons) ? review.reasons.slice(0, 10) : [],
    originalCommand: review.originalCommand || null,
    effectiveCommand: review.effectiveCommand || null,
    message: compactText(review.message || '', 500),
    updatedAt: review.updatedAt || '',
  };
}

function summarizeReplay(replay = {}) {
  return {
    status: replay.status || '',
    ok: replay.ok !== false,
    reasons: Array.isArray(replay.reasons) ? replay.reasons.slice(0, 10) : [],
    recommendedTaskStatus: replay.recommendedTaskStatus || '',
    evaluatedAt: replay.evaluatedAt || '',
  };
}

function summarizeTrajectory(trajectory = {}) {
  return {
    status: trajectory.status || '',
    ok: trajectory.ok !== false,
    reasons: Array.isArray(trajectory.reasons) ? trajectory.reasons.slice(0, 10) : [],
    counts: trajectory.counts && typeof trajectory.counts === 'object' ? { ...trajectory.counts } : {},
    evaluatedAt: trajectory.evaluatedAt || '',
  };
}

function summarizeVerification(verification = {}) {
  return {
    id: verification.id || '',
    turn: verification.turn ?? null,
    ok: verification.ok === true,
    status: verification.status || '',
    taskStatus: verification.taskStatus || '',
    type: verification.type || '',
    target: verification.target || '',
    reasons: Array.isArray(verification.reasons) ? verification.reasons : [],
    checkedAt: verification.checkedAt || '',
  };
}

function summarizePlan(plan = {}) {
  return {
    status: plan.status || '',
    intent: plan.intent || '',
    objective: compactText(plan.objective || '', 500),
    turn: plan.turn ?? null,
    blockers: Array.isArray(plan.blockers) ? plan.blockers.slice(0, 10) : [],
    evidenceNeeded: Array.isArray(plan.evidenceNeeded) ? plan.evidenceNeeded.slice(0, 10) : [],
  };
}

function summarizeRecovery(recovery = {}) {
  return {
    status: recovery.status || '',
    attemptCount: Number(recovery.attemptCount || 0),
    maxAttempts: recovery.maxAttempts ?? null,
    exhausted: recovery.exhausted === true,
    repeatFailureCount: Number(recovery.repeatFailureCount || 0),
    maxRepeatedFailures: recovery.maxRepeatedFailures ?? null,
    recoveryType: recovery.recoveryType || '',
    reason: compactText(recovery.reason || '', 500),
    failedToolNames: Array.isArray(recovery.failedToolNames) ? recovery.failedToolNames.slice(0, 10) : [],
    nextSteps: Array.isArray(recovery.nextSteps) ? recovery.nextSteps.slice(0, 10) : [],
  };
}

function requireAgentRun(runtime, runId) {
  if (!runtime?.getState) throw new Error('Agent runtime getState is not configured');
  const id = String(runId || '').trim();
  if (!id) throw new Error('runId is required');
  const state = runtime.getState(id);
  if (!state) throw new Error(`Agent run not found: ${id}`);
  return state;
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
  cancelAgentRun,
  getAgentRun,
  getAgentRunTimeline,
  listAgentRuns,
  requestAgentApproval,
  summarizeAgentRun,
};
