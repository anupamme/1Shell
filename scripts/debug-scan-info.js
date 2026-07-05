'use strict';
// 临时诊断 2：getScanInfo 卡片状态 + 二进制检测明细
const path = require('path');
const { createNativeCliConfig } = require(path.join(__dirname, '..', 'src', 'agents', 'native-cli-config'));
const { createProxyConfigStore } = require(path.join(__dirname, '..', 'src', 'routes', 'proxy.routes'));

const dataDir = path.join(__dirname, '..', 'data');
const proxyConfigStore = createProxyConfigStore(dataDir);
const ncc = createNativeCliConfig({
  dataDir,
  bridgeToken: 'x'.repeat(32),
  port: 3301,
  proxyConfigStore,
  mcpPresetStore: null,
  logger: { info() {}, warn() {}, error() {} },
});

for (const tool of ncc.getScanInfo()) {
  console.log(`\n=== ${tool.id} (${tool.name}) ===`);
  console.log('status:', tool.status);
  console.log('binary.installed:', tool.binary.installed, '| path:', tool.binary.path || '(无)', '| version:', tool.binary.version || '(无)');
  if (tool.binary.error) console.log('binary.error:', tool.binary.error);
  if (tool.binary.skipped?.length) console.log('binary.skipped:', JSON.stringify(tool.binary.skipped));
  console.log('binary.attempted:', JSON.stringify(tool.binary.attempted));
  console.log('providerCount:', tool.proxy.providerCount, '| activeProvider:', tool.proxy.activeProvider?.name || '(无)');
  console.log('readiness:', JSON.stringify(tool.readiness));
}
