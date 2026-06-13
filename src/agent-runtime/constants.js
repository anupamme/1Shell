'use strict';

const AGENT_SOURCES = Object.freeze([
  'console',
  'ide',
  'task',
  'program',
  'studio',
  'mcp',
  'cli',
  'external-agent',
]);

const RUNNER_STATUSES = Object.freeze([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'waiting_approval',
  'interrupted',
]);

const TASK_STATUSES = Object.freeze([
  'unknown',
  'verified',
  'success',
  'failed',
  'partial',
  'blocked',
  'unverified',
]);

const AGENT_EVENT_TYPES = Object.freeze([
  'agent:run-started',
  'agent:run-resumed',
  'agent:run-cancelled',
  'agent:run-ended',
  'agent:turn-updated',
  'agent:phase-started',
  'agent:phase-ended',
  'agent:tool-call-started',
  'agent:tool-call-ended',
  'agent:tool-policy-denied',
  'agent:observation-recorded',
  'agent:verification-recorded',
  'agent:verifier-plan-updated',
  'agent:decision-reviewed',
  'agent:replay-evaluated',
  'agent:trajectory-evaluated',
  'agent:runtime-plan-updated',
  'agent:cognition-updated',
  'agent:narration',
  'agent:recovery-policy-updated',
  'agent:runtime-transition',
  'agent:artifact-updated',
  'agent:checkpoint-created',
  'agent:interrupt-created',
  'agent:interrupt-resolved',
  'agent:approval-required',
  'agent:approval-resolved',
  'agent:result-published',
  'agent:status-updated',
  'agent:budget-exceeded',
  'agent:trace-event',
]);

const COMMAND_TOOL_NAMES = Object.freeze(['execute_command', 'host_exec']);

const SOURCE_TO_HARNESS_SOURCE = Object.freeze({
  console: 'console-ai',
  ide: 'ide-ai',
  task: 'task-ai',
  program: 'program-ai',
  studio: 'studio-ai',
  mcp: 'mcp-remote',
  cli: 'cli-agent',
  'external-agent': 'external-agent',
});

module.exports = {
  AGENT_EVENT_TYPES,
  AGENT_SOURCES,
  COMMAND_TOOL_NAMES,
  RUNNER_STATUSES,
  SOURCE_TO_HARNESS_SOURCE,
  TASK_STATUSES,
};
