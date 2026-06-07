#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const OUTPUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(RELEASE_DIR, 'repacked');

const ASSETS = [
  '1shell-4.1.0-linux-x64-with-deps-20260606-211813.tar.gz',
  '1shell-4.1.0-windows-x64-with-deps-20260606-211813.zip',
];

const FILES = [
  '.dockerignore',
  '.env.example',
  '.gitignore',
  '.npmignore',
  'docker-compose.yml',
  'Dockerfile',
  'HARNESS_DESIGN.md',
  'install.sh',
  'LICENSE',
  'package-lock.json',
  'package.json',
  'README.md',
  'SECURITY.md',
  'server.js',
  'start.bat',
  'start.sh',
];

const DIRS = [
  '.github',
  'agent',
  'bin',
  'data/skills',
  'desktop',
  'docs',
  'frontend/dist',
  'frontend/public',
  'frontend/src',
  'frontend/index.html',
  'frontend/package-lock.json',
  'frontend/package.json',
  'frontend/postcss.config.js',
  'frontend/tailwind.config.js',
  'frontend/tsconfig.json',
  'frontend/tsconfig.node.json',
  'frontend/vite.config.ts',
  'frontend/env.d.ts',
  'lib',
  'public',
  'scripts',
  'src',
];

function posixRel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function cp(src, dest) {
  if (!fs.existsSync(src)) return;
  rm(dest);
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter(current) {
      const rel = posixRel(src, current);
      if (!rel) return true;
      const parts = rel.split('/');
      return !parts.includes('node_modules')
        && !parts.includes('.npm-cache')
        && !parts.includes('.go-cache')
        && !parts.includes('.gomod-cache');
    },
  });
}

function findPackageDir(workDir) {
  const entries = fs.readdirSync(workDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workDir, entry.name));
  if (entries.length !== 1) {
    throw new Error(`Expected one package directory in ${workDir}, found ${entries.length}`);
  }
  return entries[0];
}

function overlay(packageDir) {
  for (const rel of FILES) {
    const src = path.join(ROOT, rel);
    const dest = path.join(packageDir, rel);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  for (const rel of DIRS) {
    cp(path.join(ROOT, rel), path.join(packageDir, rel));
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function repack(assetName) {
  const source = path.join(RELEASE_DIR, assetName);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing local asset: ${source}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshell-repack-'));
  try {
    const extractArgs = ['-xf', source, '-C', workDir];
    if (assetName.endsWith('.tar.gz') && process.platform === 'win32') {
      extractArgs.push('--exclude=*/node_modules/.bin/*');
    }
    execFileSync('tar', extractArgs, { stdio: 'inherit' });
    const packageDir = findPackageDir(workDir);
    overlay(packageDir);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const output = path.join(OUTPUT_DIR, assetName);
    rm(output);
    if (assetName.endsWith('.zip')) {
      execFileSync('tar', ['-a', '-cf', output, '-C', workDir, path.basename(packageDir)], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['-czf', output, '-C', workDir, path.basename(packageDir)], { stdio: 'inherit' });
    }

    const digest = sha256File(output);
    fs.writeFileSync(`${output}.sha256.txt`, `${digest}  ${assetName}\n`, 'utf8');
    console.log(JSON.stringify({ asset: assetName, sha256: digest, output }, null, 2));
  } finally {
    rm(workDir);
  }
}

for (const asset of ASSETS) {
  repack(asset);
}
