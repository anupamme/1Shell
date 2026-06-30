#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const archiver = require('archiver');
const crypto = require('crypto');
const extractZip = require('extract-zip');
const { once } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const OUTPUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(RELEASE_DIR, 'repacked');
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = String(pkg.version || '0.0.0');
const FRONTEND_DIST_DIR = path.join(ROOT, 'frontend', 'dist');
const FRONTEND_INDEX = path.join(FRONTEND_DIST_DIR, 'index.html');
const FRONTEND_BUILD_MARKER = path.join(FRONTEND_DIST_DIR, '.1shell-build.json');

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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(args) {
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', ['npm', ...args].join(' ')], { cwd: ROOT, stdio: 'inherit' });
    return;
  }
  execFileSync(npmCommand(), args, { cwd: ROOT, stdio: 'inherit' });
}

function currentGitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function requireFile(filePath, message) {
  if (!fs.existsSync(filePath)) throw new Error(message);
}

function writeFrontendBuildMarker() {
  fs.writeFileSync(FRONTEND_BUILD_MARKER, JSON.stringify({
    version: VERSION,
    gitHead: currentGitHead(),
    builtAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function runFrontendBuild() {
  requireFile(path.join(ROOT, 'frontend', 'package.json'), 'Missing frontend/package.json');
  console.log(`[repack] Building frontend/dist for 1Shell ${VERSION}...`);
  runNpm(['--prefix', 'frontend', 'run', 'build']);
  requireFile(FRONTEND_INDEX, 'frontend/dist/index.html is missing after build');
  writeFrontendBuildMarker();
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

function chmodIfExists(packageDir, rel, mode = 0o755) {
  const target = path.join(packageDir, rel);
  if (!fs.existsSync(target)) return;
  fs.chmodSync(target, mode);
}

function chmodFilesInDir(packageDir, rel, mode = 0o755) {
  const dir = path.join(packageDir, rel);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      chmodIfExists(packageDir, path.join(rel, entry.name), mode);
    }
  }
}

function restoreExecutableBits(packageDir) {
  for (const rel of [
    'start.sh',
    'install.sh',
    'scripts/start-bootstrap.sh',
    'bin/1shell-mcp-stdio.js',
    'runtime/node/bin/node',
    'runtime/node/bin/npm',
    'runtime/node/bin/npx',
    'runtime/node/bin/corepack',
  ]) {
    chmodIfExists(packageDir, rel);
  }
  chmodFilesInDir(packageDir, 'agent/dist');
  chmodFilesInDir(packageDir, 'runtime/node/bin');
}

function isExecutableRel(rel) {
  const normalized = rel.split(path.sep).join('/');
  return normalized === 'start.sh'
    || normalized === 'install.sh'
    || normalized === 'scripts/start-bootstrap.sh'
    || normalized === 'bin/1shell-mcp-stdio.js'
    || normalized.startsWith('runtime/node/bin/')
    || normalized.startsWith('agent/dist/')
    || normalized.includes('/node_modules/.bin/');
}

function tarModeFor(rel, stat) {
  if (stat.isDirectory()) return 0o755;
  if (stat.isSymbolicLink()) return 0o777;
  return isExecutableRel(rel) ? 0o755 : 0o644;
}

function toTarPath(value) {
  return value.split(path.sep).join('/');
}

function writeString(buf, offset, length, value) {
  const data = Buffer.from(String(value), 'utf8');
  data.copy(buf, offset, 0, Math.min(length, data.length));
}

function writeOctal(buf, offset, length, value) {
  const text = Math.floor(Number(value) || 0).toString(8).padStart(length - 1, '0');
  writeString(buf, offset, length, `${text.slice(-(length - 1))}\0`);
}

function splitTarName(name) {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const tail = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(tail) <= 100) {
      return { name: tail, prefix };
    }
  }
  return null;
}

function tarHeader({ name, mode, uid = 0, gid = 0, size = 0, mtime = Math.floor(Date.now() / 1000), type = '0', linkname = '', uname = 'root', gname = 'root' }) {
  const buf = Buffer.alloc(512, 0);
  const split = splitTarName(name) || { name: name.slice(0, 100), prefix: '' };
  writeString(buf, 0, 100, split.name);
  writeOctal(buf, 100, 8, mode);
  writeOctal(buf, 108, 8, uid);
  writeOctal(buf, 116, 8, gid);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, mtime);
  for (let i = 148; i < 156; i += 1) buf[i] = 0x20;
  writeString(buf, 156, 1, type);
  writeString(buf, 157, 100, linkname);
  writeString(buf, 257, 6, 'ustar');
  writeString(buf, 263, 2, '00');
  writeString(buf, 265, 32, uname);
  writeString(buf, 297, 32, gname);
  writeString(buf, 345, 155, split.prefix);
  let sum = 0;
  for (const byte of buf) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0');
  writeString(buf, 148, 8, `${checksum}\0 `);
  return buf;
}

