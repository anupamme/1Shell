'use strict';

const QUESTION_TYPES = new Set(['ask_user', 'question']);
const SECRET_TYPES = new Set(['request_secret', 'secret']);
const APPROVAL_TYPES = new Set(['request_approval', 'approval']);

function createAgentQuestionInterrupt(runtime, runId, input = {}) {
  const normalized = normalizeQuestionInput(input);
  return createStructuredInterrupt(runtime, runId, {
    type: 'ask_user',
    reason: normalized.reason,
    message: normalized.message,
    payload: {
      questions: normalized.questions,
      allowMultiple: normalized.allowMultiple,
    },
    turn: normalized.turn,
    scope: normalized.scope,
  });
}

function createAgentSecretInterrupt(runtime, runId, input = {}) {
  const normalized = normalizeSecretInput(input);
  return createStructuredInterrupt(runtime, runId, {
    type: 'request_secret',
    reason: normalized.reason,
    message: normalized.message,
    payload: {
      secrets: normalized.secrets,
      storePolicy: normalized.storePolicy,
    },
    turn: normalized.turn,
    scope: normalized.scope,
  });
}

function createAgentApprovalInterrupt(runtime, runId, input = {}) {
  const normalized = normalizeApprovalInput(input);
  return createStructuredInterrupt(runtime, runId, {
    type: 'request_approval',
    reason: normalized.reason,
    message: normalized.message,
    payload: {
      action: normalized.action,
      riskLevel: normalized.riskLevel,
      riskReason: normalized.riskReason,
      toolName: normalized.toolName,
      args: normalized.args,
      options: normalized.options,
    },
    turn: normalized.turn,
    scope: normalized.scope,
    runnerStatus: 'waiting_approval',
  });
}

function createAgentStructuredInterrupt(runtime, runId, input = {}) {
  const type = normalizeInterruptType(input.type);
  if (QUESTION_TYPES.has(type)) return createAgentQuestionInterrupt(runtime, runId, input);
  if (SECRET_TYPES.has(type)) return createAgentSecretInterrupt(runtime, runId, input);
  if (APPROVAL_TYPES.has(type)) return createAgentApprovalInterrupt(runtime, runId, input);
  return createStructuredInterrupt(runtime, runId, {
    type,
    reason: stringOr(input.reason, type),
    message: stringOr(input.message, input.reason || type),
    payload: normalizeObject(input.payload || input.data),
    turn: input.turn,
    scope: normalizeObject(input.scope),
  });
}

function resolveAgentInterrupt(runtime, runId, interruptId = '', resolution = {}) {
  if (!runtime?.resumeRun) throw new Error('Agent runtime resumeRun is not configured');
  const state = runtime.getState?.(runId);
  const interrupt = findInterrupt(state, interruptId);
  const normalized = normalizeInterruptResolution(interrupt, resolution);
  const checkpointId = stringOr(normalized.checkpointId, '');
  delete normalized.checkpointId;
  return runtime.resumeRun(runId, {
    checkpointId,
    interruptId,
    resolution: normalized,
    runnerStatus: normalized.status === 'rejected' ? 'interrupted' : 'running',
  });
}

function normalizeInterruptResolution(interrupt = null, resolution = {}) {
  const source = normalizeObject(resolution);
  const type = normalizeInterruptType(interrupt?.type || source.type);
  if (SECRET_TYPES.has(type)) return normalizeSecretResolution(source);
  if (APPROVAL_TYPES.has(type)) return normalizeApprovalResolution(source);
  if (QUESTION_TYPES.has(type)) return normalizeQuestionResolution(source);
  return {
    status: source.status || 'resolved',
    ...source,
  };
}

function createStructuredInterrupt(runtime, runId, input = {}) {
  if (!runtime?.createInterrupt) throw new Error('Agent runtime createInterrupt is not configured');
  return runtime.createInterrupt(runId, {
    ...input,
    type: normalizeInterruptType(input.type),
    taskStatus: input.taskStatus || 'blocked',
    runnerStatus: input.runnerStatus || 'interrupted',
  });
}

function normalizeQuestionInput(input = {}) {
  const questions = normalizeQuestions(input.questions || input.payload?.questions || input.question);
  return {
    reason: stringOr(input.reason, 'ask_user'),
    message: stringOr(input.message, questions[0]?.prompt || input.reason || 'Agent 需要用户补充信息'),
    questions,
    allowMultiple: input.allowMultiple === true || input.allow_multiple === true,
    turn: input.turn,
    scope: normalizeObject(input.scope),
  };
}

function normalizeSecretInput(input = {}) {
  const secrets = normalizeSecrets(input.secrets || input.payload?.secrets || input.secret || input.name);
  return {
    reason: stringOr(input.reason, 'request_secret'),
    message: stringOr(input.message, secrets[0]?.label || input.reason || 'Agent 需要一个密钥引用'),
    secrets,
    storePolicy: normalizeObject(input.storePolicy || input.store_policy || input.payload?.storePolicy),
    turn: input.turn,
    scope: normalizeObject(input.scope),
  };
}

