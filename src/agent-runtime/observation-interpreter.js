'use strict';

const SIDE_EFFECT_TOOL_NAMES = new Set([
  'execute_command',
  'host_exec',
  'write_remote_file',
  'create_directory',
  'delete_path',
  'rename_path',
  'upload_file',
  'download_file',
  'run_script',
  'save_script',
  'reload_registry',
  'add_mcp_server',
  'remove_mcp_server',
  'deploy_local_mcp',
  'ack_probe_alert',
  'install_probe_agent',
  'restart_probe_agent',
  'uninstall_probe_agent',
]);

function applyObservationToRuntimeState(state, observation = {}) {
  if (!state || typeof state !== 'object') return null;
  const world = ensureWorldState(state);
  const interpretation = interpretObservation(observation);

  appendLimited(world.facts, interpretation.facts, 200, 'id');
  appendLimited(world.failures, interpretation.failures, 100, 'id');
  appendLimited(world.sideEffects, interpretation.sideEffects, 100, 'id');
  markRecoveredFailures(world, observation, interpretation);
  markVerifiedSideEffects(world, observation, interpretation);
  if (interpretation.verification) world.verification = interpretation.verification;

  if (state.memory && typeof state.memory === 'object') {
    if (!Array.isArray(state.memory.facts)) state.memory.facts = [];
    appendLimited(state.memory.facts, interpretation.facts, 200, 'id');
  }
  state.runtimeState.worldState = world;
  return interpretation;
}

function interpretObservation(observation = {}) {
  const id = String(observation.id || '').trim() || `observation-${Date.now()}`;
  const toolName = String(observation.toolName || observation.tool_name || '').trim();
  const ok = observation.ok === true && observation.isError !== true && observation.is_error !== true;
  const text = compactText(observation.content || observation.stdoutExcerpt || observation.stderrExcerpt || observation.error || '', 1000);
  const data = normalizeObject(observation.data);
  const evidence = normalizeStringArray(observation.evidence).slice(0, 20);
  const evidenceRecords = normalizeEvidenceRecords(data.evidenceRecords || data.evidence_records);
  const base = {
    id,
    turn: Number.isFinite(Number(observation.turn)) ? Number(observation.turn) : null,
    kind: String(observation.kind || observation.type || 'observation'),
    toolName,
    text,
    evidence,
    evidenceRecords,
    observedAt: observation.observedAt || observation.checkedAt || new Date().toISOString(),
  };

  const facts = [];
  const failures = [];
  const sideEffects = [];
  let verification = null;
  const runtimeDirective = isRuntimeDirectiveObservation(base);

  if (ok) {
    facts.push({
      ...base,
      confidence: 'observed',
      factType: toolName ? 'tool_result' : 'observation',
    });
  } else if (!runtimeDirective) {
    failures.push({
      ...base,
      status: 'unrecovered',
      error: text,
      exitCode: observation.exitCode,
    });
  }

  if (toolName && SIDE_EFFECT_TOOL_NAMES.has(toolName)) {
    sideEffects.push({
      ...base,
      ok,
      requiresVerification: toolRequiresVerification(toolName, observation),
      verified: false,
      summary: text,
      data,
      toolInput: normalizeObject(data.toolInput || data.tool_input),
      scope: normalizeObject(data.scope),
      evidence,
      evidenceRecords,
      verifier: normalizeObject(data.verifier || data.verificationHint || data.verification_hint),
    });
  }

  if (base.kind === 'verification' || toolName === 'verify_outcome') {
    verification = {
      id,
      ok,
      status: ok ? 'passed' : 'failed',
      text,
      checkedAt: base.observedAt,
    };
  }

  return { facts, failures, sideEffects, verification };
}

function toolRequiresVerification(toolName, observation = {}) {
  if (toolName === 'verify_outcome') return false;
  return SIDE_EFFECT_TOOL_NAMES.has(toolName);
}

function isRuntimeDirectiveObservation(base = {}) {
  return ['runtime_recovery', 'recover', 'verify'].includes(base.kind)
    || ['agent_controller'].includes(base.toolName);
}

function ensureWorldState(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) {
    state.runtimeState = {};
  }
  const existing = state.runtimeState.worldState && typeof state.runtimeState.worldState === 'object'
    ? state.runtimeState.worldState
    : {};
  return {
    facts: Array.isArray(existing.facts) ? existing.facts : [],
    openQuestions: Array.isArray(existing.openQuestions) ? existing.openQuestions : [],
    failures: Array.isArray(existing.failures) ? existing.failures : [],
    sideEffects: Array.isArray(existing.sideEffects) ? existing.sideEffects : [],
    verification: existing.verification || null,
    verificationPlan: existing.verificationPlan || null,
  };
}

function appendLimited(target, items, limit, key) {
  if (!Array.isArray(items) || items.length === 0) return target;
  for (const item of items) {
    if (!item) continue;
    const id = key ? String(item[key] || '').trim() : '';
    if (id) {
      const index = target.findIndex((current) => String(current?.[key] || '') === id);
      if (index >= 0) {
        target[index] = { ...target[index], ...item };
        continue;
      }
    }
    target.push(item);
  }
  if (target.length > limit) target.splice(0, target.length - limit);
  return target;
}

function markRecoveredFailures(world, observation = {}, interpretation = {}) {
  if (!world || !Array.isArray(world.failures) || world.failures.length === 0) return;
  const ok = observation.ok === true && observation.isError !== true && observation.is_error !== true;
  if (!ok) return;
  const recovers = Array.isArray(observation.data?.recoversFailureIds)
    ? observation.data.recoversFailureIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const toolName = String(observation.toolName || observation.tool_name || '').trim();
  const now = observation.observedAt || new Date().toISOString();
  for (const failure of world.failures) {
    if (!failure || failure.status === 'recovered') continue;
    const explicit = recovers.length > 0 && recovers.includes(String(failure.id || ''));
    const sameTool = toolName && failure.toolName === toolName;
    const verificationPassed = interpretation.verification?.ok === true;
    if (!explicit && !sameTool && !verificationPassed) continue;
    failure.status = 'recovered';
    failure.recoveredBy = String(observation.id || '');
    failure.recoveredAt = now;
  }
}

function markVerifiedSideEffects(world, observation = {}, interpretation = {}) {
  if (!world || !Array.isArray(world.sideEffects) || world.sideEffects.length === 0) return;
  if (interpretation.verification?.ok !== true) return;
  const explicit = Array.isArray(observation.data?.verifiesSideEffectIds)
    ? observation.data.verifiesSideEffectIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const now = observation.observedAt || new Date().toISOString();
  for (const sideEffect of world.sideEffects) {
    if (!sideEffect || sideEffect.verified === true) continue;
    if (explicit.length > 0 && !explicit.includes(String(sideEffect.id || ''))) continue;
    if (sideEffect.requiresVerification !== true) continue;
    sideEffect.verified = true;
    sideEffect.verifiedBy = String(observation.id || '');
    sideEffect.verifiedAt = now;
  }
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function normalizeEvidenceRecords(value) {
  return (Array.isArray(value) ? value : []).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    return {
      type: String(item.type || item.kind || 'evidence'),
      summary: compactText(item.summary || item.text || item.content || item.evidence || '', 1000),
      data: normalizeObject(item.data),
    };
  }).filter((item) => item && (item.summary || Object.keys(item.data).length > 0)).slice(0, 30);
}

module.exports = {
  SIDE_EFFECT_TOOL_NAMES,
  applyObservationToRuntimeState,
  interpretObservation,
};
