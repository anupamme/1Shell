'use strict';

const {
  validateSessionClosePayload,
  validateSessionCreatePayload,
  validateSessionInputPayload,
  validateSessionResizePayload,
} = require('../utils/validators');
const {
  DEFAULT_COLS,
  DEFAULT_ROWS,
} = require('../config/env');
const { normalizePort } = require('../utils/common');
const log = require('../../lib/logger');

function registerSessionSocketHandlers(io, { sessionService }) {
  io.on('connection', (socket) => {
    log.info('WS 连接', { socketId: socket.id });

    socket.on('session:create', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      try {
        const validated = validateSessionCreatePayload(payload);
        const cols = normalizePort(validated.cols, DEFAULT_COLS);
        const rows = normalizePort(validated.rows, DEFAULT_ROWS);
        log.info('终端会话创建', {
          socketId: socket.id,
          hostId: validated.hostId,
          cols,
          rows,
        });
        const session = sessionService.createSessionForHost(socket, validated.hostId, cols, rows);
        reply({ ok: true, session: sessionService.serializeSession(session) });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('session:input', (payload = {}) => {
      try {
        const validated = validateSessionInputPayload(payload);
        // 不记录输入内容预览：每次按键都会触发，且会把用户键入的密码/密钥写进日志。
        log.debug('终端输入', {
          socketId: socket.id,
          sessionId: validated.sessionId,
          dataLength: String(validated.data || '').length,
        });
        sessionService.writeToSession(socket.id, validated.sessionId, validated.data);
      } catch {
        // ignore invalid payload
      }
    });

    socket.on('session:resize', (payload = {}) => {
      try {
        const validated = validateSessionResizePayload(payload);
        sessionService.resizeSession(socket.id, validated.sessionId, validated.cols, validated.rows);
      } catch {
        // ignore invalid payload
      }
    });

    socket.on('session:close', (payload = {}) => {
      try {
        const validated = validateSessionClosePayload(payload);
        sessionService.closeSession(socket, validated.sessionId);
      } catch {
        // ignore invalid payload
      }
    });

    socket.on('disconnect', () => {
      sessionService.closeAllSocketSessions(socket);
      log.info('WS 断开', { socketId: socket.id });
    });
  });
}

module.exports = {
  registerSessionSocketHandlers,
};
