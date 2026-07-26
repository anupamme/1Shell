'use strict';

const fs = require('fs');
const path = require('path');

// Persisted 1Shell Agent conversations (the /agent session history rail).
// One row per session; the model conversation is snapshotted as a JSON blob
// each time a run completes, because the in-memory messages array is compacted
// and sanitized in place during a run (see ide.service.js), so appending rows
// per message would not match how the conversation actually mutates.

function createIdeSessionRepository(db, { dataDir } = {}) {
  if (!db) {
    return createFileIdeSessionRepository(dataDir);
  }

  const stmts = {
    selectMetaList: db.prepare(`
      SELECT id, title, entry, host_id, workspace_hosts_json, model_label, message_count, preview, agent_id, cwd, native_session_id, created_at, updated_at
      FROM ide_sessions
      ORDER BY updated_at DESC
    `),
    countAll: db.prepare('SELECT COUNT(*) AS total FROM ide_sessions'),
    selectMeta: db.prepare('SELECT id, entry, host_id, model_label, agent_id, cwd, native_session_id, files_json, agent_bindings_json, agent_settings_json FROM ide_sessions WHERE id = ?'),
    selectFull: db.prepare('SELECT * FROM ide_sessions WHERE id = ?'),
    selectWithFiles: db.prepare(`
      SELECT id, title, entry, host_id, workspace_hosts_json, model_label, message_count, preview, agent_id, cwd, native_session_id, created_at, updated_at, files_json
      FROM ide_sessions
      WHERE files_json != '[]'
      ORDER BY updated_at DESC
    `),
    insert: db.prepare(`
      INSERT INTO ide_sessions (id, title, entry, host_id, workspace_hosts_json, model_label, message_count, messages_json, preview, agent_id, cwd, native_session_id, files_json, agent_bindings_json, agent_settings_json, created_at, updated_at)
      VALUES (@id, @title, @entry, @host_id, @workspace_hosts_json, @model_label, @message_count, @messages_json, @preview, @agent_id, @cwd, @native_session_id, @files_json, @agent_bindings_json, @agent_settings_json, datetime('now'), datetime('now'))
    `),
    update: db.prepare(`
      UPDATE ide_sessions
      SET entry = @entry,
          host_id = @host_id,
          workspace_hosts_json = @workspace_hosts_json,
          model_label = @model_label,
          message_count = @message_count,
          messages_json = @messages_json,
          preview = @preview,
          agent_id = @agent_id,
          cwd = @cwd,
          native_session_id = @native_session_id,
          files_json = @files_json,
          agent_bindings_json = @agent_bindings_json,
          agent_settings_json = @agent_settings_json,
          updated_at = datetime('now')
      WHERE id = @id
    `),
    rename: db.prepare("UPDATE ide_sessions SET title = @title, updated_at = updated_at WHERE id = @id"),
    delete: db.prepare('DELETE FROM ide_sessions WHERE id = ?'),
    detachHosts: db.prepare('UPDATE ide_sessions SET host_id = @host_id, workspace_hosts_json = @workspace_hosts_json, updated_at = updated_at WHERE id = @id'),
  };

  // INSERT sets the (auto-derived) title; UPDATE preserves it so a user rename
  // is never clobbered by the per-turn snapshot.
  // entry/host_id/model_label/agent_id/cwd/native_session_id 及 json 附件字段
  // 均按「payload 未携带（undefined）→ 保留既有行」的语义回退，双向 agent
  // 切换时两侧服务只写各自知道的字段，互不洗掉对方的。
  const upsertTx = db.transaction((payload) => {
    const existing = stmts.selectMeta.get(payload.id) || null;
    const row = {
      id: payload.id,
      title: String(payload.title || '').slice(0, 200),
      entry: payload.entry !== undefined ? (payload.entry || 'core') : (existing?.entry || 'core'),
      host_id: payload.hostId !== undefined ? (payload.hostId || null) : (existing?.host_id || null),
      workspace_hosts_json: JSON.stringify(normalizeWorkspaceHostIds(payload.workspaceHostIds, payload.hostId)),
      model_label: payload.modelLabel !== undefined ? (payload.modelLabel || null) : (existing?.model_label || null),
      message_count: Number.isFinite(payload.messageCount) ? payload.messageCount : (Array.isArray(payload.messages) ? payload.messages.length : 0),
      messages_json: JSON.stringify(Array.isArray(payload.messages) ? payload.messages : []),
      preview: String(payload.preview || '').slice(0, 400),
      agent_id: payload.agentId !== undefined ? String(payload.agentId || 'oneshell') : (existing?.agent_id || 'oneshell'),
      cwd: payload.cwd !== undefined ? (payload.cwd || null) : (existing?.cwd || null),
      native_session_id: payload.nativeSessionId !== undefined ? (payload.nativeSessionId || null) : (existing?.native_session_id || null),
      files_json: payload.files !== undefined
        ? JSON.stringify(Array.isArray(payload.files) ? payload.files : [])
        : (existing?.files_json || '[]'),
      agent_bindings_json: payload.agentBindings !== undefined
        ? JSON.stringify(payload.agentBindings && typeof payload.agentBindings === 'object' ? payload.agentBindings : {})
        : (existing?.agent_bindings_json || '{}'),
      agent_settings_json: payload.agentSettings !== undefined
        ? JSON.stringify(payload.agentSettings && typeof payload.agentSettings === 'object' ? payload.agentSettings : {})
        : (existing?.agent_settings_json || '{}'),
    };
    if (existing) stmts.update.run(row);
    else stmts.insert.run(row);
  });

  function rowToMeta(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title || '',
      entry: row.entry || 'core',
      hostId: row.host_id || '',
      workspaceHostIds: normalizeWorkspaceHostIds(safeParseArray(row.workspace_hosts_json), row.host_id || ''),
      modelLabel: row.model_label || '',
      messageCount: row.message_count || 0,
      preview: row.preview || '',
      agentId: row.agent_id || 'oneshell',
      cwd: row.cwd || '',
      nativeSessionId: row.native_session_id || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToFull(row) {
    if (!row) return null;
    return {
      ...rowToMeta(row),
      messages: safeParseArray(row.messages_json),
      files: safeParseArray(row.files_json),
      agentBindings: safeParseObject(row.agent_bindings_json),
      agentSettings: safeParseObject(row.agent_settings_json),
    };
  }

  function listSessions({ keyword, limit = 200, offset = 0 } = {}) {
    let rows = stmts.selectMetaList.all();
    const kw = String(keyword || '').trim().toLowerCase();
    if (kw) rows = rows.filter((row) => `${row.title || ''} ${row.preview || ''}`.toLowerCase().includes(kw));
    const total = rows.length;
    const start = Math.max(offset, 0);
    const sliced = rows.slice(start, start + Math.min(Math.max(limit, 1), 500));
    return { sessions: sliced.map(rowToMeta), total };
  }

  function getSession(id) {
    return rowToFull(stmts.selectFull.get(id));
  }

  function upsertSession(payload) {
    if (!payload?.id) return null;
    upsertTx(payload);
    return getSession(payload.id);
  }

  function renameSession(id, title) {
    const info = stmts.rename.run({ id, title: String(title || '').slice(0, 200) });
    return info.changes > 0;
  }

  function deleteSession(id) {
    return stmts.delete.run(id).changes > 0;
  }

  // 文件反查会话（IDE 壳）：哪些会话触碰过该文件。LIKE 对 Windows 反斜杠路径
  // 转义太脆，改为粗筛非空 files_json 后在 JS 里精确匹配（会话量有上限，可承受）。
  function findSessionsByFile(filePath) {
    const target = normalizeFilePathKey(filePath);
    if (!target) return [];
    return stmts.selectWithFiles.all()
      .filter((row) => safeParseArray(row.files_json).some((f) => normalizeFilePathKey(f?.path) === target))
      .map(rowToMeta);
  }

  // 主机删除联动（4.7.5）：把无效主机从每条会话的绑定里剔除。
  // - oneshell 会话绑定被剔空 → 整条删除（对话随主机一起消失）
  // - 协议 agent 会话跑在本机，只解绑不删除
  // - 多主机工作区剔除后仍有绑定 → 只改绑定列，消息原样保留（不能走 upsert，会清空 messages_json）
  function pruneHostBindings(isValidHostId) {
    const deletedIds = [];
    let updated = 0;
    for (const row of stmts.selectMetaList.all()) {
      const ids = normalizeWorkspaceHostIds(safeParseArray(row.workspace_hosts_json), row.host_id || '');
      if (!ids.length) continue;
      const remaining = ids.filter((id) => isValidHostId(id));
      if (remaining.length === ids.length) continue;
      const isProtocol = Boolean(row.agent_id && row.agent_id !== 'oneshell');
      if (!remaining.length && !isProtocol) {
        stmts.delete.run(row.id);
        deletedIds.push(row.id);
        continue;
      }
      stmts.detachHosts.run({
        id: row.id,
        host_id: remaining.includes(row.host_id) ? row.host_id : (remaining[0] || null),
        workspace_hosts_json: JSON.stringify(remaining),
      });
      updated += 1;
    }
    return { deletedIds, updated };
  }

  return { listSessions, getSession, upsertSession, renameSession, deleteSession, findSessionsByFile, pruneHostBindings };
}

function safeParseArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// 路径比较键：统一分隔符（同机工具产出的同一文件，斜杠风格可能不一致）
function normalizeFilePathKey(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
}

function normalizeWorkspaceHostIds(value, fallbackHostId = '') {
  const list = Array.isArray(value) ? value : [];
  const ids = [...new Set(list
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== 'all' && item !== '*'))];
  if (ids.length > 0) return ids;
  const fallback = String(fallbackHostId || '').trim();
  return fallback && fallback !== 'all' ? [fallback] : [];
}

