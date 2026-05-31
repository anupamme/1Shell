'use strict';

/**
 * Harness — AI 与外部世界之间的统一边界层。
 *
 * createHarness 组装 guard / executors / trace / dispatch，导出一个 dispatch 函数
 * 和一个 buildContext 助手。所有 AI 触达外部世界的路径都应经过 harness.dispatch。
 *
 * 设计见 HARNESS_DESIGN.md。这一版（Phase A/B）：
 *   - 立层 + 接管 Program AI step 一条路径
 *   - 其余路径（IDE / MCP / core local）后续 Phase 接入
 */

const { createDispatch } = require('./dispatch');
const { createExecutors } = require('./executors');
const { createGuard } = require('./guard');
const { createTrace } = require('./trace');
const { DEFAULT_CAPABILITIES } = require('./capabilities');
const { redactKnownSecrets } = require('../../lib/secret-redaction');

/**
 * @param {object} deps
 * @param {object} deps.bridgeService
 * @param {object} deps.hostService
 * @param {object} [deps.auditService]
 * @param {object} [deps.db]            - 给 trace 写 harness_traces
 * @param {object} [deps.logger]
 * @param {Function} [deps.executorFallback] - 未接入工具的兜底执行器
 */
function createHarness({ bridgeService, hostService, auditService, db, logger, executorFallback } = {}) {
  const guard = createGuard();
  const trace = createTrace({ db, logger, redact: redactKnownSecrets });
  const executors = createExecutors({ bridgeService, hostService, fallback: executorFallback });

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
    /**
     * 构造一次调用的上下文。各入口用预设 + 覆盖项拼装。
     * @param {string} source - 'program-ai' | 'ide' | 'mcp-remote' | 'mcp-local' | 'program-exec'
     * @param {object} overrides
     */
    buildContext(source, overrides = {}) {
      const base = {
        source,
        hostId: 'local',
        capabilities: DEFAULT_CAPABILITIES,
        allowApproval: false,
        secrets: [],
      };
      return { ...base, ...overrides };
    },
  };
}

module.exports = { createHarness };
