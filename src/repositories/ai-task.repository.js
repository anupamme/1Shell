'use strict';

const crypto = require('crypto');

function createAiTaskRepository(db) {
  if (!db) {
    return {
      listTasks: () => [],
      findTask: () => null,
      createTask: () => { throw new Error('AI 任务需要 SQLite 支持，当前环境不可用'); },
      updateTask: () => { throw new Error('AI 任务需要 SQLite 支持，当前环境不可用'); },
      deleteTask: () => false,
      createRun: () => { throw new Error('AI 任务需要 SQLite 支持，当前环境不可用'); },
      updateRun: () => null,
      findRun: () => null,
      listRunsByTask: () => ({ runs: [], total: 0 }),
      listAllRuns: () => ({ runs: [], total: 0 }),
    };
  }

  const stmts = {
    selectAllTasks: db.prepare('SELECT * FROM ai_tasks ORDER BY updated_at DESC'),
    selectTask: db.prepare('SELECT * FROM ai_tasks WHERE id = ?'),
    insertTask: db.prepare(`
      INSERT INTO ai_tasks (id, name, description, inputs, steps, run_count, created_at, updated_at)
      VALUES (@id, @name, @description, @inputs, @steps, 0, datetime('now'), datetime('now'))
    `),
    updateTask: db.prepare(`
      UPDATE ai_tasks
      SET name = @name,
          description = @description,
          inputs = @inputs,
          steps = @steps,
          updated_at = datetime('now')
      WHERE id = @id
    `),
    deleteTask: db.prepare('DELETE FROM ai_tasks WHERE id = ?'),
    deleteRunsByTask: db.prepare('DELETE FROM ai_task_runs WHERE task_id = ?'),
    deleteEvidenceByTask: db.prepare('DELETE FROM ai_task_authoring_evidence WHERE task_id = ?'),
    incrementRunCount: db.prepare("UPDATE ai_tasks SET run_count = run_count + 1, updated_at = datetime('now') WHERE id = ?"),
    insertRun: db.prepare(`
      INSERT INTO ai_task_runs (task_id, task_name, input_values, prepared_prompt, status, created_at, updated_at)
      VALUES (@task_id, @task_name, @input_values, @prepared_prompt, @status, datetime('now'), datetime('now'))
    `),
    updateRun: db.prepare(`
      UPDATE ai_task_runs
      SET status = @status,
          summary = @summary,
          updated_at = datetime('now'),
          finished_at = CASE WHEN @finished = 1 THEN datetime('now') ELSE finished_at END
      WHERE id = @id
    `),
    selectRun: db.prepare('SELECT * FROM ai_task_runs WHERE id = ?'),
    selectRunsByTask: db.prepare(`
      SELECT * FROM ai_task_runs
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `),
    countRunsByTask: db.prepare('SELECT COUNT(*) AS total FROM ai_task_runs WHERE task_id = ?'),
    selectAllRuns: db.prepare(`
      SELECT * FROM ai_task_runs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `),
    countAllRuns: db.prepare('SELECT COUNT(*) AS total FROM ai_task_runs'),
  };

  const deleteTaskTx = db.transaction((id) => {
    const info = stmts.deleteTask.run(id);
    if (info.changes > 0) {
      stmts.deleteRunsByTask.run(id);
      stmts.deleteEvidenceByTask.run(id);
    }
    return info.changes > 0;
  });

  const createTaskTx = db.transaction((payload) => {
    const id = payload.id || `task-${crypto.randomBytes(8).toString('hex')}`;
    stmts.insertTask.run({
      id,
      name: payload.name,
      description: payload.description || null,
      inputs: JSON.stringify(payload.inputs || []),
      steps: JSON.stringify(payload.steps || []),
    });
    return id;
  });

  const updateTaskTx = db.transaction((id, payload) => {
    const existing = stmts.selectTask.get(id);
    if (!existing) return false;
    stmts.updateTask.run({
      id,
      name: payload.name,
      description: payload.description || null,
      inputs: JSON.stringify(payload.inputs || []),
      steps: JSON.stringify(payload.steps || []),
    });
    return true;
  });

  const createRunTx = db.transaction((payload) => {
    const info = stmts.insertRun.run({
      task_id: payload.taskId,
      task_name: payload.taskName || null,
      input_values: JSON.stringify(payload.inputValues || {}),
      prepared_prompt: payload.preparedPrompt || null,
      status: payload.status || 'prepared',
    });
    stmts.incrementRunCount.run(payload.taskId);
    return info.lastInsertRowid;
  });

  function rowToTask(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      inputs: safeParseArray(row.inputs),
      steps: safeParseArray(row.steps),
      runCount: row.run_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      taskName: row.task_name || '',
      inputValues: safeParseObject(row.input_values),
      preparedPrompt: row.prepared_prompt || '',
      status: row.status || 'prepared',
      summary: row.summary || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }

  function listTasks({ keyword } = {}) {
    let rows = stmts.selectAllTasks.all();
    const kw = String(keyword || '').trim().toLowerCase();
    if (kw) {
      rows = rows.filter((row) => {
        const hay = `${row.name || ''} ${row.description || ''} ${row.inputs || ''} ${row.steps || ''}`.toLowerCase();
        return hay.includes(kw);
      });
    }
    return rows.map(rowToTask);
  }

  function findTask(id) {
    return rowToTask(stmts.selectTask.get(id));
  }

  function createTask(payload) {
    const id = createTaskTx(payload || {});
    return findTask(id);
  }

  function updateTask(id, payload) {
    const updated = updateTaskTx(id, payload || {});
    return updated ? findTask(id) : null;
  }

  function deleteTask(id) {
    return deleteTaskTx(id);
  }

  function createRun(payload) {
    const id = createRunTx(payload);
    return findRun(id);
  }

  function updateRun(id, { status, summary, finished = false } = {}) {
    stmts.updateRun.run({
      id,
      status: status || 'prepared',
      summary: summary || null,
      finished: finished ? 1 : 0,
    });
    return findRun(id);
  }

  function findRun(id) {
    return rowToRun(stmts.selectRun.get(id));
  }

  function listRunsByTask(taskId, { limit = 20, offset = 0 } = {}) {
    const rows = stmts.selectRunsByTask.all(taskId, Math.min(limit, 100), Math.max(offset, 0));
    const { total } = stmts.countRunsByTask.get(taskId);
    return { runs: rows.map(rowToRun), total };
  }

  function listAllRuns({ limit = 50, offset = 0 } = {}) {
    const rows = stmts.selectAllRuns.all(Math.min(limit, 200), Math.max(offset, 0));
    const { total } = stmts.countAllRuns.get();
    return { runs: rows.map(rowToRun), total };
  }

  return {
    listTasks,
    findTask,
    createTask,
    updateTask,
    deleteTask,
    createRun,
    updateRun,
    findRun,
    listRunsByTask,
    listAllRuns,
  };
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
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = { createAiTaskRepository };
