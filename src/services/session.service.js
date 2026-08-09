'use strict';

const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const pty = require('node-pty');

const {
  DEFAULT_COLS,
  DEFAULT_ROWS,
} = require('../config/env');
const {
  createId,
  nowIso,
} = require('../utils/common');

const MIN_TERMINAL_COLS = 24;
const MIN_TERMINAL_ROWS = 8;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;

function normalizeTerminalDimension(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeTerminalSize(cols, rows) {
  return {
    cols: normalizeTerminalDimension(cols, DEFAULT_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
    rows: normalizeTerminalDimension(rows, DEFAULT_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
  };
}

function createSessionService({ hostService }) {
  const socketSessions = new Map();

  function getSocketSessionMap(socketId) {
    let sessions = socketSessions.get(socketId);
    if (!sessions) {
      sessions = new Map();
      socketSessions.set(socketId, sessions);
    }
    return sessions;
  }

  function removeSocketSession(socketId, sessionId) {
    const sessions = socketSessions.get(socketId);
    if (!sessions) return;

    sessions.delete(sessionId);
    if (sessions.size === 0) socketSessions.delete(socketId);
  }

  function serializeSession(session) {
    return {
      id: session.id,
      hostId: session.hostId,
      hostName: session.hostName,
      type: session.type,
      status: session.status,
      createdAt: session.createdAt,
      lastError: session.lastError || null,
    };
  }

  function emitSessionStatus(socket, session, extra = {}) {
    socket.emit('session:status', {
      ...serializeSession(session),
      ...extra,
    });
  }

  function finalizeSession(socket, session, status, extra = {}) {
    if (!session || session.isFinalized) return;

    session.isFinalized = true;
    session.status = status;
    session.lastError = extra.error || null;
    removeSocketSession(socket.id, session.id);

    try {
      session.dispose?.();
    } catch {
      // ignore
    }

    emitSessionStatus(socket, session, extra);
  }

  function getExistingSessionByHost(socketId, hostId) {
    const sessions = socketSessions.get(socketId);
    if (!sessions) return null;

    for (const session of sessions.values()) {
      if (session.hostId === hostId && !session.isFinalized) return session;
    }

    return null;
  }

  /**
   * 交互式终端用哪个 shell。
   *
   * Windows 上 COMSPEC 恒为 cmd.exe，所以原来那个 `|| 'powershell.exe'` 分支
   * 永远走不到 —— 想用 PowerShell 的人没有任何入口。这里改成显式可选：
   * 设 ONESHELL_LOCAL_SHELL=powershell（或直接给可执行路径）即可切换。
   *
   * 默认仍是 cmd.exe：这是人自己敲的终端，不跟着 agent 的执行链路走
   * （agent/脚本库那边统一 PowerShell，见 bridge.execLocal 与 LOCAL_SHELL_STYLE）。
   */
  function resolveLocalShell() {
    const override = String(process.env.ONESHELL_LOCAL_SHELL || '').trim();

    if (os.platform() === 'win32') {
      if (override) {
        if (/^powershell$/i.test(override)) return 'powershell.exe';
        if (/^pwsh$/i.test(override)) return 'pwsh.exe';
        if (/^cmd$/i.test(override)) return process.env.COMSPEC || 'cmd.exe';
        return override;
      }
      return process.env.COMSPEC || 'powershell.exe';
    }

    if (override) return override;
    if (process.env.SHELL) return process.env.SHELL;
    if (fs.existsSync('/bin/bash')) return '/bin/bash';
    return '/bin/sh';
  }

  function createSessionBase(socket, host) {
    const session = {
      id: createId('session'),
      hostId: host.id,
      hostName: host.name,
      type: host.type,
      status: 'connecting',
      createdAt: nowIso(),
      isFinalized: false,
      lastError: null,
      write: () => {},
      resize: () => {},
      dispose: () => {},
    };

    getSocketSessionMap(socket.id).set(session.id, session);
    emitSessionStatus(socket, session);
    return session;
  }

  function createLocalSession(socket, host, cols, rows) {
    const session = createSessionBase(socket, host);
    const shell = resolveLocalShell();

    try {
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: os.homedir(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      });

      session.write = (data) => {
        if (!session.isFinalized) ptyProcess.write(data);
      };

      session.resize = (nextCols, nextRows) => {
        if (session.isFinalized) return;
        try {
          ptyProcess.resize(nextCols, nextRows);
        } catch {
          // ignore
        }
      };

      session.dispose = () => {
        try { ptyProcess.kill(); } catch { /* ignore */ }
      };

      ptyProcess.onData((data) => {
        if (session.isFinalized) return;
        socket.emit('session:output', {
          sessionId: session.id,
          hostId: session.hostId,
          data,
        });
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        finalizeSession(socket, session, 'closed', {
          exitCode,
          signal,
        });
      });

      session.status = 'ready';
      emitSessionStatus(socket, session);
      return session;
    } catch (error) {
      finalizeSession(socket, session, 'error', { error: error.message });
      return session;
    }
  }

  function createSshSession(socket, host, cols, rows) {
    const session = createSessionBase(socket, host);
    let shellStream = null;
    let sshClient = null;
    let proxyClient = null;

    session.write = (data) => {
      if (!session.isFinalized && shellStream && !shellStream.destroyed) {
        shellStream.write(data);
      }
    };

    session.resize = (nextCols, nextRows) => {
      if (!session.isFinalized && shellStream && !shellStream.destroyed) {
        try {
          shellStream.setWindow(nextRows, nextCols, 0, 0);
        } catch {
          // ignore
        }
      }
    };

    session.dispose = () => {
      try { shellStream?.destroy(); } catch { /* ignore */ }
      try { sshClient?.end(); } catch { /* ignore */ }
      try { proxyClient?.end(); } catch { /* ignore */ }
    };

    hostService.connectToHost(host.id, { probeOs: true })
      .then(({ client, proxyClient: proxy }) => {
        sshClient = client;
        proxyClient = proxy;

        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) {
            finalizeSession(socket, session, 'error', { error: `Shell 创建失败: ${err.message}` });
            return;
          }

          shellStream = stream;
          session.status = 'ready';
          emitSessionStatus(socket, session, proxy ? { proxy: true } : {});

          const stdoutDecoder = new StringDecoder('utf8');
          const stderrDecoder = new StringDecoder('utf8');
          const emitOutput = (data) => {
            if (session.isFinalized || !data) return;
            socket.emit('session:output', {
              sessionId: session.id,
              hostId: session.hostId,
              data,
            });
          };

          stream.on('data', (data) => {
            emitOutput(stdoutDecoder.write(data));
          });

          stream.stderr?.on('data', (data) => {
            emitOutput(stderrDecoder.write(data));
          });

          stream.on('close', () => {
            emitOutput(stdoutDecoder.end());
            emitOutput(stderrDecoder.end());
            finalizeSession(socket, session, 'closed');
          });
        });

        client.on('error', (err) => {
          finalizeSession(socket, session, 'error', { error: err.message });
        });

        client.on('close', () => {
          finalizeSession(socket, session, 'closed');
        });
      })
      .catch((err) => {
        finalizeSession(socket, session, 'error', { error: err.message });
      });

    return session;
  }

  function createSessionForHost(socket, hostId, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    const host = hostService.findHost(hostId);
    if (!host) throw new Error('主机不存在');

    const size = normalizeTerminalSize(cols, rows);
    const existing = getExistingSessionByHost(socket.id, hostId);
    if (existing) return existing;

    if (host.type === 'local') {
      return createLocalSession(socket, host, size.cols, size.rows);
    }

    return createSshSession(socket, host, size.cols, size.rows);
  }

  function writeToSession(socketId, sessionId, data) {
    const session = getSocketSessionMap(socketId).get(sessionId);
    if (!session || session.isFinalized) return;
    session.write(String(data || ''));
  }

  function resizeSession(socketId, sessionId, cols, rows) {
    const session = getSocketSessionMap(socketId).get(sessionId);
    if (!session || session.isFinalized) return;
    const size = normalizeTerminalSize(cols, rows);
    session.resize(size.cols, size.rows);
  }

  function closeSession(socket, sessionId) {
    const session = getSocketSessionMap(socket.id).get(sessionId);
    if (!session) return;
    finalizeSession(socket, session, 'closed');
  }

  function closeAllSocketSessions(socket) {
    const sessions = socketSessions.get(socket.id);
    if (!sessions) return;

    for (const session of [...sessions.values()]) {
      finalizeSession(socket, session, 'closed');
    }
  }

  return {
    closeAllSocketSessions,
    closeSession,
    createSessionForHost,
    resizeSession,
    serializeSession,
    writeToSession,
  };
}

module.exports = {
  createSessionService,
};
