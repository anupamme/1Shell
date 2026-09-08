'use strict';

const express = require('express');
const { SECURITY_MODES } = require('../harness/risk-rules');
const { buildAgentUserProvisionScript, cleanUser } = require('../harness/agent-user-provision');
const { assessCommand } = require('../harness/guard');
const { assessCommandRisk } = require('../ai/command-safety');

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

  // 命令试算：按当前挡位 + 自定义规则推演一条命令的处理结果，不执行。
  // 与 guard.check 走同一个 assessCommand，保证试算结果=实际判定。
  router.post('/security/evaluate', (req, res, next) => {
    try {
      const command = String(req.body?.command || '').slice(0, 2000);
      if (!command.trim()) {
        return res.status(400).json({ error: 'command 不能为空' });
      }
      const settings = securitySettingsService.getSettings();
      const catastrophic = assessCommandRisk(command);
      const risk = assessCommand(command, { securityMode: settings.securityMode, commandRules: settings.commandRules });

      // 判定优先级与 guard.check 实际执行顺序一致：红线 > 黑名单 > block >
      // approval > 白名单豁免（仅当整条命令干净放行时才算"豁免生效"）> warn/allow。
      // 不能先看 matchedAllowRule——多段命令可能"命中规则但另一段仍被阻断"。
      const exemptedByRule = !risk.denied && risk.action === 'allow' && risk.matchedAllowRule;
      let verdict;
      if (catastrophic.dangerous) verdict = 'catastrophic';
      else if (risk.denied) verdict = 'denied';
      else if (risk.action === 'block') verdict = 'block';
      else if (risk.action === 'approval') verdict = 'approval';
      else if (exemptedByRule) verdict = 'allowed_by_rule';
      else verdict = risk.action;

      res.json({
        ok: true,
        command,
        verdict,
        level: risk.level,
        action: verdict,
        securityMode: settings.securityMode,
        catastrophic: catastrophic.dangerous,
        catastrophicReason: catastrophic.reason || '',
        riskReasons: risk.reasons || [],
        reasons: risk.reasons || [],
        matchedRule: risk.denied
          ? { pattern: risk.commandRule.pattern, action: 'deny' }
          : (exemptedByRule ? { pattern: risk.matchedAllowRule.pattern, action: 'allow' } : null),
      });
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
      // 提权脚本失败时返回 502，避免客户端把失败的特权操作当成功
      res.status(result.exitCode === 0 ? 200 : 502).json({
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
