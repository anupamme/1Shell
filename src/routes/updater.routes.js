'use strict';

const { Router } = require('express');

/**
 * 在线更新路由（挂在 requireAuth 之后，更新是特权操作）
 *   GET  /updater/status        当前状态（版本/最新/限流/自动更新/可回退）
 *   POST /updater/check         立即检查更新
 *   POST /updater/apply         下载并更新（binary）→ 重启
 *   POST /updater/rollback      回退上一版本 → 重启
 *   POST /updater/docker-pull   Docker 部署：拉镜像并重建
 *   POST /updater/token         保存 GitHub token
 *   POST /updater/token/verify  验证 token（不保存）
 *   POST /updater/rate-limit    刷新限流
 *   POST /updater/auto          设置无人值守自动更新
 */
function createUpdaterRouter({ updaterService }) {
  const router = Router();

  router.get('/updater/status', (_req, res) => {
    res.json({ ok: true, status: updaterService.getStatus() });
  });

  router.post('/updater/check', async (_req, res, next) => {
    try {
      const status = await updaterService.checkForUpdate();
      res.json({ ok: !status.checkError, status, error: status.checkError || undefined });
    } catch (err) { next(err); }
  });

  router.post('/updater/apply', async (req, res, next) => {
    try {
      const result = await updaterService.applyUpdate({ targetVersion: req.body?.version || '' });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/updater/rollback', async (_req, res) => {
    try {
      const result = await updaterService.rollback();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/updater/docker-pull', async (_req, res) => {
    try {
      const result = await updaterService.dockerPullAndRecreate();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/updater/token', (req, res) => {
    const status = updaterService.setToken(req.body?.token || '');
    res.json({ ok: true, status });
  });

  router.post('/updater/token/verify', async (req, res) => {
    const result = await updaterService.verifyToken(req.body?.token || '');
    res.json(result);
  });

  router.post('/updater/rate-limit', async (_req, res, next) => {
    try {
      const rateLimit = await updaterService.refreshRateLimit();
      res.json({ ok: true, rateLimit });
    } catch (err) { next(err); }
  });

  router.post('/updater/auto', (req, res) => {
    try {
      const status = updaterService.setAutoUpdate({
        enabled: req.body?.enabled,
        at: req.body?.at,
      });
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createUpdaterRouter };
