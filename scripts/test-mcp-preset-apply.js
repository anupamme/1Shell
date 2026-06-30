'use strict';

/**
 * 验证 4.3 Sprint A.3.b:
 *   1) mcp-preset-store: apply/list/remove/重复 apply 覆盖/needsConfig 校验
 *   2) cli-sandbox.buildAllMcpEntries:applied preset 与 1Shell base 共存
 *   3) ensureSandbox 在 apply 之后,沙箱 config 真的多出 entry(end-to-end)
 *   4) 空 applied 时字节级与 Sprint B baseline 一致(由 snapshot test 守护,这里再断言一次)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createMcpPresetStore } = require('../src/agents/mcp-preset-store');
const { createCliSandbox } = require('../src/agents/cli-sandbox');

const FIXED_PORT = 3399;
const FIXED_BRIDGE = 'TEST_BRIDGE';

function makeStubProvider() {
  return {
    id: 'p', name: 'P', apiBase: 'https://api.openai.com', apiKey: 'sk-t',
    model: 'gpt-4o', upstreamProtocol: 'openai', enabled: true,
  };
}

function makeSandbox(tmpDir, mcpPresetStore) {
  return createCliSandbox({
    dataDir: tmpDir,
    bridgeToken: FIXED_BRIDGE,
    port: FIXED_PORT,
    proxyConfigStore: {
      getActiveProvider: () => makeStubProvider(),
      listProviders: () => ({ providers: [makeStubProvider()], activeProviderId: 'p' }),
    },
    claudeCodeSkillRegistry: null,
    mcpPresetStore,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// ── 1. store 基本行为 ─────────────────────────────────────────────
const tmpDir = path.join(os.tmpdir(), `1shell-mcp-preset-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  const store = createMcpPresetStore({ dataDir: tmpDir });

  // 初始为空
  assert.deepStrictEqual(store.listApplied('codex'), []);

  // apply fetch(无 needsConfig)
  store.apply('codex', 'fetch', {});
  let applied = store.listApplied('codex');
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].presetId, 'fetch');
  assert.strictEqual(applied[0].configSet, false);

  // apply github 缺 token → 报错
  assert.throws(() => store.apply('codex', 'github', {}), /githubToken/);

  // apply github 含 token → 成功 & 脱敏
  store.apply('codex', 'github', { githubToken: 'TEST_GITHUB_TOKEN_VALUE_1234567890' });
  applied = store.listApplied('codex');
  assert.strictEqual(applied.length, 2);
  const githubItem = applied.find(x => x.presetId === 'github');
  assert.ok(githubItem.config.githubToken.includes('…'), 'githubToken 应脱敏');
  assert.ok(!githubItem.config.githubToken.includes('VALUE_1234567890'), 'githubToken 明文不应出现在 listApplied');

  // getAppliedRaw 返回原始 token(供 sandbox 写入用)
  const raw = store.getAppliedRaw('codex');
  const rawGithub = raw.find(x => x.presetId === 'github');
  assert.strictEqual(rawGithub.config.githubToken, 'TEST_GITHUB_TOKEN_VALUE_1234567890', 'getAppliedRaw 应返回原始 token');

  // 重复 apply github 用新 token 覆盖
  store.apply('codex', 'github', { githubToken: 'TEST_GITHUB_TOKEN_REPLACED' });
  assert.strictEqual(store.listApplied('codex').length, 2, '重复 apply 不应增加条数');
  assert.strictEqual(store.getAppliedRaw('codex').find(x => x.presetId === 'github').config.githubToken, 'TEST_GITHUB_TOKEN_REPLACED');

  // 未知 preset
  assert.throws(() => store.apply('codex', 'nonexistent', {}), /未知 MCP preset/);

  // remove
  assert.ok(store.remove('codex', 'fetch'));
  assert.strictEqual(store.listApplied('codex').length, 1);
  assert.ok(!store.remove('codex', 'fetch'), '重复 remove 应返回 false');

  // 多 cli 隔离
  store.apply('claude-code', 'memory', {});
  assert.strictEqual(store.listApplied('codex').length, 1, 'codex 不受 claude-code apply 影响');
  assert.strictEqual(store.listApplied('claude-code').length, 1);

  // ── 2. buildAllMcpEntries + ensureSandbox ─────────────────────────
  const sandbox = makeSandbox(tmpDir, store);

  // codex 沙箱:1shell + github(fetch 已 remove)
  sandbox.ensureSandbox('codex', { cwd: '/test-cwd' });
  const codexMcpPath = path.join(tmpDir, 'cli-sandbox', 'codex', 'mcp.json');
  const codexMcp = JSON.parse(fs.readFileSync(codexMcpPath, 'utf8'));
  assert.ok(codexMcp.mcpServers['1shell'], 'codex mcp.json 应含 1shell entry');
  assert.ok(codexMcp.mcpServers.github, 'codex mcp.json 应含 github entry');
  assert.strictEqual(
    codexMcp.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    'TEST_GITHUB_TOKEN_REPLACED',
    'github entry 的 env 模板应被实际 token 替换',
  );

  // claude-code 沙箱(走 overwrite 'mcp-config'):1shell + memory
  sandbox.ensureSandbox('claude-code', { cwd: '/test-cwd' });
  const claudeMcpPath = path.join(tmpDir, 'cli-sandbox', 'claude-code', 'mcp-config.json');
  const claudeMcp = JSON.parse(fs.readFileSync(claudeMcpPath, 'utf8'));
  assert.ok(claudeMcp.mcpServers['1shell'], 'claude mcp-config.json 应含 1shell entry');
  assert.ok(claudeMcp.mcpServers.memory, 'claude mcp-config.json 应含 memory entry');
  assert.ok(Array.isArray(claudeMcp.mcpServers.memory.args), 'memory entry 应有 args');

  // ── 3. 空 applied 时,字节级与 baseline 一致(由 snapshot test 守护已足够,这里仅断言行为)──
  const emptyStore = createMcpPresetStore({ dataDir: path.join(tmpDir, '_empty') });
  const emptySandbox = makeSandbox(path.join(tmpDir, '_empty'), emptyStore);
  emptySandbox.ensureSandbox('codex', { cwd: '/empty-cwd' });
  const emptyCodexMcp = JSON.parse(
    fs.readFileSync(path.join(tmpDir, '_empty', 'cli-sandbox', 'codex', 'mcp.json'), 'utf8'),
  );
  assert.deepStrictEqual(Object.keys(emptyCodexMcp.mcpServers || {}), ['1shell'],
    '空 applied 时 codex mcp.json 应只含 1shell entry');

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✓ mcp-preset-apply 测试通过');
console.log('  - store: apply/list/remove/重复 apply 覆盖/needsConfig 校验/脱敏');
console.log('  - apply 后 codex mcp.json 含 1shell + github entry,token 已替换');
console.log('  - apply 后 claude mcp-config.json 含 1shell + memory entry');
console.log('  - 空 applied 时 codex mcp.json 只含 1shell(snapshot 兼容)');
