'use strict';

// 4.7.5 主机删除联动：绑定在已删除主机上的会话要跟着清掉。
// 覆盖 SQLite 与 file 两种 repository 实现 + ideService 包装层：
// - 仅绑定死主机的 oneshell 会话 → 删除
// - 多主机工作区 → 只把死主机剔出绑定，消息不丢
// - 协议 agent 会话（跑在本机）→ 只解绑不删除
// - 全局会话 / 绑定存活主机的会话 → 不动

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');
const { createIdeService } = require('../src/ide/ide.service');

function seed(repo) {
  repo.upsertSession({
    id: 's-solo',
    title: '死主机独占',
    hostId: 'host_dead',
    messages: [{ role: 'user', content: 'hi' }],
    messageCount: 1,
    preview: 'hi',
  });
  repo.upsertSession({
    id: 's-multi',
    title: '多主机工作区',
    hostId: 'host_dead',
    workspaceHostIds: ['host_dead', 'host_alive'],
    messages: [
      { role: 'user', content: '检查两台机器' },
      { role: 'assistant', content: '好的。' },
    ],
    messageCount: 2,
    preview: '好的。',
  });
  repo.upsertSession({
    id: 's-alive',
    title: '存活主机',
    hostId: 'host_alive',
    messages: [{ role: 'user', content: 'ok' }],
    messageCount: 1,
    preview: 'ok',
  });
  repo.upsertSession({ id: 's-global', title: '全局对话', hostId: '', messages: [], messageCount: 0, preview: '' });
  repo.upsertSession({
    id: 's-proto',
    title: '协议 agent 会话',
    hostId: 'host_dead',
    agentId: 'claude-code',
    cwd: 'C:/work/repo',
    messages: [{ role: 'user', content: 'cc' }],
    messageCount: 1,
    preview: 'cc',
  });
}

function verifyPrune(repo, result, label) {
  assert.deepStrictEqual(result.deletedIds, ['s-solo'], `${label}: 仅绑定死主机的 oneshell 会话应删除`);
  assert.strictEqual(result.updated, 2, `${label}: 多主机 + 协议会话应解绑`);

  assert.strictEqual(repo.getSession('s-solo'), null, `${label}: 死主机会话应已删除`);

  const multi = repo.getSession('s-multi');
  assert.ok(multi, `${label}: 多主机会话应保留`);
  assert.deepStrictEqual(multi.workspaceHostIds, ['host_alive'], `${label}: 死主机应被剔出绑定`);
  assert.strictEqual(multi.hostId, 'host_alive', `${label}: 主绑定应切到存活主机`);
  assert.strictEqual(multi.messages.length, 2, `${label}: 解绑不得清空消息`);
  assert.strictEqual(multi.title, '多主机工作区', `${label}: 解绑不得改标题`);

  const proto = repo.getSession('s-proto');
  assert.ok(proto, `${label}: 协议 agent 会话不删除`);
  assert.deepStrictEqual(proto.workspaceHostIds, [], `${label}: 协议会话解除死主机绑定`);
  assert.strictEqual(proto.messages.length, 1, `${label}: 协议会话消息保留`);

  assert.ok(repo.getSession('s-alive'), `${label}: 存活主机会话不受影响`);
  assert.deepStrictEqual(repo.getSession('s-alive').workspaceHostIds, ['host_alive'], `${label}: 存活绑定不变`);
  assert.ok(repo.getSession('s-global'), `${label}: 全局会话不受影响`);

  // 幂等：再跑一遍不应有任何变化
  const again = repo.pruneHostBindings((id) => id !== 'host_dead');
  assert.deepStrictEqual(again, { deletedIds: [], updated: 0 }, `${label}: 重复清理应为空操作`);
}

// ── file 模式（无 SQLite 时的回退实现），走 ideService.removeSessionsForHost ──
const tmpDir = path.join(os.tmpdir(), `1shell-host-prune-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });
try {
  const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
  seed(repo);
  const ideService = createIdeService({ ideSessionRepository: repo });
  const result = ideService.removeSessionsForHost('host_dead');
  verifyPrune(repo, result, 'file');
  assert.deepStrictEqual(ideService.removeSessionsForHost('local'), { deletedIds: [], updated: 0 }, 'file: 本机 id 拒绝清理');
  assert.deepStrictEqual(ideService.removeSessionsForHost(''), { deletedIds: [], updated: 0 }, 'file: 空 id 拒绝清理');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── SQLite 模式（真实部署路径），直接测 repository + 启动清扫谓词 ──
let db = null;
try {
  const { createDatabase } = require('../src/database/db');
  db = createDatabase(':memory:');
} catch {
  db = null;
}
if (db) {
  const repo = createIdeSessionRepository(db, {});
  seed(repo);
  const result = repo.pruneHostBindings((id) => id !== 'host_dead');
  verifyPrune(repo, result, 'sqlite');

  // 启动清扫谓词形态：validHostIds 集合
  const repo2 = createIdeSessionRepository(db, {});
  repo2.upsertSession({ id: 's-orphan2', title: '孤儿', hostId: 'host_gone', messages: [], messageCount: 0, preview: '' });
  const validIds = new Set(['local', 'host_alive']);
  const sweep = repo2.pruneHostBindings((id) => validIds.has(id));
  assert.ok(sweep.deletedIds.includes('s-orphan2'), 'sqlite: 启动清扫应删除孤儿会话');
  db.close?.();
} else {
  console.log('  (sqlite 不可用，跳过 sqlite 分支)');
}

console.log('✓ ide-session-host-prune 测试通过');
console.log('  - 死主机独占会话随主机删除');
console.log('  - 多主机工作区只解绑、消息保留');
console.log('  - 协议 agent 会话不删除');
