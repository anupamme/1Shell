'use strict';

function buildAgentDecisionContext(state = {}, options = {}) {
  if (!state || typeof state !== 'object') return '';
  const snapshot = buildAgentDecisionSnapshot(state, options);
  return [
    '',
    '## AgentRun Runtime State',
    'Observed runtime state for this run.',
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

function summarizeRecovery(recovery = null) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    return { status: 'idle', attemptCount: 0, recoveryType: '', failedToolNames: [] };
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
