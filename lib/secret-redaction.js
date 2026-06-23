'use strict';

const SENSITIVE_KEY_SOURCE = String.raw`(?:authorization|cookie|token|password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|[A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_]*)`;
const QUOTED_SECRET_ASSIGNMENT = new RegExp(`(${SENSITIVE_KEY_SOURCE})(["']?\\s*[:=]\\s*)(["'])([^\\r\\n]*?)(\\3)`, 'gi');
const UNQUOTED_SECRET_ASSIGNMENT = new RegExp('(' + SENSITIVE_KEY_SOURCE + ')(["\\\']?\\s*[:=]\\s*)([^\\s"\\\'`,;]+)', 'gi');
const COMMON_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/gi,
  /\bglpat-[A-Za-z0-9_-]{20,}/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}/gi,
  /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
];

function collectSecretValues(inputDefs, values) {
  const defs = Array.isArray(inputDefs) ? inputDefs : [];
  const source = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const secrets = [];

  for (const def of defs) {
    if (!def || typeof def !== 'object') continue;
    const name = String(def.name || '').trim();
    if (!name) continue;
    const isSecret = def.secret === true || String(def.type || '').toLowerCase() === 'password';
    if (!isSecret) continue;
    const value = source[name];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.length >= 3) secrets.push(text);
  }

  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

function redactKnownSecrets(value, secrets) {
  let text = String(value || '');
  for (const secret of normalizeSecretValues(secrets)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return redactCredentialPatterns(text);
}

function redactCredentialPatterns(value) {
  let text = String(value || '');
  for (const pattern of COMMON_SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => match.startsWith('Bearer ') ? 'Bearer [REDACTED]' : '[REDACTED]');
  }
  return text
    .replace(QUOTED_SECRET_ASSIGNMENT, '$1$2$3[REDACTED]$5')
    .replace(UNQUOTED_SECRET_ASSIGNMENT, '$1$2[REDACTED]');
}

function redactObjectSecretValues(value, inputDefs) {
  const defs = Array.isArray(inputDefs) ? inputDefs : [];
  const secretNames = new Set(defs
    .filter((def) => def?.secret === true || String(def?.type || '').toLowerCase() === 'password')
    .map((def) => String(def.name || '').trim())
    .filter(Boolean));

  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const name of secretNames) {
    if (Object.prototype.hasOwnProperty.call(out, name)) out[name] = '[REDACTED]';
  }
  return out;
}

function redactPotentialSecrets(value, secrets = []) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactKnownSecrets(value, secrets);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactPotentialSecrets(item, secrets));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|key|secret|password|passwd|auth|credential|sensitive|redact|private/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactPotentialSecrets(item, secrets);
    }
  }
  return out;
}

function normalizeSecretValues(secrets) {
  return [...new Set((Array.isArray(secrets) ? secrets : [])
    .map((secret) => String(secret || ''))
    .filter((secret) => secret.length >= 3))]
    .sort((a, b) => b.length - a.length);
}

module.exports = {
  collectSecretValues,
  redactCredentialPatterns,
  redactKnownSecrets,
  redactObjectSecretValues,
  redactPotentialSecrets,
};
