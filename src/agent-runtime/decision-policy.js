'use strict';

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
};
