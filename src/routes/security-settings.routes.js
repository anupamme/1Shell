'use strict';

const express = require('express');
const { SECURITY_MODES } = require('../harness/risk-rules');
const { buildAgentUserProvisionScript, cleanUser } = require('../harness/agent-user-provision');

function createSecuritySettingsRouter({ securitySettingsService, bridgeService, hostService, auditService }) {
  const router = express.Router();

  router.get('/security/settings', (req, res, next) => {
    try {
      res.json({ ok: true, settings: securitySettingsService.getSettings(), modes: SECURITY_MODES });
    } catch (err) {
      next(err);
    }
  });

  router.put('/security/settings', (req, res, next) => {
    try {
      const patch = req.body || {};
      const settings = securitySettingsService.updateSettings(patch, { source: 'web_ui', clientIp: req.ip });
      res.json({ ok: true, settings, modes: SECURITY_MODES });
    } catch (err) {
      next(err);
    }
  });

  router.post('/security/agent-user/init', async (req, res, next) => {
    try {
      const hostId = String(req.body?.hostId || 'local').trim() || 'local';
      const settings = securitySettingsService.getSettings();
      const agentUser = cleanUser(req.body?.agentUser || settings.agentUser || 'oneshell-agent');
      if (!agentUser) {
        return res.status(400).json({ error: 'Agent 用户名非法，请使用普通 Linux 用户名，如 oneshell-agent' });
      }
      if (hostId !== 'local' && !hostService?.findHost?.(hostId)) {
        return res.status(404).json({ error: '目标主机不存在' });
      }
      if (!bridgeService?.execOnHost) {
        return res.status(500).json({ error: 'bridgeService 未初始化' });
      }

      const script = buildAgentUserProvisionScript({ agentUser });
      const result = await bridgeService.execOnHost(hostId, script, 120000, {
        source: 'web_ui',
        clientIp: req.ip,
        auditCommand: `[1Shell] 初始化 Agent 普通用户 ${agentUser}`,
      });
      auditService?.log?.({
        action: 'security_agent_user_init',
        source: 'web_ui',
        hostId,
        command: `init agent user ${agentUser}`,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        clientIp: req.ip,
        error: result.exitCode === 0 ? undefined : result.stderr,
        details: JSON.stringify({ agentUser }),
      });
      res.json({
        ok: result.exitCode === 0,
        hostId,
        agentUser,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSecuritySettingsRouter };
