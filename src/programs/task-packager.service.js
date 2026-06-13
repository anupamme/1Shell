'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { evaluateAgentRunOutcome, getSideEffectLedger, getVerificationResult, getVerifierPlanResult } = require('../agent-runtime/outcome');
const { cloneAgentState } = require('../agent-runtime/store');
const { normalizeProgram } = require('./program-schema');

const DEFAULT_PROGRAM_ID_PREFIX = 'packaged-task';
const MAX_GOAL_LENGTH = 2400;
const MAX_EVIDENCE_LENGTH = 3000;

function createTaskPackagerService({ agentRuntime, programRegistry, programsDir, logger } = {}) {
  if (!agentRuntime?.getState) throw new Error('TaskPackagerService requires agentRuntime.getState');
  if (!programsDir) throw new Error('TaskPackagerService requires programsDir');

  function createDraftFromAgentRun(options = {}) {
    const runId = String(options.runId || options.agentRunId || '').trim();
    if (!runId) throw new Error('runId is required');

    const state = cloneAgentState(agentRuntime.getState(runId));
    if (!state) throw new Error(`AgentRun not found: ${runId}`);
    const outcome = evaluateAgentRunOutcome(state, { fallbackTaskStatus: 'unverified' });
    const outcomeStatus = String(outcome.taskStatus || 'unverified');
    const allowUnverifiedDraft = options.allowUnverifiedDraft === true;
    const write = options.write === true;

    if (hasPendingInterrupts(state)) {
      throw new Error('AgentRun still has pending interrupts; resolve them before packaging');
    }
    if (isRunnerActive(state)) {
      throw new Error('AgentRun is still active; package after it completes');
    }
    if (outcomeStatus !== 'verified' && !allowUnverifiedDraft) {
      throw new Error(`Only verified AgentRun can be packaged by default; current outcome is ${outcomeStatus}`);
    }

    const programId = normalizeProgramId(options.programId || createProgramIdFromState(state));
    const overwrite = options.overwrite === true;
    const programDir = resolveProgramDir(programsDir, programId);
    const programPath = path.join(programDir, 'program.yaml');
    if (write && fs.existsSync(programPath) && !overwrite) {
      throw new Error(`Task already exists: ${programId}`);
    }

    const draft = buildProgramDraft({ state, runId, programId, outcome, outcomeStatus });
    const yamlText = dumpProgramYaml(draft);
    const secretFindings = scanForPlainSecrets(yamlText);
    if (secretFindings.length > 0) {
      throw new Error(`Task draft may contain plaintext secrets: ${secretFindings.join(', ')}`);
    }

    const validation = validateProgramDraft(draft, programId, runId);
    if (!validation.ok) {
      throw new Error(`Generated task draft failed schema validation: ${validation.error}`);
    }

    if (write) {
      fs.mkdirSync(programDir, { recursive: true });
      fs.writeFileSync(programPath, yamlText, 'utf8');
      try { programRegistry?.reload?.(); }
      catch (err) { logger?.warn?.(`[task-packager] failed to reload program registry: ${err.message}`); }
    }

    return {
      ok: true,
      programId,
      trustLevel: outcomeStatus === 'verified' ? 'draft_from_trace' : 'unverified',
      sourceTrustLevel: outcomeStatus === 'verified' ? 'verified_agent_run' : outcomeStatus,
      written: write,
      path: write ? programPath : path.join('data', 'programs', programId, 'program.yaml'),
      yaml: yamlText,
      programDraft: draft,
      validation,
      provenance: draft.metadata?.packaging?.provenance || {},
      warnings: buildWarnings({ state, outcomeStatus, allowUnverifiedDraft, secretFindings }),
    };
  }

  return { createDraftFromAgentRun };
}

