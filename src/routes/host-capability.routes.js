'use strict';

const { Router } = require('express');

function createHostCapabilityRouter({ hostCapabilityService }) {
  const router = Router();

  function requireService(res) {
    if (hostCapabilityService) return true;
    res.status(503).json({ ok: false, error: 'Host Capability 管理器未初始化' });
    return false;
  }

  router.get('/host-capabilities/agents', (_req, res) => {
    if (!requireService(res)) return;
    res.json({ ok: true, agents: hostCapabilityService.listAgents() });
  });

  router.get('/host-capabilities/mcp', (_req, res) => {
    if (!requireService(res)) return;
    res.json({ ok: true, agents: hostCapabilityService.listAgents(), capabilities: hostCapabilityService.listMcpCapabilities() });
  });

  router.get('/host-capabilities/skills', (_req, res) => {
    if (!requireService(res)) return;
    res.json({ ok: true, agents: hostCapabilityService.listAgents(), capabilities: hostCapabilityService.listSkillCapabilities() });
  });

  router.get('/host-capabilities/skills/unmanaged', (_req, res) => {
    if (!requireService(res)) return;
    res.json({ ok: true, agents: hostCapabilityService.listAgents(), capabilities: hostCapabilityService.listUnmanagedSkillCapabilities() });
  });

  router.put('/host-capabilities/:kind/:id/exposure/:agentId', (req, res) => {
    if (!requireService(res)) return;
    try {
      const item = hostCapabilityService.setExposure(
        req.params.kind,
        req.params.id,
        req.params.agentId,
        req.body?.enabled === true,
      );
      res.json({ ok: true, capability: item });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/host-capabilities/:kind/:id/import', (req, res) => {
    if (!requireService(res)) return;
    try {
      const item = hostCapabilityService.importCapability(req.params.kind, req.params.id);
      res.json({ ok: true, capability: item });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/host-capabilities/scan', (_req, res) => {
    if (!requireService(res)) return;
    const scan = hostCapabilityService.scanHostCapabilities();
    res.json({ ok: true, scan });
  });

  router.post('/host-capabilities/apply', (_req, res) => {
    if (!requireService(res)) return;
    res.json({
      ok: true,
      phase: 'foundation',
      message: '1Shell AI 暴露已实时生效；原生 CLI 批量 apply 将在 adapter 阶段启用。',
    });
  });

  return router;
}

module.exports = { createHostCapabilityRouter };
