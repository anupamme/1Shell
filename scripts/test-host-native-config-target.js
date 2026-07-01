'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createNativeCliConfig } = require('../src/agents/native-cli-config');
const { createAgentProviders } = require('../src/agents/providers');

function makeTempDir(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeProvider(cliId) {
  if (cliId === 'claude-code') {
    return {
      id: 'claude-host',
      name: 'Claude Host',
      apiBase: 'https://claude-host.example.com',
      apiKey: 'sk-claude-host',
      model: 'claude-sonnet-4-6',
      upstreamProtocol: 'anthropic',
      reasoningEffort: 'max',
      enabled: true,
    };
  }
  return {
    id: `${cliId}-host`,
    name: `${cliId} Host`,
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-openai-host',
    model: 'gpt-5.5',
    upstreamProtocol: 'openai',
    reasoningEffort: 'high',
    enabled: true,
  };
}

function createHostNativeConfigHarness(dataDir, homeDir) {
  return createNativeCliConfig({
    dataDir,
    homeDir,
    bridgeToken: 'HOST_NATIVE_TEST_TOKEN',
    port: 3399,
    proxyConfigStore: {
      getActiveProvider: (cliId) => makeProvider(cliId),
      listProviders: (cliId) => ({ providers: [makeProvider(cliId)], activeProviderId: makeProvider(cliId).id }),
    },
    claudeCodeSkillRegistry: null,
    mcpPresetStore: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

const dataDir = makeTempDir('1shell-host-native-data');
const homeDir = makeTempDir('1shell-host-native-home');

try {
  const nativeConfig = createHostNativeConfigHarness(dataDir, homeDir);

  nativeConfig.ensureNativeConfig('claude-code', { cwd: '/host-native-cwd' });
  assert.ok(fs.existsSync(path.join(homeDir, '.claude', 'settings.json')), 'Claude settings.json should be written to host home');
  assert.ok(fs.existsSync(path.join(homeDir, '.claude', 'config.json')), 'Claude config.json should be written to host home');
  assert.ok(fs.existsSync(path.join(homeDir, '.claude', 'mcp-config.json')), 'Claude mcp-config.json should be written to host home');

  const claudeArgs = nativeConfig.buildLaunchArgs('claude-code', { cwd: '/host-native-cwd' });
  assert.ok(claudeArgs.includes(path.join(homeDir, '.claude', 'mcp-config.json')), 'Claude launch args should point to host mcp-config.json');
  const claudeEnv = nativeConfig.buildLaunchEnv('claude-code', { cwd: '/host-native-cwd' });
  assert.strictEqual(claudeEnv.CLAUDE_CONFIG_DIR, undefined, 'host mode should not inject CLAUDE_CONFIG_DIR');

  const fakeBinDir = path.join(homeDir, 'bin');
  const fakeClaude = path.join(fakeBinDir, 'claude');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(fakeClaude, '#!/bin/sh\necho fake-claude\n', 'utf8');
  fs.chmodSync(fakeClaude, 0o755);
  nativeConfig.setBinaryOverride('claude-code', fakeClaude);
  assert.strictEqual(nativeConfig.getLaunchCommand('claude-code'), fakeClaude, 'launch command should use manual/native binary path');
  const providerRegistry = createAgentProviders({ nativeCliConfig: nativeConfig });
  const claudeProvider = providerRegistry.getProvider('claude-code');
  assert.strictEqual(
    claudeProvider.command({ useLocalEnv: false }),
    fakeClaude,
    'Agent provider should spawn the resolved native binary path',
  );
  assert.strictEqual(
    claudeProvider.command({ useLocalEnv: true }),
    fakeClaude,
    'Local Agent provider should still spawn the resolved native binary path',
  );

  const codexDir = path.join(homeDir, '.codex');
  const previousCodexConfig = 'model = "old-host-model"\n';
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), previousCodexConfig, 'utf8');

  nativeConfig.ensureNativeConfig('codex', { cwd: '/host-native-cwd' });
  assert.ok(fs.existsSync(path.join(homeDir, '.codex', 'config.toml')), 'Codex config.toml should be written to host home');
  assert.ok(fs.existsSync(path.join(homeDir, '.codex', 'auth.json')), 'Codex auth.json should be written to host home');
  const codexBackupRoot = path.join(dataDir, 'cli-config-backups', 'codex');
  const codexBackups = fs.existsSync(codexBackupRoot)
    ? fs.readdirSync(codexBackupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(codexBackupRoot, entry.name, 'config.toml'))
    : [];
  assert.ok(
    codexBackups.some((filePath) => fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === previousCodexConfig),
    'host mode should backup existing config.toml before overwriting it',
  );
  const codexEnv = nativeConfig.buildLaunchEnv('codex', { cwd: '/host-native-cwd' });
  assert.strictEqual(codexEnv.CODEX_HOME, undefined, 'host mode should not inject CODEX_HOME');

  nativeConfig.ensureNativeConfig('opencode', { cwd: '/host-native-cwd' });
  assert.ok(fs.existsSync(path.join(homeDir, '.config', 'opencode', 'opencode.json')), 'OpenCode config should be written to XDG host path');
  const openCodeEnv = nativeConfig.buildLaunchEnv('opencode', { cwd: '/host-native-cwd' });
  assert.strictEqual(openCodeEnv.XDG_CONFIG_HOME, undefined, 'host mode should not inject XDG_CONFIG_HOME');

  const status = nativeConfig.getNativeConfigStatus('codex');
  assert.strictEqual(status.mode, 'host');
  assert.strictEqual(status.configDir, path.join(homeDir, '.codex'));
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
}

console.log('✓ host-native-config-target 测试通过');
console.log('  - host 模式写入主机原生配置目录');
console.log('  - host 模式启动时不注入 CLAUDE_CONFIG_DIR/CODEX_HOME/XDG_CONFIG_HOME');
console.log('  - host 模式覆盖已有配置前会自动备份');
console.log('  - Agent 启动使用解析后的本机 CLI 可执行路径');
