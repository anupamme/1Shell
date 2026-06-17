'use strict';

function createAgentCognitionState() {
  return {
    schemaVersion: 1,
    status: 'empty',
    objective: '',
    successCriteria: [],
    knownFacts: [],
    unknowns: [],
    assumptions: [],
    constraints: [],
    risks: [],
    decisionBasis: '',
    evidenceNeeded: [],
    blockers: [],
    updatedBy: '',
    turn: null,
    updatedAt: '',
  };
}

function applyAgentCognitionToState(state = {}, update = {}, options = {}) {
  const runtimeState = ensureRuntimeState(state);
  const current = runtimeState.cognition && typeof runtimeState.cognition === 'object' && !Array.isArray(runtimeState.cognition)
    ? runtimeState.cognition
    : createAgentCognitionState();
  const now = update.updatedAt || options.updatedAt || new Date().toISOString();
  const turn = update.turn === undefined ? current.turn : nullableNumber(update.turn);
  const status = String(update.status || current.status || 'empty');
  const objective = compactText(update.objective !== undefined ? update.objective : current.objective, 1000);

  const next = {
    ...current,
    schemaVersion: 1,
    status,
    objective,
    successCriteria: mergeCognitionItems(current.successCriteria, update.successCriteria || update.success_criteria, 'success_criterion', { turn, updatedAt: now }, 50),
    knownFacts: mergeCognitionItems(current.knownFacts, update.knownFacts || update.known_facts || update.facts, 'fact', { turn, updatedAt: now }, 120),
    unknowns: mergeCognitionItems(current.unknowns, update.unknowns || update.openQuestions || update.open_questions, 'unknown', { turn, updatedAt: now }, 80),
    assumptions: mergeCognitionItems(current.assumptions, update.assumptions, 'assumption', { turn, updatedAt: now }, 80),
    constraints: mergeCognitionItems(current.constraints, update.constraints, 'constraint', { turn, updatedAt: now }, 80),
    risks: mergeCognitionItems(current.risks, update.risks, 'risk', { turn, updatedAt: now }, 80),
    decisionBasis: compactText(update.decisionBasis !== undefined ? update.decisionBasis : update.decision_basis !== undefined ? update.decision_basis : current.decisionBasis, 1000),
    evidenceNeeded: mergeCognitionItems(current.evidenceNeeded, update.evidenceNeeded || update.evidence_needed, 'evidence_needed', { turn, updatedAt: now }, 80),
    blockers: mergeCognitionItems(current.blockers, update.blockers, 'blocker', { turn, updatedAt: now }, 80),
    updatedBy: String(update.updatedBy || update.updated_by || options.updatedBy || current.updatedBy || 'runtime'),
    turn,
    updatedAt: now,
  };

  runtimeState.cognition = next;
  if (!Array.isArray(runtimeState.cognitionHistory)) runtimeState.cognitionHistory = [];
  runtimeState.cognitionHistory.push(summarizeCognition(next));
  runtimeState.cognitionHistory = runtimeState.cognitionHistory.slice(-50);

  const memory = ensureRuntimeMemory(state);
  memory.cognition.push(summarizeCognition(next));
  memory.cognition = memory.cognition.slice(-50);
  return next;
}

function normalizeAgentStateDelta(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    successCriteria: source.successCriteria || source.success_criteria,
    knownFacts: source.knownFacts || source.known_facts || source.facts,
    unknowns: source.unknowns || source.openQuestions || source.open_questions,
    assumptions: source.assumptions,
    constraints: source.constraints,
    risks: source.risks,
    evidenceNeeded: source.evidenceNeeded || source.evidence_needed,
    blockers: source.blockers,
    decisionBasis: source.decisionBasis || source.decision_basis,
  };
}

function summarizeCognition(cognition = {}) {
  return {
    schemaVersion: 1,
    status: cognition.status || '',
    objective: compactText(cognition.objective || '', 500),
    turn: cognition.turn ?? null,
    successCriteriaCount: Array.isArray(cognition.successCriteria) ? cognition.successCriteria.length : 0,
    knownFactCount: Array.isArray(cognition.knownFacts) ? cognition.knownFacts.length : 0,
    unknownCount: Array.isArray(cognition.unknowns) ? cognition.unknowns.length : 0,
    assumptionCount: Array.isArray(cognition.assumptions) ? cognition.assumptions.length : 0,
    riskCount: Array.isArray(cognition.risks) ? cognition.risks.length : 0,
    evidenceNeededCount: Array.isArray(cognition.evidenceNeeded) ? cognition.evidenceNeeded.length : 0,
    blockerCount: Array.isArray(cognition.blockers) ? cognition.blockers.length : 0,
    updatedBy: cognition.updatedBy || '',
    updatedAt: cognition.updatedAt || '',
  };
}

function mergeCognitionItems(current, incoming, defaultType, context, limit) {
  const target = normalizeCognitionItems(current, defaultType, context);
  const additions = normalizeCognitionItems(incoming, defaultType, context);
  for (const item of additions) {
    const key = item.id || `${item.type}:${item.text}`.toLowerCase();
    const index = target.findIndex((existing) => (existing.id || `${existing.type}:${existing.text}`.toLowerCase()) === key);
    if (index >= 0) target[index] = { ...target[index], ...item };
    else target.push(item);
  }
  return target.filter((item) => item.text || item.id).slice(-limit);
}

function normalizeCognitionItems(value, defaultType, context = {}) {
  const items = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  return items.map((item, index) => normalizeCognitionItem(item, defaultType, context, index)).filter(Boolean);
}

function normalizeCognitionItem(value, defaultType, context = {}, index = 0) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = compactText(value.text || value.summary || value.content || value.question || value.reason || value.value || '', 700);
    const id = String(value.id || '').trim();
    if (!text && !id) return null;
    return {
      id,
      type: String(value.type || value.kind || defaultType || '').trim(),
      text,
      source: String(value.source || value.toolName || value.tool_name || '').trim(),
      confidence: String(value.confidence || '').trim(),
      turn: value.turn === undefined ? nullableNumber(context.turn) : nullableNumber(value.turn),
      updatedAt: value.updatedAt || value.updated_at || context.updatedAt || '',
    };
  }
  const text = compactText(value, 700);
  if (!text) return null;
  return {
    id: '',
    type: defaultType || '',
    text,
    source: '',
    confidence: '',
    turn: nullableNumber(context.turn),
    updatedAt: context.updatedAt || '',
  };
}

function ensureRuntimeState(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) state.runtimeState = {};
  if (!state.runtimeState.cognition || typeof state.runtimeState.cognition !== 'object' || Array.isArray(state.runtimeState.cognition)) {
    state.runtimeState.cognition = createAgentCognitionState();
  }
  if (!Array.isArray(state.runtimeState.cognitionHistory)) state.runtimeState.cognitionHistory = [];
  return state.runtimeState;
}

function ensureRuntimeMemory(state) {
  if (!state.memory || typeof state.memory !== 'object' || Array.isArray(state.memory)) state.memory = {};
  if (!Array.isArray(state.memory.cognition)) state.memory.cognition = [];
  return state.memory;
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
  applyAgentCognitionToState,
  createAgentCognitionState,
  normalizeAgentStateDelta,
  summarizeCognition,
};
