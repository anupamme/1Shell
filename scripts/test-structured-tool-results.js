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

const {
  displayAssistantTextAfterToolResult,
  parseProxyAccessResult,
} = moduleContext.exports;

const passedToolResult = 'verification passed: curl -x http://204.136.11.229:18317 https://example.com';
const parsedPassed = parseProxyAccessResult(passedToolResult);
assert.strictEqual(parsedPassed.host, '204.136.11.229');
assert.strictEqual(parsedPassed.httpPort, '18317');
assert.strictEqual(parsedPassed.password, '', 'passed must not be parsed as pass=ed');

const items = [
  {
    kind: 'tool',
    name: 'verify_outcome',
    result: passedToolResult,
  },
  {
    kind: 'assistant',
    role: 'assistant',
    text: '搭建完成 - GOST 代理服务\nHTTP 204.136.11.229:18317\n使用方式：curl -x http://204.136.11.229:18317 https://example.com',
  },
];

const displayed = displayAssistantTextAfterToolResult(items, 1, items[1].text);
assert.ok(displayed.includes('HTTP   204.136.11.229:18317'));
assert.ok(!displayed.includes('密码   ed'), 'proxy summary must not invent password ed');
assert.ok(displayed.includes('curl -x http://204.136.11.229:18317 https://example.com'));

const oldGeneratedSummary = [
  '搭建完成 - GOST 代理服务',
  '',
  '```text',
  'HTTP   204.136.11.229:18317',
  '密码   ed',
  '```',
  '',
  '使用方式',
  '',
  '```bash',
  'curl -x http://204.136.11.229:18317 https://example.com',
  '```',
].join('\n');
const repairedGenerated = displayAssistantTextAfterToolResult(items, 1, oldGeneratedSummary);
assert.ok(!repairedGenerated.includes('密码   ed'), 'old generated summaries must not re-ingest their own bogus password');

const displayedWithAuth = displayAssistantTextAfterToolResult(
  items,
  1,
  '搭建完成，HTTP 204.136.11.229:18317，user weidu password 628785220Jsw',
);
assert.ok(displayedWithAuth.includes('用户   weidu'));
assert.ok(displayedWithAuth.includes('密码   628785220Jsw'));
assert.ok(displayedWithAuth.includes('curl -x http://weidu:628785220Jsw@204.136.11.229:18317 https://example.com'));

const proxyToolResult = [
  'GOST proxy is ready',
  'SOCKS5 10.88.90.221:12325',
  'HTTP 10.88.90.221:12324',
].join('\n');
const vpsReport = [
  '| Service | URL | Status |',
  '| --- | --- | --- |',
  '| 1Panel HTTP service | https://example.com | running |',
  '| SSH | 10.88.90.221:22 | running |',
].join('\n');
const crossTurnItems = [
  { kind: 'user', role: 'user', text: '搭建 GOST 代理' },
  { kind: 'tool', name: 'execute_command', result: proxyToolResult },
  { kind: 'assistant', role: 'assistant', text: '搭建完成 - GOST 代理服务' },
  { kind: 'user', role: 'user', text: '探查这台 VPS 的情况' },
  { kind: 'assistant', role: 'assistant', text: vpsReport },
];
assert.strictEqual(
  displayAssistantTextAfterToolResult(crossTurnItems, 4, vpsReport),
  vpsReport,
  'proxy result from a previous user turn must not rewrite a normal VPS report',
);

const sameTurnOrdinaryReport = [
  { kind: 'tool', name: 'execute_command', result: proxyToolResult },
  { kind: 'assistant', role: 'assistant', text: vpsReport },
];
assert.strictEqual(
  displayAssistantTextAfterToolResult(sameTurnOrdinaryReport, 1, vpsReport),
  vpsReport,
  'normal HTTP service URLs must not trigger GOST proxy summary rewriting',
);

console.log('structured-tool-results: proxy parsing checks passed');
