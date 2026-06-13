'use strict';

const DEFAULT_IDE_AGENT_LIMITS = Object.freeze({
  maxTurns: null,
  maxToolCalls: 200,
  maxCommands: 80,
  maxRuntimeMs: 6 * 60 * 60 * 1000,
  maxOutputCharsPerCommand: 8000,
});

const IDE_AGENT_PHASE_DEFINITIONS = [
  { id: 'understand', label: 'Understand task' },
  { id: 'context', label: 'Gather context' },
  { id: 'act', label: 'Act' },
  { id: 'verify', label: 'Verify' },
  { id: 'result', label: 'Publish result' },
];

const DEPRECATED_AUTHORING_TOOLS = new Set([
  'ask_authoring_question',
  'propose_options',
  'create_program_spec',
  'create_skill_spec',
  'create_authoring_plan',
  'start_program_draft',
  'create_program_draft',
  'create_skill_draft',
  'validate_program_draft',
  'update_authoring_draft',
  'validate_skill_draft',
  'request_commit_approval',
  'commit_authoring_artifact',
  'verify_authoring_artifact',
]);

const LEGACY_PROGRAM_NAMED_TOOLS = new Set([
  'list_programs',
  'trigger_program',
  'write_program',
]);

const TASK_AUTHORING_DISCOVERY_TOOLS = new Set([
  'query_format',
  'list_artifacts',
  'list_skills',
  'load_skill',
]);

const TASK_ARTIFACT_TOOLS = new Set([
  'create_task',
  'write_task',
  'package_agent_run',
]);

const DEPLOY_TASK_INPUTS = Object.freeze([
  { name: 'hostId', label: 'VPS', type: 'select', required: true },
  { name: 'port', label: 'Port', type: 'number', required: true },
  { name: 'dockerDeploy', label: 'Docker deploy', type: 'boolean', required: true },
  { name: 'githubUrl', label: 'GitHub URL', type: 'string', required: true },
]);

const DEPLOY_TASK_PHASES = Object.freeze([
  { id: 'env_check', label: 'Environment check', required: true },
  { id: 'repo_fetch', label: 'Fetch repository', required: true },
  { id: 'project_analysis', label: 'Analyze project', required: true },
  { id: 'dependency_install', label: 'Install dependencies', required: true },
  { id: 'deploy', label: 'Deploy', required: true },
  { id: 'verify', label: 'Verify', required: true },
  { id: 'result', label: 'Result', required: true },
]);

function createIdeAgentPolicy({ tools = [], entry = 'core', remotePolicy = null, taskProfile = null } = {}) {
  const toolNames = uniqueStrings(tools.map((tool) => tool?.name));
  const profile = normalizeTaskProfile(taskProfile);
  const denied = new Set();
  for (const name of toolNames) {
    if (DEPRECATED_AUTHORING_TOOLS.has(name)) denied.add(name);
    if (LEGACY_PROGRAM_NAMED_TOOLS.has(name)) denied.add(name);
    if (profile.intent === 'automation_task_authoring' && !profile.allowExistingLookup && TASK_AUTHORING_DISCOVERY_TOOLS.has(name)) {
      denied.add(name);
    }
  }
  const deniedTools = toolNames.filter((name) => denied.has(name));
  const allowedTools = toolNames.filter((name) => !DEPRECATED_AUTHORING_TOOLS.has(name));
  return {
    allowedTools: allowedTools.filter((name) => !denied.has(name)),
    deniedTools,
    approvalPolicy: 'agent_side_effects',
    budgetMode: 'runtime_policy',
    capabilities: ['read_only', 'exec_command', 'agent_control', 'task_artifact'],
    maxTurns: DEFAULT_IDE_AGENT_LIMITS.maxTurns,
    maxToolCalls: DEFAULT_IDE_AGENT_LIMITS.maxToolCalls,
    maxCommands: DEFAULT_IDE_AGENT_LIMITS.maxCommands,
    maxRuntimeMs: DEFAULT_IDE_AGENT_LIMITS.maxRuntimeMs,
    maxOutputCharsPerCommand: DEFAULT_IDE_AGENT_LIMITS.maxOutputCharsPerCommand,
    maxRecoveryAttempts: null,
    maxRepeatedFailures: 3,
    readOnly: false,
    entry: String(entry || 'core'),
    remotePolicy: remotePolicy ? summarizeRemotePolicy(remotePolicy) : undefined,
    taskProfile: profile.intent ? profile : undefined,
    legacyFlagsIgnored: ['safeMode', 'unlimitedTurns'],
  };
}

