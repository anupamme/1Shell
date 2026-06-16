'use strict';

const { Router } = require('express');

// REST surface for the /agent conversation history rail. The live conversation
// stream still flows over Socket.IO (ide:message …); these endpoints only manage
// the persisted history records.
function createIdeSessionRouter({ ideService }) {
  const router = Router();

  router.get('/agent/sessions', (req, res, next) => {
    try {
      const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const result = ideService.listSessions({ keyword, limit, offset });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/agent/sessions/:id', (req, res, next) => {
    try {
      const session = ideService.getSessionDetail(req.params.id);
      if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
      return res.json({ ok: true, session });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/agent/sessions/:id', (req, res, next) => {
    try {
      const title = String(req.body?.title || '').trim();
      if (!title) return res.status(400).json({ ok: false, error: 'title 不能为空' });
      const ok = ideService.renameSessionRecord(req.params.id, title);
      if (!ok) return res.status(404).json({ ok: false, error: '会话不存在' });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/agent/sessions/:id', (req, res, next) => {
    try {
      ideService.removeSessionRecord(req.params.id);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createIdeSessionRouter };
