'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.ONESHELL_DATA_DIR
  ? path.resolve(process.env.ONESHELL_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const ENV_FILE = process.env.ONESHELL_ENV_FILE
  ? path.resolve(process.env.ONESHELL_ENV_FILE)
  : path.join(ROOT_DIR, '.env');

require('dotenv').config({ path: ENV_FILE });

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = Math.max(1, parseInt(process.env.PORT || '3301', 10)) || 3301;
// 监听地址：默认空。空值时由 server.js 按是否配置了登录凭据决定——
// 配置了凭据则绑 0.0.0.0（对外），未配置则只绑 127.0.0.1（仅本机，安全默认）。
const BIND_HOST = (process.env.HOST || process.env.BIND_HOST || '').trim();
const PUBLIC_SERVER_URL = (process.env.PUBLIC_SERVER_URL || process.env.ONESHELL_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const ENV_API_BASE = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const ENV_API_KEY = process.env.OPENAI_API_KEY || '';
const ENV_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json');
const LOCAL_HOST_ID = 'local';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const SESSION_COOKIE_NAME = 'mvps_console_session';
const SESSION_TTL_MS = Math.max(1, parseInt(process.env.APP_SESSION_TTL_HOURS || '12', 10)) * 60 * 60 * 1000;
const AUTH_USERNAME = process.env.APP_LOGIN_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.APP_LOGIN_PASSWORD || 'admin';
const USING_DEFAULT_CREDENTIALS = !process.env.APP_LOGIN_USERNAME || !process.env.APP_LOGIN_PASSWORD;
// 鉴权是否真正启用：用户名和密码都配置了才算。auth.service 据此决定是否放行。
const AUTH_ENABLED = Boolean(process.env.APP_LOGIN_USERNAME && process.env.APP_LOGIN_PASSWORD);
const PROBE_TIMEOUT_MS = parsePositiveInt(process.env.PROBE_TIMEOUT_MS, 12000);
const PROBE_INTERVAL_MS = parsePositiveInt(process.env.PROBE_INTERVAL_MS, 60000);
const PROBE_REMOTE_CONCURRENCY = parsePositiveInt(process.env.PROBE_REMOTE_CONCURRENCY, 3);
const AGENT_DEFAULT_PROVIDER = (process.env.AGENT_DEFAULT_PROVIDER || 'claude-code').trim() || 'claude-code';
const AGENT_DEFAULT_COLS = parsePositiveInt(process.env.AGENT_DEFAULT_COLS, 100);
const AGENT_DEFAULT_ROWS = parsePositiveInt(process.env.AGENT_DEFAULT_ROWS, 28);
const AGENT_MAX_SESSIONS_PER_SOCKET = parsePositiveInt(process.env.AGENT_MAX_SESSIONS_PER_SOCKET, 5);
const ONESHELL_SECURITY_MODE = (process.env.ONESHELL_SECURITY_MODE || 'standard').trim().toLowerCase();

// 受信任的反向代理 IP 列表（逗号分隔），仅从这些 IP 来的请求才信任 X-Forwarded-For
// 默认为空：不限制，任意 IP 均可直连；部署在 Nginx 反向代理后时填写代理 IP
const TRUSTED_PROXY_IPS = (process.env.TRUSTED_PROXY_IPS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// V6 Bridge & MCP
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();
const BRIDGE_EXEC_TIMEOUT_MS = parsePositiveInt(process.env.BRIDGE_EXEC_TIMEOUT_MS, 30000);
const PROXY_TOKEN = (process.env.PROXY_TOKEN || '').trim();

// 判断一个监听地址是否仅本机可达（loopback）。
// 0.0.0.0 / :: / 空 视为对外暴露；127.x / ::1 / localhost 视为仅本机。
function isLoopbackBindHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  if (h.startsWith('127.')) return true;
  return false;
}

function updateCredentials(username, password) {
  let content = '';
  try { content = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* no .env yet */ }

  const updates = {};
  if (username !== undefined) updates.APP_LOGIN_USERNAME = username;
  if (password !== undefined) updates.APP_LOGIN_PASSWORD = password;

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

module.exports = {
  AUTH_USERNAME,
  AUTH_PASSWORD,
  DATA_DIR,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  ENV_FILE,
  ENV_API_BASE,
  ENV_API_KEY,
  ENV_MODEL,
  HOSTS_FILE,
  LOCAL_HOST_ID,
  PORT,
  PUBLIC_SERVER_URL,
  PROBE_INTERVAL_MS,
  PROBE_REMOTE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  ROOT_DIR,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  AGENT_DEFAULT_PROVIDER,
  AGENT_DEFAULT_COLS,
  AGENT_DEFAULT_ROWS,
  AGENT_MAX_SESSIONS_PER_SOCKET,
  ONESHELL_SECURITY_MODE,
  BRIDGE_TOKEN,
  BRIDGE_EXEC_TIMEOUT_MS,
  PROXY_TOKEN,
  TRUSTED_PROXY_IPS,
  USING_DEFAULT_CREDENTIALS,
  AUTH_ENABLED,
  BIND_HOST,
  isLoopbackBindHost,
  updateCredentials,
};
