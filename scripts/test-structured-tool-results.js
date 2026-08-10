'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('../frontend/node_modules/typescript');

const sourcePath = path.join(__dirname, '..', 'frontend', 'src', 'utils', 'structuredToolResults.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const moduleContext = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleContext,
  exports: moduleContext.exports,
  URL,
  console,
  require,
}, { filename: sourcePath });

const { displayAssistantTextAfterToolResult } = moduleContext.exports;

const generatedProxyTitle = '搭建完成 - GOST 代理服务';

const fileText = [
  'HTTP 192.0.2.10:8080',
  '密码 OX81WGskwhij0CH6WJXc5psu',
].join('\n');
const readRemoteFileItems = [
  { kind: 'user', role: 'user', text: '登录的账号密码是什么' },
  { kind: 'tool', name: 'read_remote_file', result: fileText },
  { kind: 'assistant', role: 'assistant', text: fileText },
];
const displayedFileText = displayAssistantTextAfterToolResult(readRemoteFileItems, 2, fileText);
assert.strictEqual(
  displayedFileText,
  fileText,
  'read_remote_file content must stay as assistant text, not become a GOST proxy summary',
);
assert.ok(
  !displayedFileText.includes(generatedProxyTitle),
  'frontend must not generate a GOST proxy title from file contents',
);

const commandText = [
  'verification passed: curl -x http://198.51.100.23:18317 https://example.com',
  'HTTP 198.51.100.23:18317',
  '密码 secret-value',
].join('\n');
const commandItems = [
  { kind: 'tool', name: 'execute_command', result: commandText },
  { kind: 'assistant', role: 'assistant', text: commandText },
];
assert.strictEqual(
  displayAssistantTextAfterToolResult(commandItems, 1, commandText),
  commandText,
  'execute_command output must not be replaced by a frontend-authored GOST proxy summary',
);

const explicitAssistantSummary = [
  generatedProxyTitle,
  '',
  '```text',
  'HTTP   198.51.100.23:18317',
  '密码   ed',
  '```',
  '',
  '使用方式',
  '',
  '```bash',
  'curl -x http://198.51.100.23:18317 https://example.com',
  '```',
].join('\n');
assert.strictEqual(
  displayAssistantTextAfterToolResult(commandItems, 1, explicitAssistantSummary),
  explicitAssistantSummary,
  'frontend must not repair or rewrite assistant-authored proxy text',
);

const proxyToolResult = [
  'GOST proxy is ready',
  'SOCKS5 203.0.113.21:12325',
  'HTTP 203.0.113.21:12324',
].join('\n');
const vpsReport = [
  '| Service | URL | Status |',
  '| --- | --- | --- |',
  '| 1Panel HTTP service | https://example.com | running |',
  '| SSH | 203.0.113.21:22 | running |',
].join('\n');
const crossTurnItems = [
  { kind: 'user', role: 'user', text: '搭建 GOST 代理' },
  { kind: 'tool', name: 'execute_command', result: proxyToolResult },
  { kind: 'assistant', role: 'assistant', text: generatedProxyTitle },
  { kind: 'user', role: 'user', text: '探查这台 VPS 的情况' },
  { kind: 'assistant', role: 'assistant', text: vpsReport },
];
assert.strictEqual(
  displayAssistantTextAfterToolResult(crossTurnItems, 4, vpsReport),
  vpsReport,
  'previous proxy-like tool text must not rewrite a later VPS report',
);

const sameTurnOrdinaryReport = [
  { kind: 'tool', name: 'execute_command', result: proxyToolResult },
  { kind: 'assistant', role: 'assistant', text: vpsReport },
];
assert.strictEqual(
  displayAssistantTextAfterToolResult(sameTurnOrdinaryReport, 1, vpsReport),
  vpsReport,
  'normal HTTP service URLs must not trigger proxy summary rewriting',
);

const hostToolResult = JSON.stringify({
  ok: true,
  data: {
    hosts: [
      { id: 'local', name: '本机', type: 'local' },
      { id: 'host_123456abcdef', name: 'example-vps', host: '203.0.113.12', port: 22, type: 'ssh' },
    ],
  },
});
const hostAssistantText = [
  '当前共有 2 台主机：',
  '- 本机 local',
  '- example-vps 203.0.113.12:22',
].join('\n');
assert.strictEqual(
  displayAssistantTextAfterToolResult([
    { kind: 'tool', name: 'list_hosts', result: hostToolResult },
    { kind: 'assistant', role: 'assistant', text: hostAssistantText },
  ], 1, hostAssistantText),
  hostAssistantText,
  'host list assistant text must stay model-authored and must not be replaced by frontend reference text',
);

const probeToolResult = JSON.stringify({
  ok: true,
  data: {
    probes: [
      { hostId: 'local', name: '本机', online: true, cpuUsage: 1.2, memoryUsage: 35, diskUsage: 20, platform: 'Linux' },
      { hostId: 'host_123456abcdef', name: 'lax4', online: true, cpuUsage: 3.4, memoryUsage: 40, diskUsage: 28, platform: 'Ubuntu' },
    ],
  },
});
const probeAssistantText = [
  '| 主机 | 状态 | CPU | 内存 | 磁盘 |',
  '| --- | --- | --- | --- | --- |',
  '| 本机 | 在线 | 1.2% | 35% | 20% |',
  '| lax4 | 在线 | 3.4% | 40% | 28% |',
].join('\n');
assert.strictEqual(
  displayAssistantTextAfterToolResult([
    { kind: 'tool', name: 'list_probes', result: probeToolResult },
    { kind: 'assistant', role: 'assistant', text: probeAssistantText },
  ], 1, probeAssistantText),
  probeAssistantText,
  'probe assistant text must stay model-authored and must not be replaced by frontend summary text',
);

console.log('structured-tool-results: assistant text is never frontend-rewritten');
