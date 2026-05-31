'use strict';

/**
 * Harness Trace — 结构化执行轨迹。
 *
 * 每次 dispatch 落一条 harness_traces。表面是审计，实质是下一版记忆系统的数据管道。
 * 写入失败一律 fail-open（不阻塞业务），与 audit.service 一致。
 *
 * 设计见 HARNESS_DESIGN.md §9。
 */

function genTraceId() {
  return `tr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createTrace({ db, logger, redact } = {}) {
  const redactText = typeof redact === 'function' ? redact : (v) => String(v || '');
  const insertStmt = db
    ? db.prepare(`
        INSERT INTO harness_traces
          (trace_id, ts_start, source, run_id, session_id, host_id, tool_name,
           input_summary, capabilities, decision, block_reason, needed_approval)
        VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    : null;

  const updateStmt = db
    ? db.prepare(`
        UPDATE harness_traces
        SET ts_end = datetime('now'),
            decision = ?, block_reason = ?, exit_code = ?, duration_ms = ?, result_summary = ?
        WHERE trace_id = ? AND id = (SELECT MAX(id) FROM harness_traces WHERE trace_id = ?)
      `)
    : null;

  // 内存态：trace_id -> { startedAt, rowReady }
  const pending = new Map();

  function start({ toolName, input = {}, context = {} }) {
    const traceId = genTraceId();
    pending.set(traceId, { startedAt: Date.now() });
    try {
      if (insertStmt) {
        insertStmt.run(
          traceId,
          context.source || 'unknown',
          context.runId || null,
          context.sessionId || null,
          context.hostId || null,
          toolName,
          redactText(summarizeInput(toolName, input), context.secrets).slice(0, 2000),
          JSON.stringify(Array.isArray(context.capabilities) ? context.capabilities : []),
          'pending',
          null,
          context.allowApproval ? 1 : 0,
        );
      }
    } catch (err) {
      logger?.warn?.(`[harness-trace] start write failed: ${err.message}`);
    }
    return traceId;
  }

  function end(traceId, { blocked, denied, error, reason, result, exitCode } = {}) {
    const meta = pending.get(traceId);
    pending.delete(traceId);
    const durationMs = meta ? Date.now() - meta.startedAt : null;

    let decision = 'allowed';
    if (blocked) decision = 'blocked';
    else if (denied) decision = 'denied';
    else if (error) decision = 'error';

    const blockReason = reason || error || null;
    const resultSummary = summarizeResult(result, error);

    try {
      if (updateStmt) {
        updateStmt.run(
          decision,
          blockReason ? String(blockReason).slice(0, 1000) : null,
          typeof exitCode === 'number' ? exitCode : null,
          durationMs,
          resultSummary ? resultSummary.slice(0, 2000) : null,
          traceId,
          traceId,
        );
      }
    } catch (err) {
      logger?.warn?.(`[harness-trace] end write failed: ${err.message}`);
    }
    return { traceId, decision, durationMs };
  }

  return { start, end };
}

function summarizeInput(toolName, input) {
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    return `[${input.hostId || 'local'}] ${String(input.command || '')}`;
  }
  if (input && (input.path || input.dirPath)) {
    return `path=${input.path || input.dirPath}`;
  }
  try { return JSON.stringify(input || {}); } catch { return ''; }
}

function summarizeResult(result, error) {
  if (error) return `ERROR: ${error}`;
  if (!result) return '';
  if (typeof result === 'string') return result;
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const code = result.exitCode;
  const head = stdout || stderr || '';
  return `exit=${code} ${head.slice(0, 400)}`;
}

module.exports = { createTrace };
