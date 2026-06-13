'use strict';

const { normalizeAgentCommand } = require('./commands');
const { normalizeAgentTaskStatus } = require('./outcome');
const { evaluateVerifierPlan } = require('./verifiers');

function createRuntimeDecisionReviewState() {
  return {
    schemaVersion: 1,
    status: 'not_reviewed',
    kind: '',
    turn: null,
    reasons: [],
    originalCommand: null,
    effectiveCommand: null,
    message: '',
    updatedAt: '',
  };
}

function applyRuntimeDecisionReviewToState(state = {}, review = {}) {
  const runtimeState = ensureRuntimeState(state);
  const now = review.updatedAt || new Date().toISOString();
  const item = {
    schemaVersion: 1,
    status: normalizeReviewStatus(review.status),
    kind: String(review.kind || '').trim(),
    turn: nullableNumber(review.turn),
    reasons: normalizeStringArray(review.reasons),
    originalCommand: summarizeCommand(review.originalCommand || review.original_command),
    effectiveCommand: summarizeCommand(review.effectiveCommand || review.effective_command || review.command),
    message: compactText(review.message || '', 1000),
    updatedAt: now,
  };
  runtimeState.decisionReview = item;
  if (!Array.isArray(runtimeState.decisionReviewHistory)) runtimeState.decisionReviewHistory = [];
  runtimeState.decisionReviewHistory.push(item);
  runtimeState.decisionReviewHistory = runtimeState.decisionReviewHistory.slice(-50);

  const memory = ensureRuntimeMemory(state);
  memory.decisionReviews.push({
    status: item.status,
    kind: item.kind,
    turn: item.turn,
    reasons: item.reasons,
    originalType: item.originalCommand?.type || '',
    effectiveType: item.effectiveCommand?.type || '',
    updatedAt: now,
  });
  memory.decisionReviews = memory.decisionReviews.slice(-80);
  return item;
}

function evaluateAgentDecisionPolicy(state = {}, command = {}, options = {}) {
  const original = normalizeAgentCommand(command);
  const turn = options.turn ?? null;
  const result = normalizeObject(options.result);
  const finalText = String(result.text || result.report || result.content || original.text || '').trim();
  const resultStatus = normalizeAgentTaskStatus(original.status || result.taskStatus || result.status, 'unknown');
  const explicitNonSuccess = ['failed', 'blocked', 'unverified', 'partial'].includes(resultStatus)
    || /\b(failed|blocked|unverified|partial)\b/i.test(finalText);
  const pendingInterrupt = findPendingInterrupt(state);
  const failures = unrecoveredFailures(state);
  const verifierPlan = evaluateVerifierPlan(state);
  const recovery = state?.runtimeState?.recovery || {};
  const protocol = original.data?.protocol && typeof original.data.protocol === 'object' ? original.data.protocol : {};
  const reasons = [];
  let kind = 'accepted';

  if (pendingInterrupt && !['ask_user', 'request_secret', 'request_approval', 'block'].includes(original.type)) {
    kind = 'pending_interrupt';
    reasons.push('pending_interrupt');
  }

  if (recovery.exhausted === true && !['block', 'finalize'].includes(original.type)) {
    kind = kind === 'accepted' ? 'recovery_exhausted' : kind;
    reasons.push(recovery.reason || 'recovery_exhausted');
  }

  if (original.type === 'finalize' && (protocol.inferredFinalization === true || protocol.protocolFallback === true)) {
    kind = kind === 'accepted' ? (protocol.protocolFallback === true ? 'model_protocol_fallback' : 'implicit_finalization') : kind;
    reasons.push(protocol.protocolFallback === true ? 'model_protocol_fallback' : 'implicit_finalization');
  }

  if (original.type === 'act' && original.actions.length === 0) {
    kind = kind === 'accepted' ? 'empty_action' : kind;
    reasons.push('empty_action_command');
  }

  if (original.type === 'continue') {
    kind = kind === 'accepted' ? 'empty_decision' : kind;
    reasons.push('empty_or_unknown_agent_command');
  }

  if (original.type === 'finalize' && failures.length > 0 && !explicitNonSuccess) {
    kind = kind === 'accepted' ? 'unrecovered_failure' : kind;
    reasons.push(...failures.map((item) => `unrecovered_failure:${item.toolName || item.id || 'unknown'}`));
  }

  if (original.type === 'finalize' && verifierPlan.required === true && verifierPlan.ok !== true && !explicitNonSuccess) {
    kind = kind === 'accepted' ? 'verification_required' : kind;
    reasons.push(...(verifierPlan.reasons.length > 0 ? verifierPlan.reasons : ['runtime_verification_required']));
  }

  return buildReview({
    status: 'accepted',
    kind,
    turn,
    reasons,
    originalCommand: original,
    effectiveCommand: original,
    message: '',
  });
}

function buildReview({ status, kind, turn, reasons = [], originalCommand, effectiveCommand, message = '' } = {}) {
  const command = normalizeAgentCommand(effectiveCommand || originalCommand || {});
  return {
    schemaVersion: 1,
    status: normalizeReviewStatus(status),
    kind: String(kind || '').trim(),
    turn: nullableNumber(turn),
    reasons: normalizeStringArray(reasons),
    originalCommand: normalizeAgentCommand(originalCommand || command),
    effectiveCommand: command,
    command,
    message: compactText(message, 1000),
    updatedAt: new Date().toISOString(),
  };
}

function findPendingInterrupt(state = {}) {
  const interrupts = Array.isArray(state?.interrupts) ? state.interrupts : [];
  return [...interrupts].reverse().find((item) => item?.status === 'pending') || null;
}

function unrecoveredFailures(state = {}) {
  const failures = Array.isArray(state?.runtimeState?.worldState?.failures)
    ? state.runtimeState.worldState.failures
    : [];
  return failures.filter((item) => item && item.status !== 'recovered').slice(-10);
}

function ensureRuntimeState(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) state.runtimeState = {};
  if (!state.runtimeState.decisionReview || typeof state.runtimeState.decisionReview !== 'object' || Array.isArray(state.runtimeState.decisionReview)) {
    state.runtimeState.decisionReview = createRuntimeDecisionReviewState();
  }
  if (!Array.isArray(state.runtimeState.decisionReviewHistory)) state.runtimeState.decisionReviewHistory = [];
  return state.runtimeState;
}

function ensureRuntimeMemory(state) {
  if (!state.memory || typeof state.memory !== 'object' || Array.isArray(state.memory)) state.memory = {};
  if (!Array.isArray(state.memory.decisionReviews)) state.memory.decisionReviews = [];
  return state.memory;
}

function summarizeCommand(command = null) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  return {
    type: command.type || '',
    final: command.final === true,
    status: command.status || '',
    reason: command.reason || '',
    actionCount: Array.isArray(command.actions) ? command.actions.length : 0,
    text: compactText(command.text || '', 500),
  };
}

function normalizeReviewStatus(value) {
  const text = String(value || '').trim();
  return ['accepted', 'rewritten', 'rejected', 'not_reviewed'].includes(text) ? text : 'accepted';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

module.exports = {
  applyRuntimeDecisionReviewToState,
  createRuntimeDecisionReviewState,
  evaluateAgentDecisionPolicy,
};
