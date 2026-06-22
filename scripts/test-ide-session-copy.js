'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createIdeService } = require('../src/ide/ide.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const tmpDir = path.join(os.tmpdir(), `1shell-ide-session-copy-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
  const ideService = createIdeService({ ideSessionRepository: repo });

  repo.upsertSession({
    id: 'agent-original',
    title: '部署检查',
    entry: 'core',
    hostId: 'agfi',
    workspaceHostIds: ['agfi', 'vip'],
    modelLabel: 'deepseek-v4-pro',
    messages: [
      { role: 'user', content: '检查 NodeQuality 进程' },
      { role: 'assistant', content: '正在检查。' },
    ],
    messageCount: 2,
    preview: '正在检查。',
  });

  const copied = ideService.copySessionRecord('agent-original');
  assert.ok(copied, 'copySessionRecord 应返回复制后的 meta');
  assert.notStrictEqual(copied.id, 'agent-original', '复制会话应生成新 id');
  assert.strictEqual(copied.title, '部署检查-copy');
  assert.deepStrictEqual(copied.workspaceHostIds, ['agfi', 'vip']);
  assert.strictEqual(copied.hostId, 'agfi');

  const copiedDetail = ideService.getSessionDetail(copied.id);
  assert.ok(copiedDetail, '复制后的会话应可读取详情');
  assert.strictEqual(copiedDetail.title, '部署检查-copy');
  assert.strictEqual(copiedDetail.messageCount, 2);
  assert.strictEqual(copiedDetail.timeline.length, 2);
  assert.strictEqual(ideService.copySessionRecord('missing-session'), null);

  console.log('✓ ide-session-copy 测试通过');
  console.log('  - 对话复制生成新 id');
  console.log('  - 标题追加 -copy');
  console.log('  - 消息与工作区范围被保留');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
