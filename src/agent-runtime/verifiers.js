'use strict';

const { getSideEffectLedger, getVerificationResult } = require('./outcome');
const { normalizeVerifierRegistry } = require('./verifier-registry');

async function runAgentVerification({
  runtime,
  runId,
  hostId = '',
  inputs = {},
  secrets = [],
  defaultTimeoutMs = 30000,
  renderTemplate = null,
  redactText = null,
  redactResult = null,
  compactText = null,
  recordEvent = null,
  logger = null,
} = {}) {
  if (!runId || !runtime?.getState || !runtime?.dispatchTool) return null;
  const state = runtime.getState(runId);
  const verifyItems = Array.isArray(state?.spec?.outputContract?.verify) ? state.spec.outputContract.verify : [];
  if (verifyItems.length === 0) return null;

  if (state?.phases?.verify && runtime?.updatePhase) {
    runtime.updatePhase(runId, 'verify', { status: 'running', message: 'Running verification' });
  }

  const checks = [];
  for (let index = 0; index < verifyItems.length; index++) {
    const item = verifyItems[index] || {};
    const type = String(item.type || 'command').trim().toLowerCase();
    if (type !== 'command') {
      checks.push({ index, type, ok: false, status: 'unsupported', reason: `Unsupported verifier type: ${type || 'unknown'}` });
      continue;
    }

    const rawCommand = item.run || item.command || '';
    const command = renderCommand(rawCommand, inputs, renderTemplate);
    if (!command) {
      checks.push({ index, type, ok: false, status: 'failed', reason: 'command verifier requires run/command' });
      continue;
    }

    const timeout = toPositiveInt(item.timeout || item.timeout_ms, defaultTimeoutMs);
    const expectedExitCode = toExpectedExitCode(item);
    const redactedCommand = applyRedactText(command, redactText);
    try {
      recordEvent?.({ index, type, verifier: item, command, redactedCommand });
    } catch (err) {
      logger?.warn?.('[agent-runtime] verification event record failed', { runId, error: err.message });
    }

    const dispatched = await runtime.dispatchTool(runId, 'execute_command', { command, hostId, timeout }, {
      scope: { hostId },
      allowApproval: false,
      secrets,
      auditCommand: redactedCommand,
    });
    const rawResult = toolResultToCommandResult(dispatched);
    const safeResult = applyRedactResult(rawResult, redactResult);
    const exitCode = typeof safeResult.exitCode === 'number' ? safeResult.exitCode : 1;
    const ok = exitCode === expectedExitCode;
    checks.push({
      index,
      type,
      ok,
      status: ok ? 'passed' : 'failed',
      command: applyCompact(redactedCommand, 500, compactText),
      expectedExitCode,
      exitCode,
      durationMs: safeResult.durationMs || 0,
      stdout: applyCompact(safeResult.stdout || '', 1000, compactText),
      stderr: applyCompact(safeResult.stderr || '', 1000, compactText),
      reason: ok ? '' : `exit_code=${exitCode}, expected ${expectedExitCode}`,
    });
  }

  const result = summarizeVerificationChecks(checks);
  runtime.recordVerification?.(runId, {
    ...result,
    type: 'contract',
    target: hostId || state?.spec?.context?.hostId || '',
  });
  updateVerificationArtifact(runtime, runId, result);
  if (state?.phases?.verify && runtime?.updatePhase) {
    runtime.updatePhase(runId, 'verify', {
      status: result.status === 'passed' ? 'done' : 'failed',
      message: result.status === 'passed' ? 'Verification passed' : 'Verification did not pass',
    });
  }
  return result;
}

