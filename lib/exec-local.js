'use strict';

const os = require('os');
const { exec: childExec, spawn } = require('child_process');

const { buildLocalWindowsPayload } = require('./win-shell');

let iconvLite = null;
try { iconvLite = require('iconv-lite'); } catch { /* optional */ }

function makeAbortError(message = 'Cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'CANCELLED';
  return err;
}

function decodeBuffer(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value)) return String(value || '');
  if (value.length === 0) return '';
  if (os.platform() !== 'win32') return value.toString('utf8');
  const utf8 = value.toString('utf8');
  if (!utf8.includes('�') && !utf8.includes('??')) return utf8;
  if (iconvLite) {
    try { return iconvLite.decode(value, 'cp936'); } catch { /* fallback */ }
  }
  return utf8;
}

function emitOutputChunk(onOutput, stream, chunk) {
  if (typeof onOutput !== 'function') return;
  const text = decodeBuffer(chunk);
  if (!text) return;
  try { onOutput({ stream, text }); } catch { /* ignore */ }
}

function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return process.env;
  const extra = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || value === undefined || value === null) continue;
    extra[key] = String(value);
  }
  return { ...process.env, ...extra };
}

function execLocalCommand(command, { timeout = 30000, cwd, signal, maxBuffer = 8 * 1024 * 1024, onOutput, env } = {}) {
  const startedAt = Date.now();
  const safeTimeout = Math.max(1000, Number(timeout) || 30000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());

    const opts = {
      timeout: safeTimeout,
      maxBuffer,
      ...(cwd ? { cwd } : {}),
      env: normalizeEnv(env),
      ...(os.platform() === 'win32' ? { encoding: 'buffer' } : { encoding: 'utf8' }),
    };

    let settled = false;
    let child = null;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { child?.kill?.('SIGKILL'); } catch { /* ignore */ }
      cleanup();
      reject(makeAbortError());
    };

    child = childExec(command, opts, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      const decodedStdout = decodeBuffer(stdout);
      const decodedStderr = decodeBuffer(stderr);
      resolve({
        stdout: decodedStdout,
        stderr: decodedStderr || (err ? String(err.message || '') : ''),
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        durationMs: Date.now() - startedAt,
      });
    });
    child.stdout?.on?.('data', (chunk) => emitOutputChunk(onOutput, 'stdout', chunk));
    child.stderr?.on?.('data', (chunk) => emitOutputChunk(onOutput, 'stderr', chunk));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function spawnLocalScript(command, { timeout = 30000, signal, windowsShell = 'powershell', maxBuffer = 8 * 1024 * 1024, onOutput, env } = {}) {
  const startAt = Date.now();
  const safeTimeout = Math.max(1000, Number(timeout) || 30000);
  const isWindows = os.platform() === 'win32';
  const childEnv = normalizeEnv(env);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());

    let child;
    try {
      if (isWindows && windowsShell === 'cmd') {
        child = spawn('cmd.exe', ['/s', '/c', command], { windowsHide: true, env: childEnv });
      } else if (isWindows) {
        child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, env: childEnv });
      } else {
        child = spawn('/bin/bash', ['-s'], { env: childEnv });
      }
    } catch (err) {
      return resolve({
        stdout: '',
        stderr: `无法启动本地 shell: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - startAt,
      });
    }

    const stdoutBufs = [];
    const stderrBufs = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let killedByTimeout = false;
    let settled = false;

    child.stdout.on('data', (chunk) => {
      emitOutputChunk(onOutput, 'stdout', chunk);
      if (stdoutLen < maxBuffer) {
        stdoutBufs.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      emitOutputChunk(onOutput, 'stderr', chunk);
      if (stderrLen < maxBuffer) {
        stderrBufs.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      cleanup();
      reject(makeAbortError());
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, safeTimeout);
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const stdout = decodeBuffer(Buffer.concat(stdoutBufs));
      const stderr = decodeBuffer(Buffer.concat(stderrBufs));
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
        durationMs: Date.now() - startAt,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const stdout = decodeBuffer(Buffer.concat(stdoutBufs));
      const stderr = decodeBuffer(Buffer.concat(stderrBufs));
      resolve({
        stdout,
        stderr: killedByTimeout ? `${stderr}\n（执行超时，已强制终止）` : stderr,
        exitCode: code != null ? code : (killedByTimeout ? 124 : 1),
        durationMs: Date.now() - startAt,
      });
    });

    try {
      if (!isWindows || windowsShell !== 'cmd') {
        // Windows PowerShell：包一层退出码归一，否则 `cmd /c "exit 7"` 这类
        // native 命令的退出码会被吞成 1（-Command 只反映 $?）。
        child.stdin.write(isWindows ? buildLocalWindowsPayload(command) : command);
      }
      child.stdin.end();
    } catch { /* ignore */ }
  });
}

module.exports = { decodeBuffer, execLocalCommand, execLocalScript: spawnLocalScript, makeAbortError };
