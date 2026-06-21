'use strict';

/**
 * 验证 4.3 Sprint A 数据层 + reasoning 注入工具的正确性。
 */

const assert = require('assert');
const {
  PROVIDER_PRESETS,
  PRESET_CATEGORIES,
  getPreset,
  getPresetsByCategory,
} = require('../src/agents/provider-presets');
const { MCP_PRESETS, getMcpPreset } = require('../src/agents/mcp-presets');
const {
  EFFORT_LABELS,
  isValidEffort,
  isReasoningModel,
  injectAnthropicThinking,
  injectOpenAIReasoningEffort,
  codexConfigTomlReasoningLine,
} = require('../src/agents/reasoning');

// ── Provider presets ──
assert.strictEqual(PROVIDER_PRESETS.length, 12, '应有 12 家 provider preset(国内 6 + 海外 4 + 中转 2)');
const requiredFields = ['id', 'name', 'apiBase', 'protocol', 'apiKeyField', 'models', 'reasoningModels', 'docsUrl', 'category'];
for (const p of PROVIDER_PRESETS) {
  for (const f of requiredFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(p, f), `preset ${p.id} 缺字段 ${f}`);
  }
  assert.ok(['openai', 'anthropic'].includes(p.protocol), `preset ${p.id} protocol 非法: ${p.protocol}`);
  assert.ok(['domestic', 'overseas', 'relay'].includes(p.category), `preset ${p.id} category 非法: ${p.category}`);
  assert.ok(Array.isArray(p.models), `preset ${p.id} models 应是数组`);
  assert.ok(Array.isArray(p.reasoningModels), `preset ${p.id} reasoningModels 应是数组`);
}

// id 唯一
const ids = PROVIDER_PRESETS.map(p => p.id);
assert.strictEqual(new Set(ids).size, ids.length, 'preset id 应唯一');

// 分类计数
assert.strictEqual(getPresetsByCategory('domestic').length, 6, '国内 6 家');
assert.strictEqual(getPresetsByCategory('overseas').length, 4, '海外 4 家');
assert.strictEqual(getPresetsByCategory('relay').length, 2, '中转 2 家');

// PRESET_CATEGORIES 与实际分类匹配
const categorySet = new Set(PRESET_CATEGORIES.map(c => c.id));
for (const p of PROVIDER_PRESETS) {
  assert.ok(categorySet.has(p.category), `preset ${p.id} category 不在 PRESET_CATEGORIES`);
}

// getPreset 行为
assert.strictEqual(getPreset('deepseek')?.name, 'DeepSeek');
assert.strictEqual(getPreset('anthropic')?.protocol, 'anthropic');
assert.strictEqual(getPreset('not-exist'), null);

// 至少 deepseek/openai/anthropic 有 reasoningModels
assert.ok(getPreset('deepseek').reasoningModels.includes('deepseek-reasoner'));
assert.ok(getPreset('openai').reasoningModels.some(p => p.startsWith('gpt-5')));
assert.ok(getPreset('anthropic').reasoningModels.some(p => p.startsWith('claude-opus-4')));

// ── MCP presets ──
assert.strictEqual(MCP_PRESETS.length, 8, '应有 8 个 MCP preset');
const mcpRequired = ['id', 'name', 'tags', 'description', 'homepage', 'docs', 'server'];
for (const m of MCP_PRESETS) {
  for (const f of mcpRequired) {
    assert.ok(Object.prototype.hasOwnProperty.call(m, f), `mcp preset ${m.id} 缺字段 ${f}`);
  }
  assert.ok(m.server.command, `mcp preset ${m.id} server.command 不能为空`);
  assert.ok(Array.isArray(m.server.args), `mcp preset ${m.id} server.args 应是数组`);
}
assert.ok(getMcpPreset('fetch'));
assert.ok(getMcpPreset('github').needsToken === true, 'github preset 应标 needsToken');

// ── reasoning 工具 ──
assert.deepStrictEqual(EFFORT_LABELS, ['auto', 'low', 'medium', 'high']);
assert.ok(isValidEffort('low'));
assert.ok(isValidEffort('auto'));
assert.ok(!isValidEffort('extreme'));

// isReasoningModel — 内置白名单
assert.ok(isReasoningModel('gpt-5-thinking-2026', 'openai'), 'gpt-5* 应被识别为 reasoning');
assert.ok(isReasoningModel('o3-mini', 'openai'), 'o3* 应被识别');
assert.ok(isReasoningModel('claude-opus-4-8', 'anthropic'), 'claude-opus-4* 应被识别');
assert.ok(isReasoningModel('claude-3-7-sonnet-20250219', 'anthropic'), 'claude-3-7-sonnet* 应被识别');
assert.ok(isReasoningModel('Claude-Sonnet-4-6', 'anthropic'), '大小写不敏感');
assert.ok(!isReasoningModel('gpt-4o', 'openai'), 'gpt-4o 不是 reasoning');
assert.ok(!isReasoningModel('claude-haiku-4-5', 'anthropic'), 'claude-haiku 不是 reasoning');
// extraPrefixes 补判(deepseek-reasoner 走 openai 协议)
assert.ok(isReasoningModel('deepseek-reasoner', 'openai', ['deepseek-reasoner']), 'extraPrefixes 应生效');
assert.ok(!isReasoningModel('deepseek-reasoner', 'openai'), '不传 extraPrefixes 不应命中');

// injectAnthropicThinking
const b1 = { model: 'claude-opus-4-8', messages: [] };
injectAnthropicThinking(b1, 'medium');
assert.deepStrictEqual(b1.thinking, { type: 'enabled', budget_tokens: 16000 });
const b2 = { model: 'x' };
injectAnthropicThinking(b2, 'invalid');
assert.strictEqual(b2.thinking, undefined, 'invalid effort 不注入');

// injectOpenAIReasoningEffort
const b3 = { model: 'gpt-5' };
injectOpenAIReasoningEffort(b3, 'high');
assert.strictEqual(b3.reasoning_effort, 'high');
const b4 = { model: 'gpt-5' };
injectOpenAIReasoningEffort(b4, 'auto');
assert.strictEqual(b4.reasoning_effort, undefined, 'auto 不注入(由模型自决)');

// codexConfigTomlReasoningLine
assert.strictEqual(codexConfigTomlReasoningLine('high'), 'model_reasoning_effort = "high"');
assert.strictEqual(codexConfigTomlReasoningLine('auto'), null);
assert.strictEqual(codexConfigTomlReasoningLine('invalid'), null);

console.log('✓ presets-and-reasoning 测试通过');
console.log(`  - 12 provider presets(国内 6 / 海外 4 / 中转 2)`);
console.log(`  - 8 MCP presets`);
console.log(`  - reasoning 工具:isReasoningModel / inject* / codexConfigTomlReasoningLine 全部正确`);