async function runVerifierPlan({
  runtime,
  runId,
  hostId = '',
  inputs = {},
  defaultTimeoutMs = 30000,
  executeTool = null,
  requestApproval = null,
  signal = null,
  logger = null,
  reason = 'runtime_verifier_plan',
  verifierRegistry = null,
} = {}) {
  if (!runId || !runtime?.getState || !runtime?.dispatchTool) return null;
  const state = runtime.getState(runId);
  if (!state) return null;
  const plan = evaluateVerifierPlan(state);
  if (!plan.required || plan.ok === true) {
    return {
      ok: true,
      status: plan.status || 'not_required',
      attempted: false,
      reason,
      plan,
      checks: [],
      actions: [],
    };
  }

  if (state?.phases?.verify && runtime?.updatePhase) {
    runtime.updatePhase(runId, 'verify', { status: 'running', message: 'Running runtime verifier plan' });
  }

  const actionsResult = buildVerifierActionsFromPlan(state, plan, {
    hostId,
    inputs,
    defaultTimeoutMs,
    verifierRegistry: verifierRegistry || runtime?.verifierRegistry,
  });
  const actions = Array.isArray(actionsResult) ? actionsResult : actionsResult.actions;
  const resolverTrace = Array.isArray(actionsResult) ? (actionsResult.resolverTrace || []) : (actionsResult.resolverTrace || []);
  const checks = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    try {
      const dispatched = await runtime.dispatchTool(runId, action.toolName, action.args, {
        ...(action.options || {}),
        scope: { hostId: action.hostId || hostId || state?.spec?.context?.hostId || 'local' },
        allowApproval: false,
        requestApproval,
        executeTool,
        signal,
        verifierAction: true,
      });
      checks.push(normalizeVerifierActionResult(action, dispatched, index));
    } catch (err) {
      logger?.warn?.('[agent-runtime] verifier action failed', { runId, error: err.message });
      checks.push({
        index,
        requirementId: action.requirementId || '',
        type: action.type || 'unknown',
        ok: false,
        status: 'failed',
        toolName: action.toolName || '',
        target: action.target || '',
        reason: err.message,
        reasons: ['verifier_action_exception'],
        evidence: err.message,
      });
    }
  }

  if (actions.length === 0) {
    checks.push(...plan.requirements.map((requirement, index) => ({
      index,
      requirementId: requirement.id || '',
      type: requirement.type || 'outcome',
      ok: false,
      status: 'unsupported',
      toolName: '',
      target: requirement.summary || requirement.id || '',
      reason: 'No executable verifier is available for this requirement.',
      reasons: ['no_executable_verifier'],
      evidence: requirement.summary || requirement.id || '',
    })));
  }

  const result = summarizeRuntimeVerifierPlan({ checks, plan, actions, reason, resolverTrace });
  runtime.recordObservation?.(runId, {
    kind: 'verification',
    stage: 'verify',
    toolName: 'agent_verifier_executor',
    ok: result.ok,
    isError: result.ok !== true,
    content: formatRuntimeVerifierPlanResult(result),
    data: {
      reason,
      verifierPlan: plan,
      actions: actions.map(summarizeVerifierAction),
      checks,
      resolverTrace,
    },
  });
  runtime.recordVerification?.(runId, {
    ...result,
    type: 'runtime_verifier_plan',
    target: hostId || state?.spec?.context?.hostId || '',
  });
  updateVerificationArtifact(runtime, runId, result);
  if (state?.phases?.verify && runtime?.updatePhase) {
    runtime.updatePhase(runId, 'verify', {
      status: result.status === 'passed' ? 'done' : 'failed',
      message: result.status === 'passed' ? 'Runtime verifier passed' : `Runtime verifier ${result.status}`,
      evidence: result.reasons || [],
    });
  }
  return {
    ...result,
    attempted: true,
    plan,
    actions: actions.map(summarizeVerifierAction),
    resolverTrace,
  };
}

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

function buildVerifierActionsFromPlan(state = {}, plan = {}, options = {}) {
  const registry = normalizeVerifierRegistry(options.verifierRegistry);
  const actions = [];
  const resolverTrace = [];
  const requirements = Array.isArray(plan.requirements) ? plan.requirements : [];
  for (const requirement of requirements) {
    const resolved = registry.resolveRequirement(state, requirement, options);
    resolverTrace.push({
      requirementId: requirement.id || '',
      source: requirement.source || '',
      type: requirement.type || '',
      resolverId: resolved.resolverId || '',
      actionCount: resolved.actions.length,
      attempts: resolved.attempts,
    });
    if (resolved.actions.length > 0) actions.push(...resolved.actions);
  }
  actions.resolverTrace = resolverTrace;
  actions.registry = registry.listResolvers();
  return actions;
}

