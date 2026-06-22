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
    contextTokenLimit: 200000,
    maxOutputTokens: 8192,
  });
  assert.ok(id1, 'addProvider 应返回 id');

  // 列出 — maskProvider 返回 reasoningEffort + presetId
  const listed = store.listProviders('claude-code');
  assert.strictEqual(listed.providers.length, 1);
  const p1 = listed.providers[0];
  assert.strictEqual(p1.reasoningEffort, 'high');
  assert.strictEqual(p1.presetId, 'openai');
  assert.strictEqual(p1.contextTokenLimit, 200000);
  assert.strictEqual(p1.maxOutputTokens, 8192);
  assert.strictEqual(p1.models.length, 1, '旧单模型 provider 应投影出默认 models[]');
  assert.strictEqual(p1.models[0].apiModel, 'gpt-5');
  assert.strictEqual(p1.activeModelId, p1.models[0].id);
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
  assert.strictEqual(active.contextTokenLimit, 200000);
  assert.strictEqual(active.maxOutputTokens, 8192);
  assert.strictEqual(active.models[0].apiModel, 'gpt-5');
  assert.strictEqual(active.apiKey, 'sk-test-key-12345', 'getActiveProvider 返回未脱敏 apiKey');

  // shared model limits 可更新、可清空、非法值会拒绝
  assert.ok(store.updateProvider('claude-code', id1, { contextTokenLimit: 128000, maxOutputTokens: 4096 }));
  const updatedLimits = store.getActiveProvider('claude-code');
  assert.strictEqual(updatedLimits.contextTokenLimit, 128000);
  assert.strictEqual(updatedLimits.maxOutputTokens, 4096);
  assert.ok(store.updateProvider('claude-code', id1, { contextTokenLimit: null, maxOutputTokens: '' }));
  const clearedLimits = store.getActiveProvider('claude-code');
  assert.strictEqual(clearedLimits.contextTokenLimit, undefined);
  assert.strictEqual(clearedLimits.maxOutputTokens, undefined);
  assert.throws(
    () => store.updateProvider('claude-code', id1, { maxOutputTokens: -1 }),
    /positive integer/,
  );

  // models[] — provider 下可以保存多个模型档案，并把活跃档案投影回旧字段
  const multiId = store.addProvider('codex', {
    name: 'Gateway Multi',
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-codex',
    upstreamProtocol: 'openai',
    activeModelId: 'deep',
    models: [
      {
        id: 'fast',
        apiModel: 'gpt-4o',
        displayName: 'Fast',
        reasoningEffort: 'auto',
        contextTokenLimit: 128000,
        maxOutputTokens: 2048,
      },
      {
        id: 'deep',
        apiModel: 'gpt-5',
        displayName: 'GPT-5 Deep',
        reasoningEffort: 'high',
        contextTokenLimit: 200000,
        maxOutputTokens: 8192,
      },
    ],
  });
  const multiListed = store.listProviders('codex').providers.find(p => p.id === multiId);
  assert.strictEqual(multiListed.models.length, 2);
  assert.strictEqual(multiListed.activeModelId, 'deep');
  assert.strictEqual(multiListed.model, 'gpt-5');
  assert.strictEqual(multiListed.reasoningEffort, 'high');
  assert.strictEqual(multiListed.contextTokenLimit, 200000);
  assert.strictEqual(multiListed.maxOutputTokens, 8192);

  assert.ok(store.updateProvider('codex', multiId, { activeModelId: 'fast' }));
  const fastActive = store.getActiveProvider('codex');
  assert.strictEqual(fastActive.activeModelId, 'fast');
  assert.strictEqual(fastActive.model, 'gpt-4o');
  assert.strictEqual(fastActive.reasoningEffort, 'auto');
  assert.strictEqual(fastActive.contextTokenLimit, 128000);
  assert.strictEqual(fastActive.maxOutputTokens, 2048);

  assert.ok(store.updateProvider('codex', multiId, { model: 'gpt-4.1', reasoningEffort: 'medium', maxOutputTokens: 4096 }));
  const legacyUpdated = store.getActiveProvider('codex');
  assert.strictEqual(legacyUpdated.model, 'gpt-4.1');
  assert.strictEqual(legacyUpdated.reasoningEffort, 'medium');
  assert.strictEqual(legacyUpdated.maxOutputTokens, 4096);
  assert.strictEqual(legacyUpdated.models.find(p => p.id === 'fast').apiModel, 'gpt-4.1');

  const rawAll = JSON.parse(fs.readFileSync(path.join(tmpDir, 'proxy-configs.json'), 'utf8'));
  const rawMulti = rawAll.codex.providers.find(p => p.id === multiId);
  assert.strictEqual(rawMulti.model, 'gpt-4.1', '旧字段应镜像活跃模型');
  assert.strictEqual(rawMulti.activeModelId, 'fast');

  // route — 入口可以选择同一个 provider 下的不同模型档案
  assert.ok(store.setActive('codex', multiId, 'deep'));
  const deepRouted = store.getActiveProvider('codex');
  assert.strictEqual(deepRouted.activeRoute.providerId, multiId);
  assert.strictEqual(deepRouted.activeRoute.modelId, 'deep');
  assert.strictEqual(deepRouted.model, 'gpt-5');
  assert.strictEqual(deepRouted.reasoningEffort, 'high');
  const routedList = store.listProviders('codex');
  assert.strictEqual(routedList.activeRoute.providerId, multiId);
  assert.strictEqual(routedList.activeRoute.modelId, 'deep');
  assert.strictEqual(routedList.providers.find(p => p.id === multiId).activeModelId, 'deep');

  const routeResult = store.setRoute('codex', { providerId: multiId, modelId: 'fast' });
  assert.deepStrictEqual(routeResult, { providerId: multiId, modelId: 'fast' });
  const fastRouted = store.getActiveProvider('codex');
  assert.strictEqual(fastRouted.model, 'gpt-4.1');
  assert.strictEqual(fastRouted.activeRoute.modelId, 'fast');

  // 每个入口拥有自己的 provider；另一个入口不会自动复用 Codex 的配置
  const opencodeList = store.listProviders('opencode');
  assert.ok(!opencodeList.providers.find(p => p.id === multiId), 'Codex provider 不应出现在 OpenCode 入口列表');
  const opencodeId = store.addProvider('opencode', {
    name: 'OpenCode Local',
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-opencode',
    upstreamProtocol: 'openai',
    model: 'gpt-4o',
  });
  assert.ok(store.setRoute('opencode', { providerId: opencodeId }));
  const opencodeActive = store.getActiveProvider('opencode');
  assert.strictEqual(opencodeActive.id, opencodeId);
  assert.strictEqual(opencodeActive.model, 'gpt-4o');

  const copiedOpencodeId = store.copyProvider('opencode', opencodeId);
  assert.ok(copiedOpencodeId, '复制 provider 应返回新 id');
  assert.notStrictEqual(copiedOpencodeId, opencodeId, '复制 provider 应生成新 id');
  const copiedOpencode = store.getProvider('opencode', copiedOpencodeId);
  assert.strictEqual(copiedOpencode.name, 'OpenCode Local-copy');
  assert.strictEqual(copiedOpencode.apiKey, 'sk-opencode', '复制 provider 应保留真实 apiKey');
  assert.strictEqual(copiedOpencode.apiBase, 'https://api.openai.com');
  assert.strictEqual(copiedOpencode.model, 'gpt-4o');
  assert.strictEqual(copiedOpencode.enabled, true);
  assert.strictEqual(store.copyProvider('opencode', 'missing-provider'), null, '复制不存在的 provider 应返回 null');

  assert.ok(store.deleteProvider('codex', multiId), '删除 Codex provider 应成功');
  const afterDeleteCodex = store.listProviders('codex');
  const afterDeleteOpenCode = store.listProviders('opencode');
  assert.ok(!afterDeleteCodex.providers.find(p => p.id === multiId));
  assert.ok(afterDeleteOpenCode.providers.find(p => p.id === opencodeId), '删除 Codex provider 不应影响 OpenCode');
  assert.strictEqual(store.getActiveProvider('opencode')?.id, opencodeId);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 1.5 legacy 全局池拆成各入口本地副本 ─────────────────────
