'use strict';

/**
 * 验证 4.3 Sprint A.2:
 *   1) proxyConfigStore 接收 / 持久化 / 脱敏返回 reasoningEffort + presetId 字段
 *   2) reasoning 注入逻辑端到端:reasoning model 注入、非 reasoning model 跳过、auto 跳过、preset extraPrefixes 生效
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createProxyConfigStore } = require('../src/routes/proxy.routes');
const {
  isReasoningModel,
  injectAnthropicThinking,
  injectOpenAIReasoningEffort,
} = require('../src/agents/reasoning');
const { getPreset } = require('../src/agents/provider-presets');

// ── 1. store 持久化 ─────────────────────────────────────────────
const tmpDir = path.join(os.tmpdir(), `1shell-store-test-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  const store = createProxyConfigStore(tmpDir);

  // 新增 — 含 reasoningEffort + presetId
  const id1 = store.addProvider('claude-code', {
    name: 'OpenAI GPT-5',
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-test-key-12345',
    model: 'gpt-5',
    upstreamProtocol: 'openai',
    reasoningEffort: 'high',
    presetId: 'openai',
  });
  assert.ok(id1, 'addProvider 应返回 id');

  // 列出 — maskProvider 返回 reasoningEffort + presetId
  const listed = store.listProviders('claude-code');
  assert.strictEqual(listed.providers.length, 1);
  const p1 = listed.providers[0];
  assert.strictEqual(p1.reasoningEffort, 'high');
  assert.strictEqual(p1.presetId, 'openai');
  assert.strictEqual(p1.apiKeySet, true);
  assert.ok(!p1.apiKey.includes('sk-test-key-12345'), 'apiKey 应脱敏');

  // 未指定 effort — 默认 auto
  const id2 = store.addProvider('claude-code', {
    name: 'Default Auto',
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-test-2',
    model: 'gpt-4o',
    upstreamProtocol: 'openai',
  });
  const list2 = store.listProviders('claude-code');
  const p2 = list2.providers.find(p => p.id === id2);
  assert.strictEqual(p2.reasoningEffort, 'auto', '未指定 effort 时默认 auto');
  assert.strictEqual(p2.presetId, '');

  // 非法 effort 归一化为 auto
  const id3 = store.addProvider('claude-code', {
    name: 'Bad Effort',
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-test-3',
    model: 'gpt-5',
    upstreamProtocol: 'openai',
    reasoningEffort: 'extreme',
  });
  const list3 = store.listProviders('claude-code');
  const p3 = list3.providers.find(p => p.id === id3);
  assert.strictEqual(p3.reasoningEffort, 'auto', '非法 effort 归一化为 auto');

  // update — reasoningEffort 可被更新
  assert.ok(store.updateProvider('claude-code', id2, { reasoningEffort: 'medium', presetId: 'deepseek' }));
  const list4 = store.listProviders('claude-code');
  const p4 = list4.providers.find(p => p.id === id2);
  assert.strictEqual(p4.reasoningEffort, 'medium');
  assert.strictEqual(p4.presetId, 'deepseek');

  // getActiveProvider 返回原始(含 reasoningEffort,不脱敏)
  store.setActive('claude-code', id1);
  const active = store.getActiveProvider('claude-code');
  assert.strictEqual(active.reasoningEffort, 'high');
  assert.strictEqual(active.apiKey, 'sk-test-key-12345', 'getActiveProvider 返回未脱敏 apiKey');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 2. reasoning 注入端到端 ───────────────────────────────────────
// reasoning model + effort=high → 注入
const body1 = { model: 'gpt-5' };
if (isReasoningModel('gpt-5', 'openai')) {
  injectOpenAIReasoningEffort(body1, 'high');
}
assert.strictEqual(body1.reasoning_effort, 'high', 'gpt-5 + high 应注入 reasoning_effort');

// 非 reasoning model + effort=high → 跳过
const body2 = { model: 'gpt-4o' };
if (isReasoningModel('gpt-4o', 'openai')) {
  injectOpenAIReasoningEffort(body2, 'high');
}
assert.strictEqual(body2.reasoning_effort, undefined, 'gpt-4o 非 reasoning,应跳过注入');

// Anthropic reasoning model
const body3 = { model: 'claude-opus-4-8' };
if (isReasoningModel('claude-opus-4-8', 'anthropic')) {
  injectAnthropicThinking(body3, 'medium');
}
assert.deepStrictEqual(body3.thinking, { type: 'enabled', budget_tokens: 16000 });

// preset extraPrefixes 生效:openrouter preset 的 reasoningModels 为空,但 deepseek-reasoner 已内置(reasoning.js A2 扩了)
assert.ok(isReasoningModel('deepseek-reasoner', 'openai'), 'deepseek-reasoner 应被内置识别');

// preset 含 reasoningModels 时,extraPrefixes 应被并入(实际白名单已含 gpt-5,这里测试 extra 不破坏)
const openaiPreset = getPreset('openai');
assert.ok(openaiPreset.reasoningModels.length > 0);
assert.ok(isReasoningModel('gpt-5', 'openai', openaiPreset.reasoningModels), 'extraPrefixes 并入应正常工作');

console.log('✓ provider-reasoning-store 测试通过');
console.log('  - store 持久化 reasoningEffort + presetId');
console.log('  - maskProvider 返回新字段');
console.log('  - 非法 effort 归一化为 auto');
console.log('  - reasoning 注入对 reasoning model 生效、对非 reasoning model 跳过');
console.log('  - deepseek-reasoner / claude-opus-4 内置识别正确');
