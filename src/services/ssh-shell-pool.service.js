'use strict';

/**
 * SSH 持久 Shell 池
 *
 * 为每个 hostId 维护一个长驻 SSH 连接 + 交互式 shell channel。
 * 命令通过写入 shell stdin 执行，用唯一边界标记分隔每条命令的输出。
 *
 * 优势（相比 exec 模式）：
 *   - 消除每次命令的 SSH 握手开销
 *   - shell channel 保持环境变量、工作目录等状态
 *   - keepalive 保证连接活跃，不会 half-open
 *
 * 局限：
 *   - stdout/stderr 混合在一起（交互式 shell 不区分）
 *   - 需要通过边界标记解析每条命令的输出范围
 */

const crypto = require('crypto');

const IDLE_TIMEOUT_MS = 120000;  // 空闲 2 分钟后断开
const CONNECT_TIMEOUT_MS = 15000;

function createSshShellPool({ hostService }) {
  // Map<hostId, ShellEntry>
  // ShellEntry: { client, proxyClient, shell, idleTimer, busy, buffer, pendingCmd }
  const pool = new Map();
  // Map<hostId, Promise<ShellEntry>> — 正在建立中的连接，避免并发首次 acquire 重复建连
  const pending = new Map();

  // ─── 内部工具 ────────────────────────────────────────────────────────────

  function makeMarker() {
    return `__1SHELL_MARKER_${crypto.randomBytes(6).toString('hex')}__`;
  }

  function makeAbortError() {
    const err = new Error('Cancelled');
    err.name = 'AbortError';
    err.code = 'CANCELLED';
    return err;
  }

  function looksLikeInteractivePrompt(output) {
    const tail = String(output || '').slice(-1200);
    return /(\[[^\]\n]{0,80}(?:y\/n|yes\/no|y\/f\/v\/n|Y\/n)[^\]\n]*\]\s*[:：]?\s*$)|((?:password|passphrase)\s*[:：]\s*$)|((?:press any key|are you sure|continue\?)\s*[:：]?\s*$)/i.test(tail);
  }

  function extractPendingOutput(entry, cmd = entry?.pendingCmd) {
    if (!entry || !cmd) return '';
    let output = String(entry.buffer || '');
    const endIdx = output.indexOf(`${cmd.endMarker} `);
    if (endIdx >= 0) output = output.substring(0, endIdx);
    const startIdx = output.indexOf(cmd.startMarker);
    if (startIdx >= 0) {
      const lineEnd = output.indexOf('\n', startIdx);
      output = lineEnd >= 0 ? output.substring(lineEnd + 1) : '';
    }
    return output;
  }

  function attachExecutionContext(err, entry, cmd = entry?.pendingCmd) {
    if (!err || !cmd) return err;
    const output = extractPendingOutput(entry, cmd);
    err.stdout = typeof err.stdout === 'string' ? err.stdout : output;
    err.stderr = typeof err.stderr === 'string' ? err.stderr : '';
    err.exitCode = typeof err.exitCode === 'number' ? err.exitCode : (err.code === 'EXEC_TIMEOUT' ? 124 : -1);
    err.durationMs = typeof err.durationMs === 'number' ? err.durationMs : (Date.now() - (cmd.startAt || Date.now()));
    if (output) err.partialOutput = output;
    if (looksLikeInteractivePrompt(output)) {
      err.interactivePromptDetected = true;
      err.stderr = `${err.stderr ? `${err.stderr}\n` : ''}[1Shell] command appears to be waiting for interactive input`;
    }
    return err;
  }

  function destroyEntry(hostId, reason) {
    const closeError = reason || new Error('shell connection closed');
    const entry = pool.get(hostId);
    if (!entry) return;
    pool.delete(hostId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.pendingCmd) {
      entry.pendingCmd.reject(attachExecutionContext(closeError, entry, entry.pendingCmd));
      entry.pendingCmd = null;
    }
    for (const q of (entry.queue || [])) {
      q.cleanup?.();
      q.reject(closeError);
    }
    entry.queue = [];
    try { entry.shell?.close(); } catch { /* ignore */ }
    try { entry.client?.end(); } catch { /* ignore */ }
    try { entry.proxyClient?.end(); } catch { /* ignore */ }
  }

  function resetIdleTimer(hostId) {
    const entry = pool.get(hostId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => destroyEntry(hostId), IDLE_TIMEOUT_MS);
  }

  // ─── Shell 数据处理 ──────────────────────────────────────────────────────

  function emitPendingOutput(entry) {
    const cmd = entry.pendingCmd;
    if (!cmd || typeof cmd.onOutput !== 'function') return;

    const endIdx = entry.buffer.indexOf(`${cmd.endMarker} `);
    const outputEnd = endIdx >= 0 ? endIdx : entry.buffer.length;

    if (!cmd.startSeen) {
      const startIdx = entry.buffer.indexOf(cmd.startMarker);
      if (startIdx < 0) return;
      const lineEnd = entry.buffer.indexOf('\n', startIdx);
      if (lineEnd < 0) return;
      cmd.startSeen = true;
      cmd.outputStart = lineEnd + 1;
      cmd.streamedLength = 0;
    }

    if (outputEnd <= cmd.outputStart) return;
    const output = entry.buffer.substring(cmd.outputStart, outputEnd);
    const delta = output.substring(cmd.streamedLength || 0);
    if (!delta) return;
    cmd.streamedLength = output.length;
    try { cmd.onOutput({ stream: 'stdout', text: delta }); } catch { /* ignore */ }
  }

  function onShellData(hostId, chunk) {
    const entry = pool.get(hostId);
    if (!entry || !entry.pendingCmd) return;

    entry.buffer += chunk.toString('utf8');
    emitPendingOutput(entry);

    const { endMarker } = entry.pendingCmd;
    const endPattern = `${endMarker} `;
    const endIdx = entry.buffer.indexOf(endPattern);

    if (endIdx === -1) return;

    // 找到结束标记，提取输出和退出码
    const rawOutput = entry.buffer.substring(0, endIdx);
    const afterMarker = entry.buffer.substring(endIdx + endMarker.length + 1);

    // 退出码在结束标记同一行: __MARKER__ <exitCode>
    const exitCodeMatch = afterMarker.match(/^(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : -1;

    // 清除 buffer 中已处理的部分（包括结束标记行和换行）
    const newlineAfter = afterMarker.indexOf('\n');
    entry.buffer = newlineAfter >= 0 ? afterMarker.substring(newlineAfter + 1) : '';

    // 清理输出：去掉开始标记行
    const { startMarker, resolve: resolveFn, timer } = entry.pendingCmd;
    if (timer) clearTimeout(timer);

    let output = rawOutput;
    const startIdx = output.indexOf(startMarker);
    if (startIdx >= 0) {
      // 跳过开始标记所在行（包括换行符）
      const lineEnd = output.indexOf('\n', startIdx);
      output = lineEnd >= 0 ? output.substring(lineEnd + 1) : '';
    }

    entry.pendingCmd = null;
    entry.busy = false;
    resetIdleTimer(hostId);

    resolveFn({ stdout: output, stderr: '', exitCode });

    // 处理队列中等待的下一条命令
    processQueue(hostId);
  }

  function processQueue(hostId) {
    const entry = pool.get(hostId);
    if (!entry || entry.busy || !entry.queue || entry.queue.length === 0) return;
    const next = entry.queue.shift();
    // 通过 exec 调度，但跳过排队（shell 已就绪）
    next.cleanup?.();
    if (next.signal?.aborted) {
      next.reject(makeAbortError());
      processQueue(hostId);
      return;
    }
    _execOnEntry(hostId, entry, next.command, next.timeoutMs, next.startAt, next.signal, next.onOutput)
      .then(next.resolve)
      .catch(next.reject);
  }

  // ─── 建立持久 shell ─────────────────────────────────────────────────────

  async function createShellEntry(hostId) {
    const { client, proxyClient } = await hostService.connectToHost(hostId, {
      readyTimeout: CONNECT_TIMEOUT_MS,
    });

    const shell = await new Promise((resolve, reject) => {
      const shellTimer = setTimeout(
        () => reject(new Error('shell channel open timeout')),
        10000,
      );
      client.shell({ term: 'dumb', rows: 200, cols: 200 }, (err, stream) => {
        clearTimeout(shellTimer);
        if (err) return reject(err);
        resolve(stream);
      });
    });

    const entry = {
      client,
      proxyClient,
      shell,
      idleTimer: null,
      busy: false,
      buffer: '',
      pendingCmd: null,
      queue: [],    // 并发请求排队
    };

    pool.set(hostId, entry);

    // 监听 shell 数据
    shell.on('data', (chunk) => onShellData(hostId, chunk));

    shell.on('close', () => destroyEntry(hostId));
    shell.on('error', () => destroyEntry(hostId));
    client.on('error', () => destroyEntry(hostId));
    client.on('close', () => destroyEntry(hostId));

    // 等待初始 shell prompt 输出
    await new Promise((r) => setTimeout(r, 200));
    // 清空初始 banner/prompt
    entry.buffer = '';

    // 设置 shell 环境：关闭 prompt、echo，让输出更干净
    shell.write('export PS1="" PS2="" PROMPT_COMMAND=""\n');
    shell.write('stty -echo 2>/dev/null\n');
    await new Promise((r) => setTimeout(r, 100));
    entry.buffer = '';

    resetIdleTimer(hostId);
    return entry;
  }

  // ─── 公开 API ────────────────────────────────────────────────────────────

  /**
   * 在指定主机的持久 shell 中执行命令。
   *
   * @param {string} hostId
   * @param {string} command
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, durationMs: number}>}
   */
  async function exec(hostId, command, timeoutMs = 30000, { signal, onOutput } = {}) {
    if (signal?.aborted) throw makeAbortError();
    const startAt = Date.now();

    let entry = pool.get(hostId);

    // 没有可用 shell → 新建。并发首次 acquire 复用同一个 in-flight Promise，
    // 否则两路都建连、互相覆盖，被孤立那条的 idleTimer 触发时会误杀 live 连接。
    if (!entry) {
      entry = await ensureShellEntry(hostId);
      if (signal?.aborted) throw makeAbortError();
    }

    // shell 正忙 → 排队等待，不销毁正在运行的命令。
    // 必须在拿到 entry 之后再判 busy：并发首次 acquire 拿到同一个新 entry 时，
    // 第二路会在这里看到第一路已置 busy 而进入排队，不会覆盖对方的 pendingCmd。
    if (entry.busy) {
      return new Promise((resolve, reject) => {
        const queued = { command, timeoutMs, startAt, resolve, reject, signal, onOutput };
        const onAbort = () => {
          entry.queue = entry.queue.filter((item) => item !== queued);
          reject(makeAbortError());
        };
        queued.cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        entry.queue.push(queued);
      });
    }

    return _execOnEntry(hostId, entry, command, timeoutMs, startAt, signal, onOutput);
  }

  function ensureShellEntry(hostId) {
    const existing = pool.get(hostId);
    if (existing) return Promise.resolve(existing);
    let inflight = pending.get(hostId);
    if (inflight) return inflight;
    inflight = createShellEntry(hostId).finally(() => {
      pending.delete(hostId);
    });
    pending.set(hostId, inflight);
    return inflight;
  }

  function _execOnEntry(hostId, entry, command, timeoutMs, startAt, signal, onOutput) {
    if (signal?.aborted) return Promise.reject(makeAbortError());
    const startMarker = makeMarker();
    const endMarker   = makeMarker();

    return new Promise((resolve, reject) => {
      entry.busy = true;
      entry.buffer = '';

      const onAbort = () => {
        if (!entry.pendingCmd) return;
        const err = makeAbortError();
        entry.pendingCmd = null;
        entry.busy = false;
        destroyEntry(hostId, err);
        reject(err);
      };
      const timer = setTimeout(() => {
        const pendingCmd = entry.pendingCmd;
        const err = new Error(`命令执行超时 (${timeoutMs}ms): ${command}`);
        err.code = 'EXEC_TIMEOUT';
        err.exitCode = 124;
        attachExecutionContext(err, entry, pendingCmd);
        if (entry.pendingCmd) {
          entry.pendingCmd = null;
        }
        entry.busy = false;
        // 超时后销毁此 shell（可能 half-open），下次重建
        destroyEntry(hostId, err);
        signal?.removeEventListener?.('abort', onAbort);
        reject(err);
      }, timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });

      entry.pendingCmd = {
        startMarker,
        endMarker,
        resolve: (result) => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve({ ...result, durationMs: Date.now() - startAt });
        },
        reject: (err) => {
          signal?.removeEventListener?.('abort', onAbort);
          clearTimeout(timer);
          reject(err);
        },
        timer,
        command,
        timeoutMs,
        startAt,
        onOutput,
        startSeen: false,
        outputStart: 0,
        streamedLength: 0,
      };

      // 发送命令到 shell:
      // 1. echo 开始标记
      // 2. 执行实际命令
      // 3. echo 结束标记 + 退出码
      const wrappedCommand = [
        `echo '${startMarker}'`,
        '(',
        command,
        ')',
        `__1shell_exit_code=$?`,
        `echo "${endMarker} $__1shell_exit_code"`,
      ].join('\n');

      entry.shell.write(wrappedCommand + '\n');
    });
  }

  /**
   * 关闭指定主机的持久 shell。
   */
  function release(hostId) {
    destroyEntry(hostId);
  }

  /**
   * 关闭所有持久 shell。
   */
  function closeAll() {
    for (const hostId of [...pool.keys()]) {
      destroyEntry(hostId);
    }
  }

  /**
   * 检查指定主机是否有活跃的持久 shell。
   */
  function has(hostId) {
    return pool.has(hostId);
  }

  return { exec, release, closeAll, has };
}

module.exports = { createSshShellPool };
