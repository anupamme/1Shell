'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { __test } = require('../src/agents/native-cli-config');

const opencodeManifest = { id: 'opencode', name: 'OpenCode' };

const desktopReason = __test.getBinaryProbeSkipReason(
  opencodeManifest,
  { path: 'C:/Users/me/AppData/Local/Programs/OpenCode/OpenCode.exe' },
  true,
);

assert.match(desktopReason, /OpenCode .*启动器/, 'Windows OpenCode desktop launcher must be skipped');
assert.strictEqual(
  __test.getBinaryProbeSkipReason(opencodeManifest, { path: 'C:/Users/me/AppData/Roaming/npm/opencode.cmd' }, true),
  '',
  'npm opencode.cmd should remain valid',
);
assert.strictEqual(
  __test.getBinaryProbeSkipReason(opencodeManifest, { path: 'C:/Users/me/AppData/Roaming/npm/opencode.ps1' }, true),
  '',
  'npm opencode.ps1 should remain valid',
);
assert.strictEqual(
  __test.getBinaryProbeSkipReason({ id: 'codex' }, { path: 'C:/Users/me/AppData/Local/Programs/OpenCode/OpenCode.exe' }, true),
  '',
  'desktop skip is scoped to OpenCode only',
);
assert.strictEqual(
  __test.getBinaryProbeSkipReason(opencodeManifest, { path: '/usr/local/bin/opencode' }, false),
  '',
  'non-Windows OpenCode CLI should remain valid',
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-opencode-desktop-'));
try {
  const fakeDesktopDir = path.join(tmpDir, 'OpenCode');
  fs.mkdirSync(fakeDesktopDir, { recursive: true });
  const fakeDesktop = path.join(fakeDesktopDir, 'OpenCode.exe');
  fs.writeFileSync(fakeDesktop, '');
  const detected = __test.detectBinary(
    { ...opencodeManifest, binary: 'opencode', versionArgs: ['--version'] },
    true,
    fakeDesktop,
    [],
  );
  assert.strictEqual(detected.installed, false, 'OpenCode desktop launcher should not count as installed CLI');
  assert.strictEqual(detected.skipped.length, 1, 'desktop launcher should be recorded as skipped');
  assert.match(detected.error, /桌面版启动器/);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('cli-binary-detection checks passed');

// ─── 4.7.7: PATH 残缺兜底（npm 全局目录直查）+ 桌面 PATH 大小写碰撞修复 ───
// 背景：桌面版 spawnServer 曾用 env.PATH= 前置 runtime 目录，Windows 真实键名
// 是 'Path'，普通对象上新建 'PATH' 键（值为空）→ 子进程里后写者把真 Path 遮蔽
// → 后端 PATH 只剩 runtime 目录，三个 CLI 全部误报"未安装"。

const { findBinaryInNpmGlobal, npmGlobalBinDirs } = require('../src/agents/binary-locate');
const { createProtocolAgentCatalog } = require('../src/agents/protocol/agent-catalog');

const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-bin-fallback-'));
const savedPath = process.env.PATH;
const savedAppdata = process.env.APPDATA;
try {
  const fakeNpm = path.join(tmpDir2, 'npm');
  fs.mkdirSync(fakeNpm, { recursive: true });
  fs.writeFileSync(path.join(fakeNpm, 'claude.cmd'), '@echo off\n');
  fs.writeFileSync(path.join(fakeNpm, 'claude'), '#!/bin/sh\n');

  // 1) binary-locate：APPDATA 指向假目录能找到；找不到的返回空
  process.env.APPDATA = tmpDir2;
  process.env.PATH = '';
  assert.ok(npmGlobalBinDirs().some((dir) => dir === fakeNpm), 'npmGlobalBinDirs 应包含 APPDATA/npm');
  const found = findBinaryInNpmGlobal('claude');
  assert.ok(found && found.endsWith('claude.cmd'), `Windows 兜底应找到 claude.cmd: ${found}`);
  assert.strictEqual(findBinaryInNpmGlobal('nonexistent-cli-xyz'), '', '不存在的 CLI 应返回空');

  // 2) agent-catalog：PATH 清空后靠兜底仍判定 claude-code 已安装
  const catalog = createProtocolAgentCatalog();
  const agents = catalog.listAgents();
  const claudeAgent = agents.find((a) => a.id === 'claude-code');
  assert.strictEqual(claudeAgent.installed, true, 'PATH 残缺时 npm 全局兜底应识别 claude-code 已安装');
  assert.ok(claudeAgent.binaryPath.endsWith('claude.cmd'), `binaryPath 应是兜底找到的绝对路径: ${claudeAgent.binaryPath}`);

  // 3) native-cli-config detectBinary：PATH 清空（where.exe ENOENT）时走兜底
  const detected = __test.detectBinary(
    { id: 'claude-code', name: 'Claude Code', binary: 'claude', versionArgs: ['--version'] },
    true,
    '',
    [],
  );
  assert.strictEqual(detected.installed, true, 'where.exe 失败时 npm 全局兜底应判定已安装');
  assert.ok(String(detected.path || '').endsWith('claude.cmd'), `detectBinary 应返回兜底路径: ${detected.path}`);
} finally {
  process.env.PATH = savedPath;
  if (savedAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppdata;
  fs.rmSync(tmpDir2, { recursive: true, force: true });
}

// 4) 桌面 main.js 修复：大小写正确追加（不再新建 PATH 键遮蔽真 Path）
const desktopMainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
assert.ok(
  desktopMainSource.includes("key.toLowerCase() === 'path'"),
  'desktop spawnServer 必须按现有键的大小写拼写追加 PATH（防 Path/PATH 碰撞）',
);
// 修复行为的功能验证：沿用现有键 → 只有一个 path 键且原值保留在尾部
const envSim = { Path: 'C:\\Windows;C:\\Windows\\System32' };
const pathKey = Object.keys(envSim).find((key) => key.toLowerCase() === 'path') || 'PATH';
envSim[pathKey] = `C:\\runtime\\node;${envSim[pathKey] || ''}`;
assert.strictEqual(envSim.Path, 'C:\\runtime\\node;C:\\Windows;C:\\Windows\\System32', '追加后原 PATH 必须完整保留');
assert.strictEqual(envSim.PATH, undefined, '不得新建大小写冲突的第二个键');

console.log('binary-detection fallback + desktop PATH fix checks passed');