function filterToolsForAgent(tools = [], policy = {}) {
  const allowed = new Set(Array.isArray(policy.allowedTools) ? policy.allowedTools : []);
  const denied = new Set(Array.isArray(policy.deniedTools) ? policy.deniedTools : []);
  return tools.filter((tool) => {
    const name = String(tool?.name || '').trim();
    if (!name || denied.has(name)) return false;
    return allowed.size === 0 || allowed.has(name);
  });
}

function shouldRequestAgentApproval(toolName, { readonlyTools, sideEffectTools, controlTools, input } = {}) {
  const name = String(toolName || '').trim();
  if (!name) return false;
  if (name === 'package_agent_run') return input?.write === true;
  if (controlTools?.has?.(name)) return false;
  if (name === 'execute_command' || name === 'host_exec') return false;
  if (readonlyTools?.has?.(name)) return false;
  if (sideEffectTools?.has?.(name)) return true;
  return false;
}

function createIdeAgentTaskProfile({ entry = 'core' } = {}) {
  // Program/Task authoring was removed; 1Shell AI is a pure agent with no task-authoring
  // profile. Always return a neutral profile so no tool is blocked, no user-facing text is
  // rewritten, and no task-artifact final gate is forced.
  return {
    intent: '',
    taskKind: '',
    entry: String(entry || 'core').trim().toLowerCase(),
    solveCapturePackage: false,
    allowExistingLookup: false,
    hasConcreteExecutionInputs: false,
    requiredInputs: [],
    requiredRuntimePhases: [],
    expectedResultFields: [],
    expectedFailureFields: [],
  };
}

function buildIdeAgentSystemDirective(taskProfile = null) {
  const profile = normalizeTaskProfile(taskProfile);
  const lines = [
    '',
    '## Runtime Agent State',
    '- 1Shell AI is an agent. Every user request runs as an AgentRun with runtime policy, tool policy, phases, evidence, and final outcome evaluation.',
    '- Work in this order: understand the goal, gather only necessary context, act, verify, then publish a result.',
    '- Safe mode and unlimited turns are legacy UI flags and do not change agent behavior.',
    '- Side-effecting work can only end as verified after verification evidence has been recorded.',
  ];

  if (profile.intent === 'automation_task_authoring') {
    lines.push(
      '',
      '## Automation Task Authoring State',
      '- The product concept is Task, not Program. Use task wording in user-facing text.',
      '- Reliable reusable tasks come from Solve -> Capture -> Package.',
      '- If concrete execution inputs are missing, ask the user for the minimum sample inputs needed to run and verify, or clearly create only a low-trust draft.',
      '- Catalog/schema/skill browsing is a runtime-policy exception for inspecting or modifying existing artifacts; new task creation progresses through AgentRun state.',
      '- Before final answer, produce a task artifact with create_task/write_task/package_agent_run or ask the user for the missing execution inputs.',
    );
    if (profile.taskKind === 'deploy_project') {
      lines.push(
        '- This deployment task must expose inputs: hostId, port, dockerDeploy, githubUrl.',
        '- Its runtime phases must be: env_check, repo_fetch, project_analysis, dependency_install, deploy, verify, result.',
        '- Successful results must show status, VPS, GitHub project, deployment method, port, access URL, and verification evidence.',
        '- Failed results must show failed phase, completed items, failure reason, and next-step suggestions.',
      );
    }
  }

  return lines.join('\n');
}

