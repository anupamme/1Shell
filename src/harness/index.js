'use strict';

/**
 * Harness — AI 与外部世界之间的统一边界层。
 *
 * createHarness 组装 guard / executors / trace / dispatch，导出一个 dispatch 函数
 * 和一个 buildContext 助手。所有 AI 触达外部世界的路径都应经过 harness.dispatch。
 *
 * 设计见 HARNESS_DESIGN.md。Harness 负责集中执行高风险操作检测、审批、执行和审计。
 */

const { createDispatch } = require('./dispatch');
const { createExecutors } = require('./executors');
const { createGuard } = require('./guard');
const { createTrace } = require('./trace');
const { DEFAULT_CAPABILITIES } = require('./capabilities');
const { normalizeSecurityMode } = require('./risk-rules');
const { redactKnownSecrets } = require('../../lib/secret-redaction');
const { ONESHELL_SECURITY_MODE } = require('../config/env');

/**
 * @param {object} deps
 * @param {object} deps.bridgeService
 * @param {object} deps.hostService
 * @param {object} [deps.auditService]
 * @param {object} [deps.db]            - 给 trace 写 harness_traces
 * @param {object} [deps.logger]
 * @param {object} [deps.securitySettingsService]
 * @param {object} [deps.aiApprover]    - 1Shell AI 替我审批（仅外部 MCP 入口挂载）
 * @param {Function} [deps.executorFallback] - 未接入工具的兜底执行器
 */
function createHarness({ bridgeService, hostService, auditService, db, logger, securitySettingsService, aiApprover, executorFallback } = {}) {
  const guard = createGuard();
  const trace = createTrace({ db, logger, redact: redactKnownSecrets });
  const executors = createExecutors({ bridgeService, hostService, securitySettingsService, fallback: executorFallback });

  const dispatch = createDispatch({
    guard,
    executors,
    trace,
    redact: redactKnownSecrets,
    auditService,
    logger,
  });

  return {
    dispatch,
    guard,
    recordEvent: trace.recordEvent,
    /**
     * 构造一次调用的上下文。各入口用预设 + 覆盖项拼装。
     * @param {string} source - 'console-ai' | 'ide-ai' | 'mcp-remote' | 'mcp-local' | 'cli-agent' | 'external-agent'
     * @param {object} overrides
     */
    buildContext(source, overrides = {}) {
      const settings = securitySettingsService?.getSettings?.() || {};
      const base = {
        source,
        hostId: 'local',
        capabilities: DEFAULT_CAPABILITIES,
        securityMode: normalizeSecurityMode(settings.securityMode || ONESHELL_SECURITY_MODE),
        commandRules: Array.isArray(settings.commandRules) ? settings.commandRules : [],
        agentPrivilegeIsolation: settings.agentPrivilegeIsolation === true,
        agentUser: settings.agentUser || 'oneshell-agent',
        allowApproval: false,
        secrets: [],
        // AI 审批只挂外部 MCP 入口：IDE 有人审卡，协议 agent 本就全放行
        ...(source === 'mcp' && aiApprover ? {
          requestAiApproval: (toolName, input, verdict, context) => aiApprover.evaluate({
            toolName,
            input,
            verdict,
            source: context?.source || 'mcp',
            clientIp: context?.clientIp,
            hostName: context?.hostName,
            securityMode: context?.securityMode,
          }),
        } : {}),
      };
      return { ...base, ...overrides };
    },
  };
}

module.exports = { createHarness };
