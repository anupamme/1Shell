'use strict';

/**
 * cli-sandbox 字节级快照测试 — 4.3 Sprint B 验收硬约束
 *
 * 目的:manifest 数据驱动化重构期间,保证三家 CLI 的沙箱 config 文件字节
 *      级别不变。任何字节差异 = fail = 现有用户沙箱会被破坏。
 *
 * 用法:
 *   node scripts/test-cli-sandbox-snapshot.js              # diff 模式,与基线比对
 *   node scripts/test-cli-sandbox-snapshot.js --update     # 更新基线(初次/有意改动时用)
 *
 * 输入归一化(保证可重现):
 *   - 临时 dataDir(每次干净)
 *   - 固定的 port / bridgeToken
 *   - 不注入真实 proxyConfigStore(用 stub 给固定 active provider)
 *   - 不注入 claudeCodeSkillRegistry(避免读真实 skill 目录)
 *   - cwd 用固定占位符
 *
 * 快照存到 scripts/__snapshots__/cli-sandbox/<cliId>/
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCliSandbox } = require('../src/agents/cli-sandbox');
const { getAllManifests } = require('../src/agents/cli-manifest');

const SNAPSHOT_ROOT = path.join(__dirname, '__snapshots__', 'cli-sandbox');
const FIXED_PORT = 3399;
const FIXED_BRIDGE_TOKEN = 'BRIDGE_TOKEN_FOR_SNAPSHOT_TEST';
const FIXED_CWD_PLACEHOLDER = '/snapshot-fixed-cwd';

const FIXED_PROVIDER = {
  id: 'snap-provider',
  name: 'Snapshot Provider',
  apiBase: 'https://api.snapshot.test',
  apiKey: 'sk-snapshot-test',
  model: 'snapshot-model-v1',
  upstreamProtocol: 'openai',
  enabled: true,
};

const stubProxyConfigStore = {
  getActiveProvider: () => FIXED_PROVIDER,
  listProviders: () => ({ providers: [FIXED_PROVIDER], activeProviderId: FIXED_PROVIDER.id }),
};

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const isUpdate = process.argv.includes('--update');

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), `1shell-sandbox-snap-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readDirRecursive(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        out[relPath] = fs.readFileSync(full);
      }
    }
  };
  walk(root, '');
  return out;
}

function normalizeContent(content, dataDir) {
  // 把临时 dataDir 路径替换为占位符,避免快照里出现真实路径
  let text = content.toString('utf8');
  text = text.replaceAll(dataDir, '<TMP_DATA_DIR>');
  // home 目录在 buildMcpEntry 等地方不出现,但 stdio bridge 脚本路径会带
  // 项目根路径(path.join(dataDir, '..', 'bin', '...')),也归一化
  const projectRoot = path.resolve(__dirname, '..');
  text = text.replaceAll(projectRoot, '<PROJECT_ROOT>');
  // Windows 路径分隔符归一化(快照在 git 里跨平台)
  text = text.replaceAll(path.sep === '\\' ? '\\\\' : '@@noop@@', '/');
  text = text.replaceAll(path.sep, '/');
  return text;
}

function captureSandboxArtifacts(cliId, dataDir) {
  const sandboxRoot = path.join(dataDir, 'cli-sandbox');
  // 三家的目录可能是 cli-sandbox/<dirName> 或带 configSubDir
  const all = readDirRecursive(sandboxRoot);
  // 只保留这个 cliId 相关的(按 manifest.sandbox.dirName 过滤)
  const { getManifest } = require('../src/agents/cli-manifest');
  const manifest = getManifest(cliId);
  const dirPrefix = manifest.sandbox.dirName + '/';
  const filtered = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(dirPrefix)) continue;
    // 排除 .1shell-meta.json(含 updatedAt 时间戳,不稳定)
    if (k.endsWith('.1shell-meta.json')) continue;
    filtered[k] = normalizeContent(v, dataDir);
  }
  return filtered;
}

function writeSnapshot(cliId, artifacts) {
  const dir = path.join(SNAPSHOT_ROOT, cliId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(artifacts)) {
    const target = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

function readSnapshot(cliId) {
  const dir = path.join(SNAPSHOT_ROOT, cliId);
  if (!fs.existsSync(dir)) return null;
  const out = {};
  const walk = (curDir, rel) => {
    for (const entry of fs.readdirSync(curDir, { withFileTypes: true })) {
      const full = path.join(curDir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile()) out[relPath] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

function diffArtifacts(expected, actual) {
  const expectedKeys = new Set(Object.keys(expected));
  const actualKeys = new Set(Object.keys(actual));
  const issues = [];

  for (const k of expectedKeys) {
    if (!actualKeys.has(k)) issues.push(`MISSING: ${k}`);
    else if (expected[k] !== actual[k]) {
      issues.push(`DIFF:    ${k}\n  expected (snapshot):\n${indent(expected[k], '    ')}\n  actual:\n${indent(actual[k], '    ')}`);
    }
  }
  for (const k of actualKeys) {
    if (!expectedKeys.has(k)) issues.push(`UNEXPECTED: ${k}\n${indent(actual[k], '  ')}`);
  }
  return issues;
}

function indent(text, prefix) {
  return text.split('\n').map(l => prefix + l).join('\n');
}

function runForCli(cliId) {
  const dataDir = makeTempDataDir();
  try {
    const sandbox = createCliSandbox({
      dataDir,
      bridgeToken: FIXED_BRIDGE_TOKEN,
      port: FIXED_PORT,
      proxyConfigStore: stubProxyConfigStore,
      claudeCodeSkillRegistry: null, // 关闭,避免读真实 skill 目录
      logger: silentLogger,
    });
    sandbox.ensureSandbox(cliId, { cwd: FIXED_CWD_PLACEHOLDER });
    const artifacts = captureSandboxArtifacts(cliId, dataDir);

    if (Object.keys(artifacts).length === 0) {
      throw new Error(`[${cliId}] ensureSandbox 未产出任何文件,可能 manifest 配置有问题`);
    }

    if (isUpdate) {
      writeSnapshot(cliId, artifacts);
      console.log(`  [${cliId}] 写入 ${Object.keys(artifacts).length} 个文件到快照`);
      return { cliId, ok: true, updated: true };
    }

    const snapshot = readSnapshot(cliId);
    if (!snapshot) {
      throw new Error(`[${cliId}] 快照不存在,请先运行 --update 建立基线`);
    }

    const issues = diffArtifacts(snapshot, artifacts);
    if (issues.length > 0) {
      console.error(`\n[${cliId}] 快照不匹配 (${issues.length} 处):`);
      for (const issue of issues) console.error('  ' + issue);
      return { cliId, ok: false };
    }

    console.log(`  [${cliId}] OK (${Object.keys(artifacts).length} 个文件字节匹配)`);
    return { cliId, ok: true };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function main() {
  console.log(isUpdate ? '建立 cli-sandbox 快照基线...' : '验证 cli-sandbox 与基线一致...');
  const results = [];
  for (const manifest of getAllManifests()) {
    results.push(runForCli(manifest.id));
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} CLI 沙箱与基线不一致 ✗`);
    process.exit(1);
  }
  console.log(`\n${results.length}/${results.length} CLI 沙箱字节级匹配 ✓`);
}

main();
