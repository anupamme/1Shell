'use strict';

const {
  evaluateAgentRunOutcome,
  normalizeAgentTaskStatus,
} = require('../agent-runtime/outcome');

const COMMAND_TOOLS = ['execute_command'];
const LEGACY_PROGRAM_RUNTIME_SKILL_ID = ['program', 'runtime'].join('-');
const PROGRAM_RUNTIME_TOOLS = [
  { name: 'execute_command', type: 'command', capability: 'exec_command' },
  { name: 'report_phase', type: 'runtime' },
  { name: 'update_result', type: 'runtime' },
  { name: 'publish_result', type: 'runtime' },
];

function createProgramAgentRunSpec({ program, action, step, hostId, runId, inputs, host, workflow } = {}) {
  const contract = resolveWorkflowContract(program, action, step, workflow);
  const policy = createProgramAgentPolicy({ program, action, step, hostId, contract });
  const skills = createProgramAgentSkills({ program, action, step });
  const taskType = contract.workflow.taskType || 'task_run';
  return {
    source: 'task',
    goal: String(step?.goal || step?.label || action?.label || program?.name || '').trim(),
    skills,
    skillContext: {
      source: 'task',
      taskType,
      taskId: program?.id || '',
      programId: program?.id || '',
      actionName: action?.name || '',
      stepId: step?.id || '',
      hostId: hostId || '',
      capabilities: policy.capabilities || [],
    },
    context: {
      programId: program?.id || '',
      taskId: program?.id || '',
      programName: program?.name || program?.id || '',
      taskName: program?.name || program?.id || '',
      actionName: action?.name || '',
      actionLabel: action?.label || action?.name || '',
      stepId: step?.id || '',
      stepLabel: step?.label || step?.id || '',
      programRunId: runId || '',
      hostId: hostId || '',
      host: compactHost(host, hostId),
      inputs: normalizeObject(inputs),
      phases: contract.phases,
      workflow: contract.workflow,
    },
    tools: PROGRAM_RUNTIME_TOOLS,
    policy,
    outputContract: {
      phases: contract.phases,
      verify: contract.verify,
      success: contract.success,
    },
    metadata: {
      adapter: 'task-kernel-runtime-v1',
      productTerm: 'task',
      compatibility: 'program-storage-v1',
      taskType,
    },
  };
}

function createProgramAgentSkills({ program, action, step } = {}) {
  const declared = [
    ...normalizeStringArray(program?.skills),
    ...normalizeStringArray(action?.skills),
    ...normalizeStringArray(step?.skills),
  ];
  return uniqueStringArray(declared).filter((skillId) => skillId !== LEGACY_PROGRAM_RUNTIME_SKILL_ID);
}

function createProgramAgentPolicy({ step, hostId, contract } = {}) {
  const budget = contract?.budget || {};
  const capabilities = normalizeStringArray(step?.capabilities);
  return {
    allowedTools: PROGRAM_RUNTIME_TOOLS.map((tool) => tool.name),
    capabilities: Array.isArray(step?.capabilities) ? capabilities : undefined,
    hostScope: hostId ? [hostId] : 'current',
    maxToolCalls: pickPositiveNumber(budget.maxToolCalls, budget.max_tool_calls),
    maxCommands: pickPositiveNumber(budget.maxCommands, budget.max_commands),
    maxRuntimeMs: pickPositiveNumber(budget.maxRuntimeMs, budget.max_runtime_ms),
    maxOutputCharsPerCommand: pickPositiveNumber(budget.maxOutputCharsPerCommand, budget.max_output_chars_per_command),
    readOnly: capabilities.includes('read_only'),
  };
}

function resolveWorkflowContract(program, action, step, runtimeWorkflow) {
  const rootWorkflow = normalizeObject(program?.workflow);
  const actionWorkflow = normalizeObject(action?.workflow);
  const stepWorkflow = normalizeObject(step?.workflow);
  const runtimePhases = Array.isArray(runtimeWorkflow?.steps)
    ? runtimeWorkflow.steps.map((item) => ({ id: item.id, label: item.label || item.id, required: item.required === true }))
    : [];
  const phases = firstArray(stepWorkflow.phases, actionWorkflow.phases, rootWorkflow.phases, runtimePhases)
    .map(normalizePhase)
    .filter(Boolean);
  const verify = firstArray(step?.verify, stepWorkflow.verify, action?.verify, actionWorkflow.verify, program?.verify, rootWorkflow.verify)
    .map(normalizePlainObject)
    .filter(Boolean);
  return {
    phases,
    verify,
    success: {
      ...normalizeObject(rootWorkflow.success),
      ...normalizeObject(actionWorkflow.success),
      ...normalizeObject(stepWorkflow.success),
    },
    budget: {
      ...normalizeObject(rootWorkflow.budget),
      ...normalizeObject(actionWorkflow.budget),
      ...normalizeObject(stepWorkflow.budget),
    },
    workflow: {
      taskType: stepWorkflow.taskType || stepWorkflow.task_type || actionWorkflow.taskType || actionWorkflow.task_type || rootWorkflow.taskType || rootWorkflow.task_type || '',
    },
  };
}

function normalizeAgentPhaseStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['done', 'success', 'succeeded', 'completed', 'complete'].includes(value)) return 'done';
  if (['failed', 'failure', 'error'].includes(value)) return 'failed';
  if (['skipped', 'skip'].includes(value)) return 'skipped';
  return 'running';
}

function compactHost(host, hostId) {
  const source = normalizeObject(host);
  return {
    id: source.id || hostId || '',
    name: source.name || source.id || hostId || '',
    platform: source.platform || '',
  };
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function normalizePhase(phase) {
  if (!phase || typeof phase !== 'object') return null;
  const id = String(phase.id || '').trim();
  if (!id) return null;
  return {
    id,
    label: String(phase.label || phase.name || id),
    required: phase.required === true,
  };
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function uniqueStringArray(value) {
  return Array.from(new Set(normalizeStringArray(value)));
}

function pickPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

module.exports = {
  COMMAND_TOOLS,
  PROGRAM_RUNTIME_TOOLS,
  createProgramAgentPolicy,
  createProgramAgentSkills,
  createProgramAgentRunSpec,
  evaluateAgentRunOutcome,
  normalizeAgentPhaseStatus,
  normalizeAgentTaskStatus,
  resolveWorkflowContract,
};
