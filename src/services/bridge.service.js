'use strict';

const { StringDecoder } = require('string_decoder');

const { BRIDGE_EXEC_TIMEOUT_MS } = require('../config/env');
const { execLocalScript } = require('../../lib/exec-local');
const { redactKnownSecrets } = require('../../lib/secret-redaction');
const {
  buildWindowsRemoteCommand,
  decodeClixml,
  decodeRemoteOutput,
  isWindowsOsName,
} = require('../../lib/win-shell');

/**
 * Bridge Service
 *
 * 在远端主机执行命令，支持两种模式：
 *   1. 持久 shell（sshShellPool）— MCP 调用优先使用，复用长驻 shell channel
 *   2. exec 模式（sshPool）— 每次 exec 一条命令，作为后备
 *
 * Windows 远端主机强制走 exec 模式：持久 shell 的边界标记协议依赖 POSIX 语法
 * （`(...)` 子 shell、`$?`），在 cmd.exe 下不成立；而独立 exec 通道本就原生传退出码。
 *
 * 级联（ProxyJump）逻辑由 hostService.connectToHost 统一处理，本层无感知。
 */
function createBridgeService({ hostService, auditService, sshPool, sshShellPool, commandGuard = null }) {
  const MIN_TIMEOUT_MS = 30000;

  function makeAbortError() {
    const err = new Error('Cancelled');
    err.name = 'AbortError';
    err.code = 'CANCELLED';
    return err;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw makeAbortError();
  }

  function looksLikeInteractivePrompt(output) {
    const tail = String(output || '').slice(-1200);
    return /(\[[^\]\n]{0,80}(?:y\/n|yes\/no|y\/f\/v\/n|Y\/n)[^\]\n]*\]\s*[:：]?\s*$)|((?:password|passphrase)\s*[:：]\s*$)|((?:press any key|are you sure|continue\?)\s*[:：]?\s*$)/i.test(tail);
  }

  function attachExecutionContext(err, { stdout = '', stderr = '', startAt = Date.now(), exitCode } = {}) {
    if (!err) return err;
    err.stdout = typeof err.stdout === 'string' ? err.stdout : String(stdout || '');
    err.stderr = typeof err.stderr === 'string' ? err.stderr : String(stderr || '');
    err.exitCode = typeof err.exitCode === 'number'
      ? err.exitCode
      : (typeof exitCode === 'number' ? exitCode : (err.code === 'EXEC_TIMEOUT' ? 124 : -1));
    err.durationMs = typeof err.durationMs === 'number' ? err.durationMs : Date.now() - startAt;
    const combined = `${err.stdout}\n${err.stderr}`;
    if (looksLikeInteractivePrompt(combined)) {
      err.interactivePromptDetected = true;
      err.stderr = `${err.stderr ? `${err.stderr}\n` : ''}[1Shell] command appears to be waiting for interactive input`;
    }
    return err;
  }

  /**
   * 在指定主机上执行单条命令。
   *
   * @param {string} hostId - 主机 ID
   * @param {string} command - Shell 命令
   * @param {number} [timeoutMs] - 超时毫秒数
   * @param {object} [options]
   * @param {string} [options.source] - 调用来源 ('mcp' | 'bridge_api')
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, durationMs: number}>}
   */
  async function execOnHost(hostId, command, timeoutMs, { source = 'bridge_api', clientIp, auditCommand, signal, onOutput, env, secrets } = {}) {
    throwIfAborted(signal);

    const execEnv = normalizeEnv(env);
    const redactionSecrets = mergeSecrets(secrets, Object.values(execEnv));
    const safeAuditCommand = auditCommand || redactKnownSecrets(command, redactionSecrets);
    const redactingOutput = redactOutputHandler(onOutput, redactionSecrets);

    if (typeof commandGuard?.check === 'function') {
      const verdict = await commandGuard.check({ hostId, command, source });
      if (verdict && verdict.allow === false) {
        const reason = String(verdict.reason || 'command blocked by guard');
        auditService?.log({
          action: 'bridge_exec_blocked',
          source,
          hostId,
          hostName: hostService.findHost(hostId)?.name || hostId,
          command: String(safeAuditCommand || '').substring(0, 2000),
          error: reason,
          clientIp,
        });
        return { stdout: '', stderr: `[command-guard] ${reason}`, exitCode: 126, durationMs: 0 };
      }
    }

    const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
      ? Math.max(timeoutMs, MIN_TIMEOUT_MS)
      : BRIDGE_EXEC_TIMEOUT_MS;

    const host = hostService.findHost(hostId);
    const hostName = host?.name || hostId;

    // 本机：直接用 child_process 执行，不走 SSH
    if (host && host.type === 'local') {
      return execLocal(command, timeout, { source, hostId, hostName, clientIp, auditCommand: safeAuditCommand, signal, onOutput: redactingOutput, env: execEnv, secrets: redactionSecrets });
    }

    const isWindows = isWindowsOsName((await resolveHostOsInfo(hostId, host))?.os);

    // 持久 shell 模式（所有远端调用优先走此路径）
    // 优势：单次 SSH 握手，后续命令写 stdin，无 liveness check，极低延迟
    // 并发安全：sshShellPool 内置队列，同一 host 的并发命令自动排队
    // Windows 例外：池协议是 POSIX 的，强制降级到 exec 模式
    if (sshShellPool && !isWindows) {
      return execViaShellPool(hostId, command, timeout, { source, hostName, clientIp, auditCommand: safeAuditCommand, signal, onOutput: redactingOutput, env: execEnv, secrets: redactionSecrets });
    }

    // 降级：没有 shell pool 时走 exec 模式（兼容旧配置）
    return execViaExec(hostId, command, timeout, { source, hostName, clientIp, auditCommand: safeAuditCommand, signal, onOutput: redactingOutput, env: execEnv, secrets: redactionSecrets, isWindows });
  }

  // ─── 本机模式 ───────────────────────────────────────────────────────────

  /**
   * 决定用哪套包装之前，先确认目标是什么系统。
   * hostService 提供 ensureHostOsInfo 时用它（未知则现场探一次，结果落库，只付一次代价）；
   * 老的 hostService（测试替身等）没有这个方法，就退回读已有记录。
   */
  async function resolveHostOsInfo(hostId, host) {
    if (typeof hostService.ensureHostOsInfo === 'function') {
      try {
        return await hostService.ensureHostOsInfo(hostId);
      } catch {
        // OS 未知时按 POSIX 走，等于回到本功能之前的行为。
      }
    }
    return host?.osInfo || null;
  }

  async function execLocal(command, timeout, { source, hostId, hostName, clientIp, auditCommand, signal, onOutput, env, secrets }) {
    const commandForAudit = auditCommand || command;
    // Windows 本机统一用 PowerShell：脚本库的转义风格（LOCAL_SHELL_STYLE）与
    // list_hosts 告诉模型的 shell 都是 powershell，执行端必须对齐，
    // 否则模型写的 PowerShell 会被 cmd.exe 拒收（'Write-Output' 不是内部或外部命令）。
    const result = await execLocalScript(command, { timeout, signal, windowsShell: 'powershell', onOutput, env });
    auditService?.log({
      action: 'bridge_exec',
      source,
      hostId,
      hostName,
      command: commandForAudit.substring(0, 2000),
      exitCode: result.exitCode,
      error: result.exitCode === 0 ? undefined : redactKnownSecrets(result.stderr, secrets),
      durationMs: result.durationMs,
      clientIp,
    });
    return result;
  }

  // ─── 持久 shell 模式 ─────────────────────────────────────────────────────

  async function execViaShellPool(hostId, command, timeout, { source, hostName, clientIp, auditCommand, signal, onOutput, env, secrets }) {
    const startAt = Date.now();
    const commandForAudit = auditCommand || command;
    const commandForExecution = withRemoteEnv(wrapRemoteCommand(command), env);
    try {
      const result = await sshShellPool.exec(hostId, commandForExecution, timeout, { signal, onOutput });
      auditService?.log({
        action: 'bridge_exec',
        source,
        hostId,
        hostName,
        command: commandForAudit.substring(0, 2000),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        clientIp,
      });
      return result;
    } catch (err) {
      auditService?.log({
        action: 'bridge_exec',
        source,
        hostId,
        hostName,
        command: commandForAudit.substring(0, 2000),
        error: redactKnownSecrets(err.message, secrets),
        durationMs: Date.now() - startAt,
        clientIp,
      });
      throw err;
    }
  }

  // ─── exec 模式（原有逻辑）────────────────────────────────────────────────

  function execViaExec(hostId, command, timeout, { source, hostName, clientIp, auditCommand, signal, onOutput, env, secrets, isWindows = false }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeAbortError());
      const startAt = Date.now();
      const commandForAudit = auditCommand || command;
      let commandForExecution;
      let stdinPayload = null;
      try {
        if (isWindows) {
          // 长脚本自动改走 stdin：cmd.exe 命令行只有 8191 字符，
          // 工作负载探测这类 4k+ 脚本直传必然被"命令行太长。"打回。
          const built = buildWindowsRemoteCommand(command, env);
          commandForExecution = built.command;
          stdinPayload = built.stdin;
        } else {
          commandForExecution = withRemoteEnv(wrapRemoteCommand(command), env);
        }
      } catch (buildErr) {
        // 构建期错误：直接以失败结果返回，语义与 guard 拒绝一致。
        return resolve({
          stdout: '',
          stderr: buildErr.message,
          exitCode: 126,
          durationMs: Date.now() - startAt,
        });
      }
      let settled = false;
      let timer = null;
      let targetClient = null;
      let proxyClientRef = null;
      const stdoutChunks = [];
      const stderrChunks = [];

      // Windows：stdout 是 UTF-8（载荷里设过编码），但非包装路径可能回落 cp936；
      // stderr 是 PowerShell 的 CLIXML，需要还原成纯文本。
      const collectStdout = () => (isWindows
        ? decodeRemoteOutput(Buffer.concat(stdoutChunks))
        : Buffer.concat(stdoutChunks).toString('utf8'));
      const collectStderr = () => (isWindows
        ? decodeClixml(decodeRemoteOutput(Buffer.concat(stderrChunks)))
        : Buffer.concat(stderrChunks).toString('utf8'));

      const usePool = Boolean(sshPool);

      function cleanup(healthy) {
        if (timer) { clearTimeout(timer); timer = null; }
        signal?.removeEventListener?.('abort', onAbort);
        if (usePool) {
          if (healthy) sshPool.returnToPool(hostId);
          else sshPool.release(hostId);
        } else {
          try { targetClient?.end(); } catch { /* ignore */ }
          try { proxyClientRef?.end(); } catch { /* ignore */ }
        }
      }

      function onAbort() {
        const err = makeAbortError();
        if (usePool) {
          try { sshPool.release(hostId); } catch { /* ignore */ }
        } else {
          try { targetClient?.end(); } catch { /* ignore */ }
          try { proxyClientRef?.end(); } catch { /* ignore */ }
        }
        fail(err);
      }

      function settle(result) {
        if (settled) return;
        settled = true;
        cleanup(true);
        auditService?.log({
          action: 'bridge_exec',
          source,
          hostId,
          hostName,
          command: commandForAudit.substring(0, 2000),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          clientIp,
        });
        resolve(result);
      }

      function fail(err) {
        if (settled) return;
        settled = true;
        attachExecutionContext(err, {
          stdout: collectStdout(),
          stderr: collectStderr(),
          startAt,
        });
        cleanup(false);
        auditService?.log({
          action: 'bridge_exec',
          source,
          hostId,
          hostName,
          command: commandForAudit.substring(0, 2000),
          error: redactKnownSecrets(err.message, secrets),
          durationMs: Date.now() - startAt,
          clientIp,
        });
        reject(err);
      }

      timer = setTimeout(() => {
        const err = new Error(`命令执行超时 (${timeout}ms): ${command}`);
        err.code = 'EXEC_TIMEOUT';
        err.message = redactKnownSecrets(err.message.replace(String(command), String(commandForAudit)), secrets);
        fail(err);
      }, timeout);
      signal?.addEventListener?.('abort', onAbort, { once: true });

      const connectFn = usePool
        ? () => sshPool.acquire(hostId, { readyTimeout: timeout })
        : () => hostService.connectToHost(hostId, { readyTimeout: timeout });

      connectFn()
        .then(({ client, proxyClient }) => {
          if (settled) {
            if (usePool) sshPool.returnToPool(hostId);
            else { client.end(); proxyClient?.end(); }
            return;
          }

          targetClient = client;
          proxyClientRef = usePool ? null : proxyClient;

          client.exec(commandForExecution, (err, stream) => {
            if (err) {
              const execErr = new Error(`SSH exec 失败: ${err.message}`);
              execErr.code = 'SSH_EXEC_ERROR';
              return fail(execErr);
            }

            const stdoutDecoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            const emitOutput = (streamName, text) => {
              if (!text || typeof onOutput !== 'function') return;
              try { onOutput({ stream: streamName, text }); } catch { /* ignore */ }
            };

            // Windows 的 stderr 是 CLIXML，按块剥离会切坏标签：
            // 累积原文、整体清洗、只发增量，代价是 stderr 量级很小时的重复解析。
            let winStderrRaw = '';
            let winStderrEmitted = 0;
            const emitStderr = (text) => {
              if (!isWindows) return emitOutput('stderr', text);
              if (!text) return;
              winStderrRaw += text;
              const cleaned = decodeClixml(winStderrRaw);
              if (cleaned.length <= winStderrEmitted) return;
              const delta = cleaned.slice(winStderrEmitted);
              winStderrEmitted = cleaned.length;
              emitOutput('stderr', delta);
            };

            stream.on('data', (chunk) => {
              stdoutChunks.push(chunk);
              emitOutput('stdout', stdoutDecoder.write(chunk));
            });
            stream.stderr.on('data', (chunk) => {
              stderrChunks.push(chunk);
              emitStderr(stderrDecoder.write(chunk));
            });

            stream.on('close', (code) => {
              emitOutput('stdout', stdoutDecoder.end());
              emitStderr(stderrDecoder.end());
              settle({
                stdout: collectStdout(),
                stderr: collectStderr(),
                exitCode: typeof code === 'number' ? code : -1,
                durationMs: Date.now() - startAt,
              });
            });

            stream.on('error', (streamErr) => {
              const e = new Error(`SSH stream 错误: ${streamErr.message}`);
              e.code = 'SSH_STREAM_ERROR';
              fail(e);
            });

            // 长脚本经 stdin 送达（命令行侧只有恒定长度的引导程序）
            if (stdinPayload !== null) {
              try {
                stream.write(stdinPayload);
                stream.end();
              } catch { /* stream 出错会走上面的 error 处理 */ }
            }
          });
        })
        .catch((connectErr) => {
          connectErr.code = connectErr.code || 'SSH_CONNECT_ERROR';
          fail(connectErr);
        });
    });
  }

  return { execOnHost };
}

function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || value === undefined || value === null) continue;
    const name = String(key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) continue;
    out[name] = String(value);
  }
  return out;
}

function mergeSecrets(...groups) {
  return [...new Set(groups
    .flatMap((group) => Array.isArray(group) ? group : [])
    .map((value) => String(value || ''))
    .filter((value) => value.length >= 3))]
    .sort((a, b) => b.length - a.length);
}

function redactOutputHandler(onOutput, secrets) {
  if (typeof onOutput !== 'function') return undefined;
  return (chunk = {}) => {
    try {
      onOutput({ ...chunk, text: redactKnownSecrets(chunk.text || '', secrets) });
    } catch { /* ignore */ }
  };
}

function withRemoteEnv(command, env) {
  const entries = Object.entries(normalizeEnv(env));
  if (entries.length === 0) return command;
  const exports = entries
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(' ');
  return `${exports}\n${command}`;
}

function wrapRemoteCommand(command) {
  const script = String(command || '');
  return [
    'if command -v bash >/dev/null 2>&1; then',
    `  exec bash -lc ${shellQuote(script)}`,
    'else',
    `  exec sh -lc ${shellQuote(script)}`,
    'fi',
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { createBridgeService, __private: { wrapRemoteCommand, withRemoteEnv } };