function evaluateIdeAgentProfileToolUse(taskProfile, toolName, input = {}) {
  const profile = normalizeTaskProfile(taskProfile);
  const name = String(toolName || '').trim();
  if (!name) return { allow: false, reason: 'toolName is required', kind: 'invalid_tool' };
  if (LEGACY_PROGRAM_NAMED_TOOLS.has(name)) {
    const replacement = name === 'list_programs' ? 'list_tasks' : (name === 'trigger_program' ? 'trigger_task' : 'write_task');
    return {
      allow: false,
      reason: `Use ${replacement}; legacy compatibility tool names are internal only.`,
      kind: 'legacy_program_tool',
    };
  }
  if (profile.intent !== 'automation_task_authoring') return { allow: true };
  if (!profile.allowExistingLookup && TASK_AUTHORING_DISCOVERY_TOOLS.has(name)) {
    return {
      allow: false,
      reason: 'Automation task authoring should progress through AgentRun state, ask_user, create_task, write_task, trigger_task, verify_outcome, or package_agent_run; catalog/schema browsing is not progress for a new task.',
      kind: 'no_progress_discovery_tool',
    };
  }
  if (!profile.allowExistingLookup && name === 'read_file') {
    const p = String(input?.path || '').replace(/\\/g, '/');
    if (/^data\/(?:skills|programs)\//.test(p)) {
      return {
        allow: false,
        reason: 'Reading existing task/skill artifacts is only allowed when the user asked to inspect or modify an existing artifact.',
        kind: 'no_progress_artifact_read',
      };
    }
  }
  return { allow: true };
}

