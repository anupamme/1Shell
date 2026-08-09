'use strict';

/**
 * SSH 连接池
 *
 * 为 Bridge exec 复用 SSH 连接，避免每次命令都握手。
 * 每个 hostId 最多维护一个空闲连接，超时未使用则自动释放。
 *
 * 注意：连接池仅用于 exec 模式（单条命令）。
 * Shell 会话（session.service.js）始终独立连接，因为需要独占 PTY。
 */

const IDLE_TIMEOUT_MS = 60000;    // 空闲 60 秒后断开
const LIVENESS_TIMEOUT_MS = 5000; // 存活检测最多等 5 秒

function createSshPool({ hostService }) {
  // Map<hostId, { client, proxyClient, timer, busy }>
  const pool = new Map();

  function release(hostId) {
    const entry = pool.get(hostId);
    if (!entry) return;
    pool.delete(hostId);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.client.end(); } catch { /* ignore */ }
    try { entry.proxyClient?.end(); } catch { /* ignore */ }
  }

  function resetTimer(hostId) {
    const entry = pool.get(hostId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => release(hostId), IDLE_TIMEOUT_MS);
  }

  /**
   * 存活检测：exec 一个 no-op，看通道能否完整往返。
   *
   * 两个必须注意的点（都踩过）：
   *   1. **必须排空 stdout/stderr**。ssh2 的 stream 默认是暂停的，不读就有背压，
   *      `close` 永远不会触发。POSIX 上 `:` 是静默内建命令，恰好没有输出所以侥幸没事；
   *      Windows（cmd.exe）会有输出，于是这里直接挂死。
   *   2. **超时必须一直armed到 promise 落定**。以前在 exec 回调里就 clearTimeout，
   *      之后若 `close` 不来，这个 promise 永远不落定 —— 调用方一路挂到外层超时。
   */
  function checkLiveness(client) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(livenessTimer);
        if (err) reject(err);
        else resolve();
      };
      const livenessTimer = setTimeout(
        () => finish(new Error('liveness check timeout')),
        LIVENESS_TIMEOUT_MS,
      );
      client.exec(':', (err, stream) => {
        if (err) return finish(err);
        // 排空两条流，否则背压会让 close 永不触发
        stream.on('data', () => {});
        stream.stderr?.on('data', () => {});
        stream.on('close', () => finish());
        stream.on('error', finish);
      });
    });
  }

  /**
   * 获取一个到指定主机的可用 SSH client。
   * 如果池中有空闲连接，直接复用；否则新建。
   *
   * @param {string} hostId
   * @param {object} [options]
   * @returns {Promise<{client: object, proxyClient: object|null, fromPool: boolean}>}
   */
  async function acquire(hostId, options = {}) {
    const entry = pool.get(hostId);

    // 有空闲连接且连接仍存活
    if (entry && !entry.busy) {
      try {
        await checkLiveness(entry.client);
        entry.busy = true;
        resetTimer(hostId);
        return { client: entry.client, proxyClient: entry.proxyClient, fromPool: true };
      } catch {
        // 连接已死，释放并新建
        release(hostId);
      }
    }

    // 新建连接
    const { client, proxyClient } = await hostService.connectToHost(hostId, options);

    // 监听意外断开
    client.on('error', () => release(hostId));
    client.on('close', () => pool.delete(hostId));

    const newEntry = { client, proxyClient, timer: null, busy: true };
    pool.set(hostId, newEntry);
    resetTimer(hostId);

    return { client, proxyClient, fromPool: false };
  }

  /**
   * 将连接归还池中（标记为空闲）。
   */
  function returnToPool(hostId) {
    const entry = pool.get(hostId);
    if (!entry) return;
    entry.busy = false;
    resetTimer(hostId);
  }

  /**
   * 关闭池中所有连接。
   */
  function closeAll() {
    for (const hostId of [...pool.keys()]) {
      release(hostId);
    }
  }

  return { acquire, returnToPool, release, closeAll };
}

module.exports = { createSshPool };
