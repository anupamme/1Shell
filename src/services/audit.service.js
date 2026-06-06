'use strict';

/**
 * 审计日志服务
 *
 * 记录所有通过 Bridge API / MCP / SSH Session 执行的操作。
 * 审计日志仅追加，不支持删除（满足合规要求）。
 *
 * 如果 SQLite 不可用，降级为文件日志。
 */

const fs = require('fs');
const path = require('path');

function createAuditService({ db, dataDir }) {
  const LOG_FILE = path.join(dataDir, 'audit.log');

  // SQLite 模式
  const insertStmt = db
    ? db.prepare(`
        INSERT INTO audit_logs (action, source, host_id, host_name, command, exit_code, duration_ms, client_ip, error, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    : null;

  // 筛选查询通过动态拼接 WHERE 子句实现（参数化防注入）

  /**
   * 记录一条审计日志。
   *
   * @param {object} entry
   * @param {string} entry.action - 操作类型：bridge_exec / mcp_tool_call / ssh_session_open / ssh_session_close / host_create / host_update / host_delete / login
   * @param {string} [entry.source] - 来源：bridge_api / mcp / web_ui / socket
   * @param {string} [entry.hostId] - 目标主机 ID
   * @param {string} [entry.hostName] - 目标主机名称
   * @param {string} [entry.command] - 执行的命令
   * @param {number} [entry.exitCode] - 退出码
   * @param {number} [entry.durationMs] - 执行耗时
   * @param {string} [entry.clientIp] - 客户端 IP
   * @param {string} [entry.error] - 错误信息
   * @param {string} [entry.details] - 额外信息（JSON string）
   */
  function log(entry) {
    try {
      if (insertStmt) {
        insertStmt.run(
          entry.action || 'unknown',
          entry.source || 'unknown',
          entry.hostId || null,
          entry.hostName || null,
          entry.command ? entry.command.substring(0, 2000) : null,
          entry.exitCode ?? null,
          entry.durationMs ?? null,
          entry.clientIp || null,
          entry.error ? String(entry.error).substring(0, 1000) : null,
          entry.details || null,
        );
      } else {
        // 降级：追加文件
        const line = JSON.stringify({
          timestamp: new Date().toISOString(),
          ...entry,
          command: entry.command ? entry.command.substring(0, 2000) : undefined,
        });
        fs.appendFileSync(LOG_FILE, line + '\n');
      }
    } catch {
      // 审计日志写入失败不应阻塞业务
    }
  }

  /**
   * 查询审计日志（分页 + 筛选）。
   */
  function query({ limit = 50, offset = 0, action, source, hostId, keyword } = {}) {
    if (!db) {
      return { logs: [], total: 0, source: 'file' };
    }

    const conditions = [];
    const params = [];

    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (source) {
      conditions.push('source = ?');
      params.push(source);
    }
    if (hostId) {
      conditions.push('(host_id = ? OR host_name = ?)');
      params.push(hostId, hostId);
    }
    if (keyword) {
      conditions.push('(command LIKE ? OR host_name LIKE ? OR error LIKE ? OR details LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const logs = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(limit, 200), Math.max(offset, 0));
    const { total } = db.prepare(`SELECT COUNT(*) as total FROM audit_logs ${where}`)
      .get(...params);

    return { logs, total, source: 'sqlite' };
  }

  function hasHarnessColumn(name) {
    if (!db) return false;
    try {
      return db.prepare('PRAGMA table_info(harness_traces)').all().some((row) => row.name === name);
    } catch {
      return false;
    }
  }

  /**
   * 查询 harness 执行轨迹（分页 + 筛选）。
   * 与 audit_logs 互补：audit 记"发生了什么"，trace 记"为什么这么决策"。
   */
  function queryHarnessTraces({ limit = 50, offset = 0, decision, source, hostId, toolName, keyword, runId, sessionId, stage, eventType } = {}) {
    if (!db) {
      return { traces: [], total: 0, source: 'file' };
    }

    // 表可能尚未迁移（旧库），容错返回空
    try {
      const conditions = [];
      const params = [];

      if (decision) { conditions.push('decision = ?'); params.push(decision); }
      if (source) { conditions.push('source = ?'); params.push(source); }
      if (hostId) { conditions.push('host_id = ?'); params.push(hostId); }
      if (toolName) { conditions.push('tool_name = ?'); params.push(toolName); }
      if (runId) { conditions.push('run_id = ?'); params.push(runId); }
      if (sessionId) { conditions.push('session_id = ?'); params.push(sessionId); }
      if (stage && hasHarnessColumn('stage')) { conditions.push('stage = ?'); params.push(stage); }
      if (eventType && hasHarnessColumn('event_type')) { conditions.push('event_type = ?'); params.push(eventType); }
      if (keyword) {
        conditions.push('(input_summary LIKE ? OR block_reason LIKE ? OR result_summary LIKE ?)');
        const like = `%${keyword}%`;
        params.push(like, like, like);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const traces = db.prepare(`SELECT * FROM harness_traces ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, Math.min(limit, 200), Math.max(offset, 0));
      const { total } = db.prepare(`SELECT COUNT(*) as total FROM harness_traces ${where}`)
        .get(...params);

      return { traces, total, source: 'sqlite' };
    } catch (err) {
      return { traces: [], total: 0, source: 'unavailable', error: err.message };
    }
  }

  function queryReasoningChain({ runId, sessionId, limit = 200 } = {}) {
    if (!db) return { chain: [], total: 0, source: 'file' };
    if (!runId && !sessionId) return { chain: [], total: 0, source: 'sqlite', error: 'runId 或 sessionId 必填' };
    try {
      const conditions = [];
      const params = [];
      if (runId) { conditions.push('run_id = ?'); params.push(runId); }
      if (sessionId) { conditions.push('session_id = ?'); params.push(sessionId); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM harness_traces ${where} ORDER BY id ASC LIMIT ?`)
        .all(...params, Math.min(limit, 500));
      return {
        chain: rows.map(normalizeChainRow),
        total: rows.length,
        source: 'sqlite',
      };
    } catch (err) {
      return { chain: [], total: 0, source: 'unavailable', error: err.message };
    }
  }

  return { log, query, queryHarnessTraces, queryReasoningChain };
}

function normalizeChainRow(row) {
  return {
    id: row.id,
    traceId: row.trace_id,
    startedAt: row.ts_start,
    endedAt: row.ts_end,
    source: row.source,
    runId: row.run_id,
    sessionId: row.session_id,
    hostId: row.host_id,
    stage: row.stage || inferStage(row),
    eventType: row.event_type || 'tool_call',
    toolName: row.tool_name,
    summary: row.input_summary,
    decision: row.decision,
    blockReason: row.block_reason,
    riskLevel: row.risk_level,
    riskAction: row.risk_action,
    resultSummary: row.result_summary,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
  };
}

function inferStage(row) {
  if (row.risk_level || row.risk_action) return 'security';
  if (String(row.tool_name || '').match(/probe|list_hosts|read_remote_file|list_remote_dir|query_audit/i)) return 'perception';
  return 'execution';
}

module.exports = { createAuditService };
