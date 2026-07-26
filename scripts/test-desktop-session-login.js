'use strict';

// 桌面版本机免登录（4.7.5）：Electron 主进程一次性 token 换会话。
// 安全不变量：无 token 环境=404 关死；非环回=403；错 token=401；
// 正确 token+环回=签发会话；auth 未启用=直接放行不发会话。

const assert = require('assert');
const { createAuthService } = require('../src/services/auth.service');

function reqFrom(ip) {
  return { socket: { remoteAddress: ip }, headers: {} };
}

const TOKEN = 'a'.repeat(64);

// ── 未设 token（非桌面拉起）→ 404，接口视为不存在 ──
delete process.env.ONESHELL_DESKTOP_AUTH_TOKEN;
process.env.APP_LOGIN_USERNAME = 'admin';
process.env.APP_LOGIN_PASSWORD = 'secret-pass';
{
  const auth = createAuthService();
  assert.throws(() => auth.desktopLogin(TOKEN, reqFrom('127.0.0.1')), (err) => err.status === 404, 'no env token must 404');
}

process.env.ONESHELL_DESKTOP_AUTH_TOKEN = TOKEN;

// ── 非环回地址 → 403（不信任任何代理头） ──
{
  const auth = createAuthService();
  for (const ip of ['192.168.1.10', '10.0.0.2', '::ffff:192.168.1.10', '']) {
    assert.throws(() => auth.desktopLogin(TOKEN, reqFrom(ip)), (err) => err.status === 403, `non-loopback ${ip || '(empty)'} must 403`);
  }
  const forged = { socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-for': '127.0.0.1' } };
  assert.throws(() => auth.desktopLogin(TOKEN, forged), (err) => err.status === 403, 'forwarded-for spoofing must not bypass loopback check');
}

// ── 错误 / 空 token → 401 ──
{
  const auth = createAuthService();
  assert.throws(() => auth.desktopLogin('b'.repeat(64), reqFrom('127.0.0.1')), (err) => err.status === 401, 'wrong token must 401');
  assert.throws(() => auth.desktopLogin('short', reqFrom('::1')), (err) => err.status === 401, 'length-mismatched token must 401');
  assert.throws(() => auth.desktopLogin('', reqFrom('127.0.0.1')), (err) => err.status === 401, 'empty token must 401');
}

// ── 正确 token + 环回 → 签发正式会话，requireAuth 放行 ──
{
  const auth = createAuthService();
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const result = auth.desktopLogin(TOKEN, reqFrom(ip));
    assert.strictEqual(result.authenticated, true, `loopback ${ip} must authenticate`);
    assert.ok(result.sessionId, 'must issue a session id');
    assert.ok(result.csrfToken, 'must issue a csrf token');

    const authedReq = {
      method: 'GET',
      socket: { remoteAddress: ip },
      headers: { cookie: `mvps_console_session=${encodeURIComponent(result.sessionId)}` },
    };
    assert.strictEqual(auth.isRequestAuthenticated(authedReq), true, 'issued session must pass isRequestAuthenticated');
  }
}

// ── auth 未启用（无账号密码）→ 直接放行，不发会话 ──
delete process.env.APP_LOGIN_USERNAME;
delete process.env.APP_LOGIN_PASSWORD;
{
  const auth = createAuthService();
  const result = auth.desktopLogin(TOKEN, reqFrom('127.0.0.1'));
  assert.strictEqual(result.authenticated, true);
  assert.strictEqual(result.enabled, false);
  assert.strictEqual(result.sessionId, '', 'auth disabled must not issue session');
}

// ── 桌面壳源码结构断言：token 只进后端 env，cookie 由主进程种 ──
const fs = require('fs');
const path = require('path');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
assert.ok(mainJs.includes('ONESHELL_DESKTOP_AUTH_TOKEN'), 'main.js must inject the auth token env');
assert.ok(mainJs.includes('establishDesktopSession'), 'main.js must establish the desktop session before loading the app');
assert.ok(mainJs.includes('skipLocalLogin'), 'main.js must expose the skipLocalLogin setting');
assert.ok(!preloadJs.includes('desktopAuthToken'), 'preload must never see the auth token');

console.log('desktop session login checks passed');
