'use strict';

const { Router } = require('express');

function createRemoteMcpRouter({ remoteMcpService, mcpService }) {
  const router = Router();

  router.get('/remote-mcp/status', (req, res) => {
    try {
      const allTools = mcpService.getAllToolSchemas();
      remoteMcpService.pruneAllowedTools?.(allTools.map((tool) => tool.name));
      const status = remoteMcpService.getStatus(req);
      res.json({
        ...status,
        tools: allTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          exposed: status.config.allowedTools.includes(tool.name),
        })),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/remote-mcp/config', (req, res) => {
    try {
      const config = remoteMcpService.updateConfig(req.body || {});
      res.json({ ok: true, config, warnings: remoteMcpService.getStatus(req).warnings });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/remote-mcp/tokens', (req, res) => {
    try {
      const result = remoteMcpService.createToken(req.body || {});
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/remote-mcp/tokens/:id', (req, res) => {
    try {
      const token = remoteMcpService.updateToken(req.params.id, req.body || {});
      if (!token) return res.status(404).json({ ok: false, error: 'Remote MCP Token 不存在' });
      return res.json({ ok: true, token });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/remote-mcp/tokens/:id', (req, res) => {
    try {
      const token = remoteMcpService.revokeToken(req.params.id);
      if (!token) return res.status(404).json({ ok: false, error: 'Remote MCP Token 不存在' });
      return res.json({ ok: true, token });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createRemoteMcpRouter };
