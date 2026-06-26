'use strict';

const assert = require('assert');

const { __private } = require('../src/ide/ide.service');

const {
  AGENT_ATTACHMENT_MAX_TEXT_BYTES,
  assistantTraceSummary,
  buildAgentUserContent,
  expandExactTextReferences,
  normalizeAgentAttachments,
} = __private;

const structuredText = [
  'vless://example@host:443?encryption=none&security=tls&fp=chrome#node-1',
  '{"protocol":"vless","params":{"encryption":"none","fp":"chrome","marker":"n&one"}}',
  '| key | value |',
  '| --- | --- |',
  '| path | /tmp/a&b |',
  'CRLF follows:\r\nsecond line',
].join('\n');

const registry = new Map();
const content = buildAgentUserContent({
  message: 'Analyze this exact text.',
  attachments: [{
    name: 'structured.txt',
    mime: 'text/plain',
    kind: 'text',
    size: Buffer.byteLength(structuredText, 'utf8'),
    text: structuredText,
  }],
  exactTextRegistry: registry,
});

assert.ok(Array.isArray(content), 'text attachments should produce provider content blocks');
const providerText = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
assert.ok(providerText.includes(structuredText), 'provider message must include the exact attachment text');
assert.ok(providerText.includes('[[1shell-exact-attachment:'), 'provider message must include a deterministic exact-output handle');
assert.strictEqual(registry.size, 1, 'exact text attachment should be registered once');

const [handle, record] = registry.entries().next().value;
assert.strictEqual(record.text, structuredText, 'registry must keep exact original text');
assert.strictEqual(record.bytes, Buffer.byteLength(structuredText, 'utf8'), 'registry byte count must match original text');

const expanded = expandExactTextReferences(`before\n[[1shell-exact-attachment:${handle}]]\nafter`, {
  exactTextAttachments: registry,
});
assert.strictEqual(expanded.expanded, true, 'exact reference should expand');
assert.strictEqual(expanded.text, `before\n${structuredText}\nafter`, 'expanded text must be byte-for-byte equivalent as a JS string');
assert.strictEqual(expanded.refs[0].sha256, record.sha256, 'expanded ref should report the verified sha256');

const traceSummary = assistantTraceSummary(expanded.text, expanded);
assert.ok(traceSummary.includes(record.sha256), 'trace summary should retain exact attachment sha256 metadata');
assert.ok(traceSummary.includes(String(record.bytes)), 'trace summary should retain exact attachment byte metadata');
assert.ok(!traceSummary.includes(structuredText), 'trace summary must not persist expanded exact attachment text');

const longText = `${'A'.repeat(90_000)}END_MARKER`;
const longRegistry = new Map();
const longContent = buildAgentUserContent({
  message: 'Analyze long exact text.',
  attachments: [{
    name: 'long.txt',
    mime: 'text/plain',
    kind: 'text',
    size: Buffer.byteLength(longText, 'utf8'),
    text: longText,
  }],
  exactTextRegistry: longRegistry,
});
const longProviderText = longContent.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
assert.ok(longProviderText.includes(longText), 'text above the old 80k preview limit must no longer be truncated');
assert.strictEqual(longRegistry.values().next().value.text, longText, 'long exact text must be registered without truncation');

const tooLargeText = 'x'.repeat(AGENT_ATTACHMENT_MAX_TEXT_BYTES + 1);
const [tooLarge] = normalizeAgentAttachments([{
  name: 'too-large.txt',
  mime: 'text/plain',
  kind: 'text',
  size: Buffer.byteLength(tooLargeText, 'utf8'),
  text: tooLargeText,
}]);
assert.strictEqual(tooLarge.text, '', 'oversized text must not be silently truncated and sent to the model');
assert.match(tooLarge.error, /exceeds exact-text limit/, 'oversized text should explain that exact text was not expanded');

console.log('ide-exact-text-handling checks passed');
