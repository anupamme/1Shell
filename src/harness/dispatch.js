'use strict';

/**
 * Harness Dispatch — 核心 6 步管道。
 *
 * 所有 AI 触达外部世界的调用必经此函数。设计见 HARNESS_DESIGN.md §7。
 *
 *   1. startTrace
 *   2. guard.check        — 确定性拦截（capability + 灾难命令），fail-closed
 *   3. 人审 gate          — 仅当 context.allowApproval 且 needApproval
 *   4. execute            — 派发底层执行器
 *   5. redact             — secret 出口打码
 *   6. endTrace
 *
 * 返回结构与现有 tool_result 兼容：{ content, is_error?, raw? }
 */

function toToolResult(safe) {
  if (!safe || typeof safe !== 'object') {
    return { content: String(safe || ''), is_error: false };
  }
  const stdout = String(safe.stdout || '');
  const stderr = String(safe.stderr || '');
  const exitCode = typeof safe.exitCode === 'number' ? safe.exitCode : 0;
  const body = formatExec({ stdout, stderr, exitCode, durationMs: safe.durationMs });
  return { content: body, is_error: exitCode !== 0, raw: safe };
}

function formatExec({ stdout, stderr, exitCode, durationMs }) {
  const parts = [];
  parts.push(`exitCode=${exitCode}${typeof durationMs === 'number' ? ` durationMs=${durationMs}` : ''}`);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.guard     - { check(toolName, input, context) }
 * @param {object} deps.executors - { run(toolName, input, context) }
 * @param {object} deps.trace     - { start(), end() }
 * @param {Function} deps.redact  - (value, secrets) => string
 * @param {object} [deps.auditService]
 * @param {object} [deps.logger]
 */
function createDispatch({ guard, executors, trace, redact, auditService, logger }) {
  const redactText = typeof redact === 'function' ? redact : (v) => String(v || '');

  function redactResult(result, secrets) {
    if (!result || typeof result !== 'object') return result;
    return {
      ...result,
      stdout: redactText(result.stdout || '', secrets),
      stderr: redactText(result.stderr || '', secrets),
    };
  }

  return async function dispatch(toolName, input = {}, context = {}) {
    const traceId = trace.start({ toolName, input, context });

    // ── 1. 确定性护栏（fail-closed）────────────────────────────
    let verdict;
    try {
      verdict = guard.check(toolName, input, context);
    } catch (err) {
      // guard 自身异常 → 保守拒绝
      trace.end(traceId, { error: `guard error: ${err.message}` });
      return { content: `[harness] 护栏检查异常，已拒绝执行：${err.message}`, is_error: true };
    }

    if (!verdict.allow) {
      trace.end(traceId, { blocked: true, reason: verdict.reason });
      auditService?.log?.({
        action: 'harness_blocked',
        source: context.source || 'harness',
        hostId: context.hostId || (input && input.hostId) || null,
        command: redactText(String(input.command || summarize(toolName, input)), context.secrets).slice(0, 2000),
        error: verdict.reason,
      });
      return { content: `[harness] 已拦截：${verdict.reason}`, is_error: true };
    }

    // ── 2. 人审 gate（仅人在场的上下文）────────────────────────
    if (verdict.needApproval && context.allowApproval && typeof context.requestApproval === 'function') {
      let approved = false;
      try {
        approved = await context.requestApproval(toolName, input, verdict.summary, verdict.riskReason);
      } catch (err) {
        // 审批流程异常（如取消）→ 视为拒绝
        trace.end(traceId, { denied: true, reason: `approval error: ${err.message}` });
        return { content: `[harness] 审批中断：${err.message}`, is_error: true };
      }
      if (!approved) {
        trace.end(traceId, { denied: true, reason: '用户拒绝' });
        return { content: '[harness] 用户拒绝了此操作', is_error: true };
      }
    }
    // Program AI step：allowApproval=false → 此分支永不进入，零等待

    // ── 3. 执行（派发底层执行器）────────────────────────────────
    let result;
    try {
      result = await executors.run(toolName, input, context);
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'CANCELLED') {
        trace.end(traceId, { error: 'aborted' });
        throw err; // 取消信号透传给上层 loop
      }
      logger?.warn?.(`[harness] executor error: ${err.message}`);
      const safeMsg = redactText(String(err.message || err), context.secrets);
      trace.end(traceId, { error: safeMsg });
      return { content: `[ERROR] ${safeMsg}`, is_error: true };
    }

    // ── 4. 出口打码 ────────────────────────────────────────────
    const safe = redactResult(result, context.secrets);

    // ── 5. 轨迹收尾 ────────────────────────────────────────────
    trace.end(traceId, {
      result: safe,
      exitCode: typeof safe?.exitCode === 'number' ? safe.exitCode : undefined,
    });

    return toToolResult(safe);
  };
}

function summarize(toolName, input) {
  if (input && input.command) return String(input.command);
  try { return `${toolName} ${JSON.stringify(input || {})}`; } catch { return toolName; }
}

module.exports = { createDispatch, toToolResult, formatExec };
