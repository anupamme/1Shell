'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createIdeTools } = require('../src/ide/ide.tools');

const payload = {
  name: 'Practiced deploy task',
  description: 'A task created from a practiced workflow.',
  inputs: [{ key: 'host', label: 'Host', type: 'host', required: true }],
  steps: [{ title: 'Run practiced path', instruction: 'Follow the verified trajectory.' }],
};

async function callCreate({ state, serviceOverrides = {}, taskPayload = payload } = {}) {
  let createArgs = null;
  const socket = new EventEmitter();
  const taskSavedEvents = [];
  socket.on('ide:task-saved', (payload) => taskSavedEvents.push(payload));
  const aiTaskService = {
    createTask(input, options) {
      createArgs = { input, options };
      return { id: 'task-1', ...input };
    },
    ...serviceOverrides,
  };
  const tools = createIdeTools({
    aiTaskService,
    agentRuntime: {
      getState: () => state,
    },
  });
  const result = await tools.handle('create_ai_task', taskPayload, {
    socket,
    session: { entry: 'task' },
    sessionId: 'session-1',
    runId: 'run-1',
  });
  return { result, createArgs, taskSavedEvents };
}

(async () => {
  {
    const { result, createArgs } = await callCreate({ state: null });
    assert.strictEqual(result.is_error, true, 'create_ai_task should reject missing AgentRun trace');
    assert.strictEqual(createArgs, null, 'task must not be saved without trace evidence');
  }

  {
    const { result, createArgs, taskSavedEvents } = await callCreate({
      state: {
        verification: { ok: false, status: 'failed', type: 'command', evidence: 'exitCode=1' },
        toolCalls: [
          { toolName: 'execute_command', status: 'completed', args: { command: 'true' }, result: { ok: true } },
        ],
      },
    });
    assert.strictEqual(result.is_error, true, 'create_ai_task should reject failed verification');
    assert.strictEqual(createArgs, null, 'task must not be saved when verification failed');
  }

  {
    const { result, createArgs } = await callCreate({
      state: {
        verification: { ok: true, status: 'passed', type: 'command', target: 'local:true', evidence: 'exitCode=0' },
        toolCalls: [],
      },
    });
    assert.strictEqual(result.is_error, true, 'create_ai_task should reject verification with no practice call');
    assert.strictEqual(createArgs, null, 'task must not be saved without practice calls');
  }

  {
    const { result, createArgs, taskSavedEvents } = await callCreate({
      state: {
        verification: {
          ok: true,
          status: 'passed',
          type: 'command',
          target: 'get_ai_task task-1',
          evidence: 'saved task id exists in ai_task database',
        },
        toolCalls: [
          { toolName: 'execute_command', status: 'completed', args: { command: 'echo practice' }, result: { ok: true } },
        ],
      },
    });
    assert.strictEqual(result.is_error, true, 'DB/task persistence verification must not count as workflow evidence');
    assert.strictEqual(createArgs, null, 'task must not be saved with persistence-only verification');
  }

  {
    const { result, createArgs, taskSavedEvents } = await callCreate({
      state: {
        verification: {
          ok: true,
          status: 'passed',
          taskStatus: 'verified',
          type: 'command',
          target: 'vps-1:ss -ltnp',
          evidence: 'LISTEN 0 4096 0.0.0.0:443 users:(("sing-box",pid=123,fd=7))',
        },
        toolCalls: [
          {
            toolName: 'execute_command',
            status: 'completed',
            args: { hostId: 'vps-1', command: 'install sing-box and write config' },
            scope: { hostId: 'local' },
            result: { ok: true },
            startedAt: '2026-06-14T00:00:00.000Z',
            endedAt: '2026-06-14T00:00:01.000Z',
          },
        ],
      },
    });
    assert.strictEqual(result.is_error, false, 'create_ai_task should save after successful practice and verification');
    assert.ok(createArgs?.options?.authoringEvidence, 'authoring evidence must be stored with saved task');
    assert.strictEqual(createArgs.options.authoringEvidence.verified, true);
    assert.strictEqual(createArgs.options.authoringEvidence.agentRunId, 'run-1');
    assert.ok(createArgs.options.authoringEvidence.validatedScope.some((line) => line.includes('vps-1')), 'authoring evidence should prefer the actual tool input host over local runtime scope');
    assert.ok(createArgs.options.authoringEvidence.actions[0].includes('host=vps-1'), 'practice action summaries should record the actual target host');
    assert.strictEqual(taskSavedEvents.length, 1, 'create_ai_task must notify the IDE UI when a task is saved');
    assert.strictEqual(taskSavedEvents[0].taskId, 'task-1');
    assert.strictEqual(taskSavedEvents[0].action, 'created');
  }

  {
    const githubDeployPayload = {
      name: 'GitHub project VPS deploy',
      description: 'Deploy a GitHub repository to a VPS port.',
      inputs: [
        { key: 'host', label: 'Host', type: 'host', required: true },
        { key: 'repo_url', label: 'GitHub repository', type: 'text', required: true, default: 'https://github.com/QuantumNous/new-api' },
        { key: 'port', label: 'Port', type: 'number', required: true, default: '32123' },
      ],
      steps: [
        { title: 'Write compose file', instruction: 'Write docker-compose.yml using image calciumion/new-api:latest and map the requested port.' },
        { title: 'Start service', instruction: 'Run docker compose up -d.' },
      ],
    };
    const { result, createArgs } = await callCreate({
      taskPayload: githubDeployPayload,
      state: {
        verification: {
          ok: true,
          status: 'passed',
          type: 'command',
          target: 'vps-1:curl -I http://127.0.0.1:32123/',
          evidence: 'HTTP/1.1 200 OK',
        },
        toolCalls: [
          {
            toolName: 'write_remote_file',
            status: 'completed',
            args: {
              hostId: 'vps-1',
              path: '/root/new-api-deploy/docker-compose.yml',
              content: 'services:\n  new-api:\n    image: calciumion/new-api:latest\n    ports:\n      - "32123:3000"',
            },
            result: { ok: true },
          },
          {
            toolName: 'execute_command',
            status: 'completed',
            args: { hostId: 'vps-1', command: 'cd /root/new-api-deploy && docker compose up -d' },
            result: { ok: true },
          },
        ],
      },
    });
    assert.strictEqual(result.is_error, true, 'GitHub deployment claims must be rejected when practice only used a prebuilt image');
    assert.match(result.content, /prebuilt Docker image|repository deployment/i);
    assert.strictEqual(createArgs, null, 'overclaimed task must not be saved');
  }

  {
    const githubDeployPayload = {
      name: 'GitHub project VPS deploy',
      description: 'Deploy a GitHub repository to a VPS port from the checked-out source.',
      inputs: [
        { key: 'host', label: 'Host', type: 'host', required: true },
        { key: 'repo_url', label: 'GitHub repository', type: 'text', required: true, default: 'https://github.com/QuantumNous/new-api' },
        { key: 'port', label: 'Port', type: 'number', required: true, default: '32123' },
      ],
      steps: [
        { title: 'Clone repository', instruction: 'Clone the requested repository and checkout the selected branch.' },
        { title: 'Build and run', instruction: 'Build from the repository and run it on the requested port.' },
      ],
    };
    const { result, createArgs } = await callCreate({
      taskPayload: githubDeployPayload,
      state: {
        verification: {
          ok: true,
          status: 'passed',
          type: 'command',
          target: 'vps-1:curl -I http://127.0.0.1:32123/',
          evidence: 'HTTP/1.1 200 OK',
        },
        toolCalls: [
          {
            toolName: 'execute_command',
            status: 'completed',
            args: {
              hostId: 'vps-1',
              command: 'git clone https://github.com/QuantumNous/new-api /opt/new-api && cd /opt/new-api && docker build -t new-api:test . && docker run -d -p 32123:3000 new-api:test',
            },
            result: { ok: true },
          },
        ],
      },
    });
    assert.strictEqual(result.is_error, false, 'GitHub deployment claims should save when the repo clone/build path was practiced');
    assert.ok(createArgs?.options?.authoringEvidence, 'successful repo practice should still store authoring evidence');
  }

  console.log('ai-task authoring evidence gate checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
