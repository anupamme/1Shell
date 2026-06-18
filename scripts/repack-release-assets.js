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
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = String(pkg.version || '0.0.0');

const ASSETS = [
  {
    platform: 'linux',
    sourcePattern: /^1shell-\d+\.\d+\.\d+-linux-x64-offline-.*\.tar\.gz$/,
    outputName: `1shell-${VERSION}-linux-x64.tar.gz`,
    packageName: `1shell-${VERSION}-linux-x64`,
  },
  {
    platform: 'windows',
    sourcePattern: /^1shell-\d+\.\d+\.\d+-windows-x64-offline-.*\.zip$/,
    outputName: `1shell-${VERSION}-windows-x64.zip`,
    packageName: `1shell-${VERSION}-windows-x64`,
  },
];

const FILES = [
  '.dockerignore',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.npmignore',
  '.nvmrc',
  'CHANGELOG.md',
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

function pickSourceAsset(asset) {
  const candidates = fs.readdirSync(RELEASE_DIR)
    .filter((name) => asset.sourcePattern.test(name))
    .map((name) => {
      const filePath = path.join(RELEASE_DIR, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  if (!candidates.length) {
    throw new Error(`Missing ${asset.platform} base asset in ${RELEASE_DIR}`);
  }
  return candidates[0];
}

function repack(asset) {
  const sourceAsset = pickSourceAsset(asset);
  const source = sourceAsset.filePath;
  if (!fs.existsSync(source)) {
    throw new Error(`Missing local asset: ${source}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshell-repack-'));
  try {
    const extractArgs = ['-xf', source, '-C', workDir];
    if (sourceAsset.name.endsWith('.tar.gz') && process.platform === 'win32') {
      extractArgs.push('--exclude=*/node_modules/.bin/*');
    }
    execFileSync('tar', extractArgs, { stdio: 'inherit' });
    let packageDir = findPackageDir(workDir);
    overlay(packageDir);
    if (path.basename(packageDir) !== asset.packageName) {
      const renamedPackageDir = path.join(workDir, asset.packageName);
      rm(renamedPackageDir);
      fs.renameSync(packageDir, renamedPackageDir);
      packageDir = renamedPackageDir;
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const output = path.join(OUTPUT_DIR, asset.outputName);
    rm(output);
    if (asset.outputName.endsWith('.zip')) {
      execFileSync('tar', ['-a', '-cf', output, '-C', workDir, path.basename(packageDir)], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['-czf', output, '-C', workDir, path.basename(packageDir)], { stdio: 'inherit' });
    }

    const digest = sha256File(output);
    fs.writeFileSync(`${output}.sha256.txt`, `${digest}  ${asset.outputName}\n`, 'utf8');
    console.log(JSON.stringify({
      source: sourceAsset.name,
      asset: asset.outputName,
      sha256: digest,
      output,
    }, null, 2));
  } finally {
    rm(workDir);
  }
}

for (const asset of ASSETS) {
  repack(asset);
}
