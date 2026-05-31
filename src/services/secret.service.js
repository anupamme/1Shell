'use strict';

const crypto = require('crypto');
const { encryptText, decryptText } = require('../../lib/crypto');

function createSecretService({ db }) {
  if (!db) return createNoopSecretService();

  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic',
      encrypted_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_secrets_type ON secrets(type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_type_name ON secrets(type, name);
  `);

  const stmtList = db.prepare(`
    SELECT id, name, type, created_at, updated_at
      FROM secrets
     WHERE (? IS NULL OR type = ?)
     ORDER BY type, name
  `);
  const stmtGet = db.prepare('SELECT * FROM secrets WHERE id = ?');
  const stmtUpsert = db.prepare(`
    INSERT INTO secrets (id, name, type, encrypted_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(type, name) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      updated_at = datetime('now')
  `);
  const stmtByName = db.prepare('SELECT id, name, type, created_at, updated_at FROM secrets WHERE type = ? AND name = ?');
  const stmtDelete = db.prepare('DELETE FROM secrets WHERE id = ?');

  function list({ type = null } = {}) {
    const t = normalizeType(type, true);
    return stmtList.all(t, t);
  }

  function save({ name, type = 'generic', value }) {
    const cleanName = normalizeName(name);
    const cleanType = normalizeType(type);
    const cleanValue = String(value || '');
    if (!cleanValue) throw new Error('凭据内容不能为空');
    const encrypted = encryptText(cleanValue);
    const id = `sec_${crypto.randomUUID()}`;
    stmtUpsert.run(id, cleanName, cleanType, JSON.stringify(encrypted));
    return stmtByName.get(cleanType, cleanName);
  }

  function resolve(id) {
    const secretId = String(id || '').trim();
    if (!secretId) throw new Error('secretRef 不能为空');
    const row = stmtGet.get(secretId);
    if (!row) throw new Error('保存的凭据不存在或已删除');
    let encrypted;
    try { encrypted = JSON.parse(row.encrypted_value); } catch { throw new Error('保存的凭据格式损坏'); }
    return decryptText(encrypted);
  }

  function remove(id) {
    const info = stmtDelete.run(String(id || '').trim());
    return info.changes > 0;
  }

  return { list, save, resolve, remove };
}

function normalizeName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('凭据名称不能为空');
  if (value.length > 80) throw new Error('凭据名称不能超过 80 个字符');
  return value;
}

function normalizeType(type, allowNull = false) {
  const value = String(type || '').trim() || (allowNull ? '' : 'generic');
  if (!value && allowNull) return null;
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(value)) throw new Error('凭据类型不合法');
  return value;
}

function createNoopSecretService() {
  return {
    list: () => [],
    save: () => { throw new Error('数据库不可用，无法保存凭据'); },
    resolve: () => { throw new Error('数据库不可用，无法读取凭据'); },
    remove: () => false,
  };
}

module.exports = { createSecretService };
