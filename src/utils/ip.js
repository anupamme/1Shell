'use strict';

const net = require('net');

function normalizeIpAddress(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';
  if (text.includes(',')) text = text.split(',')[0].trim();
  if (text.startsWith('[') && text.includes(']')) {
    text = text.slice(1, text.indexOf(']'));
  }
  if (/^::ffff:/i.test(text)) text = text.replace(/^::ffff:/i, '');
  return net.isIP(text) ? text : '';
}

function isIpAddress(value) {
  return Boolean(normalizeIpAddress(value));
}

// Private, loopback, link-local, and documentation ranges should not go to GeoIP.
function isPrivateIp(ip) {
  const clean = normalizeIpAddress(ip);
  if (!clean) return false;

  if (net.isIP(clean) === 4) {
    const [a, b] = clean.split('.').map(Number);
    if (a === 10) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  const lower = clean.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true;

  const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isFinite(firstHextet)) {
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
  }
  return false;
}

module.exports = { isIpAddress, isPrivateIp, normalizeIpAddress };
