'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { DATA_DIR } = require('../config/env');

/**
 * 文件浏览服务
 *
 * 支持两种模式：
 * - local：通过 Node.js fs 模块读取本机文件系统
 * - ssh：通过 ssh2 SFTP 读取远程主机文件系统
 *
 * 注意：SFTP 操作使用独立 SSH 连接，不复用 sshPool。
 * sshPool 为 exec 模式设计，SFTP 需要长连接且操作模式不同。
 */
function createFileService({ hostService, probeAgentService = null }) {
  function hasPathTraversalSegment(targetPath) {
    return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(String(targetPath || ''));
  }

  function assertSafeFilePath(filePath, action = '访问') {
    if (hasPathTraversalSegment(filePath)) {
      throw new Error(`${action}被拒绝：路径包含 .. 穿越片段`);
    }
  }

  function safeUploadFilename(filename) {
    const safeName = path.basename(String(filename || '').replace(/\\/g, '/'));
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('上传被拒绝：文件名无效');
    assertSafeFilePath(safeName, '上传');
    return safeName;
  }

  /**
   * 获取 Windows 所有可用盘符
   */
  function getWindowsDrives() {
    const drives = [];
    const possibleDrives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const letter of possibleDrives) {
      const drivePath = `${letter}:\\`;
      try {
        fs.accessSync(drivePath);
        drives.push({
          name: `${letter}:\\`,
          path: drivePath,
          isDir: true,
          size: 0,
          mtime: 0,
          isDrive: true,
        });
      } catch {
        // 盘符不存在或不可访问
      }
    }
    return drives;
  }

  /**
   * 列出本机目录内容
   */
  async function listLocal(dirPath) {
    // Windows 下如果 dirPath 为空，返回所有盘符列表
    if (os.platform() === 'win32' && (!dirPath || dirPath.trim() === '')) {
      return {
        path: '此电脑',
        parent: null,
        items: getWindowsDrives(),
        isRoot: true,
      };
    }

    const resolvedPath = dirPath ? path.resolve(dirPath) : os.homedir();

    const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });

    // 并发 stat 所有文件，避免串行阻塞
    const statResults = await Promise.all(
      entries.map(async (entry) => {
        try {
          const fullPath = path.join(resolvedPath, entry.name);
          const isDir = entry.isDirectory();
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          return {
            name: entry.name,
            path: fullPath,
            isDir,
            size: stat ? stat.size : 0,
            mtime: stat ? stat.mtimeMs : 0,
          };
        } catch {
          return null;
        }
      }),
    );
    const items = statResults.filter(Boolean);

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parentDir = path.dirname(resolvedPath);
    // Windows 盘符根目录的 parent 是自身（如 C:\ 的 dirname 还是 C:\）
    const isDriveRoot = /^[A-Z]:\\$/i.test(resolvedPath);

    return {
      path: resolvedPath,
      parent: isDriveRoot ? null : parentDir,
      items,
      isRoot: isDriveRoot,
    };
  }

  // ─── SFTP 连接池：复用 SSH 连接，避免每次操作都握手 ──────────────────────

  const SFTP_IDLE_TIMEOUT_MS = 120000; // 空闲 2 分钟后断开
  const SFTP_LIVENESS_SKIP_MS = 10000; // 10 秒内用过的连接跳过健康检测
  // Map<hostId, { client, proxyClient, sftp, timer, busy, lastUsed }>
  const sftpPool = new Map();

  const DEFAULT_DOWNLOAD_CONCURRENCY = 32;
  const DEFAULT_DOWNLOAD_CHUNK_SIZE = 256 * 1024;
  const DEFAULT_DOWNLOAD_BUFFERED_CHUNKS = 64;

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function getSftpReadTuning(sftp) {
    const maxReadLen = clampInt(sftp?._maxReadLen, DEFAULT_DOWNLOAD_CHUNK_SIZE, 16 * 1024, DEFAULT_DOWNLOAD_CHUNK_SIZE);
    const envChunkSize = clampInt(process.env.ONESHELL_SFTP_DOWNLOAD_CHUNK_SIZE, DEFAULT_DOWNLOAD_CHUNK_SIZE, 16 * 1024, DEFAULT_DOWNLOAD_CHUNK_SIZE);
    const chunkSize = Math.min(envChunkSize, maxReadLen);
    const concurrency = clampInt(process.env.ONESHELL_SFTP_DOWNLOAD_CONCURRENCY, DEFAULT_DOWNLOAD_CONCURRENCY, 1, 128);
    const bufferedChunks = clampInt(process.env.ONESHELL_SFTP_DOWNLOAD_BUFFERED_CHUNKS, DEFAULT_DOWNLOAD_BUFFERED_CHUNKS, concurrency, 256);
    return { chunkSize, concurrency, bufferedChunks };
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function parsePositiveSize(value) {
    const size = Number(String(value || '').trim());
    return Number.isFinite(size) && size >= 0 ? size : null;
  }

  function createParallelSftpReadStream(sftp, filePath, fileSize, options = {}) {
    const totalSize = Math.max(0, Number(fileSize) || 0);
    const chunkSize = clampInt(options.chunkSize, DEFAULT_DOWNLOAD_CHUNK_SIZE, 16 * 1024, DEFAULT_DOWNLOAD_CHUNK_SIZE);
    const concurrency = clampInt(options.concurrency, DEFAULT_DOWNLOAD_CONCURRENCY, 1, 128);
    const bufferedChunks = clampInt(options.bufferedChunks, DEFAULT_DOWNLOAD_BUFFERED_CHUNKS, concurrency, 256);

    let handle = null;
    let opened = false;
    let opening = true;
    let closing = false;
    let ended = false;
    let failed = false;
    let nextOffset = 0;
    let nextIndex = 0;
    let expectedIndex = 0;
    let deliveredBytes = 0;
    let inflight = 0;
    let effectiveSize = totalSize;
    let backpressured = false;
    const pending = new Map();

    const stream = new Readable({
      highWaterMark: Math.max(512 * 1024, chunkSize * 2),
      read() {
        backpressured = false;
        flushReady();
        scheduleReads();
      },
      destroy(err, cb) {
        failed = Boolean(err);
        closeHandle(() => cb(err));
      },
    });

    function fail(err) {
      if (failed || stream.destroyed) return;
      failed = true;
      stream.destroy(err);
    }

    function closeHandle(cb = () => {}) {
      if (!handle || closing) {
        cb();
        return;
      }
      const h = handle;
      handle = null;
      closing = true;
      sftp.close(h, () => {
        closing = false;
        cb();
      });
    }

    function maybeEnd() {
      if (ended || failed || opening || inflight > 0 || pending.size > 0) return;
      if (nextOffset < effectiveSize || deliveredBytes < effectiveSize) return;
      ended = true;
      closeHandle(() => {
        if (!stream.destroyed) stream.push(null);
      });
    }

    function flushReady() {
      if (failed || stream.destroyed || backpressured) return;
      while (pending.has(expectedIndex)) {
        const chunk = pending.get(expectedIndex);
        pending.delete(expectedIndex);
        expectedIndex += 1;
        if (chunk.length === 0) continue;
        deliveredBytes += chunk.length;
        if (!stream.push(chunk)) {
          backpressured = true;
          break;
        }
      }
      maybeEnd();
    }

    function scheduleReads() {
      if (!opened || failed || stream.destroyed || ended || backpressured) return;
      while (
        inflight < concurrency
        && pending.size + inflight < bufferedChunks
        && nextOffset < effectiveSize
      ) {
        const offset = nextOffset;
        const index = nextIndex;
        const len = Math.min(chunkSize, effectiveSize - offset);
        const buffer = Buffer.allocUnsafe(len);
        nextOffset += len;
        nextIndex += 1;
        inflight += 1;

        sftp.read(handle, buffer, 0, len, offset, (err, bytesRead, data) => {
          inflight -= 1;
          if (failed || stream.destroyed) return;
          if (err) {
            fail(new Error(`SFTP read failed: ${err.message}`));
            return;
          }

          const n = Math.max(0, Number(bytesRead) || 0);
          const chunk = n > 0
            ? (Buffer.isBuffer(data) ? data.subarray(0, n) : buffer.subarray(0, n))
            : Buffer.alloc(0);
          if (n < len) {
            effectiveSize = Math.min(effectiveSize, offset + n);
            if (nextOffset > effectiveSize) nextOffset = effectiveSize;
          }
          pending.set(index, chunk);
          flushReady();
          scheduleReads();
        });
      }
      maybeEnd();
    }

    sftp.open(filePath, 'r', (err, openedHandle) => {
      opening = false;
      if (stream.destroyed) {
        if (openedHandle) {
          handle = openedHandle;
          closeHandle();
        }
        return;
      }
      if (err) {
        fail(new Error(`SFTP open failed: ${err.message}`));
        return;
      }
      handle = openedHandle;
      opened = true;
      if (effectiveSize === 0) {
        maybeEnd();
        return;
      }
      scheduleReads();
    });

    return stream;
  }

  function releaseSftp(hostId) {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    sftpPool.delete(hostId);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.sftp?.end(); } catch { /* ignore */ }
    try { entry.client?.end(); } catch { /* ignore */ }
    try { entry.proxyClient?.end(); } catch { /* ignore */ }
  }

  function resetSftpTimer(hostId) {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => releaseSftp(hostId), SFTP_IDLE_TIMEOUT_MS);
  }

  /**
   * 获取可复用的 SFTP 会话
   */
  async function acquireSftp(hostId) {
    const entry = sftpPool.get(hostId);
    if (entry && !entry.busy) {
      // 最近用过的连接直接复用，跳过健康检测
      const recentlyUsed = entry.lastUsed && (Date.now() - entry.lastUsed < SFTP_LIVENESS_SKIP_MS);
      if (recentlyUsed) {
        entry.busy = true;
        entry.lastUsed = Date.now();
        resetSftpTimer(hostId);
        return entry;
      }
      // 空闲较久，快速健康检测
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('sftp liveness timeout')), 3000);
          entry.sftp.realpath('.', (err) => {
            clearTimeout(t);
            if (err) reject(err); else resolve();
          });
        });
        entry.busy = true;
        entry.lastUsed = Date.now();
        resetSftpTimer(hostId);
        return entry;
      } catch {
        releaseSftp(hostId);
      }
    }

    // 新建连接
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 15000 });

    const sftp = await new Promise((resolve, reject) => {
      client.sftp((err, s) => {
        if (err) {
          client.end(); proxyClient?.end();
          return reject(new Error(`SFTP 会话创建失败: ${err.message}`));
        }
        resolve(s);
      });
    });

    client.on('error', () => releaseSftp(hostId));
    client.on('close', () => { sftpPool.delete(hostId); });

    const newEntry = { client, proxyClient, sftp, timer: null, busy: true, lastUsed: Date.now() };
    sftpPool.set(hostId, newEntry);
    resetSftpTimer(hostId);
    return newEntry;
  }

  function returnSftp(hostId) {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    entry.busy = false;
    entry.lastUsed = Date.now();
    resetSftpTimer(hostId);
  }

  async function listRemoteViaAgent(hostId, dirPath) {
    if (!probeAgentService?.enqueueCommand) return null;
    if (!probeAgentService.supportsCommand?.(hostId, 'file.listDir')) return null;
    const result = await probeAgentService.enqueueCommand(hostId, 'file.listDir', {
      path: dirPath || '/',
      sortBy: 'name',
      sortOrder: 'ascending',
    });
    if (!result || !Array.isArray(result.items)) return null;
    const items = result.items
      .map((item) => ({
        name: item.name,
        path: item.path,
        isDir: Boolean(item.isDir),
        size: Number(item.size || 0),
        mtime: Number(item.mtime || 0),
      }));
    return {
      path: result.path || dirPath || '/',
      parent: result.parent || '/',
      items,
      isRoot: Boolean(result.isRoot),
      itemTotal: items.length,
      source: 'agent',
    };
  }

  /**
   * 通过 SFTP 列出远程目录内容
   */
  async function listRemote(hostId, dirPath) {
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        const targetPath = dirPath || '.';
        const isAbsolute = targetPath.startsWith('/');

        function doReaddir(resolvedPath) {
          sftp.readdir(resolvedPath, (rdErr, list) => {
            if (rdErr) return reject(new Error(`读取目录失败: ${rdErr.message}`));

            const items = list
              .map((e) => {
                const isDir = e.attrs.isDirectory();
                const itemPath = resolvedPath + '/' + e.filename;
                return {
                  name: e.filename,
                  path: itemPath,
                  isDir,
                  size: e.attrs.size || 0,
                  mtime: (e.attrs.mtime || 0) * 1000,
                };
              });

            items.sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

            const parent = resolvedPath === '/' ? '/' : resolvedPath.replace(/\/[^/]+\/?$/, '') || '/';
            resolve({ path: resolvedPath, parent, items });
          });
        }

        // 绝对路径跳过 realpath，省一次 RTT
        if (isAbsolute) {
          doReaddir(targetPath.replace(/\/+$/, '') || '/');
        } else {
          sftp.realpath(targetPath, (rpErr, absPath) => {
            doReaddir(rpErr ? targetPath : absPath);
          });
        }
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 读取远程文件内容（文本预览，限制大小）
   */
  async function readRemoteFile(hostId, filePath, maxBytes = 512 * 1024) {
    assertSafeFilePath(filePath, '读取');
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        sftp.stat(filePath, (statErr, stats) => {
          if (statErr) return reject(new Error(`文件不存在: ${statErr.message}`));

          if (stats.size > maxBytes) {
            return reject(new Error(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，最大支持 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 预览`));
          }

          const chunks = [];
          const stream = sftp.createReadStream(filePath, { end: maxBytes });

          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            resolve({
              content: Buffer.concat(chunks).toString('utf8'),
              size: stats.size,
              path: filePath,
            });
          });
          stream.on('error', (readErr) => {
            reject(new Error(`读取文件失败: ${readErr.message}`));
          });
        });
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 读取本机文件内容
   */
  async function readLocalFile(filePath, maxBytes = 512 * 1024) {
    assertSafeFilePath(filePath, '读取');
    const resolved = path.resolve(filePath);

    const stat = await fs.promises.stat(resolved);

    if (stat.size > maxBytes) {
      throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 预览`);
    }

    const content = await fs.promises.readFile(resolved, 'utf8');
    return {
      content,
      size: stat.size,
      path: resolved.replace(/\\/g, '/'),
    };
  }

  /**
   * 统一入口：列出目录
   */
  async function listDir(hostId, dirPath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');

    if (host.type === 'local' || host.id === 'local') {
      return listLocal(dirPath);
    }

    try {
      const agentResult = await listRemoteViaAgent(hostId, dirPath);
      if (agentResult) return agentResult;
    } catch {
      // Agent 文件浏览失败时保留 SFTP 兜底。
    }
    return listRemote(hostId, dirPath);
  }

  /**
   * 统一入口：读取文件
   */
  async function readFile(hostId, filePath, maxBytes) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');

    if (host.type === 'local' || host.id === 'local') {
      return readLocalFile(filePath, maxBytes);
    }

    return readRemoteFile(hostId, filePath, maxBytes);
  }

  // ─── 文件下载（流式） ────────────────────────────────────────────────────

  /**
   * 下载本机文件，返回可读流和元信息
   */
  async function downloadLocal(filePath) {
    assertSafeFilePath(filePath, '下载');
    const resolved = path.resolve(filePath);
    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) throw new Error('不能下载目录');
    return {
      stream: fs.createReadStream(resolved),
      size: stat.size,
      filename: path.basename(resolved),
      source: 'local',
    };
  }

  /**
   * 下载远程文件，返回可读流和元信息
   * 注意：下载使用独立连接，因为流生命周期不可控
   */
  function statRemoteFileViaExec(client, filePath) {
    const quotedPath = shellQuote(filePath);
    const command = [
      `p=${quotedPath}`,
      'if [ -d "$p" ]; then printf "%s\\n" "DIR" >&2; exit 2; fi',
      'if [ ! -r "$p" ]; then printf "%s\\n" "UNREADABLE" >&2; exit 3; fi',
      'stat -Lc "%s" -- "$p"',
    ].join('; ');

    return new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        stream.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        stream.on('close', (code) => {
          if (code !== 0) {
            const reason = stderr.trim() || `exit ${code}`;
            if (reason === 'DIR') return reject(new Error('不能下载目录'));
            if (reason === 'UNREADABLE') return reject(new Error('文件不可读'));
            return reject(new Error(`远程文件检查失败: ${reason}`));
          }
          const size = parsePositiveSize(stdout);
          if (size === null) return reject(new Error(`远程文件大小解析失败: ${stdout.trim()}`));
          resolve(size);
        });
        stream.on('error', reject);
      });
    });
  }

  async function downloadRemoteViaExec(hostId, filePath) {
    assertSafeFilePath(filePath, '下载');
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 15000, probeOs: false });
    let closed = false;

    function closeConnection() {
      if (closed) return;
      closed = true;
      try { client.end(); } catch { /* ignore */ }
      try { proxyClient?.end(); } catch { /* ignore */ }
    }

    try {
      const size = await statRemoteFileViaExec(client, filePath);
      const command = `exec cat < ${shellQuote(filePath)}`;
      const stream = await new Promise((resolve, reject) => {
        client.exec(command, { pty: false }, (err, execStream) => {
          if (err) return reject(err);
          execStream.stderr?.on('data', () => { /* keep stderr out of the file stream */ });
          resolve(execStream);
        });
      });
      stream.on('close', closeConnection);
      stream.on('error', closeConnection);
      return {
        stream,
        size,
        filename: filePath.split('/').pop() || 'download',
        source: 'ssh-exec',
      };
    } catch (err) {
      closeConnection();
      throw err;
    }
  }

  async function downloadRemoteViaSftp(hostId, filePath) {
    assertSafeFilePath(filePath, '下载');
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 15000 });

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end(); proxyClient?.end();
          return reject(new Error(`SFTP 会话创建失败: ${err.message}`));
        }

        sftp.stat(filePath, (statErr, stats) => {
          if (statErr) {
            sftp.end(); client.end(); proxyClient?.end();
            return reject(new Error(`文件不存在: ${statErr.message}`));
          }
          if (stats.isDirectory()) {
            sftp.end(); client.end(); proxyClient?.end();
            return reject(new Error('不能下载目录'));
          }

          const tuning = getSftpReadTuning(sftp);
          const stream = createParallelSftpReadStream(sftp, filePath, stats.size, tuning);
          const filename = filePath.split('/').pop() || 'download';

          stream.on('close', () => {
            sftp.end(); client.end(); proxyClient?.end();
          });
          stream.on('error', () => {
            sftp.end(); client.end(); proxyClient?.end();
          });

          resolve({ stream, size: stats.size, filename, source: 'sftp' });
        });
      });
    });
  }

  /**
   * 统一入口：下载文件
   */
  async function downloadRemote(hostId, filePath) {
    if (process.env.ONESHELL_FILE_DOWNLOAD_MODE !== 'sftp') {
      try {
        return await downloadRemoteViaExec(hostId, filePath);
      } catch (err) {
        if (process.env.ONESHELL_FILE_DOWNLOAD_MODE === 'exec') throw err;
      }
    }
    return downloadRemoteViaSftp(hostId, filePath);
  }

  async function downloadFile(hostId, filePath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return downloadLocal(filePath);
    }
    return downloadRemote(hostId, filePath);
  }

  // ─── 文件上传 ─────────────────────────────────────────────────────────────

  /**
   * 上传文件到本机
   */
  async function uploadLocal(dirPath, filename, buffer) {
    const safeName = safeUploadFilename(filename);
    const resolved = path.resolve(dirPath, safeName);
    try {
      await fs.promises.writeFile(resolved, buffer);
    } catch (err) {
      throw await enrichLocalWriteError(err, resolved, '上传');
    }
    return { path: resolved, size: buffer.length };
  }

  /**
   * 上传文件到远程主机
   */
  async function uploadRemote(hostId, dirPath, filename, buffer) {
    const safeName = safeUploadFilename(filename);
    const remotePath = dirPath.endsWith('/') ? dirPath + safeName : dirPath + '/' + safeName;
    assertSafeFilePath(remotePath, '上传');

    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        const writeStream = sftp.createWriteStream(remotePath);

        writeStream.on('close', () => {
          resolve({ path: remotePath, size: buffer.length });
        });
        writeStream.on('error', (writeErr) => {
          reject(new Error(`写入文件失败: ${writeErr.message}`));
        });

        writeStream.end(buffer);
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 统一入口：上传文件
   */
  async function uploadFile(hostId, dirPath, filename, buffer) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return uploadLocal(dirPath, filename, buffer);
    }
    return uploadRemote(hostId, dirPath, filename, buffer);
  }

  // ─── 文件写入（编辑保存） ──────────────────────────────────────────────

  /**
   * 写入本机文件
   */
  async function writeLocal(filePath, content) {
    assertSafeFilePath(filePath, '写入');
    const resolved = path.resolve(filePath);
    try {
      await fs.promises.writeFile(resolved, content, 'utf8');
    } catch (err) {
      throw await enrichLocalWriteError(err, resolved, '写入');
    }
    const stat = await fs.promises.stat(resolved);
    return { path: resolved, size: stat.size };
  }

  /**
   * 写入远程文件
   */
  async function writeRemote(hostId, filePath, content) {
    assertSafeFilePath(filePath, '写入');
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      return await new Promise((resolve, reject) => {
        const writeStream = sftp.createWriteStream(filePath);
        writeStream.on('close', () => {
          sftp.stat(filePath, (statErr, stats) => {
            resolve({ path: filePath, size: statErr ? content.length : stats.size });
          });
        });
        writeStream.on('error', (writeErr) => {
          reject(new Error(`写入文件失败: ${writeErr.message}`));
        });
        writeStream.end(Buffer.from(content, 'utf8'));
      });
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 统一入口：写入文件
   */
  async function writeFile(hostId, filePath, content) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return writeLocal(filePath, content);
    }
    return writeRemote(hostId, filePath, content);
  }

  // ─── 目录创建 / 删除 / 重命名 ────────────────────────────────────────────

  const IN_DOCKER = process.env.ONESHELL_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');

  function isWriteDeniedError(err) {
    const code = err?.code || err?.cause?.code;
    if (['EROFS', 'EACCES', 'EPERM'].includes(code)) return true;
    return /read-only file system|EROFS|permission denied|EACCES|EPERM|operation not permitted/i.test(String(err?.message || ''));
  }

  /**
   * 写入自检：向 data/tmp 写一个测试文件，区分"工具链不可用"和"目标路径不可写"
   */
  async function selfCheckLocalWrite() {
    const checkPath = path.join(DATA_DIR, 'tmp', '1shell-write-test.txt');
    try {
      await fs.promises.mkdir(path.dirname(checkPath), { recursive: true });
      await fs.promises.writeFile(checkPath, `1shell write self-check ${new Date().toISOString()}\n`, 'utf8');
      await fs.promises.rm(checkPath, { force: true });
      return { ok: true, path: checkPath };
    } catch (err) {
      return { ok: false, path: checkPath, error: err.message };
    }
  }

  async function writeSelfCheck() {
    const result = await selfCheckLocalWrite();
    return { ...result, inDocker: IN_DOCKER };
  }

  /**
   * 本机写操作失败时，把 EROFS / 权限类错误转成可行动的提示，
   * 避免 Docker 只读挂载导致的失败被泛化成"无法修改文件"。
   */
  async function enrichLocalWriteError(err, targetPath, action) {
    if (!isWriteDeniedError(err)) return err;
    const check = await selfCheckLocalWrite();
    const lines = [`${action}失败: ${err.message}`];
    if (check.ok) {
      lines.push(`1Shell 写入工具链正常（${check.path} 自检通过），是目标路径本身不可写: ${targetPath}`);
    } else {
      lines.push(`1Shell 写入自检同样失败（${check.error}），运行目录可能整体只读，请检查部署配置`);
    }
    if (IN_DOCKER) {
      lines.push('当前 1Shell 运行在 Docker 容器内，操作的是容器视角的文件系统；该路径很可能是 docker-compose 中的 :ro 只读挂载（如 /opt/1panel、/www、/etc/nginx）。');
      lines.push('可选处理方式：');
      lines.push('1. 推荐：把这台 VPS 以 SSH 主机方式添加到 1Shell（主机仓库 → 添加主机），通过主机视角读写宿主机文件；');
      lines.push('2. 把 docker-compose.yml 中对应目录挂载从 :ro 改为 :rw 后重启容器（docker compose up -d）；');
      lines.push('3. 通过 docker exec 在目标容器或宿主机内执行修改。');
    } else {
      lines.push('目标路径不可写：请检查文件系统权限、属主或只读挂载。');
    }
    return new Error(lines.join('\n'));
  }

  function assertSafeMutationTarget(targetPath, action) {
    assertSafeFilePath(targetPath, action);
    const trimmed = String(targetPath || '').trim().replace(/[\\/]+$/, '');
    if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) {
      throw new Error(`${action}被拒绝：不允许操作根目录`);
    }
  }

  function sftpCall(sftp, method, ...args) {
    return new Promise((resolve, reject) => {
      sftp[method](...args, (err, result) => {
        if (err) reject(err); else resolve(result);
      });
    });
  }

  async function mkdirLocal(dirPath) {
    assertSafeMutationTarget(dirPath, '创建目录');
    const resolved = path.resolve(dirPath);
    try {
      await fs.promises.mkdir(resolved, { recursive: true });
    } catch (err) {
      throw await enrichLocalWriteError(err, resolved, '创建目录');
    }
    return { path: resolved };
  }

  async function createFileLocal(filePath) {
    assertSafeMutationTarget(filePath, '创建文件');
    const resolved = path.resolve(filePath);
    let handle;
    try {
      // 'wx'：已存在时报错，避免静默清空既有文件
      handle = await fs.promises.open(resolved, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`文件已存在: ${resolved}`);
      throw await enrichLocalWriteError(e, resolved, '创建文件');
    }
    await handle.close();
    return { path: resolved };
  }

  async function createFileRemote(hostId, filePath) {
    assertSafeMutationTarget(filePath, '创建文件');
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      await new Promise((resolve, reject) => {
        sftp.open(filePath, 'wx', (err, handle) => {
          if (err) {
            const exists = /exist/i.test(err.message) || err.code === 4 || err.code === 11;
            return reject(new Error(exists ? `文件已存在或无法创建: ${filePath}` : `创建文件失败: ${err.message}`));
          }
          sftp.close(handle, () => resolve());
        });
      });
      return { path: filePath };
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  async function mkdirRemote(hostId, dirPath) {
    assertSafeMutationTarget(dirPath, '创建目录');
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      const normalized = String(dirPath).replace(/\/+$/, '');
      const isAbsolute = normalized.startsWith('/');
      const segments = normalized.split('/').filter(Boolean);
      let current = isAbsolute ? '' : '.';

      for (const segment of segments) {
        current = current === '.' ? segment : `${current}/${segment}`;
        const target = isAbsolute ? `/${current}` : current;
        const stats = await sftpCall(sftp, 'stat', target).catch(() => null);
        if (stats) {
          if (!stats.isDirectory()) throw new Error(`路径已存在且不是目录: ${target}`);
          continue;
        }
        await sftpCall(sftp, 'mkdir', target).catch((mkErr) => {
          throw new Error(`创建目录失败: ${mkErr.message}`);
        });
      }
      return { path: isAbsolute ? normalized : current };
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  async function deleteLocal(targetPath) {
    assertSafeMutationTarget(targetPath, '删除');
    const resolved = path.resolve(targetPath);
    const stat = await fs.promises.lstat(resolved).catch(() => {
      throw new Error(`路径不存在: ${resolved}`);
    });
    try {
      await fs.promises.rm(resolved, { recursive: true, force: false });
    } catch (err) {
      throw await enrichLocalWriteError(err, resolved, '删除');
    }
    return { path: resolved, isDir: stat.isDirectory() };
  }

  async function deleteRemoteEntry(sftp, targetPath) {
    // lstat 不跟随符号链接：链接本身按文件删除，避免递归进链接目标
    const stats = await sftpCall(sftp, 'lstat', targetPath);
    if (stats.isDirectory()) {
      const list = await sftpCall(sftp, 'readdir', targetPath);
      const base = targetPath.replace(/\/+$/, '');
      for (const item of list) {
        await deleteRemoteEntry(sftp, `${base}/${item.filename}`);
      }
      await sftpCall(sftp, 'rmdir', targetPath);
      return true;
    }
    await sftpCall(sftp, 'unlink', targetPath);
    return false;
  }

  async function deleteRemote(hostId, targetPath) {
    assertSafeMutationTarget(targetPath, '删除');
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      await sftpCall(sftp, 'lstat', targetPath).catch(() => {
        throw new Error(`路径不存在: ${targetPath}`);
      });
      const isDir = await deleteRemoteEntry(sftp, targetPath);
      return { path: targetPath, isDir };
    } catch (err) {
      releaseSftp(hostId);
      throw new Error(`删除失败: ${err.message.replace(/^删除失败: /, '')}`);
    } finally {
      returnSftp(hostId);
    }
  }

  async function renameLocal(oldPath, newPath) {
    assertSafeMutationTarget(oldPath, '重命名');
    assertSafeMutationTarget(newPath, '重命名');
    const resolvedOld = path.resolve(oldPath);
    const resolvedNew = path.resolve(newPath);
    if (resolvedOld === resolvedNew) return { path: resolvedNew, oldPath: resolvedOld };
    const exists = await fs.promises.lstat(resolvedNew).then(() => true).catch(() => false);
    if (exists) throw new Error(`目标路径已存在: ${resolvedNew}`);
    try {
      await fs.promises.rename(resolvedOld, resolvedNew);
    } catch (err) {
      throw await enrichLocalWriteError(err, resolvedOld, '重命名');
    }
    return { path: resolvedNew, oldPath: resolvedOld };
  }

  async function renameRemote(hostId, oldPath, newPath) {
    assertSafeMutationTarget(oldPath, '重命名');
    assertSafeMutationTarget(newPath, '重命名');
    if (oldPath === newPath) return { path: newPath, oldPath };
    const entry = await acquireSftp(hostId);
    const { sftp } = entry;

    try {
      const exists = await sftpCall(sftp, 'lstat', newPath).then(() => true).catch(() => false);
      if (exists) throw new Error(`目标路径已存在: ${newPath}`);
      await sftpCall(sftp, 'rename', oldPath, newPath).catch((rnErr) => {
        throw new Error(`重命名失败: ${rnErr.message}`);
      });
      return { path: newPath, oldPath };
    } catch (err) {
      releaseSftp(hostId);
      throw err;
    } finally {
      returnSftp(hostId);
    }
  }

  /**
   * 统一入口：创建目录（递归）
   */
  async function createDirectory(hostId, dirPath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return mkdirLocal(dirPath);
    }
    return mkdirRemote(hostId, dirPath);
  }

  /**
   * 统一入口：创建空文件（已存在时拒绝）
   */
  async function createFile(hostId, filePath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return createFileLocal(filePath);
    }
    return createFileRemote(hostId, filePath);
  }

  /**
   * 统一入口：删除文件或目录（目录递归删除）
   */
  async function deletePath(hostId, targetPath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return deleteLocal(targetPath);
    }
    return deleteRemote(hostId, targetPath);
  }

  /**
   * 统一入口：重命名 / 移动文件或目录
   */
  async function renamePath(hostId, oldPath, newPath) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');
    if (host.type === 'local' || host.id === 'local') {
      return renameLocal(oldPath, newPath);
    }
    return renameRemote(hostId, oldPath, newPath);
  }

  return {
    listDir,
    readFile,
    downloadFile,
    uploadFile,
    writeFile,
    createDirectory,
    createFile,
    deletePath,
    renamePath,
    writeSelfCheck,
  };
}

module.exports = {
  createFileService,
};