function normalizeApprovalInput(input = {}) {
  const payload = normalizeObject(input.payload || input.data);
  return {
    reason: stringOr(input.reason, payload.reason || 'approval_required'),
    message: stringOr(input.message, payload.message || input.reason || 'Agent 请求执行需要人工审批的操作'),
    action: stringOr(input.action, payload.action || input.toolName || input.tool_name || ''),
    riskLevel: stringOr(input.riskLevel || input.risk_level, payload.riskLevel || payload.risk_level || ''),
    riskReason: stringOr(input.riskReason || input.risk_reason, payload.riskReason || payload.risk_reason || ''),
    toolName: stringOr(input.toolName || input.tool_name, payload.toolName || payload.tool_name || ''),
    args: normalizeObject(input.args || payload.args),
    options: normalizeObject(input.options || payload.options),
    turn: input.turn,
    scope: normalizeObject(input.scope || payload.scope),
  };
}

function normalizeQuestionResolution(source = {}) {
  return {
    status: source.status || 'answered',
    answers: normalizeObject(source.answers || source.answer || source.payload?.answers),
    note: stringOr(source.note, ''),
    checkpointId: source.checkpointId || source.checkpoint_id,
  };
}

function normalizeApprovalResolution(source = {}) {
  const approved = source.approved === true || source.status === 'approved' || source.decision === 'approved';
  const rejected = source.approved === false || source.status === 'rejected' || source.decision === 'rejected';
  return {
    status: approved ? 'approved' : (rejected ? 'rejected' : (source.status || 'approved')),
    reason: stringOr(source.reason, ''),
    scope: normalizeObject(source.scope),
    expiresAt: stringOr(source.expiresAt || source.expires_at, ''),
    checkpointId: source.checkpointId || source.checkpoint_id,
  };
}

function normalizeSecretResolution(source = {}) {
  const refs = normalizeSecretRefs(source.secretRefs || source.secret_refs || source.refs || source.secretRef || source.secret_ref);
  const providedPlaintext = hasPlaintextSecretValue(source);
  return {
    status: source.status || (refs.length > 0 || providedPlaintext ? 'provided' : 'resolved'),
    secretRefs: refs,
    // AgentRun trace 不保存密钥明文。真实密钥应进入 SecretService，再只把引用回灌给 Agent。
    plaintextProvided: providedPlaintext,
    redacted: providedPlaintext,
    note: stringOr(source.note, ''),
    checkpointId: source.checkpointId || source.checkpoint_id,
  };
}

function normalizeQuestions(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item, index) => {
    if (typeof item === 'string') {
      return { id: `q${index + 1}`, prompt: item, type: 'text', required: true, options: [] };
    }
    const source = normalizeObject(item);
    return {
      id: stringOr(source.id || source.name, `q${index + 1}`),
      prompt: stringOr(source.prompt || source.question || source.label, `问题 ${index + 1}`),
      type: stringOr(source.type, 'text'),
      required: source.required !== false,
      options: normalizeOptions(source.options),
    };
  }).filter((item) => item.prompt);
}

function normalizeSecrets(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item, index) => {
    if (typeof item === 'string') {
      return { name: item, label: item, required: true, target: 'secret_ref' };
    }
    const source = normalizeObject(item);
    return {
      name: stringOr(source.name || source.id, `secret_${index + 1}`),
      label: stringOr(source.label || source.name || source.id, `密钥 ${index + 1}`),
      required: source.required !== false,
      target: stringOr(source.target, 'secret_ref'),
      description: stringOr(source.description, ''),
    };
  }).filter((item) => item.name);
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((item) => {
    if (typeof item === 'string') return { value: item, label: item };
    const source = normalizeObject(item);
    return {
      value: stringOr(source.value || source.id, ''),
      label: stringOr(source.label || source.value || source.id, ''),
    };
  }).filter((item) => item.value || item.label);
}

function normalizeSecretRefs(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map((item) => {
    if (typeof item === 'string') return { ref: item };
    const source = normalizeObject(item);
    return {
      name: stringOr(source.name || source.id, ''),
      ref: stringOr(source.ref || source.secretRef || source.secret_ref || source.id, ''),
    };
  }).filter((item) => item.ref);
}

function hasPlaintextSecretValue(source = {}) {
  return ['value', 'secret', 'token', 'apiKey', 'api_key', 'password'].some((key) => source[key] !== undefined && source[key] !== null && String(source[key]).trim() !== '');
}

function findInterrupt(state = null, interruptId = '') {
  if (!state || !Array.isArray(state.interrupts)) return null;
  const id = stringOr(interruptId, '');
  return state.interrupts.find((item) => item.id === id) || null;
}

function normalizeInterruptType(type) {
  const text = stringOr(type, 'manual').toLowerCase().replace(/-/g, '_');
  if (text === 'permission') return 'request_approval';
  if (text === 'user_input') return 'ask_user';
  return text || 'manual';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function stringOr(value, fallback) {
  const text = String(value ?? '').trim();
  return text || String(fallback ?? '').trim();
}

module.exports = {
  createAgentApprovalInterrupt,
  createAgentQuestionInterrupt,
  createAgentSecretInterrupt,
  createAgentStructuredInterrupt,
  normalizeInterruptResolution,
  resolveAgentInterrupt,
};
