'use strict';

const { emitIdeEvent } = require('../ide/ide.events');

/**
 * IDE Socket Handlers
 *
 * 事件（前端 → 后端）：
 *   ide:message   { sessionId, message, context? }
 *   ide:stop      { sessionId }
 *   ide:clear     { sessionId }
 *
 * 事件（后端 → 前端）：
 *   兼容事件仍保留：ide:thinking / ide:text-delta / ide:text / ide:tool-start / ide:tool-end / ide:done / ide:error / ide:cancelled
 *   同时额外发统一事件：ide:event { v, type, sessionId, runId, payload, ts }
 */
function registerIdeSocketHandlers(io, { ideService, ideTools, localMcpService, mcpRegistry }) {
  io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      ideService.detachSessionsForSocket?.(socket.id, 'socket_disconnect');
    });

    socket.on('ide:reattach', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) return reply({ ok: false, error: 'sessionId 为必填' });
      reply(ideService.reattachSession?.(sessionId, socket) || { ok: false, error: '服务未初始化' });
    });

    socket.on('ide:message', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const message = String(payload.message || '').trim();
      if (!sessionId || !message) {
        return reply({ ok: false, error: 'sessionId 和 message 为必填' });
      }

      reply({ ok: true });

      Promise.resolve().then(() => ideService.handleMessage({
        socket,
        sessionId,
        message,
        context: payload.context || null,
        safeMode: payload.safeMode,
        claudeCodeEnabled: payload.claudeCodeEnabled,
        unlimitedTurns: payload.unlimitedTurns,
        entry: payload.entry || payload.source || '',
        approvalMode: payload.approvalMode || payload.approval_mode || '',
      })).catch((err) => {
        emitIdeEvent(socket, 'ide:error', { sessionId, error: err?.message || 'ide:message 处理失败' });
      });
    });

    socket.on('ide:stop', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const cancelled = sessionId ? ideService.cancelSession(sessionId) : false;
      if (sessionId && !cancelled) emitIdeEvent(socket, 'ide:cancelled', { sessionId });
      reply({ ok: true, cancelled });
    });

    socket.on('ide:safe-mode', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      reply({ ok: true, safeMode: false, deprecated: true, ignored: true });
    });

    socket.on('ide:unlimited-turns', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      reply({ ok: true, unlimitedTurns: false, deprecated: true, ignored: true });
    });

    socket.on('ide:claude-code-collab', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      const enabled = payload.enabled !== false;
      if (sessionId) ideService.setClaudeCodeEnabled(sessionId, enabled);
      reply({ ok: true, claudeCodeEnabled: enabled });
    });

    socket.on('ide:clear', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (sessionId) ideService.deleteSession(sessionId);
      reply({ ok: true });
    });

    socket.on('ide:authoring-reply', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) return reply({ ok: false, error: 'sessionId 为必填' });
      const result = ideService.recordAuthoringUserReply?.(sessionId, payload) || { ok: false, error: '服务未初始化' };
      if (result.ok && result.session) emitIdeEvent(socket, 'ide:authoring-session', { sessionId, session: result.session });
      reply(result);
    });

    // ─── Agent approval / user-input responses ────────────────────────────────────
    socket.on('ide:approve-response', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!ideTools) return reply({ ok: false });
      const sessionId = String(payload.sessionId || '').trim();
      const command = String(payload.command || '').trim();
      if (sessionId && command && payload.approved) {
        ideTools.approveCommand(sessionId, command);
      }
      reply({ ok: true });
    });

    // ─── 本地 MCP 启停 ──────────────────────────────────────────
    socket.on('ide:mcp-start', async (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService || !mcpRegistry) return reply({ ok: false, error: '服务未初始化' });
      const mcpId = String(payload.mcpId || '').trim();
      if (!mcpId) return reply({ ok: false, error: 'mcpId 必填' });
      const server = mcpRegistry.getServer(mcpId);
      if (!server) return reply({ ok: false, error: `MCP 不存在: ${mcpId}` });
      if (!server.enabled) return reply({ ok: false, error: '该 MCP 已禁用' });
      if (!server.exposeToIde) return reply({ ok: false, error: '该 MCP 未开放给 IDE AI' });
      if (server.type !== 'local' && !server.command) return reply({ ok: false, error: '该 MCP 不是本地类型' });
      const result = await localMcpService.start(mcpId, server.command, { cwd: server.installDir || undefined });
      emitIdeEvent(io, 'ide:mcp-status', { mcpId, ...localMcpService.getStatus(mcpId) });
      reply(result);
    });

    socket.on('ide:mcp-stop', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService) return reply({ ok: false });
      const mcpId = String(payload.mcpId || '').trim();
      if (mcpId) localMcpService.stop(mcpId);
      emitIdeEvent(io, 'ide:mcp-status', { mcpId, status: 'stopped', tools: [] });
      reply({ ok: true });
    });

    socket.on('ide:mcp-status', (payload = {}, reply) => {
      if (typeof reply !== 'function') reply = () => {};
      if (!localMcpService) return reply({ ok: false, status: 'unavailable' });
      const mcpId = String(payload.mcpId || '').trim();
      reply({ ok: true, ...localMcpService.getStatus(mcpId) });
    });
  });
}

module.exports = { registerIdeSocketHandlers };
