'use strict';

const express = require('express');

function createAuthRouter(authService, twoFactorService = null) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      enabled: authService.isAuthEnabled(),
      authenticated: authService.isRequestAuthenticated(req),
    });
  });

  router.post('/login', (req, res, next) => {
    try {
      const ip = authService.getClientIp(req);
      const result = authService.login(req.body?.username, req.body?.password, ip);
      if (result.sessionId) {
        authService.setAuthCookie(res, result.sessionId, result.csrfToken, req);
      }
      res.json({
        ok: result.ok,
        enabled: result.enabled,
        authenticated: result.authenticated,
        requiresTwoFactor: Boolean(result.requiresTwoFactor),
        pendingToken: result.pendingToken || undefined,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 桌面版本机免登录：Electron 主进程注入的一次性 token 换正式会话。
   * 仅环回地址可用；未设 ONESHELL_DESKTOP_AUTH_TOKEN（非桌面拉起）时 404。
   */
  router.post('/desktop-session', (req, res, next) => {
    try {
      const result = authService.desktopLogin(req.body?.token, req);
      if (result.sessionId) {
        authService.setAuthCookie(res, result.sessionId, result.csrfToken, req);
      }
      res.json({ ok: result.ok, enabled: result.enabled, authenticated: result.authenticated });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 登录第二步：待验证票据 + TOTP 验证码 / 恢复码
   */
  router.post('/login/2fa', (req, res, next) => {
    try {
      const ip = authService.getClientIp(req);
      const result = authService.verifyTwoFactorLogin(req.body?.pendingToken, req.body?.code, ip);
      if (result.sessionId) {
        authService.setAuthCookie(res, result.sessionId, result.csrfToken, req);
      }
      res.json({
        ok: result.ok,
        enabled: result.enabled,
        authenticated: result.authenticated,
        method: result.method,
        remainingRecoveryCodes: result.remainingRecoveryCodes,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', (req, res) => {
    authService.logout(req);
    authService.clearAuthCookie(res);
    res.json({ ok: true });
  });

  router.put('/credentials', authService.requireAuth, (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username && !password) {
        return res.status(400).json({ error: '请提供用户名或密码' });
      }
      authService.updateCredentials(username, password);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ── 2FA 管理（需已登录） ─────────────────────────────────────────────

  router.get('/2fa/status', authService.requireAuth, (req, res) => {
    if (!twoFactorService) return res.json({ enabled: false, available: false });
    res.json({ available: true, ...twoFactorService.status() });
  });

  router.post('/2fa/setup', authService.requireAuth, (req, res, next) => {
    try {
      if (!twoFactorService) return res.status(501).json({ error: '2FA 服务不可用' });
      const label = process.env.APP_LOGIN_USERNAME || 'admin';
      const result = twoFactorService.beginSetup(label);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/2fa/enable', authService.requireAuth, (req, res, next) => {
    try {
      if (!twoFactorService) return res.status(501).json({ error: '2FA 服务不可用' });
      const result = twoFactorService.enable(req.body?.code);
      res.json({ ok: true, recoveryCodes: result.recoveryCodes });
    } catch (error) {
      error.status = error.status || 400;
      next(error);
    }
  });

  router.post('/2fa/disable', authService.requireAuth, (req, res, next) => {
    try {
      if (!twoFactorService) return res.status(501).json({ error: '2FA 服务不可用' });
      twoFactorService.disable(req.body?.code);
      res.json({ ok: true });
    } catch (error) {
      error.status = error.status || 400;
      next(error);
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
