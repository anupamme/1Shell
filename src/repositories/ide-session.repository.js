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
      SELECT id, title, entry, host_id, workspace_hosts_json, model_label, message_count, preview, created_at, updated_at
      FROM ide_sessions
      ORDER BY updated_at DESC
    `),
    countAll: db.prepare('SELECT COUNT(*) AS total FROM ide_sessions'),
    selectMeta: db.prepare('SELECT id FROM ide_sessions WHERE id = ?'),
    selectFull: db.prepare('SELECT * FROM ide_sessions WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO ide_sessions (id, title, entry, host_id, workspace_hosts_json, model_label, message_count, messages_json, preview, created_at, updated_at)
      VALUES (@id, @title, @entry, @host_id, @workspace_hosts_json, @model_label, @message_count, @messages_json, @preview, datetime('now'), datetime('now'))
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
          updated_at = datetime('now')
      WHERE id = @id
    `),
    rename: db.prepare("UPDATE ide_sessions SET title = @title, updated_at = updated_at WHERE id = @id"),
    delete: db.prepare('DELETE FROM ide_sessions WHERE id = ?'),
  };

  // INSERT sets the (auto-derived) title; UPDATE preserves it so a user rename
  // is never clobbered by the per-turn snapshot.
  const upsertTx = db.transaction((payload) => {
    const row = {
      id: payload.id,
      title: String(payload.title || '').slice(0, 200),
      entry: payload.entry || 'core',
      host_id: payload.hostId || null,
      workspace_hosts_json: JSON.stringify(normalizeWorkspaceHostIds(payload.workspaceHostIds, payload.hostId)),
      model_label: payload.modelLabel || null,
      message_count: Number.isFinite(payload.messageCount) ? payload.messageCount : (Array.isArray(payload.messages) ? payload.messages.length : 0),
      messages_json: JSON.stringify(Array.isArray(payload.messages) ? payload.messages : []),
      preview: String(payload.preview || '').slice(0, 400),
    };
    if (stmts.selectMeta.get(row.id)) stmts.update.run(row);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToFull(row) {
    if (!row) return null;
    return {
      ...rowToMeta(row),
      messages: safeParseArray(row.messages_json),
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

  return { listSessions, getSession, upsertSession, renameSession, deleteSession };
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
    return row ? { ...fileRowToMeta(row), messages: Array.isArray(row.messages) ? row.messages : [] } : null;
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
      entry: payload.entry || existing?.entry || 'core',
      hostId: payload.hostId || existing?.hostId || '',
      workspaceHostIds: normalizeWorkspaceHostIds(payload.workspaceHostIds, payload.hostId || existing?.hostId || ''),
      modelLabel: payload.modelLabel || existing?.modelLabel || '',
      messageCount: Number.isFinite(payload.messageCount)
        ? payload.messageCount
        : (Array.isArray(payload.messages) ? payload.messages.length : (existing?.messageCount || 0)),
      messages: Array.isArray(payload.messages) ? payload.messages : (existing?.messages || []),
      preview: String(payload.preview || existing?.preview || '').slice(0, 400),
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

  return { listSessions, getSession, upsertSession, renameSession, deleteSession };
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

module.exports = { createIdeSessionRepository };
