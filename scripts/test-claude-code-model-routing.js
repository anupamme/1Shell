'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createNativeCliConfig } = require('../src/agents/native-cli-config');
const {
  buildAnthropicProxyModelList,
  buildOpenAIProxyModelList,
  createProxyRouter,
} = require('../src/routes/proxy.routes');

const activeProvider = {
  id: 'cpa',
  name: 'cpa',
  apiBase: 'https://cpa.example.test',
  apiKey: 'sk-test',
  model: 'claude-sonnet-4-6',
  upstreamProtocol: 'anthropic',
  reasoningEffort: 'max',
  enabled: true,
  activeModelId: 'sonnet',
  claudeModels: {
    sonnet: { model: 'claude-sonnet-4-6[1M]', displayName: 'Claude Sonnet 4.6' },
    opus: { model: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
    fable: { model: 'claude-opus-4-8', displayName: 'Claude Fable' },
    haiku: { model: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  },
  models: [
    {
      id: 'sonnet',
      apiModel: 'claude-sonnet-4-6',
      displayName: 'claude-sonnet-4-6',
      enabled: true,
      reasoningEffort: 'max',
      contextTokenLimit: 1000000,
    },
    {
      id: 'flash',
      apiModel: 'gemini-3.5-flash-low',
      displayName: 'gemini-3.5-flash-low',
      enabled: true,
      reasoningEffort: 'auto',
    },
    {
      id: 'disabled',
      apiModel: 'disabled-model',
      displayName: 'disabled-model',
      enabled: false,
    },
  ],
};

const proxyConfigStore = {
  getActiveProvider: (cliId) => (cliId === 'claude-code' ? activeProvider : null),
  listProviders: () => ({ providers: [activeProvider], activeProviderId: activeProvider.id }),
};

const dataDir = path.join(os.tmpdir(), `1shell-claude-model-routing-${crypto.randomBytes(4).toString('hex')}`);

try {
  const nativeConfig = createNativeCliConfig({
    dataDir,
    homeDir: dataDir,
    bridgeToken: 'BRIDGE_TOKEN_FOR_MODEL_ROUTING_TEST',
    port: 3399,
    proxyConfigStore,
    mcpPresetStore: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const args = nativeConfig.buildLaunchArgs('claude-code', { cwd: '/model-routing-test' });
  assert.ok(!args.includes('--model'), 'Claude Code native config mode should not force --model');
  assert.ok(args.includes('--strict-mcp-config'), 'Claude Code launch args should keep strict MCP config');

  const localArgs = nativeConfig.buildLaunchArgs('claude-code', { useLocalEnv: true, cwd: '/model-routing-test' });
  assert.ok(!localArgs.includes('--model'), 'local-env launch should not force a model');
  assert.strictEqual(
    fs.existsSync(path.join(dataDir, '.claude', 'settings.json')),
    false,
    'building Claude launch args must not write native settings.json',
  );

  nativeConfig.enableNativeConfig('claude-code', { cwd: '/model-routing-test' });

  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, activeProvider.apiBase);
  assert.strictEqual(settings.env.ANTHROPIC_AUTH_TOKEN, activeProvider.apiKey);
  assert.strictEqual(settings.env.ANTHROPIC_MODEL, activeProvider.model);
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6[1M]');
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'Claude Sonnet 4.6');
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8');
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-opus-4-8');
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5');
  assert.strictEqual(settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.strictEqual(settings.includeCoAuthoredBy, false);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, '.claude', 'config.json'), 'utf8'));
  assert.strictEqual(config.primaryApiKey, 'any', 'Claude config.json should use cc-switch plugin placeholder');

  const anthropicModels = buildAnthropicProxyModelList(activeProvider);
  assert.deepStrictEqual(
    anthropicModels.data.map((model) => model.id),
    ['claude-sonnet-4-6', 'gemini-3.5-flash-low'],
  );
  assert.strictEqual(anthropicModels.data[0].display_name, 'claude-sonnet-4-6');

  const openaiModels = buildOpenAIProxyModelList(activeProvider);
  assert.deepStrictEqual(
    openaiModels.data.map((model) => model.id),
    ['claude-sonnet-4-6', 'gemini-3.5-flash-low'],
  );
  assert.strictEqual(openaiModels.data[0].owned_by, '1shell-proxy');

  const router = createProxyRouter({ proxyConfigStore, proxyToken: '' });
  const proxyPaths = router.stack.map(layer => layer.route?.path).filter(Boolean);
  assert.ok(proxyPaths.includes('/skills/v1/messages'), 'Skills internal proxy endpoint should remain');
  for (const removedPath of [
    '/claude/v1/messages',
    '/claude/v1/models',
    '/codex/v1/chat/completions',
    '/codex/v1/responses',
    '/opencode/v1/chat/completions',
    '/opencode/v1/responses',
    '/v1/messages',
  ]) {
    assert.ok(!proxyPaths.includes(removedPath), `Agent proxy endpoint should be removed: ${removedPath}`);
  }

  console.log('claude-code model routing checks passed');
  console.log('  - launch args no longer force --model');
  console.log('  - settings.json writes cc-switch-compatible Claude model mapping');
  console.log('  - old Agent proxy endpoints stay removed');
  console.log('  - Agent provider meta exposes the active provider name and model');
  console.log('  - Anthropic/OpenAI model list responses use provider model profiles');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
