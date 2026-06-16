'use strict';

// Persisted 1Shell Agent conversations (the /agent session history rail).
// One row per session; the model conversation is snapshotted as a JSON blob
// each time a run completes, because the in-memory messages array is compacted
// and sanitized in place during a run (see ide.service.js), so appending rows
// per message would not match how the conversation actually mutates.

function createIdeSessionRepository(db) {
  if (!db) {
    return {
      listSessions: () => ({ sessions: [], total: 0 }),
      getSession: () => null,
      upsertSession: () => null,
      renameSession: () => false,
      deleteSession: () => false,
    };
  }

  const stmts = {
    selectMetaList: db.prepare(`
      SELECT id, title, entry, host_id, model_label, message_count, preview, created_at, updated_at
      FROM ide_sessions
      ORDER BY updated_at DESC
    `),
    countAll: db.prepare('SELECT COUNT(*) AS total FROM ide_sessions'),
    selectMeta: db.prepare('SELECT id FROM ide_sessions WHERE id = ?'),
    selectFull: db.prepare('SELECT * FROM ide_sessions WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO ide_sessions (id, title, entry, host_id, model_label, message_count, messages_json, preview, created_at, updated_at)
      VALUES (@id, @title, @entry, @host_id, @model_label, @message_count, @messages_json, @preview, datetime('now'), datetime('now'))
    `),
    update: db.prepare(`
      UPDATE ide_sessions
      SET entry = @entry,
          host_id = @host_id,
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

module.exports = { createIdeSessionRepository };
