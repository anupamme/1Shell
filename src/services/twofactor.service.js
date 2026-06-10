'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/env');

/**
 * 2FA（TOTP）服务 — RFC 6238，兼容 Google Authenticator 等认证器应用。
 *
 * 纯 Node crypto 实现，不引入第三方依赖。
 * 状态存储在 data/2fa.json：
 *   { enabled, secret, pendingSecret, lastUsedCounter, recoveryCodes: [{ hash, usedAt }] }
 * 恢复码只存 sha256 哈希，明文仅在生成时返回一次。
 */

const TWOFA_FILE = path.join(DATA_DIR, '2fa.json');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // 允许前后各 1 个周期的时钟偏移

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (
    ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  ) % (10 ** TOTP_DIGITS);
  return String(code).padStart(TOTP_DIGITS, '0');
}

function currentCounter() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SEC);
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).replace(/-/g, '').toLowerCase()).digest('hex');
}

function createTwoFactorService() {
  function load() {
    try {
      const raw = fs.readFileSync(TWOFA_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  function save(state) {
    fs.mkdirSync(path.dirname(TWOFA_FILE), { recursive: true });
    fs.writeFileSync(TWOFA_FILE, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  function isEnabled() {
    return Boolean(load().enabled && load().secret);
  }

  /**
   * 生成新密钥（pending 状态，验证一次有效验证码后才正式启用）
   */
  function beginSetup(accountLabel) {
    const state = load();
    const secret = base32Encode(crypto.randomBytes(20));
    state.pendingSecret = secret;
    save(state);
    const label = encodeURIComponent(accountLabel || '1Shell');
    const otpauthUrl = `otpauth://totp/1Shell:${label}?secret=${secret}&issuer=1Shell&period=${TOTP_PERIOD_SEC}&digits=${TOTP_DIGITS}`;
    return { secret, otpauthUrl };
  }

  function verifyCodeAgainstSecret(secretBase32, code, lastUsedCounter = -1) {
    const normalized = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return { ok: false };
    const secretBuf = base32Decode(secretBase32);
    if (secretBuf.length === 0) return { ok: false };
    const counter = currentCounter();
    for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i += 1) {
      const candidate = counter + i;
      // 拒绝重放：同一计数器周期的验证码只能用一次
      if (candidate <= lastUsedCounter) continue;
      if (timingSafeEqualStr(hotp(secretBuf, candidate), normalized)) {
        return { ok: true, counter: candidate };
      }
    }
    return { ok: false };
  }

  function generateRecoveryCodes() {
    const codes = [];
    for (let i = 0; i < 10; i += 1) {
      const raw = crypto.randomBytes(4).toString('hex');
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    return codes;
  }

  /**
   * 用验证码确认 pending 密钥，正式启用 2FA。返回一次性恢复码明文。
   */
  function enable(code) {
    const state = load();
    if (!state.pendingSecret) throw new Error('请先生成 2FA 密钥');
    const verdict = verifyCodeAgainstSecret(state.pendingSecret, code);
    if (!verdict.ok) throw new Error('验证码错误，请确认认证器时间同步后重试');
    const recoveryCodes = generateRecoveryCodes();
    save({
      enabled: true,
      secret: state.pendingSecret,
      pendingSecret: null,
      lastUsedCounter: verdict.counter,
      recoveryCodes: recoveryCodes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })),
      enabledAt: new Date().toISOString(),
    });
    return { recoveryCodes };
  }

  /**
   * 关闭 2FA：需要有效的 TOTP 验证码或未使用的恢复码
   */
  function disable(code) {
    const state = load();
    if (!state.enabled || !state.secret) throw new Error('2FA 未启用');
    if (!verify(code).ok) throw new Error('验证码或恢复码错误');
    save({ enabled: false, secret: null, pendingSecret: null, lastUsedCounter: -1, recoveryCodes: [] });
    return { ok: true };
  }

  /**
   * 登录二次校验：接受 6 位 TOTP 或恢复码（恢复码一次性）
   */
  function verify(code) {
    const state = load();
    if (!state.enabled || !state.secret) return { ok: true, skipped: true };
    const normalized = String(code || '').trim();
    if (!normalized) return { ok: false };

    // 6 位数字 → TOTP
    if (/^\d{6}$/.test(normalized.replace(/\s+/g, ''))) {
      const verdict = verifyCodeAgainstSecret(state.secret, normalized, Number(state.lastUsedCounter ?? -1));
      if (verdict.ok) {
        state.lastUsedCounter = verdict.counter;
        save(state);
        return { ok: true, method: 'totp' };
      }
      return { ok: false };
    }

    // 其他格式 → 尝试恢复码（一次性）
    const hash = hashRecoveryCode(normalized);
    const entry = (state.recoveryCodes || []).find((c) => !c.usedAt && timingSafeEqualStr(c.hash, hash));
    if (entry) {
      entry.usedAt = new Date().toISOString();
      save(state);
      return { ok: true, method: 'recovery', remainingRecoveryCodes: state.recoveryCodes.filter((c) => !c.usedAt).length };
    }
    return { ok: false };
  }

  function status() {
    const state = load();
    return {
      enabled: Boolean(state.enabled && state.secret),
      pendingSetup: Boolean(state.pendingSecret),
      remainingRecoveryCodes: (state.recoveryCodes || []).filter((c) => !c.usedAt).length,
      enabledAt: state.enabledAt || null,
    };
  }

  return {
    isEnabled,
    beginSetup,
    enable,
    disable,
    verify,
    status,
  };
}

module.exports = {
  createTwoFactorService,
};
