'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');
const { decryptText, encryptText, isUsingFallbackSecret } = require('../../lib/crypto');

/**
 * 在线更新服务（对齐 kiro.rs 的"下载 release 压缩包替换"模型，但落地的是整个 node app）
 *
 * 机制：
 *   1. 从 GitHub Releases API 查最新版本 + 更新日志；
 *   2. 下载 1shell-<版本>-<平台>.(tar.gz|zip)，校验 <asset>.sha256.txt；
 *   3. 解压到临时目录，把当前 app 目录备份到 <appRoot>.backup，再原子替换；
 *   4. 返回 needRestart=true，由调用方触发进程退出，supervisor（docker
 *      restart:unless-stopped / systemd Restart）拉起新版本。
 *   5. 回退：把 .backup 换回当前目录后重启。
 *
 * 桌面版（ONESHELL_DESKTOP=1）不走这里，由 electron-updater 负责。
 */

const GITHUB_OWNER = 'weidu12123';
const GITHUB_REPO = '1Shell';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const RATELIMIT_API = 'https://api.github.com/rate_limit';
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // node app 含 node_modules，留 500MB 上限

function createUpdaterService({ rootDir, dataDir, logger = console } = {}) {
  const appRoot = rootDir || path.resolve(__dirname, '..', '..');
  const resolvedDataDir = dataDir || path.join(appRoot, 'data');
  const configPath = path.join(resolvedDataDir, 'updater-config.json');

  // 内存态：最近一次检查结果（不持久化，重启后重新查）
  let latest = {
    checkedAt: null,
    version: '',
    publishedAt: '',
    releaseName: '',
    releaseNotes: '',
    htmlUrl: '',
    asset: null, // { name, url, size }
    error: '',
  };
  let rateLimit = { limit: 0, used: 0, remaining: 0, resetAt: '', authenticated: false };
  let applying = false;
  let autoTimer = null;

  // ── 构建类型 / 版本 ──────────────────────────────────────────────────
  function isDocker() {
    return process.env.ONESHELL_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  }
  function isDesktop() {
    return process.env.ONESHELL_DESKTOP === '1';
  }
  function buildType() {
    if (isDesktop()) return 'desktop';
    if (isDocker()) return 'docker';
    return 'binary'; // git/源码/release 包部署，对外统称 binary（与截图一致）
  }

  function currentVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
      return String(pkg.version || '0.0.0');
    } catch {
      return '0.0.0';
    }
  }

  function normalizeVersion(v) {
    return String(v || '').trim().replace(/^v/i, '');
  }

  // 语义版本比较：a>b → 1, a<b → -1, 相等 → 0
  function compareVersions(a, b) {
    const pa = normalizeVersion(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = normalizeVersion(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  // ── 配置存储（token + 自动更新设置 + 上次更新时间/上一版本）──────────
  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return {};
    }
  }
  function writeConfig(patch) {
    const next = { ...readConfig(), ...patch };
    Object.keys(next).forEach((key) => {
      if (next[key] === undefined) delete next[key];
    });
    if (next.encryptedGithubToken) delete next.githubToken;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
  function getToken() {
    const cfg = readConfig();
    if (cfg.encryptedGithubToken) {
      return String(decryptText(cfg.encryptedGithubToken) || '').trim();
    }

    const legacyToken = String(cfg.githubToken || '').trim();
    if (!legacyToken) return '';

    if (!isUsingFallbackSecret()) {
      try {
        writeConfig({ encryptedGithubToken: encryptText(legacyToken), githubToken: undefined });
      } catch (err) {
        logger.warn?.(`[updater] GitHub token 自动迁移失败：${err.message}`);
      }
    }
    return legacyToken;
  }

  // ── HTTP（GitHub API / 下载，带可选 token）─────────────────────────────
  function httpGet(url, { token, accept = 'application/vnd.github+json', maxBytes = 5 * 1024 * 1024, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': '1Shell-Updater',
        Accept: accept,
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = https.get(url, { headers, timeout: 30000 }, (res) => {
        // 跟随重定向（下载资产会 302 到 codeload/objects）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGet(res.headers.location, { token: undefined, accept, maxBytes, binary }).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`GitHub 返回 HTTP ${res.statusCode}: ${url}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error(`下载体超过上限 ${maxBytes} 字节`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ headers: res.headers, body: binary ? buf : buf.toString('utf8') });
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('GitHub 请求超时')); });
      req.on('error', reject);
    });
  }

  function pickAssetForPlatform(assets) {
    const plat = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    // 期望命名：1shell-<ver>-<plat>-<arch>.(tar.gz|zip)，回退到不带 arch 的旧命名
    const list = Array.isArray(assets) ? assets : [];
    const wantExt = plat === 'windows' ? '.zip' : '.tar.gz';
    const byArch = list.find((a) => a.name.includes(`-${plat}-${arch}`) && a.name.endsWith(wantExt));
    if (byArch) return byArch;
    return list.find((a) => a.name.includes(`-${plat}`) && a.name.endsWith(wantExt)) || null;
  }

  async function checkForUpdate() {
    const token = getToken();
    try {
      const { body } = await httpGet(`${RELEASES_API}/latest`, { token });
      const rel = JSON.parse(body);
      const assets = (rel.assets || []).map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
      }));
      const picked = pickAssetForPlatform(assets);
      latest = {
        checkedAt: new Date().toISOString(),
        version: normalizeVersion(rel.tag_name || rel.name),
        publishedAt: rel.published_at || '',
        releaseName: rel.name || rel.tag_name || '',
        releaseNotes: String(rel.body || '').slice(0, 20000),
        htmlUrl: rel.html_url || '',
        asset: picked,
        assets,
        error: '',
      };
      void refreshRateLimit();
      return getStatus();
    } catch (err) {
      latest = { ...latest, checkedAt: new Date().toISOString(), error: err.message || String(err) };
      return getStatus();
    }
  }

  async function refreshRateLimit() {
    const token = getToken();
    try {
      const { body } = await httpGet(RATELIMIT_API, { token });
      const core = JSON.parse(body).resources?.core || {};
      rateLimit = {
        limit: core.limit || 0,
        used: core.used || 0,
        remaining: core.remaining || 0,
        resetAt: core.reset ? new Date(core.reset * 1000).toISOString() : '',
        authenticated: Boolean(token),
      };
    } catch {
      rateLimit = { ...rateLimit, authenticated: Boolean(token) };
    }
    return rateLimit;
  }

  async function verifyToken(token) {
    const t = String(token || '').trim();
    if (!t) return { ok: false, error: 'token 为空' };
    try {
      const { body } = await httpGet(RATELIMIT_API, { token: t });
      const core = JSON.parse(body).resources?.core || {};
      return { ok: true, limit: core.limit || 0, remaining: core.remaining || 0 };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // ── 下载 + 校验 ────────────────────────────────────────────────────────
  function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  async function downloadAndVerify(asset, token) {
    if (!asset || !asset.url) throw new Error('当前平台没有可用的更新资产');
    logger.info?.(`[updater] 下载 ${asset.name} ...`);
    const { body: archive } = await httpGet(asset.url, { token, binary: true, maxBytes: MAX_DOWNLOAD_BYTES, accept: 'application/octet-stream' });

    // 校验 <asset>.sha256.txt（缺失则跳过但记日志）
    const sumUrl = `${asset.url}.sha256.txt`;
    try {
      const { body: sumText } = await httpGet(sumUrl, { token, maxBytes: 4096 });
      const expected = String(sumText).trim().split(/\s+/)[0].toLowerCase();
      const actual = sha256(archive).toLowerCase();
      if (expected && expected !== actual) {
        throw new Error(`SHA256 校验失败：期望 ${expected.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
      }
      logger.info?.('[updater] SHA256 校验通过');
    } catch (err) {
      if (/校验失败/.test(err.message)) throw err;
      logger.warn?.(`[updater] 未取到校验文件，跳过校验：${err.message}`);
    }
    return archive;
  }

  // ── 解压（用系统 tar，Linux/macOS/Win10+ 通用）─────────────────────────
  function execFileP(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { ...opts }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; reject(err); return; }
        resolve({ stdout, stderr });
      });
    });
  }

  // 解压 archive 到 destDir，返回解压出的顶层包目录（含 package.json 的那层）
  async function extractArchive(archiveBuf, assetName, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const archivePath = path.join(destDir, assetName);
    fs.writeFileSync(archivePath, archiveBuf);
    try {
      // tar 同时支持 .tar.gz 和 .zip（Windows 自带 bsdtar）
      await execFileP('tar', ['-xf', archivePath, '-C', destDir]);
    } finally {
      try { fs.unlinkSync(archivePath); } catch { /* ignore */ }
    }
    return findPackageDir(destDir);
  }

  function findPackageDir(dir) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'server.js'))) {
      return dir;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const e of entries) {
      const sub = path.join(dir, e.name);
      if (fs.existsSync(path.join(sub, 'package.json')) && fs.existsSync(path.join(sub, 'server.js'))) {
        return sub;
      }
    }
    throw new Error('解压后未找到包含 package.json + server.js 的目录');
  }

  // ── 目录交换（binary 部署）────────────────────────────────────────────
  // 运行时状态必须原地保留，不随版本替换
  const PRESERVE = new Set(['data', '.env', 'logs', '.git']);
  const backupDir = `${appRoot}.backup`;

  function moveTopLevel(fromDir, toDir, { skipPreserve = true } = {}) {
    fs.mkdirSync(toDir, { recursive: true });
    for (const name of fs.readdirSync(fromDir)) {
      if (skipPreserve && PRESERVE.has(name)) continue;
      const src = path.join(fromDir, name);
      const dst = path.join(toDir, name);
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* ignore */ }
      fs.renameSync(src, dst);
    }
  }

  // 把 newPkgDir 的内容换进 appRoot，旧文件备份到 backupDir（保留 data/.env/logs）
  function swapInPlace(newPkgDir) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    // 1. 旧应用文件 → backup
    moveTopLevel(appRoot, backupDir);
    // 2. 新版本文件 → appRoot
    try {
      moveTopLevel(newPkgDir, appRoot);
    } catch (err) {
      // 换入失败：尽力把备份还原，避免半截状态
      try { moveTopLevel(backupDir, appRoot); } catch { /* best effort */ }
      throw err;
    }
  }

  function hasBackup() {
    try {
      return fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0
        && fs.existsSync(path.join(backupDir, 'package.json'));
    } catch { return false; }
  }

  function backupVersion() {
    try {
      return normalizeVersion(JSON.parse(fs.readFileSync(path.join(backupDir, 'package.json'), 'utf8')).version);
    } catch { return ''; }
  }

  // ── 重启：交给 supervisor（docker restart / systemd Restart）拉起 ──────
  function scheduleRestart(reason) {
    logger.info?.(`[updater] ${reason}，2 秒后退出由 supervisor 拉起新版本`);
    setTimeout(() => process.exit(0), 2000);
  }

  // ── 编排：检查 → 下载 → 校验 → 解压 → 换入 → 标记重启 ─────────────────
  async function applyUpdate({ targetVersion = '' } = {}) {
    if (applying) throw new Error('已有更新任务在进行中');
    if (isDesktop()) throw new Error('桌面版请使用应用内的自动更新（electron-updater）');
    applying = true;
    const token = getToken();
    const fromVersion = currentVersion();
    let tmpDir = '';
    try {
      // 确保有目标版本信息
      if (!latest.version || (targetVersion && normalizeVersion(targetVersion) !== latest.version)) {
        await checkForUpdate();
      }
      if (!latest.version) throw new Error(latest.error || '未获取到最新版本信息');
      if (compareVersions(latest.version, fromVersion) <= 0) {
        throw new Error(`已是最新版本 v${fromVersion}，无需更新`);
      }

      // docker 部署：源码以 :ro 挂载，无法换文件，走拉镜像（见 dockerPullAndRecreate）
      if (isDocker()) {
        throw new Error('Docker 部署请使用"拉取镜像"更新；当前不支持容器内文件替换。');
      }

      const archive = await downloadAndVerify(latest.asset, token);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-update-'));
      const pkgDir = await extractArchive(archive, latest.asset.name, tmpDir);
      swapInPlace(pkgDir);

      writeConfig({
        previousVersion: fromVersion,
        lastUpdatedAt: new Date().toISOString(),
        lastUpdateTo: latest.version,
      });
      logger.info?.(`[updater] 已更新 v${fromVersion} → v${latest.version}`);
      scheduleRestart('更新完成');
      return { ok: true, needRestart: true, fromVersion, toVersion: latest.version };
    } finally {
      applying = false;
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }

  async function rollback() {
    if (applying) throw new Error('已有更新任务在进行中');
    if (isDesktop()) throw new Error('桌面版不支持此回退');
    if (isDocker()) throw new Error('Docker 部署请用镜像 tag 回退，不支持文件回退');
    if (!hasBackup()) throw new Error('没有可回退的上一版本备份');
    applying = true;
    try {
      const fromVersion = currentVersion();
      const toVersion = backupVersion();
      // 当前应用文件 → 临时，再把 backup 换回
      const stash = `${appRoot}.rollback-stash`;
      fs.rmSync(stash, { recursive: true, force: true });
      moveTopLevel(appRoot, stash);
      try {
        moveTopLevel(backupDir, appRoot);
      } catch (err) {
        moveTopLevel(stash, appRoot); // 还原
        throw err;
      }
      fs.rmSync(stash, { recursive: true, force: true });
      fs.rmSync(backupDir, { recursive: true, force: true });
      writeConfig({ previousVersion: '', lastUpdatedAt: new Date().toISOString(), lastUpdateTo: toVersion });
      logger.info?.(`[updater] 已回退 v${fromVersion} → v${toVersion}`);
      scheduleRestart('回退完成');
      return { ok: true, needRestart: true, fromVersion, toVersion };
    } finally {
      applying = false;
    }
  }

  // ── Docker 部署：拉取最新镜像并重建容器（需挂载 docker socket）─────────
  async function dockerPullAndRecreate() {
    if (!isDocker()) throw new Error('仅 Docker 部署支持拉取镜像');
    if (applying) throw new Error('已有更新任务在进行中');
    applying = true;
    try {
      // compose 项目名/服务名固定为 1shell（见 docker-compose.yml container_name）
      await execFileP('docker', ['compose', 'pull'], { cwd: appRoot, timeout: 600000 });
      // up -d 会用新镜像重建容器；当前进程随容器替换而退出
      execFile('docker', ['compose', 'up', '-d'], { cwd: appRoot }, () => {});
      logger.info?.('[updater] docker compose pull + up -d 已触发');
      return { ok: true, needRestart: true, method: 'docker' };
    } finally {
      applying = false;
    }
  }

  // ── 无人值守自动更新（每天到点检查，有新版即更新并重启）──────────────
  function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
  }

  let lastAutoRunDay = '';
  function autoTick() {
    const cfg = readConfig();
    if (!cfg.autoUpdate || isDesktop()) return;
    const at = parseHHMM(cfg.autoUpdateAt || '03:00');
    if (!at) return;
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (now.getHours() === at.h && now.getMinutes() === at.min && lastAutoRunDay !== dayKey) {
      lastAutoRunDay = dayKey;
      logger.info?.('[updater] 无人值守：到点检查更新');
      (async () => {
        try {
          await checkForUpdate();
          if (latest.version && compareVersions(latest.version, currentVersion()) > 0) {
            if (isDocker()) await dockerPullAndRecreate();
            else await applyUpdate();
          }
        } catch (err) {
          logger.warn?.(`[updater] 无人值守更新失败：${err.message}`);
        }
      })();
    }
  }

  function startScheduler() {
    if (autoTimer) return;
    autoTimer = setInterval(autoTick, 30 * 1000); // 每 30s 检查是否到点
    autoTimer.unref?.();
  }
  function stopScheduler() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  }

  // ── 对外状态（喂给前端面板）──────────────────────────────────────────
  function getStatus() {
    const cfg = readConfig();
    const cur = currentVersion();
    const hasNew = Boolean(latest.version) && compareVersions(latest.version, cur) > 0;
    return {
      buildType: buildType(),
      currentVersion: cur,
      latestVersion: latest.version || '',
      hasUpdate: hasNew,
      publishedAt: latest.publishedAt || '',
      releaseName: latest.releaseName || '',
      releaseNotes: latest.releaseNotes || '',
      releaseUrl: latest.htmlUrl || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
      asset: latest.asset ? { name: latest.asset.name, size: latest.asset.size } : null,
      checkedAt: latest.checkedAt,
      checkError: latest.error || '',
      applying,
      previousVersion: cfg.previousVersion || '',
      canRollback: hasBackup(),
      lastUpdatedAt: cfg.lastUpdatedAt || '',
      autoUpdate: Boolean(cfg.autoUpdate),
      autoUpdateAt: cfg.autoUpdateAt || '03:00',
      hasToken: Boolean(getToken()),
      rateLimit,
      repoUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    };
  }

  function setToken(token) {
    const normalized = String(token || '').trim();
    writeConfig({
      encryptedGithubToken: normalized ? encryptText(normalized) : undefined,
      githubToken: undefined,
    });
    return getStatus();
  }
  function setAutoUpdate({ enabled, at } = {}) {
    const patch = {};
    if (enabled !== undefined) patch.autoUpdate = Boolean(enabled);
    if (at !== undefined) {
      if (at && !parseHHMM(at)) throw new Error('触发时间格式应为 HH:MM');
      patch.autoUpdateAt = at || '03:00';
    }
    writeConfig(patch);
    return getStatus();
  }

  return {
    buildType,
    currentVersion,
    checkForUpdate,
    refreshRateLimit,
    verifyToken,
    applyUpdate,
    rollback,
    dockerPullAndRecreate,
    getStatus,
    setToken,
    setAutoUpdate,
    startScheduler,
    stopScheduler,
  };
}

module.exports = { createUpdaterService };