const legacyDir = path.join(os.tmpdir(), `1shell-legacy-store-test-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(legacyDir, { recursive: true });
try {
  const legacyPath = path.join(legacyDir, 'proxy-configs.json');
  fs.writeFileSync(legacyPath, JSON.stringify({
    __globalProviders: [
      {
        id: 'legacy-provider',
        name: 'Legacy Provider',
        apiBase: 'https://api.openai.com',
        apiKey: 'sk-legacy',
        model: 'gpt-5',
        upstreamProtocol: 'openai',
        reasoningEffort: 'high',
        contextTokenLimit: 200000,
        maxOutputTokens: 8192,
      },
    ],
    codex: { providers: [], activeProviderId: 'legacy-provider' },
    opencode: {
      providers: [],
      activeRoute: { providerId: 'legacy-provider', modelId: 'default' },
    },
  }, null, 2));

  const legacyStore = createProxyConfigStore(legacyDir);
  const codexProviders = legacyStore.listProviders('codex');
  assert.strictEqual(codexProviders.providers.length, 1);
  assert.strictEqual(codexProviders.providers[0].scope, 'local');
  assert.strictEqual(codexProviders.activeRoute.providerId, 'legacy-provider');
  assert.strictEqual(codexProviders.activeRoute.modelId, 'default');
  assert.strictEqual(legacyStore.getActiveProvider('codex').model, 'gpt-5');
  assert.strictEqual(legacyStore.getActiveProvider('opencode').id, 'legacy-provider');

  const migrated = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  assert.strictEqual(migrated.__globalProviders, undefined);
  assert.strictEqual(migrated.codex.providers.length, 1);
  assert.strictEqual(migrated.opencode.providers.length, 1);
  assert.strictEqual(migrated.codex.activeRoute.providerId, 'legacy-provider');
  assert.strictEqual(migrated.opencode.activeRoute.providerId, 'legacy-provider');
  assert.ok(legacyStore.deleteProvider('codex', 'legacy-provider'));
  assert.strictEqual(legacyStore.listProviders('codex').providers.length, 0);
  assert.strictEqual(legacyStore.getActiveProvider('opencode').id, 'legacy-provider');
} finally {
  fs.rmSync(legacyDir, { recursive: true, force: true });
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
console.log('  - provider.models[] 可存多个模型档案并投影活跃模型');
console.log('  - activeRoute 可把入口路由到 provider/model profile');
console.log('  - 各入口 provider 独立，删除一个入口不影响其他入口');
console.log('  - provider 复制会保留真实 apiKey 并追加 -copy');
console.log('  - 旧全局 Provider 池会拆成各入口本地副本');
console.log('  - 非法 effort 归一化为 auto');
console.log('  - reasoning 注入对 reasoning model 生效、对非 reasoning model 跳过');
console.log('  - deepseek-reasoner / claude-opus-4 内置识别正确');
