'use strict';

const { runMigrations } = require('./migrations');

let BetterSqlite3;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch {
  BetterSqlite3 = null;
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]) || 0;
}

function loadNodeSqlite() {
  if (nodeMajor() < 22) return null;
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

function createNodeSqliteAdapter(dbPath) {
  const sqlite = loadNodeSqlite();
  if (!sqlite?.DatabaseSync) return null;

  const native = new sqlite.DatabaseSync(dbPath);
  let txDepth = 0;
  let txSeq = 0;

  const db = {
    source: 'node:sqlite',
    prepare(sql) {
      const stmt = native.prepare(sql);
      try { stmt.setAllowBareNamedParameters?.(true); } catch { /* ignore */ }
      try { stmt.setAllowUnknownNamedParameters?.(true); } catch { /* ignore */ }
      return stmt;
    },
    exec(sql) {
      return native.exec(sql);
    },
    pragma(sql) {
      const text = String(sql || '').trim();
      if (!text) return undefined;
      return native.exec(/^pragma\b/i.test(text) ? text : `PRAGMA ${text}`);
    },
    transaction(fn) {
      return (...args) => {
        const nested = txDepth > 0;
        const savepoint = `oneshell_tx_${++txSeq}`;
        if (nested) native.exec(`SAVEPOINT ${savepoint}`);
        else native.exec('BEGIN');
        txDepth += 1;
        try {
          const result = fn(...args);
          txDepth -= 1;
          if (nested) native.exec(`RELEASE ${savepoint}`);
          else native.exec('COMMIT');
          return result;
        } catch (err) {
          txDepth -= 1;
          try {
            if (nested) {
              native.exec(`ROLLBACK TO ${savepoint}`);
              native.exec(`RELEASE ${savepoint}`);
            } else {
              native.exec('ROLLBACK');
            }
          } catch {
            // Preserve the original transaction error.
          }
          throw err;
        }
      };
    },
    close() {
      return native.close();
    },
  };

  return db;
}

function createBetterSqliteDatabase(dbPath) {
  if (!BetterSqlite3) return null;
  const db = new BetterSqlite3(dbPath, { fileMustExist: false });
  db.source = 'better-sqlite3';
  return db;
}

function configureDatabase(db, { logger } = {}) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, { logger });
  return db;
}

function createDatabase(dbPath, { logger } = {}) {
  const preferBuiltin = nodeMajor() >= 22;
  const attempts = preferBuiltin
    ? [createNodeSqliteAdapter, createBetterSqliteDatabase]
    : [createBetterSqliteDatabase, createNodeSqliteAdapter];

  for (const create of attempts) {
    try {
      const db = create(dbPath);
      if (db) return configureDatabase(db, { logger });
    } catch (err) {
      logger?.warn?.(`[DB] SQLite driver unavailable via ${create.name}: ${err.message}`);
    }
  }

  console.warn('[DB] SQLite unavailable, falling back to file storage mode');
  return null;
}

module.exports = { createDatabase };
