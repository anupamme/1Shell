'use strict';

const { Router } = require('express');

function createSecretRouter({ secretService }) {
  const router = Router();

  router.get('/secrets', (req, res) => {
    try {
      const secrets = secretService.list({ type: req.query?.type || null });
      res.json({ ok: true, secrets });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/secrets', (req, res) => {
    try {
      const body = req.body || {};
      const secret = secretService.save({ name: body.name, type: body.type, value: body.value });
      res.json({ ok: true, secret });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/secrets/:id', (req, res) => {
    try {
      const secret = secretService.get?.(req.params.id) || null;
      if (!secret) return res.status(404).json({ ok: false, error: '保存的凭据不存在或已删除' });
      return res.json({ ok: true, secret });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/secrets/:id', (req, res) => {
    try {
      const deleted = secretService.remove(req.params.id);
      res.json({ ok: true, deleted });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSecretRouter };
