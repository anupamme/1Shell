'use strict';

// 4H4G 服务器长会话卡死排查后的回归测试：内存回收机制四件套。
// 1) AgentRun state 到期清理 + 存量上限（runtime.js）
// 2) 1Shell AI 会话 idle 回收（createSessionIdleKeeper）
// 3) rewind 快照内存预算（applyRewindSnapshotBudget）
// 4) tool_result 入库截断（compactToolResultForModel）

const assert = require('assert');

const { createAgentRuntime } = require('../src/agent-runtime');
const { createMemoryAgentStore } = require('../src/agent-runtime/store');
const { __private } = require('../src/ide/ide.service');

const {
  applyRewindSnapshotBudget,
  compactToolResultForModel,
  createSessionIdleKeeper,
  rewindRecordSnapshotBytes,
  TOOL_RESULT_MAX_CHARS,
} = __private;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testRunGcAfterEnd() {
  const store = createMemoryAgentStore();
  const runtime = createAgentRuntime({ store, runRetentionMs: 30, maxRetainedRuns: 100, logger: null });

  runtime.startRun({ goal: 'g1' }, { runId: 'r1' });
  assert.ok(store.getRun('r1'), 'run state should exist while running');
  runtime.endRun('r1', { runnerStatus: 'completed' });

  runtime.startRun({ goal: 'g2' }, { runId: 'r2' });
  runtime.cancelRun('r2', { reason: 'test' });

  await sleep(90);
  assert.strictEqual(store.getRun('r1'), null, 'ended run must be GC-ed after retention window');
  assert.strictEqual(store.getRun('r2'), null, 'cancelled run must be GC-ed after retention window');
}

async function testRunGcKeepsRunningRun() {
  const store = createMemoryAgentStore();
  const runtime = createAgentRuntime({ store, runRetentionMs: 30, maxRetainedRuns: 100, logger: null });

  runtime.startRun({ goal: 'keep' }, { runId: 'live-1' });
  runtime.startRun({ goal: 'next' }, { runId: 'live-2' });

  await sleep(90);
  assert.ok(store.getRun('live-1'), 'running run must survive GC window');
  assert.ok(store.getRun('live-2'), 'running run must survive GC window');
}

async function testRunGcCapEvictsOldestEnded() {
  const store = createMemoryAgentStore();
  const runtime = createAgentRuntime({ store, runRetentionMs: 60_000, maxRetainedRuns: 2, logger: null });

  for (const runId of ['cap-1', 'cap-2', 'cap-3']) {
    runtime.startRun({ goal: `g-${runId}` }, { runId });
    runtime.endRun(runId, { runnerStatus: 'completed' });
  }
  runtime.startRun({ goal: 'g-live' }, { runId: 'cap-live' });

  const remaining = store.listRuns().map((state) => state.runId).sort();
  assert.strictEqual(remaining.length, 2, `ended-run overflow must be evicted to the cap (got ${remaining.join(',')})`);
  assert.ok(remaining.includes('cap-live'), 'newest run must survive cap eviction');
  assert.ok(remaining.includes('cap-3'), 'newest ended run must survive cap eviction');
  assert.strictEqual(store.getRun('cap-1'), null, 'oldest ended run must be evicted');
  assert.strictEqual(store.getRun('cap-2'), null, 'second-oldest ended run must be evicted');
}

async function testSessionIdleKeeperEvictsIdleSession() {
  const sessions = new Map();
  const evicted = [];
  const keeper = createSessionIdleKeeper({
    sessions,
    timeoutMs: 25,
    onEvict: (session) => {
      evicted.push(session.sessionId);
      sessions.delete(session.sessionId);
    },
  });

  const session = { sessionId: 's-idle', currentRunId: null, cancelled: false };
  sessions.set('s-idle', session);
  keeper.touch(session);

  await sleep(70);
  assert.ok(evicted.includes('s-idle'), 'idle session must be evicted after timeout');
  assert.strictEqual(sessions.size, 0);
}

async function testSessionIdleKeeperSkipsRunningSession() {
  const sessions = new Map();
  const evicted = [];
  const keeper = createSessionIdleKeeper({
    sessions,
    timeoutMs: 25,
    onEvict: (session) => {
      evicted.push(session.sessionId);
      sessions.delete(session.sessionId);
    },
  });

  const session = { sessionId: 's-running', currentRunId: 'run-1', cancelled: false };
  sessions.set('s-running', session);
  keeper.touch(session);

  await sleep(40);
  assert.strictEqual(evicted.length, 0, 'session with a live run must not be evicted');

  session.currentRunId = null;
  await sleep(60);
  assert.ok(evicted.includes('s-running'), 'session must be evicted once its run finished');
}

