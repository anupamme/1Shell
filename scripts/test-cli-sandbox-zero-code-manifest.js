'use strict';

/**
 * 验证:加一家新 openai 兼容 agent 只需在 manifest 填一份数据,
 *      0 行 cli-sandbox 代码改动 = ensureSandbox 跑通且生成预期文件。
 *
 * 4.3 Sprint B 验收标准 §5.3 #3 #4 的可执行版本。
 *
 * 做法:不污染真实 cli-manifest.js,直接 require 后给数组追加一份
 *      纯数据 manifest(虚构 'demo-openai' agent),跑 ensureSandbox,
 *      断言生成的 config 文件内容符合预期(stdio-bridge MCP 块 + static auth)。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { CLI_MANIFESTS } = require('../src/agents/cli-manifest');
const { createCliSandbox } = require('../src/agents/cli-sandbox');

// ---- 1. 注入一份纯数据 manifest(模拟 contrib 加新家)----
const DEMO_MANIFEST = {
  id: 'demo-openai',
  name: 'Demo OpenAI-Compatible Agent',
  icon: '◆',
  gradient: 'from-gray-400 to-gray-500',
  repo: 'example/demo-openai',
  description: '纯数据 manifest 验证用,非真实 agent',
  binary: 'demo',
  binaries: ['demo'],
  versionArgs: ['--version'],
  install: { command: '', docsUrl: '' },
  supportedOS: ['windows', 'macos', 'linux'],
  clientProtocol: 'openai',
  supportedUpstream: ['openai', 'anthropic'],
  proxyPath: '/api/proxy/demo',

  sandbox: {
    dirName: 'demo-openai',
    configDirEnv: 'DEMO_CONFIG_DIR',
    defaultConfigDir: '.demo',
    mcp: {
      transport: 'stdio-bridge',
      stdioCommand: 'node',
      stdioBridgeScript: '../bin/1shell-mcp-stdio.js',
    },
    configFiles: [
      {
        name: 'auth.json',
        mergeStrategy: 'overwrite',
        overwriteBuilder: 'static',
        content: { DEMO_API_KEY: 'sk-1shell-proxy' },
      },
      {
        name: 'mcp.json',
        mergeStrategy: 'deep-merge',
        mergePointer: 'mcp_servers.1shell',
      },
    ],
  },

  proxyEnv: {
    OPENAI_BASE_URL: '{serverUrl}/api/proxy/demo/v1',
    OPENAI_API_KEY: 'sk-1shell-proxy',
  },

  launchArgs: [],
  extraEnv: {},
};

const alreadyHasDemo = CLI_MANIFESTS.some(m => m.id === DEMO_MANIFEST.id);
if (!alreadyHasDemo) CLI_MANIFESTS.push(DEMO_MANIFEST);

// ---- 2. 跑 ensureSandbox ----
const FIXED_PORT = 3399;
const FIXED_BRIDGE_TOKEN = 'BRIDGE_TOKEN_ZERO_CODE_TEST';

const stubProvider = {
  id: 'p', name: 'P', apiBase: 'https://api.demo.test', apiKey: 'k',
  model: 'm', upstreamProtocol: 'openai', enabled: true,
};
const stubProxyConfigStore = {
  getActiveProvider: () => stubProvider,
  listProviders: () => ({ providers: [stubProvider], activeProviderId: 'p' }),
};

const tmpDataDir = path.join(os.tmpdir(), `1shell-zerocode-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDataDir, { recursive: true });

try {
  const sandbox = createCliSandbox({
    dataDir: tmpDataDir,
    bridgeToken: FIXED_BRIDGE_TOKEN,
    port: FIXED_PORT,
    proxyConfigStore: stubProxyConfigStore,
    claudeCodeSkillRegistry: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // 不应抛
  sandbox.ensureSandbox(DEMO_MANIFEST.id, { cwd: '/zerocode-cwd' });

  // ---- 3. 断言生成的文件符合 manifest 描述 ----
  const sandboxDir = path.join(tmpDataDir, 'cli-sandbox', DEMO_MANIFEST.sandbox.dirName);

  // auth.json 来自 static overwriteBuilder
  const authPath = path.join(sandboxDir, 'auth.json');
  assert.ok(fs.existsSync(authPath), 'auth.json 应被创建');
  const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.deepStrictEqual(authData, { DEMO_API_KEY: 'sk-1shell-proxy' }, 'auth.json 内容应来自 manifest.content');

  // mcp.json 来自 deep-merge,mergePointer=mcp_servers.1shell,值=buildMcpEntry('demo-openai')=stdio-bridge
  const mcpPath = path.join(sandboxDir, 'mcp.json');
  assert.ok(fs.existsSync(mcpPath), 'mcp.json 应被创建');
  const mcpData = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  const entry = mcpData?.mcp_servers?.['1shell'];
  assert.ok(entry, 'mcp.json 应含 mcp_servers.1shell');
  assert.strictEqual(entry.command, 'node', 'MCP entry 应是 stdio-bridge → node');
  assert.ok(Array.isArray(entry.args) && entry.args[0].endsWith('1shell-mcp-stdio.js'),
    'MCP entry args 应指向 1shell-mcp-stdio.js');
  assert.strictEqual(entry.env.ONESHELL_TOKEN, FIXED_BRIDGE_TOKEN, 'MCP entry env 应注入 bridgeToken');
  assert.strictEqual(entry.env.ONESHELL_URL, `http://127.0.0.1:${FIXED_PORT}`, 'MCP entry env 应注入 serverOrigin');

  // 校验 buildLaunchEnv 注入 proxyEnv
  const launchEnv = sandbox.buildLaunchEnv(DEMO_MANIFEST.id, { cwd: '/zerocode-cwd' });
  assert.strictEqual(launchEnv.OPENAI_BASE_URL, `http://127.0.0.1:${FIXED_PORT}/api/proxy/demo/v1`,
    'launchEnv 应渲染 proxyEnv 模板');
  assert.strictEqual(launchEnv.DEMO_CONFIG_DIR, sandboxDir, 'launchEnv 应注入 configDirEnv');

  console.log('✓ zero-code manifest 接入验证通过');
  console.log(`  - demo-openai sandbox 在 ${sandboxDir} 生成 ${fs.readdirSync(sandboxDir).length} 个文件`);
  console.log('  - auth.json 走 static overwriteBuilder');
  console.log('  - mcp.json 走 deep-merge + stdio-bridge MCP entry');
  console.log('  - launchEnv 渲染 proxyEnv 模板正确');
} finally {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  // 还原 manifest 数组,避免污染同进程后续测试
  const idx = CLI_MANIFESTS.findIndex(m => m.id === DEMO_MANIFEST.id);
  if (idx >= 0) CLI_MANIFESTS.splice(idx, 1);
}
