'use strict';

const fs = require('fs');
const path = require('path');
const { ONESHELL_SECURITY_MODE } = require('../config/env');
const { normalizeSecurityMode } = require('../harness/risk-rules');

const DEFAULT_STATE = Object.freeze({
  securityMode: normalizeSecurityMode(ONESHELL_SECURITY_MODE),
  agentPrivilegeIsolation: false,
  agentUser: 'oneshell-agent',
});

function createSecuritySettingsService({ dataDir, auditService, logger } = {}) {
  const filePath = path.join(dataDir, 'security-settings.json');

  function ensureFile() {
    if (!fs.existsSync(filePath)) {
      writeState(DEFAULT_STATE);
    }
  }

  function normalizeState(value = {}) {
    return {
      securityMode: normalizeSecurityMode(value.securityMode || DEFAULT_STATE.securityMode),
      agentPrivilegeIsolation: value.agentPrivilegeIsolation === true,
      agentUser: cleanUser(value.agentUser) || DEFAULT_STATE.agentUser,
      updatedAt: value.updatedAt || null,
    };
  }

  function readState() {
    ensureFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeState(parsed);
    } catch (err) {
      logger?.warn?.(`[security-settings] failed to read config: ${err.message}`);
      return normalizeState(DEFAULT_STATE);
    }
  }

  function writeState(state) {
    fs.writeFileSync(filePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, 'utf8');
  }

  function getSettings() {
    return readState();
  }

  function updateSettings(patch = {}, context = {}) {
    const current = readState();
    const next = { ...current };

    if (typeof patch.securityMode === 'string') {
      next.securityMode = normalizeSecurityMode(patch.securityMode);
    }
    if (typeof patch.agentPrivilegeIsolation === 'boolean') {
      next.agentPrivilegeIsolation = patch.agentPrivilegeIsolation;
    }
    if (typeof patch.agentUser === 'string') {
      const user = cleanUser(patch.agentUser);
      if (user) next.agentUser = user;
    }
    next.updatedAt = new Date().toISOString();
    writeState(next);

    auditService?.log?.({
      action: 'security_settings_update',
      source: context.source || 'web_ui',
      clientIp: context.clientIp,
      details: JSON.stringify({
        previous: publicState(current),
        next: publicState(next),
      }),
    });
    return publicState(next);
  }

  function publicState(state = readState()) {
    const normalized = normalizeState(state);
    return {
      securityMode: normalized.securityMode,
      agentPrivilegeIsolation: normalized.agentPrivilegeIsolation,
      agentUser: normalized.agentUser,
      updatedAt: normalized.updatedAt,
    };
  }

  return { getSettings: () => publicState(readState()), updateSettings };
}

function cleanUser(value) {
  const text = String(value || '').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(text)) return '';
  return text;
}

module.exports = { createSecuritySettingsService, DEFAULT_STATE };
