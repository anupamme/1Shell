'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { __test } = require('../src/agents/cli-sandbox');

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