function buildProgramDraft({ state, runId, programId, outcome, outcomeStatus }) {
  const verification = getVerificationResult(state);
  const verifierPlan = getVerifierPlanResult(state);
  const verificationArtifact = findArtifact(state, (item) => item?.type === 'verification_result' || item?.id === 'program-verify-result');
  const sideEffectLedger = getSideEffectLedger(state);
  const hostIds = extractHostIds(state, sideEffectLedger);
  const workflowPhases = extractWorkflowPhases(state);
  const inputs = extractInputsFromContext(state);
  const secretRequirements = extractSecretRequirements(state);
  const verifyContract = buildVerifyContract(verificationArtifact, verification);
  const name = titleFromGoal(state.goal, programId);
  const description = `从 AgentRun ${runId} 打包生成的自动化任务草稿。`;

  return {
    name,
    description,
    enabled: true,
    hosts: hostIds.length > 0 ? hostIds : 'all',
    inputs,
    triggers: [
      { id: 'manual', type: 'manual', action: 'run' },
    ],
    actions: {
      run: {
        label: '运行打包的自动化任务',
        steps: [
          {
            id: 'run_task',
            type: 'ai',
            label: '执行自动化任务',
            goal: buildPackagedGoal(state, { runId, outcome, sideEffectLedger, secretRequirements }),
            workflow: workflowPhases.length > 0 ? { phases: workflowPhases } : undefined,
            verify: verifyContract,
          },
        ],
      },
    },
    workflow: workflowPhases.length > 0 ? { phases: workflowPhases } : undefined,
    verify: verifyContract,
    metadata: {
      product_term: 'automation_task',
      task_status: outcomeStatus === 'verified' ? 'draft_from_trace' : 'unverified',
      packaging: {
        schemaVersion: 1,
        source: 'agent_run',
        trustLevel: outcomeStatus === 'verified' ? 'draft_from_trace' : 'unverified',
        requiresReplay: true,
        secretRequirements,
        sideEffectLedger: summarizeSideEffectLedger(sideEffectLedger),
        provenance: {
          agentRunId: runId,
          goal: redactPotentialSecrets(state.goal || ''),
          source: state.source || '',
          runnerStatus: state.runnerStatus || '',
          taskStatus: state.taskStatus || '',
          outcomeStatus,
          outcomeReasons: Array.isArray(outcome.reasons) ? outcome.reasons : [],
          verification: verification ? {
            ok: verification.ok === true,
            status: verification.status || '',
            reasons: verification.reasons || [],
            evidence: truncate(redactPotentialSecrets(verificationArtifact?.content || ''), MAX_EVIDENCE_LENGTH),
          } : null,
          verifierPlan: verifierPlan ? {
            required: verifierPlan.required === true,
            ok: verifierPlan.ok === true,
            status: verifierPlan.status || '',
            reasons: verifierPlan.reasons || [],
            requirementIds: verifierPlan.requirementIds || [],
          } : null,
          packagedAt: new Date().toISOString(),
        },
      },
    },
  };
}

function buildPackagedGoal(state, { runId, outcome, sideEffectLedger, secretRequirements }) {
  const lines = [
    '你正在执行一个从已验证 AgentRun 打包而来的 1Shell 自动化任务草稿。',
    '',
    '原始目标：',
    truncate(redactPotentialSecrets(state.goal || '未记录原始目标'), MAX_GOAL_LENGTH),
    '',
    '执行要求：',
    '- 不要假设本次环境与原始 AgentRun 完全相同，先观察再行动。',
    '- 缺少关键输入时调用 ask_user；需要 token、密码、API key 时调用 request_secret。',
    '- 不要在普通聊天、任务 YAML、日志或 artifact 中保存 secret 明文。',
    '- 发生部署、写文件、配置、启动服务等副作用后，结束前必须调用 verify_outcome 或等价验证。',
    '- 只有验证通过才能报告 verified；否则明确 failed / blocked / unverified。',
    '',
    `来源 AgentRun：${runId}`,
    `来源 outcome：${String(outcome?.taskStatus || 'unknown')}`,
  ];
  if (Array.isArray(outcome?.reasons) && outcome.reasons.length > 0) {
    lines.push(`来源 outcome reasons：${outcome.reasons.join(', ')}`);
  }
  if (sideEffectLedger?.requiresVerification || sideEffectLedger?.hasSideEffects) {
    lines.push('来源执行包含副作用，因此本任务必须保留验证闭环。');
  }
  if (secretRequirements.length > 0) {
    lines.push('', '运行时可能需要这些 secret slot：');
    for (const item of secretRequirements) {
      lines.push(`- ${item.name}: ${item.description || item.provider || '运行时凭据'}`);
    }
  }
  return lines.join('\n');
}

