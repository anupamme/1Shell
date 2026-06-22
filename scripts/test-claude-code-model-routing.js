'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCliSandbox } = require('../src/agents/cli-sandbox');
const { createAgentProviders } = require('../src/agents/providers');
const {
  buildAnthropicProxyModelList,
  buildOpenAIProxyModelList,
} = require('../src/routes/proxy.routes');

const activeProvider = {
  id: 'cpa',
  name: 'cpa',
  apiBase: 'https://cpa.example.test',
  apiKey: 'sk-test',
  model: 'claude-opus-4-6-thinking',
  upstreamProtocol: 'openai',
  enabled: true,
  activeModelId: 'opus',
  models: [
    {
      id: 'opus',
      apiModel: 'claude-opus-4-6-thinking',
      displayName: 'claude-opus-4-6-thinking',
      enabled: true,
      reasoningEffort: 'auto',
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
  const sandbox = createCliSandbox({
    dataDir,
    bridgeToken: 'BRIDGE_TOKEN_FOR_MODEL_ROUTING_TEST',
    port: 3399,
    proxyConfigStore,
    claudeCodeSkillRegistry: null,
    mcpPresetStore: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const args = sandbox.buildLaunchArgs('claude-code', { cwd: '/model-routing-test' });
  const modelFlagIndex = args.indexOf('--model');
  assert.ok(modelFlagIndex >= 0, 'Claude Code launch args should include --model');
  assert.strictEqual(args[modelFlagIndex + 1], activeProvider.model);
  assert.ok(args.includes('--strict-mcp-config'), 'Claude Code launch args should keep strict MCP config');

  const localArgs = sandbox.buildLaunchArgs('claude-code', { useLocalEnv: true, cwd: '/model-routing-test' });
  assert.ok(!localArgs.includes('--model'), 'local-env launch should not force the 1Shell gateway model');

  const registry = createAgentProviders({ cliSandbox: sandbox });
  const claudeProvider = registry.listProviders().find((provider) => provider.id === 'claude-code');
  assert.ok(claudeProvider?.configured, 'Agent provider meta should mark the active API provider as configured');
  assert.strictEqual(claudeProvider.activeProviderId, activeProvider.id);
  assert.strictEqual(claudeProvider.activeProviderName, activeProvider.name);
  assert.strictEqual(claudeProvider.activeModelId, activeProvider.activeModelId);
  assert.strictEqual(claudeProvider.model, activeProvider.model);
  assert.deepStrictEqual(
    claudeProvider.models.map((model) => model.apiModel),
    ['claude-opus-4-6-thinking', 'gemini-3.5-flash-low'],
  );

  const anthropicModels = buildAnthropicProxyModelList(activeProvider);
  assert.deepStrictEqual(
    anthropicModels.data.map((model) => model.id),
    ['claude-opus-4-6-thinking', 'gemini-3.5-flash-low'],
  );
  assert.strictEqual(anthropicModels.data[0].display_name, 'claude-opus-4-6-thinking');

  const openaiModels = buildOpenAIProxyModelList(activeProvider);
  assert.deepStrictEqual(
    openaiModels.data.map((model) => model.id),
    ['claude-opus-4-6-thinking', 'gemini-3.5-flash-low'],
  );
  assert.strictEqual(openaiModels.data[0].owned_by, '1shell-proxy');

  console.log('claude-code model routing checks passed');
  console.log('  - launch args pass the active 1Shell model via --model');
  console.log('  - Agent provider meta exposes the active provider name and model');
  console.log('  - Anthropic/OpenAI model list responses use provider model profiles');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
