'use strict';

const { Router } = require('express');

function createAiTaskRouter({ aiTaskService }) {
  const router = Router();

  router.get('/ai-tasks', (req, res, next) => {
    try {
      const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
      const tasks = aiTaskService.listTasks({ keyword });
      res.json({ ok: true, tasks });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ai-tasks', (req, res, next) => {
    try {
      const task = aiTaskService.createTask(req.body);
      res.status(201).json({ ok: true, task });
    } catch (err) {
      next(err);
    }
  });

  router.get('/ai-tasks/:id', (req, res, next) => {
    try {
      const task = aiTaskService.getTask(req.params.id);
      if (!task) return res.status(404).json({ ok: false, error: 'AI 任务不存在' });
      return res.json({ ok: true, task });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/ai-tasks/:id', (req, res, next) => {
    try {
      const task = aiTaskService.updateTask(req.params.id, req.body);
      if (!task) return res.status(404).json({ ok: false, error: 'AI 任务不存在' });
      return res.json({ ok: true, task });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/ai-tasks/:id', (req, res, next) => {
    try {
      const deleted = aiTaskService.deleteTask(req.params.id);
      if (!deleted) return res.status(404).json({ ok: false, error: 'AI 任务不存在' });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/ai-tasks/:id/runs', (req, res, next) => {
    try {
      const result = aiTaskService.prepareRun(req.params.id, req.body || {});
      return res.status(201).json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/ai-tasks/:id/runs', (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const result = aiTaskService.listRunsByTask(req.params.id, { limit, offset });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/ai-task-runs', (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const result = aiTaskService.listAllRuns({ limit, offset });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/ai-task-runs/:runId', (req, res, next) => {
    try {
      const runId = parseRunId(req.params.runId);
      const run = aiTaskService.getRun(runId);
      if (!run) return res.status(404).json({ ok: false, error: 'AI 任务运行记录不存在' });
      return res.json({ ok: true, run });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/ai-task-runs/:runId', (req, res, next) => {
    try {
      const runId = parseRunId(req.params.runId);
      const run = aiTaskService.finishRun(runId, req.body || {});
      if (!run) return res.status(404).json({ ok: false, error: 'AI 任务运行记录不存在' });
      return res.json({ ok: true, run });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

function parseRunId(value) {
  const runId = parseInt(value, 10);
  if (!Number.isInteger(runId)) {
    const error = new Error('runId 必须是整数');
    error.status = 400;
    throw error;
  }
  return runId;
}

module.exports = { createAiTaskRouter };
