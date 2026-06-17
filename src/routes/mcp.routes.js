'use strict';

const { Router } = require('express');

/**
 * MCP Routes
 *
 * GET  /mcp/sse      — 建立 SSE 长连接，客户端订阅此端点
 * POST /mcp/message  — 客户端发送 JSON-RPC 消息
 *
 * 鉴权：本地 loopback 访问可免 token；Remote MCP 使用 X-Remote-Mcp-Token / Bearer。
 */
function createMcpRouter({ mcpService, remoteMcpService }) {
  const router = Router();

  function isLoopbackLocalRequest(req) {
    const host = stripPort(String(req.headers.host || '').trim().toLowerCase());
    const socketIp = normalizeIp(req.socket?.remoteAddress || req.ip || '');
    return isLocalHost(host) && isLocalIp(socketIp);
  }

  function stripPort(host) {
    if (!host) return '';
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
    return host.split(':')[0];
  }

  function normalizeIp(ip) {
    return String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
  }

  function isLocalHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function isLocalIp(ip) {
    return ip === '127.0.0.1' || ip === '::1';
  }

  function requireRemotePolicy(req, res, next) {
    if (!remoteMcpService) return next();
    const result = remoteMcpService.validateRequest(req);
    if (!result.ok) {
      return res.status(result.status || 403).json({ ok: false, error: result.error, code: result.code });
    }
    req.mcpContext = result.context;
    return next();
  }

  function requireToken(req, res, next) {
    if (req.mcpContext?.exposure === 'remote' && remoteMcpService) {
      const result = remoteMcpService.validateToken(req);
      if (!result.ok) {
        return res.status(401).json({ ok: false, error: result.error, code: result.code || 'UNAUTHORIZED' });
      }
      req.mcpContext.remoteToken = result.token;
      const globalAllowed = new Set(Array.isArray(req.mcpContext.allowedTools) ? req.mcpContext.allowedTools : []);
      const tokenAllowed = Array.isArray(result.token.allowedTools) ? result.token.allowedTools : [];
      req.mcpContext.allowedTools = tokenAllowed.filter((name) => globalAllowed.has(name));
      req.mcpContext.allowedHosts = Array.isArray(result.token.allowedHosts) ? result.token.allowedHosts : [];
      req.mcpContext.allowedScripts = Array.isArray(result.token.allowedScripts) ? result.token.allowedScripts : [];
      req.mcpContext.allowedPaths = Array.isArray(result.token.allowedPaths) ? result.token.allowedPaths : [];
      return next();
    }

    if (isLoopbackLocalRequest(req)) return next();

    // 非 loopback 本地 MCP 只接受 header 传 Bridge Token，禁止 query param（防止进 access log / 浏览器历史）
    let token = req.headers['x-bridge-token'];
    if (!token) {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }
    if (!mcpService.validateToken(token)) {
      return res.status(401).json({
        ok: false,
        error: 'MCP Token 无效或未配置 BRIDGE_TOKEN',
        code: 'UNAUTHORIZED',
      });
    }
    return next();
  }

  // Streamable HTTP MCP：POST /mcp/sse — Codex v0.120+ 使用此协议
  router.post('/sse', requireRemotePolicy, requireToken, async (req, res) => {
    const msg = req.body;

    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    }

    const batch = Array.isArray(msg) ? msg : [msg];
    const results = [];

    try {
      for (const item of batch) {
        const result = await mcpService.handleDirectRequest(item, req.mcpContext || {});
        if (result) results.push(result);
      }
    } catch (err) {
      if (res.headersSent) return;
      return res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err?.message || 'Internal error' },
        id: (msg && !Array.isArray(msg) && msg.id != null) ? msg.id : null,
      });
    }

    if (results.length === 0) {
      return res.status(202).end();
    }

    if (Array.isArray(msg)) {
      return res.json(results);
    }
    return res.json(results[0]);
  });

  // SSE 连接端点
  router.get('/sse', requireRemotePolicy, requireToken, (req, res) => {
    // 设置 SSE 必要响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 关闭 nginx 缓冲
    res.flushHeaders();

    // 构造 baseUrl 用于生成 endpoint 事件
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const baseUrl = `${proto}://${host}`;

    const sessionId = mcpService.connect(res, baseUrl, req.mcpContext || {});

    // 客户端断开时清理 session
    req.on('close', () => {
      mcpService.disconnect(sessionId);
    });
  });

  // JSON-RPC 消息端点
  router.post('/message', requireRemotePolicy, requireToken, async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: '缺少 sessionId 参数', code: 'BAD_REQUEST' });
    }

    const msg = req.body;
    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({ ok: false, error: '请求体必须为 JSON 对象', code: 'BAD_REQUEST' });
    }

    let found;
    try {
      found = await mcpService.receiveMessage(sessionId, msg);
    } catch (err) {
      if (res.headersSent) return;
      return res.status(500).json({ ok: false, error: err?.message || 'Internal error', code: 'INTERNAL_ERROR' });
    }
    if (!found) {
      return res.status(404).json({ ok: false, error: 'MCP session 不存在或已断开', code: 'SESSION_NOT_FOUND' });
    }

    // MCP 规范：POST 响应为空 202
    return res.status(202).end();
  });

  return router;
}

module.exports = { createMcpRouter };
