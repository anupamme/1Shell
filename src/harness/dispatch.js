'use strict';

const { analyzeCommandOutput, formatOutputDiagnostics } = require('../utils/output-diagnostics');

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
  const outputDiagnostics = safe.outputDiagnostics || analyzeCommandOutput(safe);
  const raw = safe.outputDiagnostics ? safe : { ...safe, outputDiagnostics };
  const body = formatExec({ stdout, stderr, exitCode, durationMs: safe.durationMs, outputDiagnostics });
  return { content: body, is_error: exitCode !== 0, raw };
}

function formatExec({ stdout, stderr, exitCode, durationMs, outputDiagnostics }) {
  const parts = [];
  parts.push(`exitCode=${exitCode}${typeof durationMs === 'number' ? ` durationMs=${durationMs}` : ''}`);
  const diagnosticsText = formatOutputDiagnostics(outputDiagnostics);
  if (diagnosticsText) parts.push(diagnosticsText);
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
    context = {
      ...context,
      auditCommand: context.auditCommand || redactText(String(input.command || summarize(toolName, input)), context.secrets).slice(0, 2000),
    };
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
      recordSecurityEvent(trace, toolName, input, context, verdict, 'blocked');
      trace.end(traceId, { blocked: true, reason: verdict.reason, risk: verdict.risk });
      auditService?.log?.({
        action: 'harness_blocked',
        source: context.source || 'harness',
        hostId: context.hostId || (input && input.hostId) || null,
        command: redactText(String(input.command || summarize(toolName, input)), context.secrets).slice(0, 2000),
        error: verdict.reason,
        details: formatRiskDetails(verdict.risk),
      });
      return { content: `[harness] 已拦截：${verdict.reason}`, is_error: true };
    }

    // ── 2. 人审 gate（仅人在场的上下文）────────────────────────
    let approvalGranted = context.approvalGranted === true || context.preApproved === true;
    if (!approvalGranted && verdict.needApproval && context.allowApproval && typeof context.requestApproval === 'function') {
      try {
        approvalGranted = await context.requestApproval(toolName, input, verdict.summary, verdict.riskReason, {
          approval: verdict.approval || null,
          risk: verdict.risk || null,
          needApproval: verdict.needApproval === true,
          approvalRequired: verdict.approvalRequired === true,
        });
      } catch (err) {
        // 审批流程异常（如取消）→ 视为拒绝
        trace.end(traceId, { denied: true, reason: `approval error: ${err.message}` });
        return { content: `[harness] 审批中断：${err.message}`, is_error: true };
      }
      if (!approvalGranted) {
        trace.end(traceId, { denied: true, reason: '用户拒绝', risk: verdict.risk });
        return { content: '[harness] 用户拒绝了此操作', is_error: true };
      }
    }
    if (verdict.approvalRequired && !approvalGranted) {
      // AI 审批（1Shell AI 替我审批）：仅无人在场的入口（外部 MCP）会带
      // context.requestAiApproval。红线/黑名单/critical 在 guard 阶段已被拦死，
      // AI 只决定"这条需审批的高危命令放不放行"；评估异常即拒绝（fail-closed）。
      if (typeof context.requestAiApproval === 'function') {
        let aiVerdict;
        try {
          aiVerdict = await context.requestAiApproval(toolName, input, verdict, context);
        } catch (err) {
          aiVerdict = { handled: true, allow: false, reason: `AI 审批异常: ${err?.message || err}` };
        }
        if (!aiVerdict?.handled) {
          // 审批器未启用/不适用 → 走原有拒绝路径（下方）
        } else if (aiVerdict.allow === true) {
          approvalGranted = true;
          trace.recordEvent?.({
            stage: 'security',
            eventType: 'security_check',
            source: context.source || 'harness',
            runId: context.runId,
            sessionId: context.sessionId,
            hostId: context.hostId || input?.hostId,
            toolName: 'security_check',
            summary: `工具=${toolName}；动作=ai_approved；${aiVerdict.reason || ''}`.slice(0, 400),
            decision: 'ai_approved',
            capabilities: context.capabilities,
          });
        } else {
          const reason = aiVerdict.reason || 'AI 审批拒绝';
          trace.end(traceId, { denied: true, reason: `ai denied: ${reason}`, risk: verdict.risk });
          return { content: `[harness] AI 审批拒绝，已拦截：${reason}`, is_error: true };
        }
      }
    }
    if (verdict.approvalRequired && !approvalGranted) {
      const reason = verdict.approval?.reason || verdict.riskReason || '当前操作需要人工审批';
      recordSecurityEvent(trace, toolName, input, context, verdict, 'approval_required');
      trace.end(traceId, { denied: true, reason: `approval required: ${reason}`, risk: verdict.risk });
      auditService?.log?.({
        action: 'harness_approval_required',
        source: context.source || 'harness',
        hostId: context.hostId || (input && input.hostId) || null,
        command: redactText(String(input.command || summarize(toolName, input)), context.secrets).slice(0, 2000),
        error: reason,
        details: formatRiskDetails(verdict.risk),
      });
      return { content: `[harness] 需要人工审批，已拒绝自动执行：${reason}`, is_error: true };
    }
    // Unattended agent paths use allowApproval=false, so approval-required risks are denied here.

    if (verdict.risk?.risky) {
      recordSecurityEvent(trace, toolName, input, context, verdict, verdict.risk.action || 'checked');
    }

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
      const failure = executionErrorToResult(err);
      if (failure) {
        const safe = redactResult(failure, context.secrets);
        const safeMsg = redactText(String(err.message || err), context.secrets);
        trace.end(traceId, { error: safeMsg, result: safe, exitCode: safe.exitCode });
        return toToolResult(safe);
      }
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
      risk: verdict.risk,
    });

    return toToolResult(safe);
  };
}

