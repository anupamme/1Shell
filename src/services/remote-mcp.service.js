'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ALLOWED_TOOLS = [
  'list_hosts',
  'list_scripts',
  'query_audit',
  'list_probes',
  'get_probe',
  'get_probe_samples',
  'get_probe_timeseries',
  'get_probe_traffic',
  'list_probe_alerts',
  'probe_diag_ping',
  'probe_diag_http',
  'probe_diag_dns',
];

function createRemoteMcpService({ dataDir, auditService, logger } = {}) {
  const filePath = path.join(dataDir, 'remote-mcp.json');

  const DEFAULT_STATE = {
    enabled: false,
    auditEnabled: true,
    requireHttps: true,
    allowedOrigins: [],
    allowedHosts: [],
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    tokens: [],
    updatedAt: null,
  };

  function ensureFile() {
    if (!fs.existsSync(filePath)) {
      writeState(DEFAULT_STATE);
    }
  }

  function readState() {
    ensureFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeState(parsed);
    } catch (err) {
      logger?.warn?.(`[remote-mcp] failed to read config: ${err.message}`);
      return normalizeState(DEFAULT_STATE);
    }
  }

  function writeState(state) {
    fs.writeFileSync(filePath, JSON.stringify(normalizeState(state), null, 2), 'utf8');
  }

  function readConfig() {
    return publicConfig(readState());
  }

  function updateConfig(patch = {}) {
    const current = readState();
    const next = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.auditEnabled === 'boolean') next.auditEnabled = patch.auditEnabled;
    if (typeof patch.requireHttps === 'boolean') next.requireHttps = patch.requireHttps;
    if (Array.isArray(patch.allowedOrigins)) next.allowedOrigins = cleanStringList(patch.allowedOrigins);
    if (Array.isArray(patch.allowedHosts)) next.allowedHosts = cleanStringList(patch.allowedHosts).map(stripPort).filter(Boolean);
    if (Array.isArray(patch.allowedTools)) next.allowedTools = cleanStringList(patch.allowedTools);
    next.updatedAt = new Date().toISOString();

    writeState(next);
    auditService?.log?.({
      action: 'remote_mcp_config_update',
      source: 'web_ui',
      details: JSON.stringify({
        enabled: next.enabled,
        auditEnabled: next.auditEnabled,
        requireHttps: next.requireHttps,
        allowedOrigins: next.allowedOrigins.length,
        allowedHosts: next.allowedHosts.length,
        allowedTools: next.allowedTools.length,
      }),
    });
    return readConfig();
  }

  function listTokens() {
    return readState().tokens.map(publicToken);
  }

  function createToken(input = {}) {
    const state = readState();
    const token = `1smcp_${crypto.randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const record = {
      id: createId('rtok'),
      name: String(input.name || 'Remote MCP Token').trim().slice(0, 80) || 'Remote MCP Token',
      tokenHash: hashToken(token),
      prefix: token.slice(0, 12),
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: normalizeExpiresAt(input.expiresAt),
      allowedTools: Array.isArray(input.allowedTools) ? cleanStringList(input.allowedTools) : [...state.allowedTools],
      allowedHosts: Array.isArray(input.allowedHosts) ? cleanStringList(input.allowedHosts) : [],
      allowedScripts: Array.isArray(input.allowedScripts) ? cleanStringList(input.allowedScripts) : [],
      allowedPaths: Array.isArray(input.allowedPaths) ? cleanStringList(input.allowedPaths) : [],
    };
    state.tokens.push(record);
    state.updatedAt = now;
    writeState(state);
    auditService?.log?.({ action: 'remote_mcp_token_create', source: 'web_ui', details: JSON.stringify({ tokenId: record.id, name: record.name }) });
    return { token, record: publicToken(record) };
  }

  function updateToken(id, patch = {}) {
    const state = readState();
    const token = state.tokens.find((item) => item.id === id);
    if (!token) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) token.name = patch.name.trim().slice(0, 80);
    if (Array.isArray(patch.allowedTools)) token.allowedTools = cleanStringList(patch.allowedTools);
    if (Array.isArray(patch.allowedHosts)) token.allowedHosts = cleanStringList(patch.allowedHosts);
    if (Array.isArray(patch.allowedScripts)) token.allowedScripts = cleanStringList(patch.allowedScripts);
    if (Array.isArray(patch.allowedPaths)) token.allowedPaths = cleanStringList(patch.allowedPaths);
    if (patch.expiresAt !== undefined) token.expiresAt = normalizeExpiresAt(patch.expiresAt);
    state.updatedAt = new Date().toISOString();
    writeState(state);
    auditService?.log?.({
      action: 'remote_mcp_token_update',
      source: 'web_ui',
      details: JSON.stringify({ tokenId: token.id, name: token.name, allowedTools: token.allowedTools.length, allowedHosts: token.allowedHosts.length, allowedScripts: token.allowedScripts.length, allowedPaths: token.allowedPaths.length }),
    });
    return publicToken(token);
  }

  function revokeToken(id) {
    const state = readState();
    const token = state.tokens.find((item) => item.id === id);
    if (!token) return null;
    if (!token.revokedAt) token.revokedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    writeState(state);
    auditService?.log?.({ action: 'remote_mcp_token_revoke', source: 'web_ui', details: JSON.stringify({ tokenId: token.id, name: token.name }) });
    return publicToken(token);
  }

  function validateToken(req) {
    const raw = extractToken(req);
    if (!raw) return { ok: false, code: 'REMOTE_MCP_TOKEN_REQUIRED', error: 'Remote MCP Token 缺失' };
    const state = readState();
    const hash = hashToken(raw);
    const nowMs = Date.now();
    const token = state.tokens.find((item) => item.tokenHash && safeEqual(item.tokenHash, hash));
    if (!token || token.revokedAt) return { ok: false, code: 'REMOTE_MCP_TOKEN_INVALID', error: 'Remote MCP Token 无效或已吊销' };
    if (token.expiresAt && Date.parse(token.expiresAt) <= nowMs) return { ok: false, code: 'REMOTE_MCP_TOKEN_EXPIRED', error: 'Remote MCP Token 已过期' };
    token.lastUsedAt = new Date().toISOString();
    writeState(state);
    return { ok: true, token: publicToken(token) };
  }

  function getStatus(req) {
    const state = readState();
    const config = publicConfig(state);
    const request = req ? inspectRequest(req) : null;
    return {
      ok: true,
      config,
      tokens: state.tokens.map(publicToken),
      defaults: {
        allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      },
      request,
      warnings: buildWarnings(config, request),
    };
  }

  function validateRequest(req) {
    const state = readState();
    const config = publicConfig(state);
    const request = inspectRequest(req);
    const context = {
      source: request.exposure === 'remote' ? 'remote_mcp' : 'mcp',
      exposure: request.exposure,
      clientIp: request.clientIp,
      origin: request.origin,
      host: request.host,
      allowedTools: request.exposure === 'remote' ? config.allowedTools : null,
      auditEnabled: request.exposure === 'remote' ? config.auditEnabled : true,
    };

    if (request.origin && !isOriginAllowed(request.origin, config.allowedOrigins, request)) {
      auditDenied('remote_mcp_origin_denied', request, { allowedOrigins: config.allowedOrigins.length });
      return { ok: false, status: 403, code: 'ORIGIN_DENIED', error: 'MCP Origin 不在允许列表中', context };
    }

    if (request.exposure !== 'remote') {
      return { ok: true, context };
    }

    if (!config.enabled) {
      auditDenied('remote_mcp_disabled', request);
      return { ok: false, status: 403, code: 'REMOTE_MCP_DISABLED', error: 'Remote MCP 未启用', context };
    }

    if (config.requireHttps && request.protocol !== 'https') {
      auditDenied('remote_mcp_https_required', request, { protocol: request.protocol });
      return { ok: false, status: 403, code: 'HTTPS_REQUIRED', error: 'Remote MCP 要求 HTTPS 访问', context };
    }

    if (config.allowedHosts.length > 0 && !isHostAllowed(request.hostname, config.allowedHosts)) {
      auditDenied('remote_mcp_host_denied', request, { allowedHosts: config.allowedHosts.length });
      return { ok: false, status: 403, code: 'HOST_DENIED', error: 'MCP Host 不在允许列表中', context };
    }

    return { ok: true, context };
  }

  function isToolAllowed(name, context = {}) {
    if (context.exposure !== 'remote') return true;
    const allowed = Array.isArray(context.allowedTools) ? context.allowedTools : [];
    return allowed.includes(name);
  }

  function filterTools(tools, context = {}) {
    if (context.exposure !== 'remote') return tools;
    const allowed = new Set(Array.isArray(context.allowedTools) ? context.allowedTools : []);
    return tools.filter((tool) => allowed.has(tool.name));
  }

  function auditDenied(action, request, extra = {}) {
    auditService?.log?.({
      action,
      source: 'remote_mcp',
      clientIp: request.clientIp,
      command: request.path,
      details: JSON.stringify({
        host: request.host,
        origin: request.origin || null,
        protocol: request.protocol,
        exposure: request.exposure,
        ...extra,
      }),
    });
  }

  function inspectRequest(req) {
    const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').trim();
    const hostname = stripPort(host).toLowerCase();
    const protocol = String(req.headers?.['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim().toLowerCase() || 'http';
    const clientIp = getClientIp(req);
    const origin = String(req.headers?.origin || '').trim();
    const localHost = isLocalHostname(hostname);
    const localClient = isLocalIp(getSocketIp(req));
    return {
      host,
      hostname,
      protocol,
      clientIp,
      origin,
      path: req.originalUrl || req.url || '',
      exposure: localHost && localClient ? 'local' : 'remote',
    };
  }

  function buildWarnings(config, request) {
    const warnings = [];
    if (!config.enabled) warnings.push('Remote MCP 当前未启用，仅本地 / localhost MCP 可用。');
    if (config.enabled && config.requireHttps) warnings.push('已要求 Remote MCP 必须通过 HTTPS 或 X-Forwarded-Proto=https 访问。');
    if (config.enabled && config.allowedHosts.length === 0) warnings.push('Remote MCP 未配置 allowedHosts，建议绑定公网域名。');
    if (config.enabled && config.allowedOrigins.length === 0) warnings.push('未允许任何浏览器 Origin；CLI/IDE 客户端通常不带 Origin，可正常连接。');
    if (config.enabled && config.allowedTools.length === 0) warnings.push('Remote MCP allowedTools 为空，远程客户端将看不到工具。');
    if (config.enabled && listTokens().filter((token) => !token.revokedAt).length === 0) warnings.push('Remote MCP 已启用但没有可用专用 Token。');
    if (request?.exposure === 'remote' && config.requireHttps && request.protocol !== 'https') warnings.push('当前请求不是 HTTPS，启用 requireHttps 后会被拒绝。');
    return warnings;
  }

  function normalizeState(state = {}) {
    return {
      ...DEFAULT_STATE,
      ...state,
      enabled: state.enabled === true,
      auditEnabled: state.auditEnabled !== false,
      requireHttps: state.requireHttps !== false,
      allowedOrigins: cleanStringList(state.allowedOrigins),
      allowedHosts: cleanStringList(state.allowedHosts).map(stripPort).filter(Boolean),
      allowedTools: Array.isArray(state.allowedTools) ? cleanStringList(state.allowedTools) : [...DEFAULT_ALLOWED_TOOLS],
      tokens: Array.isArray(state.tokens) ? state.tokens.map(normalizeTokenRecord).filter(Boolean) : [],
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
    };
  }

  function publicConfig(state) {
    return {
      enabled: state.enabled === true,
      auditEnabled: state.auditEnabled !== false,
      requireHttps: state.requireHttps !== false,
      allowedOrigins: cleanStringList(state.allowedOrigins),
      allowedHosts: cleanStringList(state.allowedHosts),
      allowedTools: Array.isArray(state.allowedTools) ? cleanStringList(state.allowedTools) : [...DEFAULT_ALLOWED_TOOLS],
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
    };
  }

  function normalizeTokenRecord(record) {
    if (!record || typeof record !== 'object' || !record.tokenHash) return null;
    return {
      id: String(record.id || createId('rtok')).slice(0, 80),
      name: String(record.name || 'Remote MCP Token').slice(0, 80),
      tokenHash: String(record.tokenHash),
      prefix: String(record.prefix || '').slice(0, 24),
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
      lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : null,
      revokedAt: typeof record.revokedAt === 'string' ? record.revokedAt : null,
      expiresAt: normalizeExpiresAt(record.expiresAt),
      allowedTools: Array.isArray(record.allowedTools) ? cleanStringList(record.allowedTools) : [...DEFAULT_ALLOWED_TOOLS],
      allowedHosts: Array.isArray(record.allowedHosts) ? cleanStringList(record.allowedHosts) : [],
      allowedScripts: Array.isArray(record.allowedScripts) ? cleanStringList(record.allowedScripts) : [],
      allowedPaths: Array.isArray(record.allowedPaths) ? cleanStringList(record.allowedPaths) : [],
    };
  }

  function publicToken(record) {
    return {
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      revokedAt: record.revokedAt,
      expiresAt: record.expiresAt,
      allowedTools: Array.isArray(record.allowedTools) ? cleanStringList(record.allowedTools) : [...DEFAULT_ALLOWED_TOOLS],
      allowedHosts: Array.isArray(record.allowedHosts) ? cleanStringList(record.allowedHosts) : [],
      allowedScripts: Array.isArray(record.allowedScripts) ? cleanStringList(record.allowedScripts) : [],
      allowedPaths: Array.isArray(record.allowedPaths) ? cleanStringList(record.allowedPaths) : [],
    };
  }

  function normalizeExpiresAt(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function extractToken(req) {
    let token = req.headers?.['x-remote-mcp-token'] || req.headers?.['x-1shell-mcp-token'];
    if (!token) {
      const authHeader = String(req.headers?.authorization || '');
      if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    }
    return String(token || '').trim();
  }

  function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
  }

  function safeEqual(a, b) {
    const left = Buffer.from(String(a || ''), 'hex');
    const right = Buffer.from(String(b || ''), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function createId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
  }

  function cleanStringList(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
  }

  function stripPort(host) {
    const raw = String(host || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
    return raw.split(':')[0];
  }

  function isLocalHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '';
  }

  function isLocalIp(ip) {
    const clean = String(ip || '').replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost' || clean === '' || clean === 'unknown';
  }

  function getClientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return getSocketIp(req);
  }

  function getSocketIp(req) {
    return req.socket?.remoteAddress || req.ip || 'unknown';
  }

  function isOriginAllowed(origin, allowedOrigins, request) {
    if (!origin) return true;
    if (allowedOrigins.includes('*')) return true;
    if (allowedOrigins.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      const originHost = stripPort(parsed.host);
      if (request.exposure === 'local' && isLocalHostname(originHost)) return true;
    } catch { /* invalid origins are denied */ }
    return false;
  }

  function isHostAllowed(hostname, allowedHosts) {
    if (allowedHosts.includes('*')) return true;
    return allowedHosts.map(stripPort).includes(stripPort(hostname));
  }

  return {
    DEFAULT_ALLOWED_TOOLS,
    getStatus,
    readConfig,
    updateConfig,
    listTokens,
    createToken,
    updateToken,
    revokeToken,
    validateRequest,
    validateToken,
    isToolAllowed,
    filterTools,
  };
}

module.exports = { createRemoteMcpService, DEFAULT_ALLOWED_TOOLS };