function buildVerifierActionForRequirement(state = {}, requirement = {}, options = {}) {
  if (requirement.source !== 'output_contract') return null;
  const verifier = normalizeVerifierSpec(requirement.verifier);
  const type = normalizeVerifierType(verifier.type || requirement.type || 'command');
  const hostId = String(verifier.hostId || verifier.host_id || options.hostId || state?.spec?.context?.hostId || 'local').trim() || 'local';
  const base = {
    requirementId: String(requirement.id || ''),
    type,
    toolName: 'verify_outcome',
    hostId,
    target: requirement.summary || '',
    options: { capability: 'verify' },
  };

  if (type === 'command') {
    const command = renderCommand(verifier.run || verifier.command || '', options.inputs, options.renderTemplate);
    if (!command) return null;
    return {
      ...base,
      args: {
        type: 'command',
        reason: verifier.reason || requirement.summary || 'Verify output contract command.',
        hostId,
        command,
        contains: verifier.contains || verifier.expect_contains || '',
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: `${hostId}: ${command.slice(0, 300)}`,
    };
  }

  if (type === 'http') {
    const url = String(verifier.url || '').trim();
    if (!url) return null;
    return {
      ...base,
      args: {
        type: 'http',
        reason: verifier.reason || requirement.summary || 'Verify output contract HTTP endpoint.',
        url,
        method: verifier.method || 'GET',
        expectedStatus: verifier.expectedStatus || verifier.expected_status,
        contains: verifier.contains || '',
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: url,
    };
  }

  if (type === 'file_exists') {
    const filePath = String(verifier.path || verifier.file || '').trim();
    if (!filePath) return null;
    return {
      ...base,
      args: {
        type: 'file_exists',
        reason: verifier.reason || requirement.summary || 'Verify output contract file exists.',
        hostId,
        path: filePath,
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: `${hostId}: ${filePath}`,
    };
  }

  if (type === 'port') {
    const port = Number(verifier.port);
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      ...base,
      args: {
        type: 'port',
        reason: verifier.reason || requirement.summary || 'Verify output contract TCP port.',
        hostId,
        host: verifier.host || '',
        port,
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: `${verifier.host || hostId}:${port}`,
    };
  }

  return null;
}

function normalizeVerifierActionResult(action = {}, result = {}, index = 0) {
  const verification = normalizeVerificationPayload(result?.verification || result?.data?.verification || null);
  if (verification) {
    return {
      index,
      requirementId: action.requirementId || '',
      type: verification.type || action.type || 'unknown',
      ok: verification.ok === true,
      status: verification.status || (verification.ok ? 'passed' : 'failed'),
      toolName: action.toolName || '',
      target: verification.target || action.target || '',
      reason: verification.reason || '',
      reasons: normalizeStringArray(verification.reasons),
      evidence: verification.evidence || '',
      data: normalizeObject(verification.data),
    };
  }
  const isError = result?.is_error === true || result?.ok === false;
  return {
    index,
    requirementId: action.requirementId || '',
    type: action.type || 'unknown',
    ok: !isError,
    status: isError ? 'failed' : 'passed',
    toolName: action.toolName || '',
    target: action.target || '',
    reason: result?.error || '',
    reasons: isError ? ['verifier_tool_failed'] : [],
    evidence: compactText(result?.content || '', 4000),
    data: normalizeObject(result?.data),
  };
}

function summarizeRuntimeVerifierPlan({ checks = [], plan = {}, actions = [], reason = '', resolverTrace = [] } = {}) {
  const status = summarizeVerifyStatus(checks);
  const failed = checks.filter((check) => check.ok !== true);
  const reasons = failed.length > 0
    ? failed.flatMap((check) => normalizeStringArray(check.reasons).length ? normalizeStringArray(check.reasons) : [`verify_${check.status || 'failed'}:${check.requirementId || check.index}`])
    : ['verification_passed'];
  return {
    ok: status === 'passed',
    status,
    reasons: Array.from(new Set(reasons)),
    checks: Array.isArray(checks) ? checks : [],
    data: {
      verifierPlanStatus: plan.status || '',
      requirementIds: Array.isArray(plan.requirements) ? plan.requirements.map((item) => item.id).filter(Boolean) : [],
      actionCount: actions.length,
      resolverTrace,
      reason,
    },
  };
}

function formatRuntimeVerifierPlanResult(result = {}) {
  const lines = [
    `[runtime_verifier_plan] ${result.status || 'unknown'}`,
    `ok=${result.ok === true}`,
    Array.isArray(result.reasons) && result.reasons.length ? `reasons=${result.reasons.join(',')}` : '',
  ];
  for (const check of Array.isArray(result.checks) ? result.checks : []) {
    lines.push([
      `- ${check.requirementId || `check-${check.index}`}: ${check.status || 'unknown'}`,
      check.target ? `target=${check.target}` : '',
      check.reason ? `reason=${check.reason}` : '',
    ].filter(Boolean).join(' | '));
  }
  return lines.filter(Boolean).join('\n');
}

function summarizeVerifierAction(action = {}) {
  return {
    requirementId: action.requirementId || '',
    resolverId: action.resolverId || '',
    type: action.type || '',
    toolName: action.toolName || '',
    target: action.target || '',
    hostId: action.hostId || '',
  };
}

function normalizeVerifierSpec(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeVerifierType(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function normalizeVerificationPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = String(value.status || (value.ok === true ? 'passed' : 'failed')).trim() || 'failed';
  return {
    type: String(value.type || 'unknown'),
    ok: value.ok === true || status === 'passed',
    status,
    taskStatus: String(value.taskStatus || value.task_status || ''),
    target: String(value.target || ''),
    reason: String(value.reason || ''),
    reasons: normalizeStringArray(value.reasons),
    evidence: compactText(value.evidence || value.content || '', 4000),
    data: normalizeObject(value.data),
  };
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

function summarizeVerificationChecks(checks) {
  const status = summarizeVerifyStatus(checks);
  const reasons = checks
    .filter((check) => !check.ok)
    .map((check) => check.reason || `verify_${check.status || 'failed'}:${check.index}`);
  return {
    ok: status === 'passed',
    status,
    reasons,
    checks: Array.isArray(checks) ? checks : [],
  };
}

function updateVerificationArtifact(runtime, runId, result) {
  if (!runtime?.updateArtifact) return null;
  return runtime.updateArtifact(runId, {
    id: 'agent-verify-result',
    type: 'verification_result',
    title: result.ok ? 'Verification passed' : 'Verification failed',
    content: result.ok ? 'All verifier checks passed.' : (result.reasons || []).join('\n'),
    data: result,
  });
}

function toolResultToCommandResult(result) {
  if (result?.raw && typeof result.raw === 'object') return result.raw;
  return {
    stdout: '',
    stderr: String(result?.content || ''),
    exitCode: result?.is_error ? 126 : 0,
    durationMs: 0,
  };
}

function summarizeVerifyStatus(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'unsupported';
  if (checks.some((check) => check.status === 'unsupported')) return 'unsupported';
  return checks.every((check) => check.ok) ? 'passed' : 'failed';
}

function toExpectedExitCode(item) {
  const value = item.expect_exit_code ?? item.expected_exit_code ?? item.exit_code;
  const number = Number(value === undefined ? 0 : value);
  return Number.isInteger(number) ? number : 0;
}

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function renderCommand(value, inputs, renderTemplate) {
  if (typeof renderTemplate === 'function') return String(renderTemplate(value, inputs) || '').trim();
  return String(value || '').replace(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => String(inputs?.[name] ?? '')).trim();
}

function applyRedactText(value, redactText) {
  return typeof redactText === 'function' ? String(redactText(value) || '') : String(value || '');
}

function applyRedactResult(result, redactResult) {
  if (typeof redactResult !== 'function') return result;
  const redacted = redactResult(result);
  return redacted && typeof redacted === 'object' ? redacted : result;
}

function applyCompact(value, maxLength, compactText) {
  if (typeof compactText === 'function') return compactText(value, maxLength);
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
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
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

module.exports = {
  applyVerifierPlanToRuntimeState,
  buildVerifierActionsFromPlan,
  collectVerifierRequirements,
  evaluateVerifierPlan,
  runAgentVerification,
  runVerifierPlan,
  summarizeVerificationChecks,
  summarizeVerifyStatus,
  toExpectedExitCode,
  toPositiveInt,
  toolResultToCommandResult,
  updateVerificationArtifact,
};
