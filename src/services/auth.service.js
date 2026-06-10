'use strict';

const crypto = require('crypto');

const {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  TRUSTED_PROXY_IPS,
  updateCredentials: updateEnvCredentials,
} = require('../config/env');
const { parseCookies } = require('../utils/common');

const CSRF_COOKIE_NAME = 'mvps_csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

function getAuthUsername() { return process.env.APP_LOGIN_USERNAME || ''; }
function getAuthPassword() { return process.env.APP_LOGIN_PASSWORD || ''; }

function createAuthService({ twoFactorService = null } = {}) {
  const authSessions = new Map();

  // 2FA 待验证票据：密码校验通过后签发，验证码通过后才发正式会话
  const pendingTwoFactor = new Map();
  const PENDING_2FA_TTL_MS = 2 * 60 * 1000;
  const PENDING_2FA_MAX_ATTEMPTS = 5;

  // 暴力破解防护：记录每个 IP 的失败次数与解锁时间
  const loginFailMap = new Map();
  const MAX_FAIL_COUNT = 5;
  const LOCKOUT_MS = 60 * 1000;

  function getClientIp(req) {
    const remoteIp = req.socket?.remoteAddress || req.ip || 'unknown';
    // 只有来自受信任代理 IP 的请求才读取 X-Forwarded-For，防止伪造绕过锁定
    if (TRUSTED_PROXY_IPS.includes(remoteIp)) {
      const forwarded = req.headers?.['x-forwarded-for'];
      if (forwarded) return String(forwarded).split(',')[0].trim();
    }
    return remoteIp;
  }

  function shouldUseSecureCookie(req) {
    const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return Boolean(req?.secure || req?.socket?.encrypted || forwardedProto === 'https');
  }

  function isIpLockedOut(ip) {
    const record = loginFailMap.get(ip);
    if (!record) return false;
    if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
    if (record.lockedUntil && Date.now() >= record.lockedUntil) {
      loginFailMap.delete(ip);
    }
    return false;
  }

  function recordLoginFailure(ip) {
    const record = loginFailMap.get(ip) || { count: 0, lockedUntil: null };
    record.count += 1;
    if (record.count >= MAX_FAIL_COUNT) {
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    loginFailMap.set(ip, record);
  }

  function clearLoginFailure(ip) {
    loginFailMap.delete(ip);
  }

  function createAuthSession() {
    const sessionId = crypto.randomUUID();
    const csrfToken = crypto.randomBytes(24).toString('hex');
    authSessions.set(sessionId, {
      expiresAt: Date.now() + SESSION_TTL_MS,
      csrfToken,
    });
    return { sessionId, csrfToken };
  }

  function clearExpiredAuthSessions() {
    const now = Date.now();
    for (const [sessionId, session] of authSessions.entries()) {
      if (!session || session.expiresAt <= now) {
        authSessions.delete(sessionId);
      }
    }
  }

  function getAuthSessionId(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[SESSION_COOKIE_NAME] || '';
  }

  function isRequestAuthenticated(req) {
    if (!getAuthUsername() && !getAuthPassword()) return true;
    clearExpiredAuthSessions();
    const sessionId = getAuthSessionId(req);
    const session = authSessions.get(sessionId);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      authSessions.delete(sessionId);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return true;
  }

  // 校验 CSRF token：GET/HEAD/OPTIONS 豁免，其余必须携带有效 token
  function verifyCsrfToken(req) {
    if (!getAuthUsername() && !getAuthPassword()) return true;
    const method = req.method?.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const sessionId = getAuthSessionId(req);
    const session = authSessions.get(sessionId);
    if (!session) return false;

    const tokenFromHeader = req.headers[CSRF_HEADER_NAME] || '';
    const tokenFromSession = session.csrfToken || '';
    if (!tokenFromHeader || !tokenFromSession) return false;

    // 等长比较防时序攻击
    if (tokenFromHeader.length !== tokenFromSession.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(tokenFromHeader),
      Buffer.from(tokenFromSession),
    );
  }

  function setAuthCookie(res, sessionId, csrfToken, req = null) {
    const secure = shouldUseSecureCookie(req);
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const secureFlag = secure ? '; Secure' : '';

    // Session cookie：HttpOnly，JS 不可读
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
      // CSRF cookie：不带 HttpOnly，前端 JS 可读取后放入请求头
      `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
    ]);
  }

  function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`,
    ]);
  }

  function requireAuth(req, res, next) {
    if (!isRequestAuthenticated(req)) {
      return res.status(401).json({ error: '未登录或登录已失效' });
    }
    if (!verifyCsrfToken(req)) {
      return res.status(403).json({ error: 'CSRF 校验失败，请刷新页面后重试' });
    }
    return next();
  }

  function isAuthEnabled() {
    return Boolean(getAuthUsername() && getAuthPassword());
  }

  function login(username, password, ip = 'unknown') {
    if (!getAuthUsername() && !getAuthPassword()) {
      return { ok: true, enabled: false, authenticated: true, sessionId: '', csrfToken: '' };
    }

    if (isIpLockedOut(ip)) {
      const error = new Error('登录失败次数过多，请 60 秒后再试');
      error.status = 429;
      throw error;
    }

    const normalizedUsername = String(username || '');
    const normalizedPassword = String(password || '');

    const usernameMatch = !getAuthUsername() || normalizedUsername === getAuthUsername();
    const passwordMatch = !getAuthPassword() || (
      normalizedPassword.length === getAuthPassword().length
      && crypto.timingSafeEqual(Buffer.from(normalizedPassword), Buffer.from(getAuthPassword()))
    );

    if (!usernameMatch || !passwordMatch) {
      recordLoginFailure(ip);
      const error = new Error('用户名或密码错误');
      error.status = 401;
      throw error;
    }

    clearLoginFailure(ip);

    // 已开启 2FA：密码通过后签发短时效待验证票据，验证码通过后才发正式会话
    if (twoFactorService?.isEnabled?.()) {
      const pendingToken = crypto.randomBytes(24).toString('hex');
      pendingTwoFactor.set(pendingToken, {
        expiresAt: Date.now() + PENDING_2FA_TTL_MS,
        attempts: 0,
        ip,
      });
      return {
        ok: true,
        enabled: true,
        authenticated: false,
        requiresTwoFactor: true,
        pendingToken,
        sessionId: '',
        csrfToken: '',
      };
    }

    const { sessionId, csrfToken } = createAuthSession();
    return {
      ok: true,
      enabled: true,
      authenticated: true,
      sessionId,
      csrfToken,
    };
  }

  function clearExpiredPendingTwoFactor() {
    const now = Date.now();
    for (const [token, entry] of pendingTwoFactor.entries()) {
      if (!entry || entry.expiresAt <= now) pendingTwoFactor.delete(token);
    }
  }

  /**
   * 登录第二步：用待验证票据 + TOTP/恢复码换取正式会话。
   * 错误信息保持通用，不泄露 2FA 配置细节。
   */
  function verifyTwoFactorLogin(pendingToken, code, ip = 'unknown') {
    clearExpiredPendingTwoFactor();

    if (isIpLockedOut(ip)) {
      const error = new Error('失败次数过多，请 60 秒后再试');
      error.status = 429;
      throw error;
    }

    const entry = pendingTwoFactor.get(String(pendingToken || ''));
    if (!entry || entry.expiresAt <= Date.now()) {
      pendingTwoFactor.delete(String(pendingToken || ''));
      const error = new Error('验证已过期，请重新登录');
      error.status = 401;
      throw error;
    }

    entry.attempts += 1;
    if (entry.attempts > PENDING_2FA_MAX_ATTEMPTS) {
      pendingTwoFactor.delete(String(pendingToken || ''));
      recordLoginFailure(ip);
      const error = new Error('验证失败次数过多，请重新登录');
      error.status = 429;
      throw error;
    }

    const verdict = twoFactorService.verify(code);
    if (!verdict.ok) {
      recordLoginFailure(ip);
      const error = new Error('验证码错误');
      error.status = 401;
      throw error;
    }

    pendingTwoFactor.delete(String(pendingToken || ''));
    clearLoginFailure(ip);
    const { sessionId, csrfToken } = createAuthSession();
    return {
      ok: true,
      enabled: true,
      authenticated: true,
      method: verdict.method || 'totp',
      remainingRecoveryCodes: verdict.remainingRecoveryCodes,
      sessionId,
      csrfToken,
    };
  }

  function logout(req) {
    const sessionId = getAuthSessionId(req);
    if (sessionId) authSessions.delete(sessionId);
  }

  function authenticateSocket(socket, next) {
    if (!getAuthUsername() && !getAuthPassword()) return next();

    clearExpiredAuthSessions();

    const cookieHeader = socket.handshake.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies[SESSION_COOKIE_NAME] || '';
    const session = authSessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) authSessions.delete(sessionId);
      return next(new Error('UNAUTHORIZED'));
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    socket.authSessionId = sessionId;
    return next();
  }

  function updateCredentials(username, password) {
    updateEnvCredentials(username, password);
  }

  return {
    authenticateSocket,
    clearAuthCookie,
    clearExpiredAuthSessions,
    getClientIp,
    isAuthEnabled,
    isRequestAuthenticated,
    login,
    verifyTwoFactorLogin,
    logout,
    requireAuth,
    setAuthCookie,
    updateCredentials,
  };
}

module.exports = {
  createAuthService,
};
