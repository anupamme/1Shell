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
    candidateActions: [],
    selectedAction: null,
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
  const selectedAction = update.selectedAction !== undefined || update.selected_action !== undefined
    ? normalizeSelectedAction(update.selectedAction || update.selected_action, { turn, updatedAt: now })
    : current.selectedAction;

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
    candidateActions: Array.isArray(update.candidateActions || update.candidate_actions)
      ? normalizeCognitionItems(update.candidateActions || update.candidate_actions, 'candidate_action', { turn, updatedAt: now }).slice(0, 20)
      : normalizeCognitionItems(current.candidateActions, 'candidate_action', { turn: current.turn, updatedAt: current.updatedAt }).slice(0, 20),
    selectedAction,
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

function buildPreDecisionCognitionUpdate(state = {}, { turn = null, observations = [] } = {}) {
  const runtimeState = state.runtimeState || {};
  const current = runtimeState.cognition || {};
  const world = runtimeState.worldState || {};
  const policy = state.spec?.policy || {};
  const verifier = runtimeState.verifier || world.verificationPlan || {};
  const failures = (Array.isArray(world.failures) ? world.failures : []).filter((item) => item?.status !== 'recovered').slice(-8);
  const pendingInterrupts = (Array.isArray(state.interrupts) ? state.interrupts : []).filter((item) => item?.status === 'pending');
  const sideEffectsNeedingVerification = (Array.isArray(world.sideEffects) ? world.sideEffects : [])
    .filter((item) => item?.requiresVerification === true && item?.verified !== true)
    .slice(-8);
  const evidenceNeeded = [];
  if (verifier?.required === true && verifier.ok !== true) evidenceNeeded.push('runtime verification is required before success');
  for (const sideEffect of sideEffectsNeedingVerification) {
    evidenceNeeded.push(`verify side effect from ${sideEffect.toolName || sideEffect.id || 'tool action'}`);
  }

  return {
    status: failures.length > 0 ? 'needs_recovery' : 'orienting',
    objective: state.goal || state.spec?.goal || '',
    turn,
    successCriteria: inferSuccessCriteria(state, current),
    knownFacts: [
      ...summarizeWorldFacts(world.facts, 12),
      ...summarizeObservationsAsFacts(observations, 8),
    ],
    unknowns: [
      ...summarizeOpenQuestions(world.openQuestions, 8),
      ...pendingInterrupts.map((item) => ({
        id: `interrupt:${item.id || item.type || 'pending'}`,
        text: item.reason || item.message || `pending ${item.type || 'interrupt'}`,
        source: 'pending_interrupt',
      })),
    ],
    constraints: inferPolicyConstraints(policy),
    risks: inferRuntimeRisks({ failures, verifier, sideEffectsNeedingVerification }),
    evidenceNeeded,
    blockers: [
      ...failures.map((item) => `failure:${item.toolName || item.id || 'unknown'}`),
      ...pendingInterrupts.map((item) => `interrupt:${item.type || item.id || 'pending'}`),
    ],
    updatedBy: 'runtime_pre_decision',
  };
}

function buildDecisionCognitionUpdate(command = {}, result = {}, { turn = null, state = {}, decisionReview = null } = {}) {
  const type = String(command?.type || '').trim() || 'continue';
  const actions = Array.isArray(command.actions) ? command.actions : [];
  const stateDelta = normalizeAgentStateDelta(command.stateDelta || command.state_delta || result.stateDelta || result.state_delta || result.agentStateDelta || result.agent_state_delta);
  const selectedAction = selectedActionFromCommand(command, result, { turn, decisionReview });
  return {
    ...stateDelta,
    status: statusForCommand(type),
    objective: state.goal || state.spec?.goal || '',
    turn,
    candidateActions: actions.length > 0
      ? actions.map((action) => ({
        id: action.id || '',
        text: summarizeAction(action),
        toolName: action.toolName || '',
        source: 'model_command',
      }))
      : [{
        id: `turn-${turn || 'current'}-${type}`,
        text: compactText(command.text || result.text || result.report || result.content || type, 700),
        type,
        source: 'model_command',
      }],
    selectedAction,
    decisionBasis: compactText(
      stateDelta.decisionBasis
      || command.reason
      || result.reason
      || decisionReview?.message
      || command.text
      || result.text
      || '',
      1000,
    ),
    updatedBy: decisionReview?.status && decisionReview.status !== 'accepted' ? 'runtime_decision_policy' : 'model_decision',
  };
}

function buildObservationCognitionUpdate(observations = [], { turn = null, state = {} } = {}) {
  const items = Array.isArray(observations) ? observations : [];
  const failed = items.filter((item) => item?.isError === true || item?.ok === false);
  const succeeded = items.filter((item) => item?.ok === true && item?.isError !== true);
  const verifier = state?.runtimeState?.verifier || state?.runtimeState?.worldState?.verificationPlan || {};
  return {
    status: failed.length > 0 ? 'observed_failure' : 'observed',
    objective: state?.goal || state?.spec?.goal || '',
    turn,
    knownFacts: succeeded.map((item) => ({
      id: item.id || '',
      text: compactText(item.content || item.stdoutExcerpt || item.evidence?.[0] || `${item.toolName || 'observation'} succeeded`, 700),
      source: item.toolName ? `tool:${item.toolName}` : 'observation',
    })),
    risks: failed.map((item) => ({
      id: item.id || '',
      text: compactText(item.error || item.stderrExcerpt || item.content || `${item.toolName || 'observation'} failed`, 700),
      source: item.toolName ? `tool:${item.toolName}` : 'observation',
    })),
    blockers: failed.map((item) => `failure:${item.toolName || item.id || 'unknown'}`),
    evidenceNeeded: verifier?.required === true && verifier.ok !== true ? ['runtime verification is still required'] : [],
    updatedBy: 'runtime_observation',
  };
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
    selectedAction: cognition.selectedAction ? {
      type: cognition.selectedAction.type || '',
      toolNames: Array.isArray(cognition.selectedAction.toolNames) ? cognition.selectedAction.toolNames.slice(0, 10) : [],
      summary: compactText(cognition.selectedAction.summary || '', 500),
    } : null,
    updatedBy: cognition.updatedBy || '',
    updatedAt: cognition.updatedAt || '',
  };
}

function selectedActionFromCommand(command = {}, result = {}, { turn = null, decisionReview = null } = {}) {
  const type = String(command?.type || '').trim() || 'continue';
  const actions = Array.isArray(command.actions) ? command.actions : [];
  return normalizeSelectedAction({
    type,
    toolNames: actions.map((action) => action.toolName).filter(Boolean),
    summary: actions.length > 0
      ? actions.map(summarizeAction).join('\n')
      : compactText(command.text || result.text || result.report || result.content || type, 700),
    reviewStatus: decisionReview?.status || '',
    reviewKind: decisionReview?.kind || '',
  }, { turn });
}

function inferSuccessCriteria(state = {}, current = {}) {
  const explicit = state.spec?.outputContract?.successCriteria
    || state.spec?.outputContract?.success_criteria
    || state.spec?.context?.successCriteria
    || state.spec?.context?.success_criteria;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;
  if (Array.isArray(current.successCriteria) && current.successCriteria.length > 0) return current.successCriteria;
  const goal = String(state.goal || state.spec?.goal || '').trim();
  return goal ? [`Satisfy the user goal with observable evidence: ${goal}`] : [];
}

function inferPolicyConstraints(policy = {}) {
  const constraints = [];
  if (policy.readOnly === true) constraints.push('read-only policy is active');
  for (const tool of normalizeStringArray(policy.allowedTools)) constraints.push(`allowed tool: ${tool}`);
  for (const tool of normalizeStringArray(policy.deniedTools)) constraints.push(`denied tool: ${tool}`);
  for (const item of normalizeStringArray(policy.requireApproval)) constraints.push(`approval required: ${item}`);
  if (policy.hostScope) constraints.push(`host scope: ${String(policy.hostScope)}`);
  return constraints;
}

function inferRuntimeRisks({ failures = [], verifier = {}, sideEffectsNeedingVerification = [] } = {}) {
  const risks = [];
  if (failures.length > 0) risks.push(`${failures.length} unrecovered failure(s) exist`);
  if (verifier?.required === true && verifier.ok !== true) risks.push('required runtime verification has not passed');
  if (sideEffectsNeedingVerification.length > 0) risks.push(`${sideEffectsNeedingVerification.length} side effect(s) still need verification`);
  return risks;
}

function summarizeWorldFacts(facts = [], limit = 12) {
  return (Array.isArray(facts) ? facts : []).slice(-limit).map((item) => ({
    id: item?.id || '',
    text: compactText(item?.text || item?.summary || item?.content || '', 700),
    source: item?.toolName ? `tool:${item.toolName}` : (item?.kind || item?.factType || 'world'),
  })).filter((item) => item.text);
}

function summarizeObservationsAsFacts(observations = [], limit = 8) {
  return (Array.isArray(observations) ? observations : []).slice(-limit)
    .filter((item) => item?.ok === true && item?.isError !== true)
    .map((item) => ({
      id: item?.id || '',
      text: compactText(item?.content || item?.stdoutExcerpt || item?.evidence?.[0] || '', 700),
      source: item?.toolName ? `tool:${item.toolName}` : 'observation',
    }))
    .filter((item) => item.text);
}

function summarizeOpenQuestions(openQuestions = [], limit = 8) {
  return (Array.isArray(openQuestions) ? openQuestions : []).slice(-limit).map((item) => {
    if (typeof item === 'string') return item;
    return {
      id: item?.id || '',
      text: item?.question || item?.text || '',
      source: item?.source || 'world',
    };
  });
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

function normalizeSelectedAction(value, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    type: String(value.type || value.command || '').trim(),
    toolNames: normalizeStringArray(value.toolNames || value.tool_names),
    summary: compactText(value.summary || value.text || value.reason || '', 1000),
    reviewStatus: String(value.reviewStatus || value.review_status || '').trim(),
    reviewKind: String(value.reviewKind || value.review_kind || '').trim(),
    turn: value.turn === undefined ? nullableNumber(context.turn) : nullableNumber(value.turn),
    updatedAt: value.updatedAt || value.updated_at || context.updatedAt || new Date().toISOString(),
  };
}

function statusForCommand(type) {
  if (type === 'act') return 'acting';
  if (type === 'verify') return 'verifying';
  if (type === 'recover') return 'recovering';
  if (type === 'finalize') return 'finalizing';
  if (type === 'block') return 'blocked';
  if (['ask_user', 'request_secret', 'request_approval'].includes(type)) return 'waiting_for_input';
  return 'deciding';
}

function summarizeAction(action = {}) {
  const args = action.args && typeof action.args === 'object' ? action.args : {};
  if (args.command) return `${action.toolName || 'tool'}: ${String(args.command).slice(0, 300)}`;
  return action.toolName || 'tool action';
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
  applyAgentCognitionToState,
  buildDecisionCognitionUpdate,
  buildObservationCognitionUpdate,
  buildPreDecisionCognitionUpdate,
  createAgentCognitionState,
  normalizeAgentStateDelta,
  summarizeCognition,
};
