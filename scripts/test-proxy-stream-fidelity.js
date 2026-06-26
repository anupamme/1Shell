'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { __private } = require('../src/routes/proxy.routes');

const {
  streamAnthropicToOpenAI,
  streamOpenAIToAnthropic,
} = __private;

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.output = '';
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  write(chunk) {
    this.output += String(chunk);
    return true;
  }

  end(chunk = '') {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.emit('finish');
  }
}

function splitInsideUtf8(text, needle) {
  const bytes = Buffer.from(text, 'utf8');
  const target = Buffer.from(needle, 'utf8');
  const index = bytes.indexOf(target);
  assert.ok(index >= 0, `fixture should contain ${needle}`);
  return [bytes.slice(0, index + 1), bytes.slice(index + 1)];
}

function streamChunks(chunks) {
  const stream = new Readable({ read() {} });
  for (const chunk of chunks) stream.push(chunk);
  stream.push(null);
  return stream;
}

function waitForFinish(res) {
  if (res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => res.once('finish', resolve));
}

function parseAnthropicSse(output) {
  return String(output || '').split(/\n\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\n/);
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: data ? JSON.parse(data) : null };
  });
}

function parseOpenAISse(output) {
  return String(output || '').split(/\n\n/).filter(Boolean).map((block) => {
    const line = block.split(/\n/).find((item) => item.startsWith('data: '));
    const data = line ? line.slice(6) : '';
    return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
  });
}

async function testOpenAIToAnthropicSplitUtf8() {
  const text = '准确内容: `handshake.server`，引号 ‘ 和 www.apple.com 必须不变。';
  const payload = [
    'data: ' + JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: null }],
    }),
    'data: [DONE]',
    '',
  ].join('\n\n');

  const res = new FakeResponse();
  streamOpenAIToAnthropic(res, streamChunks(splitInsideUtf8(payload, '准确')), 'test-model');
  await waitForFinish(res);

  const textDelta = parseAnthropicSse(res.output).find((item) => item.event === 'content_block_delta');
  assert.strictEqual(textDelta?.data?.delta?.text, text, 'OpenAI to Anthropic stream must preserve split UTF-8 text exactly');
}

async function testAnthropicToOpenAISplitUtf8() {
  const text = '准确内容: `handshake.server`，引号 ‘ 和 www.apple.com 必须不变。';
  const payload = [
    { type: 'message_start', message: { model: 'test-model' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ].map((event) => `data: ${JSON.stringify(event)}\n`).join('');

  const res = new FakeResponse();
  streamAnthropicToOpenAI(res, streamChunks(splitInsideUtf8(payload, '准确')));
  await waitForFinish(res);

  const contentDelta = parseOpenAISse(res.output).find((item) => item?.choices?.[0]?.delta?.content);
  assert.strictEqual(contentDelta?.choices?.[0]?.delta?.content, text, 'Anthropic to OpenAI stream must preserve split UTF-8 text exactly');
}

(async () => {
  await testOpenAIToAnthropicSplitUtf8();
  await testAnthropicToOpenAISplitUtf8();
  console.log('proxy-stream-fidelity checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
