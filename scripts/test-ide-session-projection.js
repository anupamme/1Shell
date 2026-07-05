'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createIdeService } = require('../src/ide/ide.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const tmpDir = path.join(os.tmpdir(), `1shell-ide-session-projection-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
  const ideService = createIdeService({ ideSessionRepository: repo });

  const beforeTool = [
    'Found two `www.microsoft.com` entries:',
    '- `server_name`',
    '- `handshake.server`',
  ].join('\n');
  const afterTool = 'I will change them to `www.apple.com`, then back up and write.';

  repo.upsertSession({
    id: 'agent-projection',
    title: 'projection',
    entry: 'core',
    hostId: 'vip-hk',
    messages: [
      { role: 'user', content: 'Check sing-box config' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: beforeTool },
          { type: 'tool_use', id: 'toolu_read', name: 'read_remote_file', input: { path: '/etc/sing-box/config.json' }, locations: [{ path: '/etc/sing-box/config.json' }] },
          { type: 'text', text: afterTool },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }] },
    ],
    preview: afterTool,
    files: [{ path: '/etc/sing-box/config.json' }],
  });

  const detail = ideService.getSessionDetail('agent-projection');
  assert.ok(detail, 'session detail should be readable');
  assert.strictEqual(detail.timeline.length, 4, 'timeline should keep user, assistant, tool, assistant order');
  assert.strictEqual(detail.timeline[1].kind, 'assistant');
  assert.strictEqual(detail.timeline[1].text, beforeTool, 'assistant text before tool must preserve newlines and backticks');
  assert.strictEqual(detail.timeline[2].kind, 'tool', 'tool call must stay between text blocks');
  assert.strictEqual(detail.timeline[2].result, 'ok', 'tool_result must fill the matching tool card');
  assert.deepStrictEqual(detail.timeline[2].locations, [{ path: '/etc/sing-box/config.json' }], 'tool_use locations must project onto the tool card');
  assert.strictEqual(detail.timeline[3].kind, 'assistant');
  assert.strictEqual(detail.timeline[3].text, afterTool, 'assistant text after tool must stay after the tool call');
  assert.deepStrictEqual(detail.files, [{ path: '/etc/sing-box/config.json' }], 'session detail must expose touched files');

  // 文件反查会话：命中触碰过该文件的会话，路径分隔符归一化（Windows 反斜杠也能查）
  repo.upsertSession({
    id: 'agent-projection-2',
    title: 'projection 2',
    entry: 'core',
    hostId: '',
    messages: [{ role: 'user', content: 'touch same file' }],
    files: [{ path: '/etc/sing-box/config.json' }, { path: '/tmp/other.txt' }],
  });
  repo.upsertSession({
    id: 'agent-projection-3',
    title: 'projection 3',
    entry: 'core',
    hostId: '',
    messages: [{ role: 'user', content: 'unrelated' }],
    files: [{ path: '/tmp/unrelated.txt' }],
  });

  const hits = repo.findSessionsByFile('/etc/sing-box/config.json').map((s) => s.id).sort();
  assert.deepStrictEqual(hits, ['agent-projection', 'agent-projection-2'], 'findSessionsByFile must return sessions touching the file');
  const hitsBackslash = repo.findSessionsByFile('\\etc\\sing-box\\config.json').map((s) => s.id).sort();
  assert.deepStrictEqual(hitsBackslash, ['agent-projection', 'agent-projection-2'], 'backslash path must normalize to the same key');
  assert.deepStrictEqual(repo.findSessionsByFile('/nope/none.txt'), [], 'unknown file must return empty');
  const serviceHits = ideService.findSessionsByFile('/tmp/other.txt').map((s) => s.id);
  assert.deepStrictEqual(serviceHits, ['agent-projection-2'], 'ideService.findSessionsByFile must delegate to the repository');

  console.log('ide-session-projection checks passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