function executionErrorToResult(err) {
  if (!err || typeof err !== 'object') return null;
  const hasExecutionContext = ['stdout', 'stderr', 'partialOutput', 'exitCode', 'durationMs', 'interactivePromptDetected']
    .some((key) => Object.prototype.hasOwnProperty.call(err, key));
  if (!hasExecutionContext) return null;
  const stdout = String(err.stdout ?? err.partialOutput ?? '');
  const stderrParts = [];
  if (err.stderr) stderrParts.push(String(err.stderr));
  if (err.message && !stderrParts.some((part) => part.includes(err.message))) stderrParts.push(String(err.message));
  if (err.interactivePromptDetected === true) stderrParts.push('[1Shell] interactivePromptDetected=true');
  const exitCode = typeof err.exitCode === 'number' ? err.exitCode : (err.code === 'EXEC_TIMEOUT' ? 124 : -1);
  return {
    stdout,
    stderr: stderrParts.join('\n'),
    exitCode,
    durationMs: typeof err.durationMs === 'number' ? err.durationMs : undefined,
    errorCode: err.code || undefined,
    interactivePromptDetected: err.interactivePromptDetected === true,
  };
}

function summarize(toolName, input) {
  if (input && input.command) return String(input.command);
  try { return `${toolName} ${JSON.stringify(input || {})}`; } catch { return toolName; }
}

function formatRiskDetails(risk) {
  if (!risk?.risky) return null;
  try {
    return JSON.stringify({
      securityMode: risk.securityMode,
      level: risk.level,
      action: risk.action,
      reasons: risk.reasons || [],
      matchedRules: risk.matchedRules || [],
    });
  } catch {
    return null;
  }
}

function recordSecurityEvent(trace, toolName, input, context, verdict, action) {
  if (typeof trace?.recordEvent !== 'function' || !verdict?.risk?.risky) return;
  const risk = verdict.risk;
  trace.recordEvent({
    stage: 'security',
    eventType: 'security_check',
    source: context.source || 'harness',
    runId: context.runId,
    sessionId: context.sessionId,
    hostId: context.hostId || input?.hostId,
    toolName: 'security_check',
    summary: [
      `工具=${toolName}`,
      input?.command ? `命令=${String(input.command).slice(0, 300)}` : '',
      `动作=${action}`,
      risk.level ? `风险=${risk.level}` : '',
      Array.isArray(risk.reasons) && risk.reasons.length ? `规则=${risk.reasons.join('、')}` : '',
    ].filter(Boolean).join('；'),
    decision: action,
    capabilities: context.capabilities,
    secrets: context.secrets,
  });
}

module.exports = { createDispatch, toToolResult, formatExec };
