'use strict';

const crypto = require('crypto');
const { summarizeAgentGraph } = require('./graph');
const { createRuntimeDecisionReviewState } = require('./decision-policy');
const { createReplayEvaluationState } = require('./replay');
const { createTrajectoryEvaluationState } = require('./trajectory');
const {
  AGENT_SOURCES,
  RUNNER_STATUSES,
  TASK_STATUSES,
} = require('./constants');
const { createAgentCognitionState } = require('./cognition');
const { createRuntimePlanState, createRuntimeRecoveryState } = require('./planning');

function createRunId(prefix = 'agent') {
  if (typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRunSpec(spec = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('AgentRunSpec must be an object');
  const source = normalizeEnum(spec.source, AGENT_SOURCES, 'console');
  const goal = String(spec.goal || '').trim();
  if (!goal) throw new Error('AgentRunSpec.goal is required');

  return {
    id: typeof spec.id === 'string' && spec.id.trim() ? spec.id.trim() : null,
    source,
    goal,
    context: normalizeObject(spec.context),
    tools: Array.isArray(spec.tools) ? spec.tools : [],
    policy: normalizePolicy(spec.policy),
    outputContract: normalizeObject(spec.outputContract),
    metadata: normalizeObject(spec.metadata),
  };
}

function createInitialAgentState(spec, { runId = null, now = new Date() } = {}) {
  const normalized = normalizeRunSpec(spec);
  const id = runId || normalized.id || createRunId(normalized.source);
  const budget = createBudgetState(normalized.policy);
  const phases = createPhaseState(normalized.outputContract?.phases || normalized.context?.phases);
  const timestamp = toIso(now);

  return {
    runId: id,
    source: normalized.source,
    goal: normalized.goal,
    runnerStatus: 'queued',
    taskStatus: 'unknown',
    currentPhase: '',
    currentTurn: null,
    phases,
    budget,
    turns: [],
    observations: [],
    verification: null,
    memory: createRuntimeMemoryState(),
    runtimeState: createRuntimeState(),
    toolCalls: [],
    artifacts: [],
    checkpoints: [],
    interrupts: [],
    events: [],
    result: null,
    spec: normalized,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createRuntimeMemoryState() {
  return {
    facts: [],
    plans: [],
    decisions: [],
    commands: [],
    decisionReviews: [],
    interrupts: [],
    replayEvaluations: [],
    trajectoryEvaluations: [],
    cognition: [],
    observations: [],
    failures: [],
    recoveries: [],
    verification: null,
  };
}

function createRuntimeState() {
  return {
    schemaVersion: 2,
    mode: 'agent-first',
    owner: 'AgentRun',
    controller: 'AgentRunController',
    graph: summarizeAgentGraph(),
    currentNode: 'understand',
    previousNode: '',
    status: 'queued',
    loop: ['understand', 'observe', 'plan', 'decide', 'act', 'observe', 'verify', 'recover', 'plan', 'finalize'],
    transitionCount: 0,
    transitions: [],
    pendingCommand: null,
    lastCommand: null,
    decisionReview: createRuntimeDecisionReviewState(),
    decisionReviewHistory: [],
    replay: createReplayEvaluationState(),
    replayHistory: [],
    trajectory: createTrajectoryEvaluationState(),
    trajectoryHistory: [],
    plan: createRuntimePlanState(),
    planHistory: [],
    recovery: createRuntimeRecoveryState(),
    recoveryHistory: [],
    cognition: createAgentCognitionState(),
    cognitionHistory: [],
    verifier: {
      schemaVersion: 1,
      required: false,
      status: 'not_required',
      ok: true,
      requirements: [],
      missingRequirements: [],
      failedRequirements: [],
      verification: null,
      reasons: [],
      evaluatedAt: '',
    },
    worldState: {
      facts: [],
      openQuestions: [],
      failures: [],
      sideEffects: [],
      verification: null,
      verificationPlan: null,
    },
    productOutputs: [],
  };
}

function setRunnerStatus(state, status) {
  state.runnerStatus = normalizeEnum(status, RUNNER_STATUSES, state.runnerStatus || 'queued');
  touch(state);
  return state;
}

function setTaskStatus(state, status) {
  state.taskStatus = normalizeEnum(status, TASK_STATUSES, state.taskStatus || 'unknown');
  touch(state);
  return state;
}

function touch(state, now = new Date()) {
  if (state && typeof state === 'object') state.updatedAt = toIso(now);
  return state;
}

function createBudgetState(policy = {}) {
  return {
    maxToolCalls: toPositiveNumber(policy.maxToolCalls),
    usedToolCalls: 0,
    maxCommands: toPositiveNumber(policy.maxCommands),
    usedCommands: 0,
    maxRuntimeMs: toPositiveNumber(policy.maxRuntimeMs),
    maxOutputCharsPerCommand: toPositiveNumber(policy.maxOutputCharsPerCommand),
  };
}

function createPhaseState(phases) {
  const result = {};
  const items = Array.isArray(phases) ? phases : [];
  for (const phase of items) {
    const id = String(phase?.id || '').trim();
    if (!id) continue;
    result[id] = {
      id,
      label: String(phase.label || id),
      required: phase.required === true,
      status: 'pending',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      evidence: [],
      message: '',
    };
  }
  return result;
}

function normalizePolicy(policy = {}) {
  const source = normalizeObject(policy);
  return {
    ...source,
    allowedTools: normalizeStringArray(source.allowedTools),
    deniedTools: normalizeStringArray(source.deniedTools),
    capabilities: source.capabilities === undefined ? undefined : normalizeStringArray(source.capabilities),
    requireApproval: normalizeStringArray(source.requireApproval),
    readOnly: source.readOnly === true,
  };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeEnum(value, allowed, fallback) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value || Date.now()).toISOString();
}

module.exports = {
  createBudgetState,
  createInitialAgentState,
  createRuntimeMemoryState,
  createRuntimeState,
  createPhaseState,
  createRunId,
  normalizePolicy,
  normalizeRunSpec,
  setRunnerStatus,
  setTaskStatus,
  touch,
};