async function writeAll(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function writePadded(stream, size) {
  const remainder = size % 512;
  if (remainder) await writeAll(stream, Buffer.alloc(512 - remainder));
}

async function writeLongName(stream, type, value) {
  const body = Buffer.from(`${value}\0`, 'utf8');
  await writeAll(stream, tarHeader({
    name: '././@LongLink',
    mode: 0o644,
    size: body.length,
    type,
  }));
  await writeAll(stream, body);
  await writePadded(stream, body.length);
}

async function writeEntryHeader(stream, entry) {
  if (!splitTarName(entry.name)) {
    await writeLongName(stream, 'L', entry.name);
  }
  if (entry.linkname && Buffer.byteLength(entry.linkname) > 100) {
    await writeLongName(stream, 'K', entry.linkname);
  }
  await writeAll(stream, tarHeader(entry));
}

async function addTarEntry(stream, rootDir, absPath) {
  const stat = fs.lstatSync(absPath);
  let rel = toTarPath(path.relative(rootDir, absPath));
  if (!rel) return;
  const entryName = stat.isDirectory() && !rel.endsWith('/') ? `${rel}/` : rel;
  const packageRel = rel.split('/').slice(1).join('/');
  const mode = tarModeFor(packageRel, stat);
  const mtime = Math.floor(stat.mtimeMs / 1000);

  if (stat.isDirectory()) {
    await writeEntryHeader(stream, { name: entryName, mode, size: 0, type: '5', mtime });
    const children = fs.readdirSync(absPath)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => path.join(absPath, name));
    for (const child of children) {
      await addTarEntry(stream, rootDir, child);
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    await writeEntryHeader(stream, {
      name: entryName,
      mode,
      size: 0,
      type: '2',
      linkname: toTarPath(fs.readlinkSync(absPath)),
      mtime,
    });
    return;
  }

  if (!stat.isFile()) return;

  await writeEntryHeader(stream, {
    name: entryName,
    mode,
    size: stat.size,
    type: '0',
    mtime,
  });

  const input = fs.createReadStream(absPath);
  for await (const chunk of input) {
    await writeAll(stream, chunk);
  }
  await writePadded(stream, stat.size);
}

async function createTarGz(output, workDir, packageName) {
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(output);
  gzip.pipe(out);
  await addTarEntry(gzip, workDir, path.join(workDir, packageName));
  await writeAll(gzip, Buffer.alloc(1024));
  gzip.end();
  await once(out, 'finish');
}

async function createZip(output, workDir, packageName) {
  const out = fs.createWriteStream(output);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(out);
  archive.directory(path.join(workDir, packageName), packageName);
  await archive.finalize();
  await once(out, 'finish');
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

async function repack(asset) {
  const sourceAsset = pickSourceAsset(asset);
  const source = sourceAsset.filePath;
  if (!fs.existsSync(source)) {
    throw new Error(`Missing local asset: ${source}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshell-repack-'));
  try {
    if (sourceAsset.name.endsWith('.zip')) {
      await extractZip(source, { dir: workDir });
    } else {
      const extractArgs = ['-xf', source, '-C', workDir];
      if (sourceAsset.name.endsWith('.tar.gz') && process.platform === 'win32') {
        extractArgs.push('--exclude=*/node_modules/.bin/*');
      }
      execFileSync('tar', extractArgs, { stdio: 'inherit' });
    }
    let packageDir = findPackageDir(workDir);
    overlay(packageDir);
    restoreExecutableBits(packageDir);
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
      await createZip(output, workDir, path.basename(packageDir));
    } else {
      await createTarGz(output, workDir, path.basename(packageDir));
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

(async () => {
  runFrontendBuild();
  for (const asset of ASSETS) {
    await repack(asset);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
