'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { __private } = require('../src/ide/ide.service');

const {
  compactToolResultForModel,
  streamAnthropicSSE,
} = __private;

async function testSplitUtf8Sse() {
  const text = '找到准确内容: `handshake.server`，引号 ‘ 和 www.apple.com 必须不变。';
  const events = [
    { type: 'message_start', message: { model: 'test-model', usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map((event) => `data: ${JSON.stringify(event)}\n`).join('');

  const bytes = Buffer.from(events, 'utf8');
  const splitTarget = Buffer.from('准确', 'utf8');
  const splitAt = bytes.indexOf(splitTarget) + 1;
  assert.ok(splitAt > 0, 'test fixture should split inside a UTF-8 sequence');

  const stream = new Readable({ read() {} });
  const socket = new EventEmitter();
  const emitted = [];
  socket.emit = (event, payload) => {
    emitted.push({ event, payload });
    return true;
  };
  const session = { currentRunId: 'run-text', cancelled: false };
  const abortController = new AbortController();

  const done = streamAnthropicSSE(stream, abortController, session, socket, 'session-text', 'run-text');
  stream.push(bytes.slice(0, splitAt));
  stream.push(bytes.slice(splitAt));
  stream.push(null);
  const result = await done;

  assert.strictEqual(result.content[0].text, text, 'SSE parser must preserve split UTF-8 text exactly');
  const textDelta = emitted.find((item) => item.event === 'ide:text-delta');
  assert.strictEqual(textDelta?.payload?.delta, text, 'emitted text delta must preserve split UTF-8 text exactly');
}

function testReadRemoteFileIsExactForModel() {
  const fileText = [
    'line 1: `www.microsoft.com`',
    'line 2: `handshake.server`',
    'x'.repeat(7000),
    'line 4: www.apple.com',
  ].join('\n');
  const result = compactToolResultForModel('read_remote_file', fileText);
  assert.strictEqual(result, fileText, 'read_remote_file results must not be compacted before the model sees them');

  const shellText = Array.from({ length: 240 }, (_, index) => `same line ${index}`).join('\n');
  const compacted = compactToolResultForModel('execute_command', shellText);
  assert.ok(String(compacted).length <= 5200, 'non-exact tool results may still be compacted for model budget');
}

(async () => {
  await testSplitUtf8Sse();
  testReadRemoteFileIsExactForModel();
  console.log('ide-text-fidelity checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