async function testSessionIdleKeeperClear() {
  const sessions = new Map();
  const evicted = [];
  const keeper = createSessionIdleKeeper({
    sessions,
    timeoutMs: 25,
    onEvict: (session) => {
      evicted.push(session.sessionId);
      sessions.delete(session.sessionId);
    },
  });

  const session = { sessionId: 's-clear', currentRunId: null, cancelled: false };
  sessions.set('s-clear', session);
  keeper.touch(session);
  keeper.clear(session);
  keeper.clear({ idleTimer: null });

  await sleep(60);
  assert.strictEqual(evicted.length, 0, 'cleared timer must never fire');
}

function testRewindSnapshotBudget() {
  const mb = (n) => 'x'.repeat(n * 1024 * 1024);
  const restoreEntry = (path, bytes) => ({
    id: path,
    toolName: 'write_remote_file',
    record: { type: 'restore_file', hostId: 'local', path, snapshot: { base64Content: bytes } },
  });
  const renameEntry = { id: 'mv', toolName: 'rename_path', record: { type: 'rename_path', hostId: 'local', path: '/b', newPath: '/a' } };

  const entries = [restoreEntry('/a', mb(20)), restoreEntry('/b', mb(10)), renameEntry, restoreEntry('/c', mb(6))];
  const total = applyRewindSnapshotBudget(entries, 25 * 1024 * 1024);

  assert.ok(total <= 25 * 1024 * 1024, 'total snapshot bytes must fall under budget');
  assert.strictEqual(entries.length, 4, 'budget must degrade in place, never drop entries');
  assert.strictEqual(entries[0].record.type, 'unrestorable', 'oldest snapshot must be recycled');
  assert.ok(entries[0].record.note.includes('回收'), 'recycled record must explain why');
  assert.strictEqual(entries[1].record.type, 'restore_file', 'newer snapshots stay restorable while under budget');
  assert.strictEqual(entries[3].record.type, 'restore_file');
  assert.strictEqual(rewindRecordSnapshotBytes(entries[0]), 0);

  const underBudget = [restoreEntry('/small', 'y'.repeat(1024))];
  const before = JSON.stringify(underBudget);
  applyRewindSnapshotBudget(underBudget, 25 * 1024 * 1024);
  assert.strictEqual(JSON.stringify(underBudget), before, 'under-budget records must be untouched');
}

function testToolResultCap() {
  const exact = 'line 1\n' + 'x'.repeat(7000) + '\nline 4';
  assert.strictEqual(compactToolResultForModel('read_remote_file', exact), exact, 'small outputs stay exact for the model');
  assert.strictEqual(compactToolResultForModel('execute_command', 'a'.repeat(TOOL_RESULT_MAX_CHARS)), 'a'.repeat(TOOL_RESULT_MAX_CHARS), 'at-cap output stays exact');

  const huge = 'z'.repeat(TOOL_RESULT_MAX_CHARS + 5000);
  const truncated = compactToolResultForModel('execute_command', huge);
  assert.ok(truncated.length < huge.length, 'oversized output must be truncated');
  assert.ok(truncated.startsWith('z'.repeat(1000)), 'truncation keeps the head');
  assert.ok(truncated.includes('已截断'), 'truncation marker must be present');
  assert.ok(truncated.length <= TOOL_RESULT_MAX_CHARS + 200, 'truncated output must be near the cap');

  const arrayContent = [{ type: 'text', text: 'x' }];
  assert.strictEqual(compactToolResultForModel('t', arrayContent), arrayContent, 'non-string content passes through unchanged');
}

(async () => {
  await testRunGcAfterEnd();
  await testRunGcKeepsRunningRun();
  await testRunGcCapEvictsOldestEnded();
  await testSessionIdleKeeperEvictsIdleSession();
  await testSessionIdleKeeperSkipsRunningSession();
  await testSessionIdleKeeperClear();
  testRewindSnapshotBudget();
  testToolResultCap();
  console.log('agent-memory-reclaim checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