function extractWorkflowPhases(state) {
  const outputPhases = state?.spec?.outputContract?.phases;
  const raw = Array.isArray(outputPhases) && outputPhases.length > 0
    ? outputPhases
    : Object.values(state?.phases || {});
  const seen = new Set();
  return raw
    .map((phase) => {
      if (!phase || typeof phase !== 'object') return null;
      const id = String(phase.id || '').trim();
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        label: String(phase.label || phase.name || id),
        required: phase.required === true,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function extractInputsFromContext(state) {
  const context = state?.spec?.context && typeof state.spec.context === 'object' ? state.spec.context : {};
  const candidates = { ...(context.inputs && typeof context.inputs === 'object' ? context.inputs : {}), ...context };
  const skip = new Set(['inputs', 'messages', 'phases', 'sessionId', 'runId', 'agentRunId', 'source', 'metadata']);
  const inputs = [];
  for (const [key, value] of Object.entries(candidates)) {
    if (inputs.length >= 8) break;
    if (skip.has(key) || isSecretLikeKey(key)) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    if (!isScalar(value)) continue;
    const type = typeof value === 'number' ? 'number' : (typeof value === 'boolean' ? 'boolean' : 'string');
    inputs.push({
      name: key,
      label: key,
      type,
      required: false,
      description: '从源 AgentRun context 推断出的可选输入，请在 replay 前审查。',
      default: redactPotentialSecrets(value),
    });
  }
  return inputs;
}

function extractSecretRequirements(state) {
  const found = [];
  const add = (raw = {}) => {
    const name = normalizeInputName(raw.name || raw.key || raw.id || raw.provider || `secret_${found.length + 1}`);
    if (!name || found.some((item) => item.name === name)) return;
    found.push({
      name,
      provider: String(raw.provider || raw.kind || '').slice(0, 80),
      required: true,
      description: String(raw.description || raw.reason || raw.prompt || '运行时需要的凭据').slice(0, 300),
    });
  };
  for (const interrupt of Array.isArray(state?.interrupts) ? state.interrupts : []) {
    const kind = String(interrupt?.kind || interrupt?.type || interrupt?.interruptType || '').toLowerCase();
    if (kind.includes('secret')) add(interrupt?.payload || interrupt?.data || interrupt);
  }
  for (const toolCall of Array.isArray(state?.toolCalls) ? state.toolCalls : []) {
    if (String(toolCall?.name || toolCall?.toolName || '') === 'request_secret') {
      add(toolCall.args || toolCall.input || toolCall.request || {});
    }
  }
  return found.slice(0, 8);
}

function extractHostIds(state, ledger) {
  const hosts = new Set();
  const add = (value) => {
    const host = String(value || '').trim();
    if (host && host !== 'all') hosts.add(host);
  };
  const context = state?.spec?.context || {};
  add(context.hostId || context.host_id);
  for (const hostId of Array.isArray(context.hostIds) ? context.hostIds : []) add(hostId);
  for (const item of Array.isArray(ledger?.sideEffects) ? ledger.sideEffects : []) add(item.hostId);
  for (const toolCall of Array.isArray(state?.toolCalls) ? state.toolCalls : []) {
    add(toolCall.hostId || toolCall.args?.hostId || toolCall.input?.hostId);
  }
  return Array.from(hosts).slice(0, 12);
}

function buildVerifyContract(artifact, verification) {
  if (!verification && !artifact) return [];
  const data = artifact?.data && typeof artifact.data === 'object' ? artifact.data : {};
  const item = {
    type: String(data.type || 'manual'),
    status: String(data.status || verification?.status || ''),
    target: data.target ? String(data.target) : undefined,
    reason: data.reason ? String(data.reason) : '沿用源 AgentRun 的验证证据；replay 时需要转换为可自动复现的验证。',
    evidence: truncate(redactPotentialSecrets(artifact?.content || data.evidence || ''), MAX_EVIDENCE_LENGTH),
    reasons: Array.isArray(data.reasons) ? data.reasons.map(String).filter(Boolean) : (verification?.reasons || []),
  };
  return [removeUndefined(item)];
}

function validateProgramDraft(draft, programId, runId) {
  try {
    const normalized = normalizeProgram(draft, programId, `<task-packager:${runId}>`);
    return { ok: true, normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function dumpProgramYaml(draft) {
  return yaml.dump(pruneUndefined(draft), {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

function resolveProgramDir(programsDir, programId) {
  const base = path.resolve(programsDir);
  const target = path.resolve(base, programId);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Task path is outside programsDir');
  return target;
}

function createProgramIdFromState(state) {
  const slug = slugify(state?.goal || state?.runId || 'task').slice(0, 46) || 'task';
  return `${DEFAULT_PROGRAM_ID_PREFIX}-${slug}`.replace(/-+/g, '-').replace(/-$/g, '');
}

function normalizeProgramId(value) {
  const id = slugify(String(value || '').trim());
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Task id is invalid: ${value}`);
  return id;
}

function normalizeInputName(value) {
  const name = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) return '';
  return /^[a-z_]/.test(name) ? name : `secret_${name}`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function titleFromGoal(goal, fallback) {
  const text = String(goal || '').trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return truncate(redactPotentialSecrets(text), 80);
}

function summarizeSideEffectLedger(ledger) {
  return {
    hasSideEffects: ledger?.hasSideEffects === true,
    requiresVerification: ledger?.requiresVerification === true,
    reasons: Array.isArray(ledger?.reasons) ? ledger.reasons : [],
    sideEffects: (Array.isArray(ledger?.sideEffects) ? ledger.sideEffects : []).slice(-20).map((item) => ({
      toolName: item.toolName || '',
      hostId: item.hostId || '',
      summary: redactPotentialSecrets(item.summary || ''),
    })),
  };
}

function buildWarnings({ state, outcomeStatus, allowUnverifiedDraft, secretFindings }) {
  const warnings = [];
  if (outcomeStatus !== 'verified') warnings.push(`source_agent_run_not_verified:${outcomeStatus}`);
  if (allowUnverifiedDraft) warnings.push('allow_unverified_draft_enabled');
  if (!findArtifact(state, (item) => item?.type === 'verification_result')) warnings.push('verification_artifact_missing');
  if (secretFindings.length > 0) warnings.push(...secretFindings.map((item) => `secret_finding:${item}`));
  warnings.push('draft_requires_replay_before_proven');
  return warnings;
}

function hasPendingInterrupts(state) {
  return (Array.isArray(state?.interrupts) ? state.interrupts : []).some((item) => item?.status === 'pending');
}

function isRunnerActive(state) {
  return ['queued', 'running', 'pausing'].includes(String(state?.runnerStatus || '').toLowerCase());
}

function findArtifact(state, predicate) {
  const items = Array.isArray(state?.artifacts) ? state.artifacts : [];
  return [...items].reverse().find(predicate) || null;
}

function isScalar(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 500;
}

function isSecretLikeKey(key) {
  return /(secret|token|password|passwd|apikey|api_key|private[_-]?key|credential)/i.test(String(key || ''));
}

function redactPotentialSecrets(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"`]+/ig, '$1[REDACTED_SECRET]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[REDACTED_SECRET]');
  text = text.replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*['"]?([^\s'"`]{12,})/ig, '$1: [REDACTED_SECRET]');
  return text;
}

function scanForPlainSecrets(text) {
  const findings = [];
  const patterns = [
    ['bearer_token', /authorization\s*[:=]\s*bearer\s+(?!\[REDACTED_SECRET\])[^\s'"`]{12,}/i],
    ['openai_or_similar_key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
    ['github_token', /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/],
    ['assigned_secret_value', /\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*['"]?(?!\[REDACTED_SECRET\])[^\s'"`]{16,}/i],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push(name);
  }
  return findings;
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = pruneUndefined(item);
  }
  return out;
}

function removeUndefined(value) {
  return pruneUndefined(value);
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

module.exports = { createTaskPackagerService };
