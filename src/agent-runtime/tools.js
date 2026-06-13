'use strict';

const crypto = require('crypto');
const { SOURCE_TO_HARNESS_SOURCE } = require('./constants');

function createToolCallEnvelope({ state, toolName, args = {}, riskLevel = '', capability = '', scope = {} } = {}) {
  const now = new Date().toISOString();
  return {
    id: createToolCallId(),
    runId: state?.runId || '',
    source: state?.source || 'program',
    toolName: String(toolName || '').trim(),
    args: normalizeObject(args),
    riskLevel: String(riskLevel || ''),
    capability: String(capability || ''),
    scope: normalizeObject(scope),
    status: 'pending',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    result: null,
    createdAt: now,
  };
}

function buildHarnessContext({ harness, state, toolCall, overrides = {} } = {}) {
  const spec = state?.spec || {};
  const policy = spec.policy || {};
  const source = SOURCE_TO_HARNESS_SOURCE[state?.source] || state?.source || 'program-ai';
  const scope = toolCall?.scope || {};
  const context = spec.context || {};
  const capabilities = policy.capabilities === undefined
    ? (policy.readOnly ? ['read_only'] : undefined)
    : policy.capabilities;
  const base = harness?.buildContext
    ? harness.buildContext(source, {})
    : { source, hostId: 'local', capabilities: ['exec_command'], allowApproval: false, secrets: [] };

  return {
    ...base,
    source,
    runId: state?.runId,
    hostId: scope.hostId || context.hostId || base.hostId || 'local',
    hostScope: policy.hostScope,
    capabilities: capabilities === undefined ? base.capabilities : capabilities,
    allowApproval: overrides.allowApproval === true,
    approvalGranted: overrides.approvalGranted === true || overrides.preApproved === true,
    requestApproval: overrides.requestApproval,
    signal: overrides.signal,
    onOutput: overrides.onOutput,
    secrets: Array.isArray(overrides.secrets) ? overrides.secrets : (Array.isArray(base.secrets) ? base.secrets : []),
    auditCommand: overrides.auditCommand,
  };
}

function normalizeToolResult(result = {}) {
  const raw = result?.raw && typeof result.raw === 'object' ? result.raw : null;
  const exitCode = typeof raw?.exitCode === 'number'
    ? raw.exitCode
    : (typeof result.exitCode === 'number' ? result.exitCode : undefined);
  const isError = result.is_error === true || (typeof exitCode === 'number' && exitCode !== 0);
  const content = String(result.content || '');
  const stdoutExcerpt = excerpt(raw?.stdout || result.stdout || '');
  const stderrExcerpt = excerpt(raw?.stderr || result.stderr || '');
  const auditId = result.auditId || raw?.auditId || '';
  const durationMs = typeof raw?.durationMs === 'number' ? raw.durationMs : result.durationMs;
  const data = result.data && typeof result.data === 'object' ? { ...result.data } : {};
  const evidenceRecords = normalizeEvidenceRecords({
    evidence: result.evidence,
    data,
    content,
    stdoutExcerpt,
    stderrExcerpt,
    exitCode,
    auditId,
    durationMs,
    isError,
  });
  if (evidenceRecords.length > 0) data.evidenceRecords = evidenceRecords;

  return {
    ok: !isError,
    exitCode,
    durationMs,
    content,
    stdoutExcerpt,
    stderrExcerpt,
    evidence: evidenceRecords.map((item) => item.summary).filter(Boolean).slice(0, 20),
    data,
    truncated: Boolean(result.truncated),
    error: isError ? String(result.error || content || '').slice(0, 1000) : '',
    auditId,
  };
}

function normalizeEvidenceRecords({ evidence, data = {}, content = '', stdoutExcerpt = '', stderrExcerpt = '', exitCode, auditId = '', durationMs, isError = false } = {}) {
  const out = [];
  const existing = Array.isArray(data.evidenceRecords || data.evidence_records)
    ? (data.evidenceRecords || data.evidence_records)
    : [];
  for (const item of existing) pushEvidenceRecord(out, item);
  if (Array.isArray(evidence)) {
    for (const item of evidence) pushEvidenceRecord(out, item);
  }
  if (content) pushEvidenceRecord(out, { type: isError ? 'error_content' : 'content', summary: content });
  if (stdoutExcerpt) pushEvidenceRecord(out, { type: 'stdout', summary: stdoutExcerpt });
  if (stderrExcerpt) pushEvidenceRecord(out, { type: 'stderr', summary: stderrExcerpt });
  if (typeof exitCode === 'number') pushEvidenceRecord(out, { type: 'exit_code', summary: `exit_code=${exitCode}`, data: { exitCode } });
  if (auditId) pushEvidenceRecord(out, { type: 'audit', summary: `audit=${auditId}`, data: { auditId } });
  if (typeof durationMs === 'number') pushEvidenceRecord(out, { type: 'duration', summary: `duration_ms=${durationMs}`, data: { durationMs } });
  return out.slice(0, 30);
}

function pushEvidenceRecord(out, item) {
  if (!item) return;
  const record = typeof item === 'object' && !Array.isArray(item)
    ? {
      type: String(item.type || item.kind || 'evidence').trim() || 'evidence',
      summary: excerpt(item.summary || item.text || item.content || item.evidence || '', 1000),
      data: normalizeObject(item.data),
    }
    : {
      type: 'evidence',
      summary: excerpt(item, 1000),
      data: {},
    };
  if (!record.summary && Object.keys(record.data).length === 0) return;
  const key = `${record.type}:${record.summary}`;
  if (out.some((existing) => `${existing.type}:${existing.summary}` === key)) return;
  out.push(record);
}

function createToolCallId() {
  if (typeof crypto.randomUUID === 'function') return `tool-${crypto.randomUUID()}`;
  return `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function excerpt(value, max = 4000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

module.exports = {
  buildHarnessContext,
  createToolCallEnvelope,
  normalizeToolResult,
};