function createFileIdeSessionRepository(dataDir) {
  const root = dataDir ? path.resolve(dataDir) : path.join(process.cwd(), 'data');
  const filePath = path.join(root, 'ide-sessions.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const rows = Array.isArray(parsed?.sessions) ? parsed.sessions : (Array.isArray(parsed) ? parsed : []);
      cache = rows.map(normalizeFileRow).filter((row) => row.id);
    } catch {
      cache = [];
    }
    return cache;
  }

  function save(rows = load()) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions: rows }, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function listSessions({ keyword, limit = 200, offset = 0 } = {}) {
    let rows = load().slice().sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
    const kw = String(keyword || '').trim().toLowerCase();
    if (kw) rows = rows.filter((row) => `${row.title || ''} ${row.preview || ''}`.toLowerCase().includes(kw));
    const total = rows.length;
    const start = Math.max(offset, 0);
    const end = start + Math.min(Math.max(limit, 1), 500);
    return { sessions: rows.slice(start, end).map(fileRowToMeta), total };
  }

  function getSession(id) {
    const row = load().find((item) => item.id === id);
    return row
      ? {
          ...fileRowToMeta(row),
          messages: Array.isArray(row.messages) ? row.messages : [],
          files: Array.isArray(row.files) ? row.files : [],
          agentBindings: safeParseObject(row.agentBindings),
          agentSettings: safeParseObject(row.agentSettings),
        }
      : null;
  }

  function upsertSession(payload) {
    if (!payload?.id) return null;
    const rows = load();
    const now = new Date().toISOString();
    const index = rows.findIndex((item) => item.id === payload.id);
    const existing = index >= 0 ? rows[index] : null;
    const row = normalizeFileRow({
      id: payload.id,
      title: existing?.title || String(payload.title || '').slice(0, 200),
      entry: payload.entry !== undefined ? (payload.entry || 'core') : (existing?.entry || 'core'),
      hostId: payload.hostId !== undefined ? String(payload.hostId || '') : (existing?.hostId || ''),
      workspaceHostIds: normalizeWorkspaceHostIds(payload.workspaceHostIds, payload.hostId || existing?.hostId || ''),
      modelLabel: payload.modelLabel !== undefined ? String(payload.modelLabel || '') : (existing?.modelLabel || ''),
      messageCount: Number.isFinite(payload.messageCount)
        ? payload.messageCount
        : (Array.isArray(payload.messages) ? payload.messages.length : (existing?.messageCount || 0)),
      messages: Array.isArray(payload.messages) ? payload.messages : (existing?.messages || []),
      preview: String(payload.preview || existing?.preview || '').slice(0, 400),
      agentId: payload.agentId !== undefined ? String(payload.agentId || 'oneshell') : (existing?.agentId || 'oneshell'),
      cwd: payload.cwd !== undefined ? String(payload.cwd || '') : (existing?.cwd || ''),
      nativeSessionId: payload.nativeSessionId !== undefined ? String(payload.nativeSessionId || '') : (existing?.nativeSessionId || ''),
      files: payload.files !== undefined
        ? (Array.isArray(payload.files) ? payload.files : [])
        : (existing?.files || []),
      agentBindings: payload.agentBindings !== undefined
        ? safeParseObject(payload.agentBindings)
        : safeParseObject(existing?.agentBindings),
      agentSettings: payload.agentSettings !== undefined
        ? safeParseObject(payload.agentSettings)
        : safeParseObject(existing?.agentSettings),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    save(rows);
    return getSession(payload.id);
  }

  function renameSession(id, title) {
    const rows = load();
    const row = rows.find((item) => item.id === id);
    if (!row) return false;
    row.title = String(title || '').slice(0, 200);
    save(rows);
    return true;
  }

  function deleteSession(id) {
    const rows = load();
    const next = rows.filter((item) => item.id !== id);
    if (next.length === rows.length) return false;
    cache = next;
    save(cache);
    return true;
  }

  function findSessionsByFile(filePath) {
    const target = normalizeFilePathKey(filePath);
    if (!target) return [];
    return load()
      .filter((row) => Array.isArray(row.files) && row.files.some((f) => normalizeFilePathKey(f?.path) === target))
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
      .map(fileRowToMeta);
  }

  // 与 SQLite 版 pruneHostBindings 语义一致（见上方注释）
  function pruneHostBindings(isValidHostId) {
    const rows = load();
    const deletedIds = [];
    let updated = 0;
    const kept = [];
    for (const row of rows) {
      const ids = normalizeWorkspaceHostIds(row.workspaceHostIds, row.hostId || '');
      if (!ids.length) { kept.push(row); continue; }
      const remaining = ids.filter((id) => isValidHostId(id));
      if (remaining.length === ids.length) { kept.push(row); continue; }
      const isProtocol = Boolean(row.agentId && row.agentId !== 'oneshell');
      if (!remaining.length && !isProtocol) {
        deletedIds.push(row.id);
        continue;
      }
      row.workspaceHostIds = remaining;
      row.hostId = remaining.includes(row.hostId) ? row.hostId : (remaining[0] || '');
      kept.push(row);
      updated += 1;
    }
    if (deletedIds.length || updated) {
      cache = kept;
      save(cache);
    }
    return { deletedIds, updated };
  }

  return { listSessions, getSession, upsertSession, renameSession, deleteSession, findSessionsByFile, pruneHostBindings };
}

function normalizeFileRow(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const messages = Array.isArray(row.messages) ? row.messages : safeParseArray(row.messages_json);
  return {
    id: String(row.id || '').trim(),
    title: String(row.title || '').slice(0, 200),
    entry: String(row.entry || 'core'),
    hostId: String(row.hostId || row.host_id || ''),
    workspaceHostIds: normalizeWorkspaceHostIds(row.workspaceHostIds || row.workspace_host_ids || safeParseArray(row.workspace_hosts_json), row.hostId || row.host_id || ''),
    modelLabel: String(row.modelLabel || row.model_label || ''),
    messageCount: Number.isFinite(Number(row.messageCount ?? row.message_count))
      ? Number(row.messageCount ?? row.message_count)
      : messages.length,
    messages,
    preview: String(row.preview || '').slice(0, 400),
    agentId: String(row.agentId || row.agent_id || 'oneshell'),
    cwd: String(row.cwd || ''),
    nativeSessionId: String(row.nativeSessionId || row.native_session_id || ''),
    files: Array.isArray(row.files) ? row.files : safeParseArray(row.files_json),
    agentBindings: safeParseObject(row.agentBindings ?? row.agent_bindings_json),
    agentSettings: safeParseObject(row.agentSettings ?? row.agent_settings_json),
    createdAt: String(row.createdAt || row.created_at || row.updatedAt || row.updated_at || new Date().toISOString()),
    updatedAt: String(row.updatedAt || row.updated_at || row.createdAt || row.created_at || new Date().toISOString()),
  };
}

function fileRowToMeta(row) {
  return {
    id: row.id,
    title: row.title || '',
    entry: row.entry || 'core',
    hostId: row.hostId || '',
    workspaceHostIds: normalizeWorkspaceHostIds(row.workspaceHostIds, row.hostId || ''),
    modelLabel: row.modelLabel || '',
    messageCount: row.messageCount || 0,
    preview: row.preview || '',
    agentId: row.agentId || 'oneshell',
    cwd: row.cwd || '',
    nativeSessionId: row.nativeSessionId || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

module.exports = { createIdeSessionRepository };
