'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 二进制定位兜底 —— 不依赖进程 PATH。
 *
 * 背景：桌面版自启动等场景下后端进程的 PATH 可能残缺（Windows 键名
 * Path/PATH 大小写碰撞曾把真值遮蔽成只剩 runtime 目录），where.exe/
 * powershell/PATH 扫描全部失效，三个 CLI 全部误报"未安装"。npm 全局
 * 目录是固定绝对路径，直查即可兜住绝大多数安装场景（cc-switch 的思路：
 * 按约定的固定位置找，而不是依赖进程环境）。
 */

// npm 全局 bin 目录（npm-windows-installer / nvm-windows 的默认布局）
function npmGlobalBinDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  } else if (process.env.HOME) {
    dirs.push(path.join(process.env.HOME, '.npm-global', 'bin'));
    dirs.push(path.join(process.env.HOME, '.local', 'bin'));
  }
  return dirs;
}

function windowsPathExtCandidates(binary) {
  if (process.platform !== 'win32') return [binary];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  exts.sort((a, b) => (b.toLowerCase() === '.exe' ? 1 : 0) - (a.toLowerCase() === '.exe' ? 1 : 0));
  return exts.map((ext) => `${binary}${ext.toLowerCase()}`);
}

/**
 * 在 npm 全局目录里直查二进制（PATH 扫描失败时的兜底）。
 * @returns {string} 找到的绝对路径；未找到返回 ''
 */
function findBinaryInNpmGlobal(binary) {
  const clean = String(binary || '').trim();
  if (!clean) return '';
  const candidates = path.sep === '\\'
    ? windowsPathExtCandidates(clean)
    : [clean];
  for (const dir of npmGlobalBinDirs()) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch { /* keep scanning */ }
    }
  }
  return '';
}

module.exports = { npmGlobalBinDirs, findBinaryInNpmGlobal, windowsPathExtCandidates };
