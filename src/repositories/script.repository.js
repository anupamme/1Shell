'use strict';

/**
 * Script Repository
 *
 * 脚本库的存储层，SQLite。只存脚本本身：id / name / description / tags / content。
 * 参数不入库——`placeholders` 是从 content 扫描出来的派生字段（见 lib/script-placeholders）。
 * 执行历史表在 4.7.6 一并退役，这里不再有 run 相关接口。
 *
 * 如果 db 不可用（better-sqlite3 编译不出且 node:sqlite 不可用），返回一个
 * "只读空库"的 stub，让上层 service/route 正常响应但不实际存储。
 */

const crypto = require('crypto');
const { extractPlaceholders } = require('../../lib/script-placeholders');

function createScriptRepository(db) {
  // ─── 无 db 时的 stub（避免 host 上没装 better-sqlite3 时整站崩溃）──────
  if (!db) {
    const unavailable = () => { throw new Error('脚本库需要 SQLite 支持，当前环境不可用'); };
    return {
      listScripts: () => [],
      findScript: () => null,
      createScript: unavailable,
      updateScript: unavailable,
      deleteScript: () => false,
    };
  }

  // ─── 预编译语句 ───────────────────────────────────────────────────────
  const stmts = {
    selectAll: db.prepare('SELECT * FROM scripts ORDER BY updated_at DESC'),
    selectOne: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    insertScript: db.prepare(`
      INSERT INTO scripts (id, name, description, tags, content, created_at, updated_at)
      VALUES (@id, @name, @description, @tags, @content, datetime('now'), datetime('now'))
    `),
    updateScript: db.prepare(`
      UPDATE scripts
      SET name = @name,
          description = @description,
          tags = @tags,
          content = @content,
          updated_at = datetime('now')
      WHERE id = @id
    `),
    deleteScript: db.prepare('DELETE FROM scripts WHERE id = ?'),
  };

  // ─── 内部工具：row → 对外对象 ─────────────────────────────────────────
  function rowToScript(row) {
    if (!row) return null;
    const content = row.content || '';
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      tags: safeParseArray(row.tags),
      content,
      placeholders: extractPlaceholders(content),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function safeParseArray(s) {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  // ─── 对外接口 ────────────────────────────────────────────────────────
  function listScripts({ keyword } = {}) {
    let rows = stmts.selectAll.all();

    if (keyword) {
      const kw = String(keyword).trim().toLowerCase();
      if (kw) {
        rows = rows.filter((row) => {
          const name = (row.name || '').toLowerCase();
          const desc = (row.description || '').toLowerCase();
          const tags = (row.tags || '').toLowerCase();
          return name.includes(kw) || desc.includes(kw) || tags.includes(kw);
        });
      }
    }

    return rows.map(rowToScript);
  }

  function findScript(id) {
    return rowToScript(stmts.selectOne.get(id));
  }

  function createScript(payload) {
    const id = payload.id || `script-${crypto.randomBytes(8).toString('hex')}`;
    stmts.insertScript.run({
      id,
      name: payload.name,
      description: payload.description || null,
      tags: JSON.stringify(payload.tags || []),
      content: payload.content,
    });
    return findScript(id);
  }

  function updateScript(id, payload) {
    const existing = stmts.selectOne.get(id);
    if (!existing) return null;
    stmts.updateScript.run({
      id,
      name: payload.name,
      description: payload.description || null,
      tags: JSON.stringify(payload.tags || []),
      content: payload.content,
    });
    return findScript(id);
  }

  function deleteScript(id) {
    const info = stmts.deleteScript.run(id);
    return info.changes > 0;
  }

  return {
    listScripts,
    findScript,
    createScript,
    updateScript,
    deleteScript,
  };
}

module.exports = { createScriptRepository };
