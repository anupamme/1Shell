'use strict';

const { isReadonlyCommand } = require('./capabilities');

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
  const hasColumn = createColumnChecker(db, 'harness_traces');
  const riskColumnsReady = hasColumn('security_mode') && hasColumn('risk_level') && hasColumn('risk_rules') && hasColumn('risk_action');
  const chainColumnsReady = hasColumn('stage') && hasColumn('event_type');
  const insertColumns = [
    'trace_id', 'ts_start', 'source', 'run_id', 'session_id', 'host_id', 'tool_name',
    'input_summary', 'capabilities', 'decision', 'block_reason', 'needed_approval',
  ];
  if (riskColumnsReady) insertColumns.push('security_mode', 'risk_level', 'risk_rules', 'risk_action');
  if (chainColumnsReady) insertColumns.push('stage', 'event_type');
  const insertSql = `
    INSERT INTO harness_traces
      (${insertColumns.join(', ')})
    VALUES (${insertColumns.map((column) => column === 'ts_start' ? "datetime('now')" : '?').join(', ')})
  `;
  const updateSql = riskColumnsReady
    ? `
        UPDATE harness_traces
        SET ts_end = datetime('now'),
            decision = ?, block_reason = ?, exit_code = ?, duration_ms = ?, result_summary = ?,
            security_mode = COALESCE(?, security_mode),
            risk_level = COALESCE(?, risk_level),
            risk_rules = COALESCE(?, risk_rules),
            risk_action = COALESCE(?, risk_action)
        WHERE trace_id = ? AND id = (SELECT MAX(id) FROM harness_traces WHERE trace_id = ?)
      `
    : `
        UPDATE harness_traces
        SET ts_end = datetime('now'),
            decision = ?, block_reason = ?, exit_code = ?, duration_ms = ?, result_summary = ?
        WHERE trace_id = ? AND id = (SELECT MAX(id) FROM harness_traces WHERE trace_id = ?)
      `;
  const insertStmt = db ? db.prepare(insertSql) : null;
  const updateStmt = db ? db.prepare(updateSql) : null;

  // 内存态：trace_id -> { startedAt, rowReady }
  const pending = new Map();

  function start({ toolName, input = {}, context = {} }) {
    const traceId = genTraceId();
    pending.set(traceId, { startedAt: Date.now() });
    try {
      if (insertStmt) {
        const stage = classifyStage(toolName, input);
        const args = [
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
        ];
        if (riskColumnsReady) {
          args.push(context.securityMode || null, null, null, null);
        }
        if (chainColumnsReady) {
          args.push(stage, 'tool_call');
        }
        insertStmt.run(...args);
      }
    } catch (err) {
      logger?.warn?.(`[harness-trace] start write failed: ${err.message}`);
    }
    return traceId;
  }

  function end(traceId, { blocked, denied, error, reason, result, exitCode, risk } = {}) {
    const meta = pending.get(traceId);
    pending.delete(traceId);
    const durationMs = meta ? Date.now() - meta.startedAt : null;

    let decision = 'allowed';
    if (blocked) decision = 'blocked';
    else if (denied) decision = 'denied';
    else if (error) decision = 'error';
    else if (risk?.risky) decision = risk.action === 'warn' ? 'allowed_with_warning' : 'allowed_after_security_check';

    const riskSummary = summarizeRisk(risk);
    const blockReason = reason || error || riskSummary || null;
    const resultSummary = summarizeResult(result, error);

    try {
      if (updateStmt) {
        const args = [
          decision,
          blockReason ? String(blockReason).slice(0, 1000) : null,
          typeof exitCode === 'number' ? exitCode : null,
          durationMs,
          resultSummary ? resultSummary.slice(0, 2000) : null,
        ];
        if (riskColumnsReady) {
          args.push(
            risk?.securityMode || null,
            risk?.level || null,
            risk?.matchedRules ? JSON.stringify(risk.matchedRules) : null,
            risk?.action || null,
          );
        }
        args.push(traceId, traceId);
        updateStmt.run(...args);
      }
    } catch (err) {
      logger?.warn?.(`[harness-trace] end write failed: ${err.message}`);
    }
    return { traceId, decision, durationMs };
  }

  function recordEvent({ stage, eventType, source, runId, sessionId, hostId, toolName, summary, resultSummary, decision = 'event', capabilities = [], secrets = [] } = {}) {
    if (!insertStmt || !chainColumnsReady) return null;
    const traceId = genTraceId();
    try {
      const args = [
        traceId,
        source || 'unknown',
        runId || null,
        sessionId || null,
        hostId || null,
        toolName || eventType || stage || 'event',
        redactText(summary || '', secrets).slice(0, 2000),
        JSON.stringify(Array.isArray(capabilities) ? capabilities : []),
        decision,
        null,
        0,
      ];
      if (riskColumnsReady) {
        args.push(null, null, null, null);
      }
      args.push(normalizeStage(stage), eventType || 'event');
      insertStmt.run(...args);
      if (resultSummary && updateStmt) {
        const updateArgs = [decision, null, null, 0, redactText(resultSummary, secrets).slice(0, 2000)];
        if (riskColumnsReady) updateArgs.push(null, null, null, null);
        updateArgs.push(traceId, traceId);
        updateStmt.run(...updateArgs);
      }
      return traceId;
    } catch (err) {
      logger?.warn?.(`[harness-trace] event write failed: ${err.message}`);
      return null;
    }
  }

  return { start, end, recordEvent };
}

function createColumnChecker(db, table) {
  let columns = null;
  return function hasColumn(name) {
    if (!db) return false;
    try {
      if (!columns) {
        columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      }
      return columns.has(name);
    } catch {
      return false;
    }
  };
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

function summarizeRisk(risk) {
  if (!risk?.risky) return '';
  const reasons = Array.isArray(risk.reasons) ? risk.reasons.join('、') : '';
  const parts = [reasons, risk.level ? `风险等级=${risk.level}` : '', risk.securityMode ? `安全档位=${risk.securityMode}` : ''].filter(Boolean);
  return parts.join('；');
}

function classifyStage(toolName, input = {}) {
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const command = String(input.command || '');
    return isReadonlyCommand(command) ? 'perception' : 'execution';
  }
  if (/probe|list_hosts|read_remote_file|list_remote_dir|query_audit/i.test(String(toolName || ''))) {
    return 'perception';
  }
  return 'execution';
}

function normalizeStage(stage) {
  const value = String(stage || '').trim().toLowerCase();
  return ['instruction', 'perception', 'reasoning', 'security', 'execution', 'result'].includes(value) ? value : 'execution';
}

module.exports = { createTrace, classifyStage };
