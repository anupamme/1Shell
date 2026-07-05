'use strict';
// 临时诊断 3：验证 importNativeProviderForCli 全链路（写入临时 dataDir，不动真实 data）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNativeCliConfig } = require(path.join(__dirname, '..', 'src', 'agents', 'native-cli-config'));
const { createProxyConfigStore } = require(path.join(__dirname, '..', 'src', 'routes', 'proxy.routes'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-import-test-'));
const proxyConfigStore = createProxyConfigStore(dataDir);
const ncc = createNativeCliConfig({
  dataDir,
  bridgeToken: '',
  port: 0,
  proxyConfigStore,
  mcpPresetStore: null,
  logger: { info() {}, warn() {}, error() {} },
});

function redact(v) { const s = String(v || ''); return s ? `${s.slice(0, 6)}…(${s.length})` : '(空)'; }

for (const cliId of ['claude-code', 'codex']) {
  const scan = ncc.scanNativeProviderConfig(cliId);
  if (!scan.found) { console.log(`${cliId}: scan not found`, scan.error || scan.reason || ''); continue; }
  try {
    const result = proxyConfigStore.upsertNativeProvider(cliId, scan.provider);
    const list = proxyConfigStore.listProviders(cliId);
    console.log(`\n=== ${cliId} ===`);
    console.log('upsert result:', JSON.stringify(result));
    console.log('providers now:', (list.providers || []).map(p => `${p.id} / ${p.name} / base=${p.apiBase} / key=${redact(p.apiKey)}`).join(' ; '));
    console.log('activeRoute:', JSON.stringify(list.activeRoute || null));
  } catch (err) {
    console.log(`${cliId}: upsert FAILED:`, err.message);
  }
}
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\ntemp dataDir cleaned');
