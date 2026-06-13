'use strict';

const { Router } = require('express');
const {
  cancelAgentRun,
  createAgentStructuredInterrupt,
  evaluateAgentRunReplayForRuntime,
  getAgentRun,
  getAgentRunTimeline,
  listAgentRuns,
  requestAgentApproval,
  resolveAgentInterrupt,
  runAgentTask,
} = require('../agent-runtime');

function createAgentRuntimeRouter({ agentRuntime, aiService = null, skillRegistry = null, logger = null } = {}) {
  const router = Router();
  const activeJobs = new Map();

  router.post('/agent-runs', async (req, res) => {
    try {
      const body = normalizeObject(req.body);
      const state = agentRuntime.startRun(buildAgentRunSpec(body), {
        runId: body.runId || body.run_id,
      });
      let interrupt = null;
      if (body.interrupt || body.interruptRequest || body.interrupt_request) {
        interrupt = createAgentStructuredInterrupt(agentRuntime, state.runId, body.interrupt || body.interruptRequest || body.interrupt_request);
      }
      if (shouldRunAgent(body) && !interrupt) {
        const wait = parseBoolean(body.wait, false);
        const job = startAgentRunJob({ activeJobs, agentRuntime, aiService, skillRegistry, logger, runId: state.runId, body });
        if (wait) {
          const result = await job.promise;
          res.status(201).json({ ok: true, run: result.state, result, interrupt: result.interrupt || null });
          return;
        }
        res.status(202).json({ ok: true, run: agentRuntime.getState(state.runId), interrupt: null, job: summarizeJob(job) });
        return;
      }
      res.status(201).json({ ok: true, run: agentRuntime.getState(state.runId), interrupt });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/agent-runs', (req, res) => {
    try {
      const runs = listAgentRuns(agentRuntime, normalizeRunFilter(req.query || {}));
      const limit = toPositiveInteger(req.query?.limit, 0);
      res.json({ ok: true, runs: limit > 0 ? runs.slice(0, limit) : runs });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/agent-runs/:runId', (req, res) => {
    try {
      const run = getAgentRun(agentRuntime, req.params.runId, {
        includeEvents: parseBoolean(req.query?.includeEvents, true),
      });
      res.json({ ok: true, run });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/agent-runs/:runId/timeline', (req, res) => {
    try {
      const timeline = getAgentRunTimeline(agentRuntime, req.params.runId);
      res.json({ ok: true, timeline });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/evaluate', (req, res) => {
    try {
      const body = normalizeObject(req.body);
      const evaluation = evaluateAgentRunReplayForRuntime(agentRuntime, req.params.runId, {
        ...body,
        persist: parseBoolean(body.persist, true),
        applyRecommendation: parseBoolean(body.applyRecommendation ?? body.apply_recommendation, false),
      });
      res.json({ ok: true, evaluation, state: agentRuntime.getState(req.params.runId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/replay', (req, res) => {
    try {
      const body = normalizeObject(req.body);
      const evaluation = evaluateAgentRunReplayForRuntime(agentRuntime, req.params.runId, {
        ...body,
        persist: parseBoolean(body.persist, true),
        applyRecommendation: parseBoolean(body.applyRecommendation ?? body.apply_recommendation, false),
      });
      res.json({ ok: true, evaluation, state: agentRuntime.getState(req.params.runId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/interrupts/:interruptId/approve', (req, res) => {
    try {
      const result = requestAgentApproval(agentRuntime, req.params.runId, req.params.interruptId, req.body || {});
      res.json({ ok: true, state: result.state, checkpoint: result.checkpoint, interrupt: result.interrupt });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/interrupts', (req, res) => {
    try {
      const interrupt = createAgentStructuredInterrupt(agentRuntime, req.params.runId, req.body || {});
      res.status(201).json({ ok: true, interrupt, state: agentRuntime.getState(req.params.runId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/interrupts/:interruptId/resolve', (req, res) => {
    try {
      const result = resolveAgentInterrupt(agentRuntime, req.params.runId, req.params.interruptId, req.body || {});
      res.json({ ok: true, state: result.state, checkpoint: result.checkpoint, interrupt: result.interrupt });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/tool-calls', async (req, res) => {
    try {
      const body = normalizeObject(req.body);
      const toolName = stringOr(body.toolName || body.tool_name || body.name, '');
      if (!toolName) throw new Error('toolName is required');
      const args = normalizeObject(body.args || body.input || body.parameters);
      const result = await agentRuntime.dispatchTool(req.params.runId, toolName, args, buildDispatchOptions(body));
      res.json({ ok: true, result, state: agentRuntime.getState(req.params.runId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/run', async (req, res) => {
    try {
      const body = normalizeObject(req.body);
      const job = startAgentRunJob({ activeJobs, agentRuntime, aiService, skillRegistry, logger, runId: req.params.runId, body });
      const wait = parseBoolean(body.wait, true);
      if (!wait) {
        res.status(202).json({ ok: true, state: agentRuntime.getState(req.params.runId), job: summarizeJob(job) });
        return;
      }
      const result = await job.promise;
      res.json({ ok: true, state: result.state, result, interrupt: result.interrupt || null });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/resume', (req, res) => {
    try {
      const body = normalizeObject(req.body);
      const resolution = normalizeObject(body.resolution || body.interruptResolution || body.interrupt_resolution);
      const result = agentRuntime.resumeRun(req.params.runId, {
        checkpointId: body.checkpointId || body.checkpoint_id,
        interruptId: body.interruptId || body.interrupt_id,
        resolution,
        runnerStatus: body.runnerStatus || body.runner_status || 'running',
        taskStatus: body.taskStatus || body.task_status,
        data: normalizeObject(body.data),
      });
      res.json({ ok: true, state: result.state, checkpoint: result.checkpoint, interrupt: result.interrupt, observation: result.observation || null });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/agent-runs/:runId/cancel', (req, res) => {
    try {
      const state = cancelAgentRun(agentRuntime, req.params.runId, req.body || {});
      res.json({ ok: true, state });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

function shouldRunAgent(body = {}) {
  return parseBoolean(body.run ?? body.autoRun ?? body.auto_run ?? body.execute, false);
}

function startAgentRunJob({ activeJobs, agentRuntime, aiService, skillRegistry, logger, runId, body = {} }) {
  const id = stringOr(runId, '');
  if (!id) throw new Error('runId is required');
  if (activeJobs.has(id)) throw new Error(`Agent run is busy: ${id}`);
  if (!aiService?.requestAgentTurn) throw new Error('AI service requestAgentTurn is not configured');

  const startedAt = new Date().toISOString();
  const promise = runAgentTask({
    runtime: agentRuntime,
    runId: id,
    modelAdapter: createAiModelAdapter(aiService, body),
    skillRegistry,
    maxTurns: toPositiveInteger(body.maxTurns || body.max_turns, 6),
    checkpointTurns: parseBoolean(body.checkpointTurns ?? body.checkpoint_turns, true),
    publishResult: parseBoolean(body.publishResult ?? body.publish_result, true),
    fallbackTaskStatus: body.fallbackTaskStatus || body.fallback_task_status || 'unverified',
    logger,
  }).finally(() => {
    activeJobs.delete(id);
  });
  const job = { runId: id, startedAt, promise };
  activeJobs.set(id, job);
  promise.catch((err) => logger?.warn?.('[agent-runtime] background run failed', { runId: id, error: err.message }));
  return job;
}

function createAiModelAdapter(aiService, body = {}) {
  const modelOptions = normalizeObject(body.modelOptions || body.model_options || body.ai || body.provider);
  return {
    async runTurn(request = {}) {
      return aiService.requestAgentTurn({
        ...modelOptions,
        apiBase: body.apiBase || body.api_base || modelOptions.apiBase || modelOptions.api_base,
        apiKey: body.apiKey || body.api_key || modelOptions.apiKey || modelOptions.api_key,
        model: body.model || modelOptions.model,
        temperature: body.temperature ?? modelOptions.temperature,
        maxTokens: body.maxTokens || body.max_tokens || modelOptions.maxTokens || modelOptions.max_tokens,
        timeoutMs: body.timeoutMs || body.timeout_ms || modelOptions.timeoutMs || modelOptions.timeout_ms,
        systemPrompt: body.systemPrompt || body.system_prompt || modelOptions.systemPrompt || modelOptions.system_prompt,
        runId: request.runId,
        state: request.state,
        spec: request.spec,
        goal: request.goal,
        context: request.context,
        policy: request.policy,
        skillPrompt: request.skillPrompt,
        turn: request.turn,
        maxTurns: request.maxTurns,
        observations: request.observations,
        previousTurns: request.previousTurns,
        resume: request.resume,
        runtimeContext: request.runtimeContext,
        runtimeStateSnapshot: request.runtimeStateSnapshot,
        commandProtocol: request.commandProtocol,
      });
    },
  };
}

function summarizeJob(job = {}) {
  return {
    runId: job.runId || '',
    status: 'running',
    startedAt: job.startedAt || '',
  };
}

function buildAgentRunSpec(body = {}) {
  const spec = normalizeObject(body.spec || body.agentRunSpec || body.agent_run_spec);
  const context = {
    ...normalizeObject(spec.context),
    ...normalizeObject(body.context),
  };
  const hostId = stringOr(body.hostId || body.host_id || context.hostId || context.host_id, '');
  if (hostId) context.hostId = hostId;
  const metadata = {
    ...normalizeObject(spec.metadata),
    ...normalizeObject(body.metadata),
    entrypoint: 'api.agent-runs',
  };
  return {
    ...spec,
    source: spec.source || body.source || 'console',
    goal: stringOr(spec.goal || body.goal, ''),
    skills: spec.skills || body.skills || [],
    skillContext: spec.skillContext || spec.skill_context || body.skillContext || body.skill_context || {},
    context,
    tools: spec.tools || body.tools || [],
    policy: spec.policy || body.policy || {},
    outputContract: spec.outputContract || spec.output_contract || body.outputContract || body.output_contract || {},
    metadata,
  };
}

function buildDispatchOptions(body = {}) {
  const options = normalizeObject(body.options);
  return {
    ...options,
    scope: normalizeObject(body.scope || options.scope),
    riskLevel: body.riskLevel || body.risk_level || options.riskLevel || options.risk_level,
    capability: body.capability || options.capability,
    allowApproval: parseBoolean(body.allowApproval ?? body.allow_approval ?? options.allowApproval, false),
  };
}

function normalizeRunFilter(query = {}) {
  return {
    source: query.source,
    runnerStatus: query.runnerStatus || query.runner_status,
    taskStatus: query.taskStatus || query.task_status,
    active: query.active === undefined ? undefined : parseBoolean(query.active, undefined),
    query: query.query || query.search,
  };
}

function parseBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function stringOr(value, fallback) {
  const text = String(value ?? '').trim();
  return text || String(fallback ?? '').trim();
}

function sendError(res, err) {
  const message = err?.message || 'Agent Runtime 请求失败';
  const status = /not found|不存在/i.test(message) ? 404 : 400;
  res.status(status).json({ ok: false, error: message });
}

module.exports = {
  createAgentRuntimeRouter,
};
