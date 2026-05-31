'use strict';

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
  for (const secret of secrets || []) {
    if (!secret) continue;
    text = text.split(String(secret)).join('[REDACTED]');
  }
  return redactCredentialPatterns(text);
}

function redactCredentialPatterns(value) {
  return String(value || '')
    .replace(/(authorization|cookie|token|password|passwd|secret|api[_-]?key|private[_-]?key)=([^\s'"`]+)/gi, '$1=[REDACTED]')
    .replace(/(authorization|cookie|token|password|passwd|secret|api[_-]?key|private[_-]?key)(["']?\s*[:=]\s*["'])([^"'\s]+)/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
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

module.exports = {
  collectSecretValues,
  redactCredentialPatterns,
  redactKnownSecrets,
  redactObjectSecretValues,
};
