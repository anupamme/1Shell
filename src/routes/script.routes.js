'use strict';

const { Router } = require('express');
const { validateScriptPayload } = require('../utils/validators');

/**
 * Script Routes
 *
 * 所有路由都经过 authService.requireAuth（在 server.js 挂载时已生效）。
 *
 * GET    /api/scripts                    列表，支持 ?keyword=
 * GET    /api/scripts/:id                详情
 * POST   /api/scripts                    新建
 * PUT    /api/scripts/:id                更新
 * DELETE /api/scripts/:id                删除
 * POST   /api/scripts/:id/render         参数渲染，返回可注入终端的命令
 *
 * 4.7.6 起 Web 端不再执行脚本：执行入口、批量执行、执行历史全部退役，
 * 服务端执行只保留给 agent 的 run_script 工具。渲染接口仍在服务端，
 * 因为 shell 转义是防注入的关键，不能挪到前端。
 */
function createScriptRouter({ scriptService }) {
  const router = Router();

  // ─── 列表 ─────────────────────────────────────────────────────────
  router.get('/scripts', (req, res, next) => {
    try {
      const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
      const scripts = scriptService.listScripts({ keyword });
      res.json({ ok: true, scripts });
    } catch (err) {
      next(err);
    }
  });

  // ─── 详情 ─────────────────────────────────────────────────────────
  router.get('/scripts/:id', (req, res, next) => {
    try {
      const script = scriptService.getScript(req.params.id);
      if (!script) return res.status(404).json({ error: '脚本不存在' });
      return res.json({ ok: true, script });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 新建 ─────────────────────────────────────────────────────────
  router.post('/scripts', (req, res, next) => {
    try {
      const payload = validateScriptPayload(req.body);
      const script = scriptService.createScript(payload);
      res.status(201).json({ ok: true, script });
    } catch (err) {
      next(err);
    }
  });

  // ─── 更新 ─────────────────────────────────────────────────────────
  router.put('/scripts/:id', (req, res, next) => {
    try {
      const payload = validateScriptPayload(req.body);
      const script = scriptService.updateScript(req.params.id, payload);
      if (!script) return res.status(404).json({ error: '脚本不存在' });
      return res.json({ ok: true, script });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 删除 ─────────────────────────────────────────────────────────
  router.delete('/scripts/:id', (req, res, next) => {
    try {
      const deleted = scriptService.deleteScript(req.params.id);
      if (!deleted) return res.status(404).json({ error: '脚本不存在' });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // ─── 渲染（替换占位符 + shell 转义，供终端注入面板使用） ───────────
  router.post('/scripts/:id/render', (req, res, next) => {
    try {
      const script = scriptService.getScript(req.params.id);
      if (!script) return res.status(404).json({ error: '脚本不存在' });

      const params = (req.body && typeof req.body.params === 'object' && !Array.isArray(req.body.params))
        ? req.body.params
        : {};
      const hostId = typeof req.body?.hostId === 'string' ? req.body.hostId : undefined;

      // allowMissing：注入面板是边填边看，缺键按空串渲染，不报错
      const { rendered, placeholders, shellStyle } = scriptService.renderContent(
        script,
        params,
        { hostId, allowMissing: true },
      );
      return res.json({
        ok: true,
        renderedCommand: rendered,
        placeholders,
        shellStyle,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createScriptRouter };
