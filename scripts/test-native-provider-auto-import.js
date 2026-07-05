#!/usr/bin/env node
'use strict';

// GET /api/agent/providers/:cliId 的本机配置自动导入（读取器+储存器）行为：
// 1. 本机原生配置存在且非 1Shell 写入 → 自动落库为配置方案并设为当前路由（幂等）
// 2. enabled-meta 记录了 providerId（1Shell 启用过配置写盘）→ 跳过自动导入，
//    不把替换器写盘的内容镜像回列表覆盖用户原始条目
// 3. 显式 POST /import-native 不受 2 的限制（手动“重新读取”仍按磁盘镜像）

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const root = path.resolve(__dirname, '..');
const { createAgentSetupRouter } = require(path.join(root, 'src', 'routes', 'agent-setup.routes'));
const { createProxyConfigStore } = require(path.join(root, 'src', 'routes', 'proxy.routes'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-auto-import-'));
const proxyConfigStore = createProxyConfigStore(dataDir);

const scanState = {
  provider: {
    name: 'Claude Code Native',
    apiBase: 'https://native.example',
    apiKey: 'sk-native-key',
    upstreamProtocol: 'anthropic',
    model: 'model-a',
    models: [{ id: 'imported-model-a', name: 'model-a', model: 'model-a' }],
    activeModelId: 'imported-model-a',
    nativeProviderId: 'claude-code',
    nativeSource: 'host-config',
  },
};
const metaState = { meta: null };

const nativeCliConfig = {
  scanNativeProviderConfig(cliId) {
    assert.strictEqual(cliId, 'claude-code');
    return {
      found: true,
      cliId,
      provider: { ...scanState.provider, models: scanState.provider.models.map((m) => ({ ...m })) },
      files: [{ name: 'settings.json', path: '/fake/settings.json', exists: true }],
    };
  },
  getNativeConfigStatus() {
    return { configured: true, configDir: '/fake', mode: 'host', files: [], meta: metaState.meta };
  },
};

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentSetupRouter({ proxyConfigStore, nativeCliConfig, mcpPresetStore: null }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/agent`;

  const getProviders = async () => (await fetch(`${base}/providers/claude-code`)).json();
  const postImport = async () => (await fetch(`${base}/providers/claude-code/import-native`, { method: 'POST' })).json();

  try {
    // 1. 首次 GET：自动导入并成为当前方案
    let resp = await getProviders();
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.nativeImport.imported, true, '首次 GET 应自动导入本机配置');
    assert.strictEqual(resp.nativeImport.created, true);
    assert.strictEqual(resp.providers.length, 1);
    assert.strictEqual(resp.providers[0].nativeSource, 'host-config');
    assert.strictEqual(resp.providers[0].apiBase, 'https://native.example');
    assert.strictEqual(resp.activeProviderId, resp.providers[0].id, '自动导入的本机配置应成为当前方案');

    // 2. 再次 GET：幂等，不产生重复条目
    resp = await getProviders();
    assert.strictEqual(resp.nativeImport.created, false, '重复 GET 不应重复创建');
    assert.strictEqual(resp.providers.length, 1);
    const nativeId = resp.providers[0].id;

    // 3. 模拟 1Shell「启用」某方案写盘：meta 记录 providerId，磁盘内容变成生成配置
    metaState.meta = { cliId: 'claude-code', providerId: 'generated-abc', updatedAt: new Date().toISOString() };
    scanState.provider = { ...scanState.provider, apiBase: 'https://generated.example', apiKey: 'sk-generated' };
    resp = await getProviders();
    assert.strictEqual(resp.nativeImport.imported, false, '1Shell 写盘后 GET 不应自动导入');
    assert.strictEqual(resp.nativeImport.managedProviderId, 'generated-abc');
    assert.strictEqual(resp.providers.length, 1, '不应新增镜像条目');
    const preserved = resp.providers.find((p) => p.id === nativeId);
    assert.strictEqual(preserved.apiBase, 'https://native.example', '用户原始本机配置条目不应被生成配置覆盖');

    // 4. 显式 POST import-native：手动重新读取仍按磁盘镜像
    resp = await postImport();
    assert.strictEqual(resp.nativeImport.imported, true, '显式导入不受 managed 限制');
    const mirrored = resp.providers.find((p) => p.id === nativeId);
    assert.strictEqual(mirrored.apiBase, 'https://generated.example', '显式导入应按当前磁盘内容更新');

    console.log('✓ native provider auto-import 行为测试通过');
    console.log('  - 首次 GET 自动导入本机配置并设为当前方案');
    console.log('  - 重复 GET 幂等');
    console.log('  - 1Shell 启用写盘后跳过自动导入，原始条目不被覆盖');
    console.log('  - 显式 import-native 仍可手动镜像磁盘');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，忽略 */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
