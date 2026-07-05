'use strict';

// Windows spawn 兼容：npm 全局 CLI 在 Windows 上是 .cmd/.ps1 shim，
// child_process.spawn 无法直接执行（Node ≥18.20 对 .cmd 还会抛 EINVAL），
// 需要包一层 cmd.exe / powershell.exe；对应地，杀进程必须杀整棵树，
// 否则只杀掉 shell 壳、真正的 agent 进程变成孤儿。

const { spawn } = require('child_process');

function buildSpawnCommand(binaryPath, args = []) {
  if (process.platform === 'win32') {
    if (/\.(cmd|bat)$/i.test(binaryPath)) {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', binaryPath, ...args],
      };
    }
    if (/\.ps1$/i.test(binaryPath)) {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', binaryPath, ...args],
      };
    }
  }
  return { command: binaryPath, args };
}

function killProcessTree(child, { escalateMs = 3000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      } catch { /* fall through */ }
    }
    try { child.kill(); } catch { /* ignore */ }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const timer = setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, escalateMs);
  timer.unref?.();
}

module.exports = { buildSpawnCommand, killProcessTree };
