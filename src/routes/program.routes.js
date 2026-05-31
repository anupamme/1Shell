'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const { ROOT_DIR } = require('../config/env');

/**
 * Program Routes
 *
 *   GET    /api/programs                        列表（含每个实例最新状态）
 *   POST   /api/programs/reload                 重扫 data/programs/
 *   GET    /api/programs/:id                    详情
 *   GET    /api/programs/:id/instances          该 Program 的所有实例状态
 *   POST   /api/programs/:id/trigger            手动触发
 *     Body: { hostId?: string|'all', triggerId?: string, actionName?: string, inputs?: object }
 *   POST   /api/programs/:id/instances/:hostId/enable   启用实例
 *   POST   /api/programs/:id/instances/:hostId/disable  停用实例
 *   GET    /api/program-runs                    运行历史
 *     Query: programId?, hostId?, limit?
 *   GET    /api/program-runs/:runId             单次运行详情
 *   POST   /api/program-runs/:runId/cancel      取消运行
 *   GET    /api/program-runs/active             当前活跃 run 列表
 */
function createProgramRouter({ registry, stateService, engine, hostService, secretService }) {
  const router = Router();

  const stripDir = ({ dir, ...rest }) => rest;

  // 把 DB 里没有记录的主机补全为默认实例（enabled=1，无运行历史）
  function mergeInstances(program, dbInstances, allHosts) {
    const hostIds = program.hosts === 'all'
      ? (allHosts || []).map((h) => h.id)
      : (program.hosts || []);
    const byHost = new Map(dbInstances.map((i) => [i.host_id, i]));
    return hostIds.map((hid) => byHost.get(hid) || {
      program_id: program.id,
      host_id: hid,
      enabled: 1,
      last_run_id: null,
      last_status: null,
      last_run_at: null,
      last_trigger_id: null,
    });
  }

  function programHostIds(program) {
    return program.hosts === 'all'
      ? (hostService?.listHosts?.() || []).map((h) => h.id)
      : (program.hosts || []);
  }

  function assertHostAllowed(program, hostId, { allowAll = false } = {}) {
    const target = String(hostId || '').trim();
    if (allowAll && target === 'all') return;
    if (!target || target === 'all') throw new Error('hostId 不能为空');
    const allowed = programHostIds(program);
    if (!allowed.includes(target)) throw new Error(`目标主机不在 Program 范围内: ${target}`);
  }

  function actionConfirmText(program, actionName) {
    const launchers = program.ui?.instance_actions || [];
    const launcher = launchers.find((item) => item.action === actionName);
    return launcher?.confirm || (launcher?.style === 'danger' ? `确认执行高风险 action: ${actionName}` : null);
  }

  function passwordInputNames(program) {
    const defs = Array.isArray(program.inputs)
      ? program.inputs
      : Object.entries(program.inputs || {}).map(([name, def]) => ({ name, ...(def || {}) }));
    return new Set(defs
      .filter((def) => def?.type === 'password' && def.name)
      .map((def) => def.name));
  }

  function resolveSecretInputs(program, inputs) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return inputs;
    const passwordNames = passwordInputNames(program);
    const resolved = { ...inputs };
    for (const [key, value] of Object.entries(resolved)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const secretRef = String(value.secretRef || '').trim();
      if (!secretRef) continue;
      if (!passwordNames.has(key)) throw new Error(`输入 ${key} 不是 password 字段，不能引用保存的凭据`);
      if (!secretService?.resolve) throw new Error(`输入 ${key} 引用了凭据，但凭据服务不可用`);
      resolved[key] = secretService.resolve(secretRef);
    }
    return resolved;
  }

  function buildProgramSnapshot(program) {
    const allHosts = hostService?.listHosts?.() || [];
    const allowed = new Set(programHostIds(program));
    return {
      program: stripDir(program),
      hosts: allHosts
        .filter((host) => program.hosts === 'all' || allowed.has(host.id))
        .map((host) => ({ id: host.id, name: host.name || host.id, label: host.name || host.id })),
      currentRuns: engine.listActive?.().filter((run) => run.programId === program.id) || [],
      latestResults: [],
    };
  }

  router.get('/programs', (_req, res) => {
    const allHosts = hostService?.listHosts?.() || [];
    const programs = registry.list().map(stripDir);
    for (const p of programs) {
      const db = stateService.listInstances(p.id);
      p.instances = mergeInstances(p, db, allHosts);
      p.enabled = p.instances.some((i) => i.enabled === 1);
    }
    res.json({ ok: true, programs, residuals: registry.getLastErrors?.() || [] });
  });

  router.get('/programs/residuals', (_req, res) => {
    res.json({ ok: true, residuals: registry.getLastErrors?.() || [] });
  });

  router.post('/programs/reload', (_req, res) => {
    try {
      const result = engine.reload();
      res.json({ ok: true, count: registry.list().length, residuals: result?.errors || registry.getLastErrors?.() || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/programs/:id', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const allHosts = hostService?.listHosts?.() || [];
    const db = stateService.listInstances(program.id);
    const instances = mergeInstances(program, db, allHosts);
    res.json({ ok: true, program: stripDir(program), instances });
  });

  router.get('/programs/:id/runs', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const runs = stateService.listRuns({ programId: program.id, limit: Number(req.query?.limit) || 50 });
    res.json({ ok: true, runs });
  });

  router.get('/programs/:id/results', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const results = [];
    for (const hostId of programHostIds(program)) {
      for (const item of stateService.getLastRenders(program.id, hostId) || []) {
        results.push({ hostId, ...item });
      }
    }
    res.json({ ok: true, results });
  });

  router.get('/programs/:id/events', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    res.json({ ok: true, events: [] });
  });

  router.post('/programs/:id/actions/:action/run', async (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });

    const actionName = String(req.params.action || '').trim();
    const body = req.body || {};
    try {
      const hostId = String(body.hostId || '').trim();
      if (!hostId) throw new Error('hostId 不能为空');
      assertHostAllowed(program, hostId);
      const confirmText = actionConfirmText(program, actionName);
      if (confirmText && body.confirmToken !== `confirmed:${program.id}:${actionName}`) {
        return res.status(409).json({ ok: false, requiresConfirm: true, confirmText });
      }
      const runIds = await engine.triggerManual({
        programId: program.id,
        hostId,
        actionName,
        inputs: resolveSecretInputs(program, body.inputs),
      });
      res.json({ ok: true, runIds });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/programs/:id/instances', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const allHosts = hostService?.listHosts?.() || [];
    const db = stateService.listInstances(program.id);
    res.json({ ok: true, instances: mergeInstances(program, db, allHosts) });
  });

  // GET /api/programs/:id/instances/:hostId/renders — 最近一次 run 的 render 输出
  router.get('/programs/:id/instances/:hostId/renders', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    const renders = stateService.getLastRenders(program.id, req.params.hostId);
    res.json({ ok: true, renders });
  });

  router.delete('/program-residuals/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return res.status(400).json({ ok: false, error: 'Program id 不合法' });
    if (registry.get(id)) return res.status(409).json({ ok: false, error: 'Program 已成功加载，请使用正常删除入口' });

    try {
      const programDir = path.join(ROOT_DIR, 'data', 'programs', id);
      const programsRoot = path.join(ROOT_DIR, 'data', 'programs');
      const rel = path.relative(programsRoot, programDir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).json({ ok: false, error: 'Program 路径不合法' });
      if (!fs.existsSync(programDir)) return res.status(404).json({ ok: false, error: '残留 Program 目录不存在' });
      fs.rmSync(programDir, { recursive: true, force: true });
      const result = engine.reload();
      res.json({ ok: true, deleted: id, residuals: result?.errors || registry.getLastErrors?.() || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/programs/:id/trigger', async (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });

    const body = req.body || {};
    try {
      const hostId = body.hostId || 'all';
      assertHostAllowed(program, hostId, { allowAll: true });
      const runIds = await engine.triggerManual({
        programId: program.id,
        hostId,
        triggerId: body.triggerId,
        actionName: body.actionName,
        inputs: resolveSecretInputs(program, body.inputs),
      });
      res.json({ ok: true, runIds });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/programs/:id — 删除 Program（停止调度 + 删除文件）
  router.delete('/programs/:id', async (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });

    try {
      const programDir = path.join(ROOT_DIR, 'data', 'programs', program.id);
      if (fs.existsSync(programDir)) {
        fs.rmSync(programDir, { recursive: true, force: true });
      }
      // 删除后重新扫描 registry，停止该 program 的 cron 调度
      engine.reload();
      res.json({ ok: true, deleted: program.id });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/programs/:id/instances/:hostId/enable', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    try {
      assertHostAllowed(program, req.params.hostId);
      engine.setInstanceEnabled(program.id, req.params.hostId, true);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/programs/:id/instances/:hostId/disable', (req, res) => {
    const program = registry.get(req.params.id);
    if (!program) return res.status(404).json({ ok: false, error: 'Program 不存在' });
    try {
      assertHostAllowed(program, req.params.hostId);
      engine.setInstanceEnabled(program.id, req.params.hostId, false);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/program-runs/active', (_req, res) => {
    res.json({ ok: true, runs: engine.listActive() });
  });

  router.get('/program-runs', (req, res) => {
    const { programId, hostId, limit } = req.query || {};
    const runs = stateService.listRuns({
      programId: programId || null,
      hostId: hostId || null,
      limit: Number(limit) || 50,
    });
    res.json({ ok: true, runs });
  });

  router.get('/program-runs/:runId', (req, res) => {
    const run = stateService.getRun(Number(req.params.runId));
    if (!run) return res.status(404).json({ ok: false, error: '运行记录不存在' });
    res.json({ ok: true, run });
  });

  router.post('/program-runs/:runId/cancel', (req, res) => {
    engine.cancelRun(Number(req.params.runId));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createProgramRouter };
