'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createNativeCliConfig } = require('../src/agents/native-cli-config');
const { getPreset } = require('../src/agents/provider-presets');

function makeTempDir(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createNativeConfigHarness(dataDir, providerByCli) {
  return createNativeCliConfig({
    dataDir,
    homeDir: dataDir,
    bridgeToken: 'NATIVE_AGENT_CONFIG_TEST_TOKEN',
    port: 3399,
    proxyConfigStore: {
      getActiveProvider: (cliId) => providerByCli[cliId] || null,
      listProviders: (cliId) => {
        const provider = providerByCli[cliId];
        return provider ? { providers: [provider], activeProviderId: provider.id } : { providers: [], activeProviderId: null };
      },
    },
    claudeCodeSkillRegistry: null,
    mcpPresetStore: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readLocalCodexConfig() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  const model = matchTomlString(raw, /^model\s*=\s*["']([^"']+)["']/m);
  const providerId = matchTomlString(raw, /^model_provider\s*=\s*["']([^"']+)["']/m);
  const providerSection = providerId
    ? raw.match(new RegExp(`\\[model_providers\\.${escapeRegExp(providerId)}\\]([\\s\\S]*?)(?:\\n\\[|$)`))?.[1] || ''
    : '';
  const name = matchTomlString(providerSection, /^\s*name\s*=\s*["']([^"']+)["']/m) || providerId || 'local-codex';
  const baseUrl = matchTomlString(providerSection, /^\s*base_url\s*=\s*["']([^"']+)["']/m);
  const envKey = matchTomlString(providerSection, /^\s*env_key\s*=\s*["']([^"']+)["']/m) || 'OPENAI_API_KEY';
  if (!model || !providerId || !baseUrl) return null;
  return { model, providerId, name, baseUrl, envKey };
}

function matchTomlString(text, regex) {
  return String(text || '').match(regex)?.[1] || '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function claudeProvider(reasoningEffort) {
  return {
    id: 'claude-native',
    name: 'Claude Native',
    apiBase: 'https://claude-native.example.com',
    apiKey: 'sk-claude-native',
    model: 'claude-sonnet-4-6',
    upstreamProtocol: 'anthropic',
    reasoningEffort,
    enabled: true,
    activeModelId: 'sonnet',
    claudeModels: {
      sonnet: { model: 'claude-sonnet-4-6[1M]', displayName: 'Claude Sonnet 4.6' },
      opus: { model: 'claude-opus-4-8[1M]', displayName: 'Claude Opus 4.8' },
      fable: { model: 'claude-fable-5[1M]', displayName: 'Claude Fable 5' },
      haiku: { model: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
    },
    models: [
      {
        id: 'sonnet',
        apiModel: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        enabled: true,
        reasoningEffort,
      },
    ],
  };
}

function codexProvider(reasoningEffort, localConfig) {
  return {
    id: 'codex-native',
    name: localConfig?.providerId || 'cpa',
    codexProviderId: localConfig?.providerId || 'cpa',
    apiBase: localConfig?.baseUrl || 'https://codex.weidu.my/v1',
    apiKey: process.env.OPENAI_API_KEY || 'sk-codex-native-test',
    model: localConfig?.model || 'gpt-5.5',
    upstreamProtocol: 'openai',
    reasoningEffort,
    enabled: true,
  };
}

function assertClaudeNativeConfig() {
  const effortExpectations = [
    ['auto', null, null],
    [undefined, null, null],
    ['low', 'low', null],
    ['medium', 'medium', null],
    ['high', 'high', null],
    ['max', null, 'max'],
    ['xhigh', null, 'max'],
  ];

  for (const [effort, expectedEffortLevel, expectedMaxEnv] of effortExpectations) {
    const dataDir = makeTempDir('1shell-claude-native');
    try {
      const nativeConfig = createNativeConfigHarness(dataDir, { 'claude-code': claudeProvider(effort) });
      nativeConfig.ensureNativeConfig('claude-code', { cwd: '/native-claude-test' });
      const settings = readJson(path.join(dataDir, '.claude', 'settings.json'));
      const config = readJson(path.join(dataDir, '.claude', 'config.json'));

      assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, 'https://claude-native.example.com');
      assert.strictEqual(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-claude-native');
      assert.strictEqual(settings.env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6[1M]');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'Claude Sonnet 4.6');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8[1M]');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'Claude Opus 4.8');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5[1M]');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, 'Claude Fable 5');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5');
      assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, 'Claude Haiku 4.5');
      assert.strictEqual(config.primaryApiKey, 'any');
      assert.strictEqual(settings.includeCoAuthoredBy, false);

      if (expectedEffortLevel) {
        assert.strictEqual(settings.effortLevel, expectedEffortLevel, `Claude effort=${effort} should write effortLevel`);
      } else {
        assert.ok(!Object.prototype.hasOwnProperty.call(settings, 'effortLevel'), `Claude effort=${effort} should not write effortLevel`);
      }
      if (expectedMaxEnv) {
        assert.strictEqual(settings.env.CLAUDE_CODE_EFFORT_LEVEL, expectedMaxEnv, `Claude effort=${effort} should write max env`);
      } else {
        assert.ok(!Object.prototype.hasOwnProperty.call(settings.env, 'CLAUDE_CODE_EFFORT_LEVEL'), `Claude effort=${effort} should not write max env`);
      }
      assert.ok(!JSON.stringify(settings).includes('"xhigh"'), 'Claude Code native settings must not emit xhigh');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

function assertCodexNativeConfig() {
  const localConfig = readLocalCodexConfig();
  const effortExpectations = [
    ['auto', null],
    [undefined, null],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
  ];

  for (const [effort, expectedEffort] of effortExpectations) {
    const dataDir = makeTempDir('1shell-codex-native');
    try {
      const provider = codexProvider(effort, localConfig);
      const nativeConfig = createNativeConfigHarness(dataDir, { codex: provider });
      nativeConfig.ensureNativeConfig('codex', { cwd: '/native-codex-test' });
      const configToml = fs.readFileSync(path.join(dataDir, '.codex', 'config.toml'), 'utf8');
      const launchEnv = nativeConfig.buildLaunchEnv('codex', { cwd: '/native-codex-test' });
      const providerId = localConfig?.providerId || 'cpa';
      const baseUrl = localConfig?.baseUrl || 'https://codex.weidu.my/v1';
      const model = localConfig?.model || 'gpt-5.5';

      assert.ok(configToml.includes(`model_provider = "${providerId}"`), configToml);
      assert.ok(configToml.includes(`model = "${model}"`), configToml);
      assert.ok(configToml.includes(`[model_providers.${providerId}]`), configToml);
      assert.ok(configToml.includes(`base_url = "${baseUrl}"`), configToml);
      assert.ok(configToml.includes('wire_api = "responses"'), configToml);
      assert.ok(configToml.includes('env_key = "OPENAI_API_KEY"'), configToml);
      assert.ok(!configToml.includes('disable_response_storage'), 'Codex 0.142 strict config rejects disable_response_storage');
      assert.ok(!configToml.includes('/api/proxy/codex'), 'Codex native config must not use old proxy URL');
      assert.strictEqual(fs.existsSync(path.join(dataDir, '.codex', 'auth.json')), false, 'Codex auth.json should not be generated');
      assert.strictEqual(launchEnv.OPENAI_API_KEY, provider.apiKey, 'Codex API key should be injected at launch time');

      if (expectedEffort) {
        assert.ok(configToml.includes(`model_reasoning_effort = "${expectedEffort}"`), configToml);
      } else {
        assert.ok(!configToml.includes('model_reasoning_effort'), configToml);
      }
      assert.ok(!configToml.includes('model_reasoning_effort = "max"'), 'Codex must never emit max; highest effort is xhigh');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

function assertRawConfigOverride() {
  const localConfig = readLocalCodexConfig();
  const dataDir = makeTempDir('1shell-native-override');
  try {
    const nativeConfig = createNativeConfigHarness(dataDir, {
      codex: codexProvider('high', localConfig),
      'claude-code': claudeProvider('max'),
    });
    nativeConfig.ensureNativeConfig('codex', { cwd: '/native-override-test' });
    const customToml = [
      'model_provider = "manual"',
      'model = "manual-model"',
      '',
      '[model_providers.manual]',
      'name = "manual"',
      'wire_api = "responses"',
      'base_url = "https://manual.example/v1"',
      'env_key = "OPENAI_API_KEY"',
    ].join('\n');
    nativeConfig.writeConfigFile('codex', 'config.toml', customToml);
    nativeConfig.ensureNativeConfig('codex', { cwd: '/native-override-test' });
    const files = nativeConfig.listConfigFiles('codex', { cwd: '/native-override-test' });
    const configFile = files.find(file => file.name === 'config.toml');
    assert.strictEqual(configFile.overridden, true, 'manual config.toml should be marked overridden');
    assert.strictEqual(configFile.content, customToml, 'manual config.toml should survive regeneration');

    nativeConfig.clearConfigFileOverride('codex', 'config.toml', { cwd: '/native-override-test' });
    const regenerated = nativeConfig.listConfigFiles('codex', { cwd: '/native-override-test' })
      .find(file => file.name === 'config.toml');
    assert.strictEqual(regenerated.overridden, false, 'cleared config.toml should no longer be overridden');
    const expectedProviderId = localConfig?.providerId || 'cpa';
    assert.ok(regenerated.content.includes(`model_provider = "${expectedProviderId}"`), 'cleared config.toml should regenerate from provider');

    assert.throws(
      () => nativeConfig.writeConfigFile('claude-code', 'settings.json', '{ invalid json'),
      /不是合法 JSON/,
      'JSON raw editor should reject invalid JSON',
    );
    assert.throws(
      () => nativeConfig.writeConfigFile('codex', 'config.toml', 'model = "ok"\n[broken'),
      /不是合法 TOML/,
      'TOML raw editor should reject invalid TOML',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function assertConfigPreviewFollowsDraftWithoutWriting() {
  const dataDir = makeTempDir('1shell-native-preview');
  try {
    const nativeConfig = createNativeConfigHarness(dataDir, {});

    const claudeDraft = {
      ...claudeProvider('max'),
      apiBase: 'https://preview-claude.example.com',
      apiKey: 'sk-preview-claude',
      model: 'claude-preview-sonnet',
      claudeModels: {
        sonnet: { model: 'claude-preview-sonnet[1M]', displayName: 'Preview Sonnet' },
        opus: { model: 'claude-preview-opus', displayName: 'Preview Opus' },
        fable: { model: 'claude-preview-fable', displayName: 'Preview Fable' },
        haiku: { model: 'claude-preview-haiku', displayName: 'Preview Haiku' },
      },
    };
    const claudeFiles = nativeConfig.previewConfigFiles('claude-code', {
      cwd: '/native-preview-test',
      activeProvider: claudeDraft,
    });
    const settingsFile = claudeFiles.find(file => file.name === 'settings.json');
    assert.ok(settingsFile, 'preview should include Claude settings.json');
    const settings = JSON.parse(settingsFile.content);
    assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, 'https://preview-claude.example.com');
    assert.strictEqual(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-preview-claude');
    assert.strictEqual(settings.env.ANTHROPIC_MODEL, 'claude-preview-sonnet');
    assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-preview-sonnet[1M]');
    assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'Preview Sonnet');
    assert.strictEqual(settings.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.strictEqual(fs.existsSync(path.join(dataDir, '.claude', 'settings.json')), false, 'preview must not write Claude files');

    const partialClaudeFiles = nativeConfig.previewConfigFiles('claude-code', {
      cwd: '/native-preview-test',
      activeProvider: {
        ...claudeDraft,
        apiKey: '',
        apiBase: 'https://partial-claude.example.com',
        model: 'partial-sonnet',
      },
    });
    const partialSettingsFile = partialClaudeFiles.find(file => file.name === 'settings.json');
    const partialSettings = JSON.parse(partialSettingsFile.content);
    assert.strictEqual(partialSettings.env.ANTHROPIC_BASE_URL, 'https://partial-claude.example.com');
    assert.strictEqual(partialSettings.env.ANTHROPIC_MODEL, 'partial-sonnet');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in partialSettings.env), 'empty draft API key should not make preview fall back to existing env');

    const codexDraft = codexProvider('xhigh', {
      providerId: 'preview-codex',
      baseUrl: 'https://preview-codex.example.com/v1',
      model: 'gpt-preview',
    });
    codexDraft.apiKey = 'sk-preview-codex';
    const codexFiles = nativeConfig.previewConfigFiles('codex', {
      cwd: '/native-preview-test',
      activeProvider: codexDraft,
    });
    const codexToml = codexFiles.find(file => file.name === 'config.toml')?.content || '';
    assert.ok(codexToml.includes('model_provider = "preview-codex"'), codexToml);
    assert.ok(codexToml.includes('model = "gpt-preview"'), codexToml);
    assert.ok(codexToml.includes('model_reasoning_effort = "xhigh"'), codexToml);
    assert.ok(codexToml.includes('base_url = "https://preview-codex.example.com/v1"'), codexToml);
    assert.strictEqual(codexFiles.some(file => file.name === 'auth.json'), false, 'Codex preview should not expose auth.json');
    assert.strictEqual(fs.existsSync(path.join(dataDir, '.codex', 'config.toml')), false, 'preview must not write Codex files');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function assertSaveDraftAndLaunchDoNotWriteNativeFiles() {
  const dataDir = makeTempDir('1shell-native-draft-no-write');
  try {
    const localConfig = readLocalCodexConfig();
    const nativeConfig = createNativeConfigHarness(dataDir, { codex: codexProvider('high', localConfig) });
    const configPath = path.join(dataDir, '.codex', 'config.toml');
    const authPath = path.join(dataDir, '.codex', 'auth.json');
    const mcpPath = path.join(dataDir, '.codex', 'mcp.json');
    const customToml = [
      'model_provider = "draft"',
      'model = "draft-model"',
      '',
      '[model_providers.draft]',
      'name = "draft"',
      'wire_api = "responses"',
      'base_url = "https://draft.example/v1"',
      'env_key = "OPENAI_API_KEY"',
    ].join('\n');

    nativeConfig.writeConfigFile('codex', 'config.toml', customToml);
    assert.strictEqual(fs.existsSync(configPath), false, 'saving a config draft must not write native config.toml');

    nativeConfig.buildShellCommand('codex');
    assert.strictEqual(fs.existsSync(configPath), false, 'building launch command must not write native config.toml');
    assert.strictEqual(fs.existsSync(authPath), false, 'building launch command must not write native auth.json');

    nativeConfig.enableNativeConfig('codex', {
      cwd: '/native-enable-test',
      files: [
        { name: 'config.toml', content: customToml },
        { name: 'mcp.json', content: JSON.stringify({ mcpServers: {} }, null, 2) },
      ],
    });
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), customToml, 'enable should write selected config.toml content');
    assert.strictEqual(fs.existsSync(authPath), false, 'enable should not write Codex auth.json');
    assert.ok(fs.existsSync(mcpPath), 'enable should write selected mcp.json content');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function assertClaudeDeepSeekPresetMatchesNativeConfig() {
  const dataDir = makeTempDir('1shell-claude-deepseek-preset');
  try {
    const nativeConfig = createNativeConfigHarness(dataDir, {});
    const preset = getPreset('deepseek', 'claude-code');
    const provider = {
      id: 'deepseek',
      name: preset.name,
      apiBase: preset.apiBase,
      apiKey: 'sk-deepseek-preview',
      upstreamProtocol: preset.protocol,
      model: preset.models[0],
      reasoningEffort: 'auto',
      claudeModels: preset.claudeModels,
      models: [
        {
          id: 'deepseek-v4-pro',
          apiModel: preset.models[0],
          displayName: preset.models[0],
          enabled: true,
          reasoningEffort: 'auto',
        },
      ],
    };

    const files = nativeConfig.previewConfigFiles('claude-code', {
      cwd: '/native-deepseek-preview',
      activeProvider: provider,
    });
    const settings = JSON.parse(files.find(file => file.name === 'settings.json')?.content || '{}');
    assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.strictEqual(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek-preview');
    assert.strictEqual(settings.env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
    assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro');
    assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro');
    assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'deepseek-v4-pro');
    assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
    assert.ok(!JSON.stringify(settings).includes('deepseek-chat'), 'Claude Code DeepSeek preset must not emit legacy deepseek-chat');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function assertMissingProviderDoesNotOverwriteNativeApiConfig() {
  const dataDir = makeTempDir('1shell-native-no-provider');
  try {
    const nativeConfig = createNativeConfigHarness(dataDir, {});
    const claudeDir = path.join(dataDir, '.claude');
    const codexDir = path.join(dataDir, '.codex');
    const existingClaudeSettings = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'keep-claude-token' } }, null, 2);
    const existingClaudeConfig = JSON.stringify({ primaryApiKey: 'keep-primary-key' }, null, 2);
    const existingCodexConfig = 'model_provider = "keep"\nmodel = "keep-model"\n';
    const existingCodexAuth = JSON.stringify({ OPENAI_API_KEY: 'keep-codex-token' }, null, 2);

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), existingClaudeSettings, 'utf8');
    fs.writeFileSync(path.join(claudeDir, 'config.json'), existingClaudeConfig, 'utf8');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), existingCodexConfig, 'utf8');
    fs.writeFileSync(path.join(codexDir, 'auth.json'), existingCodexAuth, 'utf8');

    nativeConfig.ensureNativeConfig('claude-code', { cwd: '/native-no-provider' });
    nativeConfig.ensureNativeConfig('codex', { cwd: '/native-no-provider' });

    assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'), existingClaudeSettings);
    assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'config.json'), 'utf8'), existingClaudeConfig);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), existingCodexConfig);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'), existingCodexAuth);
    assert.ok(fs.existsSync(path.join(claudeDir, 'mcp-config.json')), 'Claude MCP config should still be written');
    assert.ok(fs.existsSync(path.join(codexDir, 'mcp.json')), 'Codex MCP config should still be written');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function assertNativeConfigScanReadsHostApiConfig() {
  const dataDir = makeTempDir('1shell-native-scan');
  const projectDir = makeTempDir('1shell-native-scan-project');
  try {
    const nativeConfig = createNativeConfigHarness(dataDir, {});
    const codexDir = path.join(dataDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), [
      'model = "gpt-5.5"',
      'model_provider = "cpa"',
      'model_reasoning_effort = "high"',
      '',
      '[model_providers.cpa]',
      'name = "cpa-codex"',
      'base_url = "https://codex.weidu.my/v1"',
      'env_key = "OPENAI_API_KEY"',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-import-codex' }, null, 2), 'utf8');

    const codexScan = nativeConfig.scanNativeProviderConfig('codex');
    assert.strictEqual(codexScan.found, true, 'Codex native scan should find config.toml');
    assert.strictEqual(codexScan.provider.name, 'cpa-codex');
    assert.strictEqual(codexScan.provider.apiBase, 'https://codex.weidu.my/v1');
    assert.strictEqual(codexScan.provider.apiKey, 'sk-import-codex');
    assert.strictEqual(codexScan.provider.model, 'gpt-5.5');
    assert.strictEqual(codexScan.provider.reasoningEffort, 'high');
    assert.strictEqual(codexScan.provider.codexProviderId, 'cpa');
    assert.strictEqual(codexScan.provider.models[0].apiModel, 'gpt-5.5');

    const claudeDir = path.join(dataDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://claude-native.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-import-claude',
        ANTHROPIC_MODEL: 'claude-user-sonnet',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6[1M]',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Claude Sonnet 4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Claude Haiku 4.5',
      },
      includeCoAuthoredBy: false,
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({
      env: {
        ANTHROPIC_MODEL: 'claude-project-sonnet',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
      },
    }, null, 2), 'utf8');

    const claudeScan = nativeConfig.scanNativeProviderConfig('claude-code', { cwd: projectDir });
    assert.strictEqual(claudeScan.found, true, 'Claude native scan should find settings.json');
    assert.strictEqual(claudeScan.provider.apiBase, 'https://claude-native.example.com');
    assert.strictEqual(claudeScan.provider.apiKey, 'sk-import-claude');
    assert.strictEqual(claudeScan.provider.model, 'claude-user-sonnet');
    assert.strictEqual(claudeScan.provider.reasoningEffort, 'high');
    assert.strictEqual(claudeScan.provider.claudeModels.sonnet.model, 'claude-sonnet-4-6[1M]');
    assert.strictEqual(claudeScan.provider.claudeModels.haiku.displayName, 'Claude Haiku 4.5');

    const openCodeConfigDir = path.join(dataDir, '.config', 'opencode');
    fs.mkdirSync(openCodeConfigDir, { recursive: true });
    fs.writeFileSync(path.join(openCodeConfigDir, 'opencode.json'), [
      '{',
      '  "model": "cpa/gpt-5.5",',
      '  "provider": {',
      '    "cpa": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '      "name": "cpa-opencode",',
      '      "options": { "baseURL": "https://codex.weidu.my/v1", "apiKey": "sk-import-opencode" },',
      '      "models": {',
      '        "gpt-5.5": { "name": "gpt-5.5", "limit": { "context": 200000, "output": 8192 } }',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'), 'utf8');

    const openCodeScan = nativeConfig.scanNativeProviderConfig('opencode', { cwd: projectDir });
    assert.strictEqual(openCodeScan.found, true, 'OpenCode native scan should find opencode.jsonc');
    assert.strictEqual(openCodeScan.provider.name, 'cpa-opencode');
    assert.strictEqual(openCodeScan.provider.apiBase, 'https://codex.weidu.my/v1');
    assert.strictEqual(openCodeScan.provider.apiKey, 'sk-import-opencode');
    assert.strictEqual(openCodeScan.provider.model, 'gpt-5.5');
    assert.strictEqual(openCodeScan.provider.opencodeProviderId, 'cpa');
    assert.strictEqual(openCodeScan.provider.models[0].contextTokenLimit, 200000);
    assert.strictEqual(openCodeScan.provider.models[0].maxOutputTokens, 8192);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

assertClaudeNativeConfig();
assertCodexNativeConfig();
assertRawConfigOverride();
assertConfigPreviewFollowsDraftWithoutWriting();
assertSaveDraftAndLaunchDoNotWriteNativeFiles();
assertClaudeDeepSeekPresetMatchesNativeConfig();
assertMissingProviderDoesNotOverwriteNativeApiConfig();
assertNativeConfigScanReadsHostApiConfig();

console.log('✓ native-agent-config 测试通过');
console.log('  - Claude Code 写入完整 Sonnet/Opus/Fable/Haiku 模型映射和名称');
console.log('  - Claude Code 支持 auto/low/medium/high/max，且不输出 xhigh');
console.log('  - Codex 支持 auto/low/medium/high/xhigh，旧 max 映射为 xhigh');
console.log('  - Codex 生成配置按本机 ~/.codex/config.toml 的 model/base_url 形态验证');
console.log('  - raw 配置文件覆盖会保留，清除覆盖后可重新生成');
console.log('  - 表单草稿配置预览复用真实生成器，且不会提前写盘');
console.log('  - 保存草稿和生成启动命令都不会写原生配置，只有启用配置会写入');
console.log('  - Claude Code DeepSeek preset 对齐 cc-switch 的 /anthropic 与 deepseek-v4-* 映射');
console.log('  - 未配置 provider 时不会覆盖用户已有原生 API 配置，只补 MCP 配置');
console.log('  - 能从本机 Claude/Codex/OpenCode 原生配置反向扫描出界面 provider');
