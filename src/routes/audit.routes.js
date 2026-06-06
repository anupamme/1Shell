'use strict';

const { Router } = require('express');

/**
 * Audit Routes
 *
 * GET /api/audit/logs?limit=50&offset=0
 *   查询审计日志（分页，最新在前）
 * GET /api/audit/harness-traces?limit=50&offset=0
 *   查询 harness 执行轨迹（分页，最新在前；带 decision/block_reason 决策上下文）
 */
function createAuditRouter({ auditService }) {
  const router = Router();

  router.get('/audit/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const action = req.query.action || undefined;
    const source = req.query.source || undefined;
    const hostId = req.query.hostId || undefined;
    const keyword = req.query.keyword || undefined;
    const result = auditService.query({ limit, offset, action, source, hostId, keyword });
    res.json({ ok: true, ...result });
  });

  router.get('/audit/harness-traces', (req, res) => {
    if (typeof auditService.queryHarnessTraces !== 'function') {
      return res.json({ ok: true, traces: [], total: 0, source: 'unavailable' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const decision = req.query.decision || undefined;
    const source = req.query.source || undefined;
    const hostId = req.query.hostId || undefined;
    const toolName = req.query.toolName || undefined;
    const keyword = req.query.keyword || undefined;
    const runId = req.query.runId || undefined;
    const sessionId = req.query.sessionId || undefined;
    const stage = req.query.stage || undefined;
    const eventType = req.query.eventType || undefined;
    const result = auditService.queryHarnessTraces({ limit, offset, decision, source, hostId, toolName, keyword, runId, sessionId, stage, eventType });
    return res.json({ ok: true, ...result });
  });

  router.get('/audit/reasoning-chain', (req, res) => {
    if (typeof auditService.queryReasoningChain !== 'function') {
      return res.json({ ok: true, chain: [], total: 0, source: 'unavailable' });
    }
    const runId = req.query.runId || undefined;
    const sessionId = req.query.sessionId || undefined;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const result = auditService.queryReasoningChain({ runId, sessionId, limit });
    return res.json({ ok: !result.error, ...result });
  });

  return router;
}

module.exports = { createAuditRouter };
