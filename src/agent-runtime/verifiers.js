'use strict';

const { getSideEffectLedger, getVerificationResult } = require('./outcome');

function evaluateVerifierPlan(state = {}, options = {}) {
  const requirements = collectVerifierRequirements(state, options);
  const verification = getVerificationResult(state);
  const required = requirements.length > 0;
  let status = 'not_required';
  if (required && !verification) status = 'missing';
  else if (required && verification?.ok === true) status = 'passed';
  else if (required && verification?.status === 'unsupported') status = 'unsupported';
  else if (required && verification) status = 'failed';

  const missingRequirements = status === 'missing' ? requirements : [];
  const failedRequirements = ['failed', 'unsupported'].includes(status) ? requirements : [];
  const reasons = buildVerifierPlanReasons({ status, requirements, verification });
  return {
    schemaVersion: 1,
    required,
    status,
    ok: status === 'not_required' || status === 'passed',
    requirements,
    missingRequirements,
    failedRequirements,
    verification: verification || null,
    reasons,
    evaluatedAt: new Date().toISOString(),
  };
}

function applyVerifierPlanToRuntimeState(state = {}, options = {}) {
  if (!state || typeof state !== 'object') return null;
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) state.runtimeState = {};
  if (!state.runtimeState.worldState || typeof state.runtimeState.worldState !== 'object' || Array.isArray(state.runtimeState.worldState)) {
    state.runtimeState.worldState = {};
  }
  const plan = evaluateVerifierPlan(state, options);
  state.runtimeState.verifier = plan;
  state.runtimeState.worldState.verificationPlan = plan;
  return plan;
}

function collectVerifierRequirements(state = {}, _options = {}) {
  const requirements = [];
  const outputContract = normalizeObject(state?.spec?.outputContract);
  const success = normalizeObject(outputContract.success);
  const verifyItems = Array.isArray(outputContract.verify) ? outputContract.verify : [];

  verifyItems.forEach((item, index) => {
    requirements.push({
      id: `contract-verify-${index}`,
      source: 'output_contract',
      type: String(item?.type || 'command').trim() || 'command',
      required: true,
      summary: summarizeVerifierItem(item, index),
      verifier: normalizeVerifierSpec(item),
    });
  });

  if (success.requiresVerify === true || success.requires_verify === true) {
    requirements.push({
      id: 'success-requires-verify',
      source: 'success_contract',
      type: 'outcome',
      required: true,
      summary: 'Output contract success requires verification.',
    });
  }

  const sideEffectLedger = getSideEffectLedger(state);
  const sideEffects = Array.isArray(sideEffectLedger.sideEffects) ? sideEffectLedger.sideEffects : [];
  const sideEffectsNeedingVerify = sideEffects.filter((item) => item?.requiresVerification === true && item?.ok !== false && item?.verified !== true);
  sideEffectsNeedingVerify.forEach((item, index) => {
    requirements.push({
      id: `side-effect-${item.id || item.toolCallId || index}`,
      source: 'side_effect',
      type: 'outcome',
      required: true,
      sideEffectId: String(item.id || item.toolCallId || ''),
      toolName: String(item.toolName || item.tool_name || ''),
      summary: String(item.summary || item.text || item.toolName || 'side effect requires verification').slice(0, 1000),
      verifier: normalizeVerifierSpec(item.verifier || item.verificationHint || item.verification_hint),
      toolInput: normalizeObject(item.toolInput || item.tool_input),
      scope: normalizeObject(item.scope),
      evidenceRecords: Array.isArray(item.evidenceRecords || item.evidence_records)
        ? (item.evidenceRecords || item.evidence_records).slice(0, 10).map(normalizeObject)
        : [],
    });
  });

  if ((sideEffectLedger.requiresVerification === true || sideEffectLedger.hasSideEffects === true) && sideEffectsNeedingVerify.length === 0) {
    requirements.push({
      id: 'side-effects-require-verification',
      source: 'side_effect_ledger',
      type: 'outcome',
      required: true,
      summary: 'Side-effect ledger requires verification.',
    });
  }

  const phases = Object.values(normalizeObject(state?.phases));
  const requiredVerifyPhase = phases.find((phase) => phase?.required === true && String(phase.id || '').toLowerCase() === 'verify');
  if (requiredVerifyPhase && !['done', 'skipped'].includes(String(requiredVerifyPhase.status || ''))) {
    requirements.push({
      id: 'required-phase-verify',
      source: 'required_phase',
      type: 'phase',
      required: true,
      summary: 'Required verify phase is not complete.',
    });
  }

  return dedupeRequirements(requirements);
}

function normalizeVerifierSpec(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function buildVerifierPlanReasons({ status, requirements = [], verification = null } = {}) {
  if (status === 'not_required' || status === 'passed') return [];
  const sources = Array.from(new Set(requirements.map((item) => item.source).filter(Boolean)));
  const reasons = sources.length > 0
    ? sources.map((source) => `verification_required:${source}`)
    : ['verification_required'];
  if (status === 'missing') reasons.push('verification_missing');
  if (status === 'unsupported') reasons.push('verification_unsupported');
  if (status === 'failed') reasons.push(`verification_failed:${verification?.status || 'failed'}`);
  return Array.from(new Set(reasons));
}

function summarizeVerifierItem(item = {}, index = 0) {
  const type = String(item?.type || 'command').trim() || 'command';
  const target = item.command || item.run || item.url || item.path || item.reason || '';
  return `${type} verifier #${index + 1}${target ? `: ${String(target).slice(0, 500)}` : ''}`;
}

function dedupeRequirements(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

module.exports = {
  applyVerifierPlanToRuntimeState,
  collectVerifierRequirements,
  evaluateVerifierPlan,
  toPositiveInt,
};