function normalizeIdeAgentToolInput(taskProfile, toolName, input = {}) {
  const profile = normalizeTaskProfile(taskProfile);
  const name = String(toolName || '').trim();
  if (profile.intent !== 'automation_task_authoring') return input;
  if (!['ask_user', 'request_secret'].includes(name)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

  const out = { ...input };
  for (const key of ['question', 'reason', 'message', 'title', 'description', 'detail', 'label']) {
    if (typeof out[key] === 'string') out[key] = normalizeTaskUserText(out[key]);
  }
  if (Array.isArray(out.options)) {
    out.options = out.options.map((item) => typeof item === 'string' ? normalizeTaskUserText(item) : item);
  }
  return out;
}

function evaluateIdeAgentFinalTurn({ taskProfile = null, state = null, ledger = null, text = '', repairCount = 0 } = {}) {
  const profile = normalizeTaskProfile(taskProfile);
  const reasons = [];
  const toolNames = Array.isArray(state?.toolCalls) ? state.toolCalls.map((tool) => String(tool?.toolName || tool?.name || '').trim()).filter(Boolean) : [];
  const hasTaskArtifact = toolNames.some((name) => TASK_ARTIFACT_TOOLS.has(name));
  const hasPendingVerification = ledger?.requiresVerification === true && !(ledger?.verification && ledger.verification.ok === true);

  if (hasPendingVerification) reasons.push('side_effects_require_verification');
  if (profile.intent === 'automation_task_authoring' && !hasTaskArtifact) reasons.push('task_artifact_missing');

  if (reasons.length === 0) return { shouldContinue: false, reasons: [] };
  if (isWaitingForUserContinuation(text)) {
    return {
      shouldContinue: false,
      reasons,
      forcedStatus: hasPendingVerification ? 'unverified' : 'blocked',
    };
  }
  if (repairCount >= 2) {
    return {
      shouldContinue: false,
      reasons,
      forcedStatus: hasPendingVerification ? 'unverified' : 'blocked',
    };
  }

  const lines = [
    '[AGENT_RUNTIME_REQUIRED_ACTION]',
    `reasons=${reasons.join(',')}`,
  ];
  if (hasPendingVerification) {
    lines.push(
      'Side effects were recorded in the AgentRun ledger, but no passing verification has been recorded.',
      'Next turn must call verify_outcome, fix then verify again, ask_user/request_secret if blocked, or explicitly publish failed/blocked/unverified with evidence.',
    );
  }
  if (profile.intent === 'automation_task_authoring' && !hasTaskArtifact) {
    lines.push(
      'The user requested an automation Task artifact, but no task artifact was created or packaged.',
      'Next turn must either call ask_user for missing concrete execution inputs, call package_agent_run for a verified AgentRun, or call create_task/write_task to create a low-trust draft artifact.',
    );
    if (profile.taskKind === 'deploy_project') {
      lines.push(
        'The draft task must include inputs hostId, port, dockerDeploy, githubUrl and phases env_check, repo_fetch, project_analysis, dependency_install, deploy, verify, result.',
      );
    }
  }
  if (text) lines.push(`Previous final text excerpt:\n${String(text).slice(0, 1200)}`);
  return { shouldContinue: true, reasons, message: lines.join('\n') };
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function summarizeRemotePolicy(policy = {}) {
  return {
    gatewayMode: policy.gatewayMode || '',
    allowedTools: Array.isArray(policy.allowedTools) ? policy.allowedTools : [],
    allowedHosts: Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [],
  };
}

function normalizeTaskProfile(profile = null) {
  if (!profile || typeof profile !== 'object') {
    return {
      intent: '',
      taskKind: '',
      entry: 'core',
      solveCapturePackage: false,
      allowExistingLookup: false,
      hasConcreteExecutionInputs: false,
      requiredInputs: [],
      requiredRuntimePhases: [],
      expectedResultFields: [],
      expectedFailureFields: [],
    };
  }
  return {
    intent: String(profile.intent || '').trim(),
    taskKind: String(profile.taskKind || '').trim(),
    entry: String(profile.entry || 'core').trim(),
    solveCapturePackage: profile.solveCapturePackage === true,
    allowExistingLookup: profile.allowExistingLookup === true,
    hasConcreteExecutionInputs: profile.hasConcreteExecutionInputs === true,
    requiredInputs: Array.isArray(profile.requiredInputs) ? profile.requiredInputs : [],
    requiredRuntimePhases: Array.isArray(profile.requiredRuntimePhases) ? profile.requiredRuntimePhases : [],
    expectedResultFields: Array.isArray(profile.expectedResultFields) ? profile.expectedResultFields : [],
    expectedFailureFields: Array.isArray(profile.expectedFailureFields) ? profile.expectedFailureFields : [],
  };
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function normalizeTaskUserText(value) {
  return String(value || '')
    .replace(/\bProgram\b/g, '任务')
    .replace(/\bprogram\b/g, '任务')
    .replace(/程序/g, '任务');
}

function isWaitingForUserContinuation(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  return /你可以.*继续|让我继续|请.*(?:确认|提供|补充|选择)|需要你.*(?:确认|提供|补充|选择|审批)|等待你|如果你.*继续/.test(value)
    || /还未|尚未|未实际|没有真正|缺少|无法|不能|不完整|未验证|未部署|未执行|需要.*(?:输入|参数|确认|审批|Secret|凭据)/.test(value);
}

function hasAny(text, needles) {
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

module.exports = {
  DEFAULT_IDE_AGENT_LIMITS,
  IDE_AGENT_PHASE_DEFINITIONS,
  buildIdeAgentSystemDirective,
  createIdeAgentPolicy,
  createIdeAgentTaskProfile,
  evaluateIdeAgentFinalTurn,
  evaluateIdeAgentProfileToolUse,
  filterToolsForAgent,
  normalizeIdeAgentToolInput,
  shouldRequestAgentApproval,
};
