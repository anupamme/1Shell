'use strict';
// 临时诊断：复现 GET /agent/providers/:cliId 的 nativeImport 逻辑（只读，密钥打码）
const path = require('path');
const { createNativeCliConfig } = require(path.join(__dirname, '..', 'src', 'agents', 'native-cli-config'));
const { createProxyConfigStore } = require(path.join(__dirname, '..', 'src', 'routes', 'proxy.routes'));

const dataDir = process.env.ONESHELL_DATA_DIR || path.join(__dirname, '..', 'data');
const proxyConfigStore = createProxyConfigStore(dataDir);
const ncc = createNativeCliConfig({
  dataDir,
  bridgeToken: '',
  port: 0,
  proxyConfigStore,
  mcpPresetStore: null,
  logger: { info() {}, warn() {}, error() {} },
});

function redact(value) {
  const s = String(value || '');
  if (!s) return '(空)';
  return `${s.slice(0, 6)}…(${s.length}字符)`;
}

console.log('dataDir:', dataDir);
console.log('homedir:', require('os').homedir());

for (const cliId of ['claude-code', 'codex']) {
  const scan = ncc.scanNativeProviderConfig(cliId);
  console.log(`\n=== ${cliId} ===`);
  console.log('scan.found:', scan.found);
  if (scan.error) console.log('scan.error:', scan.error);
  if (scan.reason) console.log('scan.reason:', scan.reason);
  console.log('files:', (scan.files || []).map(f => `${f.name}=${f.exists ? '存在' : '无'}`).join(' | '));
  if (scan.provider) {
    console.log('provider.apiBase:', scan.provider.apiBase || '(空)');
    console.log('provider.apiKey:', redact(scan.provider.apiKey));
    console.log('provider.model:', scan.provider.model || '(空)');
  }
  const list = proxyConfigStore.listProviders(cliId);
  console.log('stored providers:', (list.providers || []).map(p => `${p.id}:${p.name}`).join(', ') || '(无)');
  console.log('activeRoute:', JSON.stringify(list.activeRoute || null));
}
