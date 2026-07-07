'use strict';

/**
 * 数据库迁移管理
 *
 * 设计目标：
 *   - schema_migrations 表记录已执行的版本号
 *   - 每个 migration 在事务里执行，失败回滚并标记 'failed'
 *   - 所有 v1 用 CREATE TABLE IF NOT EXISTS / ALTER TABLE 包裹，保证已部署实例首次运行时幂等
 *   - 后续所有结构变更追加为 v2、v3 ...，不允许修改已发布的 migration
 *
 * 用法：
 *   const { runMigrations } = require('./migrations');
 *   runMigrations(db);
 */

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'success'
    );
  `);
}

function getAppliedVersions(db) {
  const rows = db.prepare("SELECT version FROM schema_migrations WHERE status = 'success'").all();
  return new Set(rows.map((row) => row.version));
}

function recordMigration(db, version, name, status) {
  db.prepare(`
    INSERT INTO schema_migrations (version, name, executed_at, status)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(version) DO UPDATE SET
      name = excluded.name,
      executed_at = excluded.executed_at,
      status = excluded.status
  `).run(version, name, status);
}

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((col) => col.name === column);
}

/**
 * Migration 列表 —— 严格按版本号顺序追加，不要修改已发布项。
 */
const migrations = [
  {
    version: 1,
    name: 'initial schema (hosts, audit, scripts, probe baseline)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hosts (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          action TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          host_id TEXT,
          host_name TEXT,
          command TEXT,
          exit_code INTEGER,
          duration_ms INTEGER,
          client_ip TEXT,
          error TEXT,
          details TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_host_id ON audit_logs(host_id);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

        CREATE TABLE IF NOT EXISTS scripts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          icon TEXT,
          category TEXT,
          tags TEXT,
          risk_level TEXT NOT NULL DEFAULT 'safe',
          description TEXT,
          content TEXT NOT NULL,
          parameters TEXT,
          run_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_scripts_category ON scripts(category);
        CREATE INDEX IF NOT EXISTS idx_scripts_updated_at ON scripts(updated_at);

        CREATE TABLE IF NOT EXISTS script_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          script_id TEXT NOT NULL,
          script_name TEXT,
          host_id TEXT,
          host_name TEXT,
          params TEXT,
          rendered_command TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          exit_code INTEGER,
          duration_ms INTEGER,
          stdout TEXT,
          stderr TEXT,
          error TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_runs_script_id ON script_runs(script_id);
        CREATE INDEX IF NOT EXISTS idx_runs_started_at ON script_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON script_runs(status);


        CREATE TABLE IF NOT EXISTS probe_agent_install_tokens (
          token_hash TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_probe_agent_install_tokens_host ON probe_agent_install_tokens(host_id);
        CREATE INDEX IF NOT EXISTS idx_probe_agent_install_tokens_expires ON probe_agent_install_tokens(expires_at);

        CREATE TABLE IF NOT EXISTS probe_agents (
          host_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          agent_version TEXT,
          status TEXT NOT NULL DEFAULT 'registered',
          last_seen_at TEXT,
          installed_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_probe_agents_token_hash ON probe_agents(token_hash);
        CREATE INDEX IF NOT EXISTS idx_probe_agents_last_seen ON probe_agents(last_seen_at);

        CREATE TABLE IF NOT EXISTS probe_agent_latest (
          host_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS probe_relay_tokens (
          token_hash TEXT PRIMARY KEY,
          name TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE TABLE IF NOT EXISTS probe_relay_upstreams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          relay_host_id TEXT,
          server_url TEXT NOT NULL,
          sync_token TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_sync_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS probe_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          host_id TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'agent',
          reported_at TEXT NOT NULL,
          cpu_usage REAL,
          memory_usage REAL,
          swap_usage REAL,
          disk_usage REAL,
          load1 REAL,
          load5 REAL,
          load15 REAL,
          rx_bps REAL,
          tx_bps REAL,
          rx_bytes INTEGER,
          tx_bytes INTEGER,
          process_count INTEGER,
          uptime_sec INTEGER,
          payload TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_probe_samples_host_time ON probe_samples(host_id, reported_at);
        CREATE INDEX IF NOT EXISTS idx_probe_samples_reported_at ON probe_samples(reported_at);
      `);

      // 已部署实例的兼容补丁：probe_relay_upstreams 早期版本没有 relay_host_id 列
      if (!columnExists(db, 'probe_relay_upstreams', 'relay_host_id')) {
        db.exec('ALTER TABLE probe_relay_upstreams ADD COLUMN relay_host_id TEXT');
      }
    },
  },
  {
    version: 2,
    name: 'probe_agents: consecutive heartbeat trust fields',
    up(db) {
      if (!columnExists(db, 'probe_agents', 'consecutive_ok_count')) {
        db.exec('ALTER TABLE probe_agents ADD COLUMN consecutive_ok_count INTEGER NOT NULL DEFAULT 0');
      }
      if (!columnExists(db, 'probe_agents', 'first_healthy_at')) {
        db.exec('ALTER TABLE probe_agents ADD COLUMN first_healthy_at TEXT');
      }
    },
  },
  {
    version: 3,
    name: 'probe_traffic: monthly traffic quota + 24h/31d/12m rolling buffers',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS probe_traffic (
          host_id TEXT PRIMARY KEY,
          hs TEXT NOT NULL DEFAULT '[]',
          ds TEXT NOT NULL DEFAULT '[]',
          ms TEXT NOT NULL DEFAULT '[]',
          last_rx_bytes INTEGER,
          last_tx_bytes INTEGER,
          last_sample_at TEXT,
          last_hour_index INTEGER,
          last_day_index INTEGER,
          last_month_index INTEGER,
          current_month_used_bytes INTEGER NOT NULL DEFAULT 0,
          traffic_limit_bytes INTEGER,
          reset_day INTEGER NOT NULL DEFAULT 1,
          alert_percent REAL NOT NULL DEFAULT 80,
          last_reset_at TEXT,
          calibration_at TEXT,
          calibration_value_bytes INTEGER,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 4,
    name: 'probe alerts: rules + events tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS probe_alert_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          scope_host_ids TEXT,
          kind TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          level TEXT NOT NULL DEFAULT 'warn',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_probe_alert_rules_enabled ON probe_alert_rules(enabled);

        CREATE TABLE IF NOT EXISTS probe_alert_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id TEXT NOT NULL,
          rule_name TEXT NOT NULL,
          rule_kind TEXT NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT,
          level TEXT NOT NULL DEFAULT 'warn',
          message TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT,
          ack_at TEXT,
          snapshot TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_probe_alert_events_rule ON probe_alert_events(rule_id);
        CREATE INDEX IF NOT EXISTS idx_probe_alert_events_host ON probe_alert_events(host_id);
        CREATE INDEX IF NOT EXISTS idx_probe_alert_events_status
          ON probe_alert_events(resolved_at, ack_at);
        CREATE INDEX IF NOT EXISTS idx_probe_alert_events_started ON probe_alert_events(started_at);
      `);
    },
  },
  {
    version: 5,
    name: 'probe samples: 1m/1h/1d rollup tables (B1 multi-tier timeseries)',
    up(db) {
      // 三层聚合表：bucket_at 是 UTC ISO 字符串（桶起始时间）
      // 1m：每 1 分钟一行，保留 7d
      // 1h：每 1 小时一行，保留 180d
      // 1d：每 1 天一行，长期保留（手动清理）
      for (const table of ['probe_samples_1m', 'probe_samples_1h', 'probe_samples_1d']) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS ${table} (
            host_id TEXT NOT NULL,
            bucket_at TEXT NOT NULL,
            cpu_avg REAL,
            cpu_max REAL,
            memory_avg REAL,
            memory_max REAL,
            swap_avg REAL,
            disk_avg REAL,
            disk_max REAL,
            load1_avg REAL,
            load1_max REAL,
            rx_bps_avg REAL,
            rx_bps_max REAL,
            tx_bps_avg REAL,
            tx_bps_max REAL,
            sample_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (host_id, bucket_at)
          );
          CREATE INDEX IF NOT EXISTS idx_${table}_bucket ON ${table}(bucket_at);
        `);
      }
    },
  },
  {
    version: 6,
    name: 'host preferences for console visibility and repository metadata',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS host_preferences (
          host_id TEXT PRIMARY KEY,
          show_in_console INTEGER NOT NULL DEFAULT 1,
          console_order INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          role TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          archived INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_host_preferences_console
          ON host_preferences(show_in_console, pinned, console_order);

        CREATE INDEX IF NOT EXISTS idx_host_preferences_role
          ON host_preferences(role);
      `);
    },
  },
  {
    version: 7,
    name: 'harness_traces: structured tool-call execution traces (AI boundary harness)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS harness_traces (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id        TEXT NOT NULL,
          ts_start        TEXT NOT NULL DEFAULT (datetime('now')),
          ts_end          TEXT,
          source          TEXT NOT NULL,
          run_id          TEXT,
          session_id      TEXT,
          host_id         TEXT,
          tool_name       TEXT NOT NULL,
          input_summary   TEXT,
          capabilities    TEXT,
          decision        TEXT NOT NULL,
          block_reason    TEXT,
          needed_approval INTEGER DEFAULT 0,
          exit_code       INTEGER,
          duration_ms     INTEGER,
          result_summary  TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_trace_run    ON harness_traces(run_id);
        CREATE INDEX IF NOT EXISTS idx_trace_source ON harness_traces(source);
        CREATE INDEX IF NOT EXISTS idx_trace_tool   ON harness_traces(tool_name);
        CREATE INDEX IF NOT EXISTS idx_trace_traceid ON harness_traces(trace_id);
      `);
    },
  },
  {
    version: 8,
    name: 'harness_traces: security risk metadata',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(harness_traces)').all().map((row) => row.name);
      const addColumn = (name, ddl) => {
        if (!columns.includes(name)) db.exec(`ALTER TABLE harness_traces ADD COLUMN ${ddl}`);
      };
      addColumn('security_mode', 'security_mode TEXT');
      addColumn('risk_level', 'risk_level TEXT');
      addColumn('risk_rules', 'risk_rules TEXT');
      addColumn('risk_action', 'risk_action TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trace_risk_level ON harness_traces(risk_level);
        CREATE INDEX IF NOT EXISTS idx_trace_security_mode ON harness_traces(security_mode);
      `);
    },
  },
  {
    version: 9,
    name: 'harness_traces: reasoning chain stages',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(harness_traces)').all().map((row) => row.name);
      const addColumn = (name, ddl) => {
        if (!columns.includes(name)) db.exec(`ALTER TABLE harness_traces ADD COLUMN ${ddl}`);
      };
      addColumn('stage', 'stage TEXT');
      addColumn('event_type', 'event_type TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trace_stage ON harness_traces(stage);
        CREATE INDEX IF NOT EXISTS idx_trace_event_type ON harness_traces(event_type);
        CREATE INDEX IF NOT EXISTS idx_trace_session ON harness_traces(session_id);
      `);
    },
  },
  {
    version: 10,
    name: 'ai tasks: lightweight task templates and prepared runs',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          inputs TEXT NOT NULL DEFAULT '[]',
          steps TEXT NOT NULL DEFAULT '[]',
          run_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ai_tasks_updated_at ON ai_tasks(updated_at);

        CREATE TABLE IF NOT EXISTS ai_task_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          task_name TEXT,
          input_values TEXT NOT NULL DEFAULT '{}',
          prepared_prompt TEXT,
          status TEXT NOT NULL DEFAULT 'prepared',
          summary TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_ai_task_runs_task_id ON ai_task_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_ai_task_runs_created_at ON ai_task_runs(created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_task_runs_status ON ai_task_runs(status);
      `);
    },
  },
  {
    version: 11,
    name: 'ai tasks: authoring evidence side records',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_task_authoring_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          session_id TEXT,
          agent_run_id TEXT,
          mode TEXT,
          verified INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          validated_scope TEXT NOT NULL DEFAULT '[]',
          actions TEXT NOT NULL DEFAULT '[]',
          verification TEXT NOT NULL DEFAULT '[]',
          limitations TEXT NOT NULL DEFAULT '[]',
          cleanup TEXT NOT NULL DEFAULT '{}',
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ai_task_authoring_evidence_task_id ON ai_task_authoring_evidence(task_id);
        CREATE INDEX IF NOT EXISTS idx_ai_task_authoring_evidence_agent_run_id ON ai_task_authoring_evidence(agent_run_id);
        CREATE INDEX IF NOT EXISTS idx_ai_task_authoring_evidence_created_at ON ai_task_authoring_evidence(created_at);
      `);
    },
  },
  {
    version: 12,
    name: 'ide sessions: persisted agent conversations',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ide_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          entry TEXT NOT NULL DEFAULT 'core',
          host_id TEXT,
          model_label TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          messages_json TEXT NOT NULL DEFAULT '[]',
          preview TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ide_sessions_updated_at ON ide_sessions(updated_at);
      `);
    },
  },
  {
    version: 13,
    name: 'host preferences: repository order',
    up(db) {
      if (!columnExists(db, 'host_preferences', 'repository_order')) {
        db.exec('ALTER TABLE host_preferences ADD COLUMN repository_order INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_host_preferences_repository_order
          ON host_preferences(repository_order);
      `);
    },
  },
  {
    version: 14,
    name: 'ide sessions: workspace host scope',
    up(db) {
      if (!columnExists(db, 'ide_sessions', 'workspace_hosts_json')) {
        db.exec("ALTER TABLE ide_sessions ADD COLUMN workspace_hosts_json TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 15,
    name: 'ide sessions: protocol agent binding',
    up(db) {
      // (agent_id, cwd, native_session_id) 三元组：协议 agent 会话与原生会话的
      // 绑定关系，服务重启后据此 --resume / session/load 恢复。
      if (!columnExists(db, 'ide_sessions', 'agent_id')) {
        db.exec("ALTER TABLE ide_sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'oneshell'");
      }
      if (!columnExists(db, 'ide_sessions', 'cwd')) {
        db.exec('ALTER TABLE ide_sessions ADD COLUMN cwd TEXT');
      }
      if (!columnExists(db, 'ide_sessions', 'native_session_id')) {
        db.exec('ALTER TABLE ide_sessions ADD COLUMN native_session_id TEXT');
      }
    },
  },
  {
    version: 16,
    name: 'ide sessions: touched files',
    up(db) {
      // 会话涉及的文件列表（tool 事件 locations 聚合），IDE 壳的文件↔会话关联。
      if (!columnExists(db, 'ide_sessions', 'files_json')) {
        db.exec("ALTER TABLE ide_sessions ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 17,
    name: 'ide sessions: multi-agent bindings & settings',
    up(db) {
      // agent_bindings_json：agentId → { nativeSessionId, ctxSeq }。一个会话可
      // 在多个协议 agent 之间切换，各自的原生会话与已见上下文水位在此登记。
      if (!columnExists(db, 'ide_sessions', 'agent_bindings_json')) {
        db.exec("ALTER TABLE ide_sessions ADD COLUMN agent_bindings_json TEXT NOT NULL DEFAULT '{}'");
      }
      // agent_settings_json：{ approvalMode, effort, fast } 等协议会话运行设置。
      if (!columnExists(db, 'ide_sessions', 'agent_settings_json')) {
        db.exec("ALTER TABLE ide_sessions ADD COLUMN agent_settings_json TEXT NOT NULL DEFAULT '{}'");
      }
    },
  },
];

function runMigrations(db, { logger } = {}) {
  if (!db) return { applied: [], skipped: [], failed: [] };

  ensureMigrationTable(db);
  const applied = getAppliedVersions(db);
  const result = { applied: [], skipped: [], failed: [] };

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (applied.has(migration.version)) {
      result.skipped.push(migration.version);
      continue;
    }

    const tx = db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.name, 'success');
    });

    try {
      tx();
      result.applied.push(migration.version);
      logger?.info?.(`[DB migration] applied v${migration.version} ${migration.name}`);
    } catch (error) {
      try { recordMigration(db, migration.version, migration.name, 'failed'); } catch { /* ignore */ }
      result.failed.push({ version: migration.version, error: error.message });
      logger?.error?.(`[DB migration] failed v${migration.version} ${migration.name}: ${error.message}`);
      throw error;
    }
  }

  return result;
}

module.exports = {
  runMigrations,
  migrations,
};
