#!/usr/bin/env node
'use strict';

/**
 * Package macOS release archives on a macOS host.
 *
 * Flavors:
 * - starter: source package with bootstrap start.sh; installs deps on first run.
 * - with-deps: includes production node_modules built on macOS.
 * - offline: includes production node_modules plus runtime/node.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const pkg = require(path.join(ROOT, 'package.json'));

const FLAVORS = new Set(['starter', 'with-deps', 'offline']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      throw new Error(`Unexpected argument: ${item}`);
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function defaultArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported Node architecture: ${process.arch}`);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    '-',
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join('');
}

function posixRel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function shouldCopy(src, rel, flavor) {
  if (!rel) return true;

  const top = rel.split('/')[0];
  if (top === '.git' || top === 'release' || top === '.npm-cache') return false;
  if (top === '.env' || top === '.DS_Store') return false;
  if (rel === 'npm-debug.log' || rel.endsWith('/npm-debug.log')) return false;
  if (rel === 'yarn-error.log' || rel.endsWith('/yarn-error.log')) return false;
  if (rel === 'frontend/node_modules' || rel.startsWith('frontend/node_modules/')) return false;
  if ((rel === 'node_modules' || rel.startsWith('node_modules/')) && flavor === 'starter') return false;
  if ((rel === 'runtime' || rel.startsWith('runtime/')) && flavor !== 'offline') return false;

  const name = path.basename(src);
  if (name === '.DS_Store') return false;
  return true;
}

function requirePath(target, message) {
  if (!fs.existsSync(target)) {
    throw new Error(message);
  }
}

function validateInputs(flavor) {
  requirePath(path.join(ROOT, 'package-lock.json'), 'package-lock.json is required.');
  requirePath(path.join(ROOT, 'server.js'), 'server.js is required.');
  requirePath(path.join(ROOT, 'frontend', 'dist', 'index.html'), 'frontend/dist is missing. Run npm --prefix frontend run build first.');

  if (flavor === 'with-deps' || flavor === 'offline') {
    requirePath(path.join(ROOT, 'node_modules', 'better-sqlite3'), 'node_modules is missing. Run npm ci --omit=dev first.');
    requirePath(path.join(ROOT, 'node_modules', 'node-pty'), 'node_modules is missing. Run npm ci --omit=dev first.');
  }

  if (flavor === 'offline') {
    requirePath(path.join(ROOT, 'runtime', 'node', 'bin', 'node'), 'runtime/node is missing. Download macOS Node.js before packaging offline.');
  }
}

function copyBootstrapStart(outDir) {
  const src = path.join(ROOT, 'scripts', 'start-bootstrap.sh');
  const dest = path.join(outDir, 'start.sh');
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
}

function makeExecutable(outDir) {
  for (const rel of ['start.sh', 'install.sh', 'bin/1shell-mcp-stdio.js']) {
    const target = path.join(outDir, rel);
    if (fs.existsSync(target)) {
      fs.chmodSync(target, 0o755);
    }
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const flavor = args.flavor || 'offline';
  const arch = args.arch || defaultArch();
  const stamp = args.timestamp || timestamp();

  if (!FLAVORS.has(flavor)) {
    throw new Error(`Unsupported flavor "${flavor}". Use one of: ${Array.from(FLAVORS).join(', ')}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported macOS arch "${arch}". Use x64 or arm64.`);
  }

  validateInputs(flavor);

  const packageName = `1shell-${pkg.version}-macos-${arch}-${flavor}-${stamp}`;
  const workBase = args['work-dir'] ? path.resolve(args['work-dir']) : (process.env.RUNNER_TEMP || os.tmpdir());
  const workDir = path.join(workBase, `1shell-work-macos-${arch}-${flavor}-${stamp}`);
  const outDir = path.join(workDir, packageName);
  const tarball = path.join(RELEASE_DIR, `${packageName}.tar.gz`);
  const checksumFile = `${tarball}.sha256.txt`;

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(tarball, { force: true });
  fs.rmSync(checksumFile, { force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  fs.cpSync(ROOT, outDir, {
    recursive: true,
    dereference: false,
    filter(src) {
      return shouldCopy(src, posixRel(ROOT, src), flavor);
    },
  });

  if (flavor === 'starter' || flavor === 'offline') {
    copyBootstrapStart(outDir);
  }
  makeExecutable(outDir);

  execFileSync('tar', ['-czf', tarball, '-C', workDir, packageName], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const digest = sha256File(tarball);
  fs.writeFileSync(checksumFile, `${digest}  ${path.basename(tarball)}\n`);

  const result = {
    packageName,
    flavor,
    arch,
    tarball: posixRel(ROOT, tarball),
    checksum: posixRel(ROOT, checksumFile),
    sha256: digest,
  };
  console.log(JSON.stringify(result, null, 2));
}

main();
