'use strict';

/**
 * 验证 4.3 Sprint A.3.a:
 *   codex config.toml 在 active provider 设了 reasoningEffort = low/medium/high/xhigh 时,
 *   生成的 config.toml 应多一行 `model_reasoning_effort = "..."`。
 *   reasoningEffort = 'auto' 或未设时不写该行。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createNativeCliConfig } = require('../src/agents/native-cli-config');

const FIXED_PORT = 3399;

function withNativeConfigHarness(reasoningEffort) {
  const tmpDir = path.join(os.tmpdir(), `1shell-track1-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const provider = {
    id: 'p',
    name: 'P',
    apiBase: 'https://api.openai.com',
    apiKey: 'sk-test',
    model: 'gpt-5-codex',
    upstreamProtocol: 'openai',
    reasoningEffort,
    enabled: true,
  };
  try {
    const nativeConfig = createNativeCliConfig({
      dataDir: tmpDir,
      homeDir: tmpDir,
      bridgeToken: 'TEST_TOKEN',
      port: FIXED_PORT,
      proxyConfigStore: {
        getActiveProvider: () => provider,
        listProviders: () => ({ providers: [provider], activeProviderId: 'p' }),
      },
      claudeCodeSkillRegistry: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    nativeConfig.ensureNativeConfig('codex', { cwd: '/track1-cwd' });
    const tomlPath = path.join(tmpDir, '.codex', 'config.toml');
    return fs.readFileSync(tomlPath, 'utf8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// auto / 未设 → 不写
const tomlAuto = withNativeConfigHarness('auto');
assert.ok(!tomlAuto.includes('model_reasoning_effort'),
  `effort=auto 时 config.toml 不应含 model_reasoning_effort 行,但内容是:\n${tomlAuto}`);

const tomlUnset = withNativeConfigHarness(undefined);
assert.ok(!tomlUnset.includes('model_reasoning_effort'),
  `未设 effort 时 config.toml 不应含 model_reasoning_effort 行`);

// low/medium/high/xhigh → 在 model 行后写入；旧 max 兼容值映射为 xhigh
for (const [effort, expectedEffort] of [
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'xhigh'],
]) {
  const toml = withNativeConfigHarness(effort);
  const expectedLine = `model_reasoning_effort = "${expectedEffort}"`;
  assert.ok(toml.includes(expectedLine),
    `effort=${effort} 应在 config.toml 含 \`${expectedLine}\`,但实际:\n${toml}`);
  assert.ok(toml.includes('base_url = "https://api.openai.com/v1"'), 'Codex 应写上游真实 /v1 base_url,不再写 1Shell proxy URL');
  assert.ok(!toml.includes('/api/proxy/codex'), 'Codex config.toml 不应再包含旧 proxy 路径');

  // 顺序断言:应在 model 行之后、provider section 之前
  const lines = toml.split('\n');
  const modelLineIdx = lines.findIndex(l => l.startsWith('model = '));
  const reasoningLineIdx = lines.findIndex(l => l === expectedLine);
  const providerLineIdx = lines.findIndex(l => l.startsWith('[model_providers.'));
  assert.ok(modelLineIdx >= 0 && reasoningLineIdx === modelLineIdx + 1,
    `reasoning 行应紧跟 model 行(effort=${effort}),实际顺序:model=${modelLineIdx} reasoning=${reasoningLineIdx}`);
  assert.ok(providerLineIdx > reasoningLineIdx,
    `provider section 应在 reasoning 行之后(effort=${effort})`);
}

console.log('✓ codex config.toml reasoning 轨 1 测试通过');
console.log('  - effort=auto/未设 → 不写 model_reasoning_effort');
console.log('  - effort=low/medium/high/xhigh → 写入,位置紧跟 model 行');
console.log('  - 旧 max 兼容值 → xhigh');
