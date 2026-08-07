'use strict';

const { hasOwn } = require('./common');

function createValidationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function ensureObject(value, message) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw createValidationError(message);
  }
  return value;
}

function ensureNonEmptyString(value, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createValidationError(message);
  }
  return value.trim();
}

function ensureOptionalString(value, message) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw createValidationError(message);
  }
  return value;
}

function ensureHttpUrl(value, message) {
  const raw = ensureNonEmptyString(value, message);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw createValidationError(message);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createValidationError(message);
  }

  return parsed.toString();
}

function ensureIntegerInRange(value, { field, min = 1, max = 65535 }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw createValidationError(`${field}必须是 ${min}-${max} 之间的整数`);
  }
  return number;
}

function ensureOptionalIntegerInRange(value, options) {
  if (value == null || value === '') return null;
  return ensureIntegerInRange(value, options);
}

function ensureArray(value, message) {
  if (!Array.isArray(value)) {
    throw createValidationError(message);
  }
  return value;
}

function ensureEnum(value, allowedValues, message) {
  if (!allowedValues.includes(value)) {
    throw createValidationError(message);
  }
  return value;
}

function validateCompletionRequestBody(payload) {
  const body = ensureObject(payload, '补全请求体必须是对象');
  const next = {};

  if (hasOwn(body, 'prefix')) {
    next.prefix = ensureOptionalString(body.prefix, 'prefix 必须是字符串');
  }

  if (hasOwn(body, 'mode')) {
    next.mode = ensureEnum(body.mode, ['chat', 'command'], 'mode 不合法');
  }

  return next;
}

function validateManualLocation(value) {
  if (value == null) return null;
  const obj = ensureObject(value, 'manualLocation 必须是对象');

  const countryCode = ensureNonEmptyString(obj.countryCode, 'manualLocation.countryCode 不能为空').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw createValidationError('manualLocation.countryCode 必须是 2 位 ISO 国家代码');
  }

  const lat = Number(obj.lat);
  const lng = Number(obj.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw createValidationError('manualLocation.lat 必须是 -90~90 之间的数字');
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw createValidationError('manualLocation.lng 必须是 -180~180 之间的数字');
  }

  const country = obj.country == null ? '' : ensureOptionalString(obj.country, 'manualLocation.country 必须是字符串').trim();
  const city = obj.city == null ? '' : ensureOptionalString(obj.city, 'manualLocation.city 必须是字符串').trim();

  return {
    countryCode,
    country: country || null,
    city: city || null,
    lat,
    lng,
  };
}

function validateHostLinks(value) {
  if (value == null) return [];

  const links = ensureArray(value, 'links 必须是数组');
  return links.map((link, index) => {
    const item = ensureObject(link, `links[${index}] 必须是对象`);
    const url = ensureHttpUrl(item.url, `links[${index}].url 只允许 http:// 或 https://`);

    if (hasOwn(item, 'id')) {
      ensureOptionalString(item.id, `links[${index}].id 必须是字符串`);
    }

    if (hasOwn(item, 'description')) {
      ensureOptionalString(item.description, `links[${index}].description 必须是字符串`);
    }

    return {
      id: hasOwn(item, 'id') ? ensureOptionalString(item.id, `links[${index}].id 必须是字符串`).trim() : '',
      name: ensureNonEmptyString(item.name, `links[${index}].name 不能为空`),
      url,
      description: hasOwn(item, 'description')
        ? ensureOptionalString(item.description, `links[${index}].description 必须是字符串`).trim()
        : '',
    };
  });
}

function validateHostPayload(payload, { isEditing = false } = {}) {
  const body = ensureObject(payload, '主机请求体必须是对象');
  const authType = ensureEnum(body.authType, ['password', 'privateKey'], '认证方式不合法');

  ensureNonEmptyString(body.name, '主机名称不能为空');
  ensureNonEmptyString(body.host, '主机地址不能为空');
  ensureIntegerInRange(body.port, { field: '主机端口' });
  ensureNonEmptyString(body.username, '用户名不能为空');

  if (hasOwn(body, 'links')) {
    body.links = validateHostLinks(body.links);
  } else if (!isEditing) {
    body.links = [];
  }

  if (hasOwn(body, 'manualLocation')) {
    body.manualLocation = validateManualLocation(body.manualLocation);
  }

  if (hasOwn(body, 'proxyHostId')) {
    if (body.proxyHostId != null && body.proxyHostId !== '') {
      ensureNonEmptyString(body.proxyHostId, 'proxyHostId 必须是非空字符串或 null');
    } else {
      body.proxyHostId = null;
    }
  }

  if (authType === 'password') {
    if (!isEditing || hasOwn(body, 'password')) {
      ensureNonEmptyString(body.password, '密码认证需要填写密码');
    }
  }

  if (authType === 'privateKey') {
    if (!isEditing || hasOwn(body, 'privateKey')) {
      ensureNonEmptyString(body.privateKey, '私钥认证需要填写私钥内容');
    }

    if (hasOwn(body, 'passphrase')) {
      ensureOptionalString(body.passphrase, '私钥口令必须是字符串');
    }
  }

  return body;
}

function validateSessionCreatePayload(payload) {
  const body = ensureObject(payload, 'session:create 参数必须是对象');
  ensureNonEmptyString(body.hostId, 'hostId 不能为空');
  ensureOptionalIntegerInRange(body.cols, { field: 'cols' });
  ensureOptionalIntegerInRange(body.rows, { field: 'rows' });
  return body;
}

function validateSessionInputPayload(payload) {
  const body = ensureObject(payload, 'session:input 参数必须是对象');
  ensureNonEmptyString(body.sessionId, 'sessionId 不能为空');
  if (typeof body.data !== 'string') {
    throw createValidationError('data 必须是字符串');
  }
  return body;
}

function validateSessionResizePayload(payload) {
  const body = ensureObject(payload, 'session:resize 参数必须是对象');
  ensureNonEmptyString(body.sessionId, 'sessionId 不能为空');
  ensureIntegerInRange(body.cols, { field: 'cols' });
  ensureIntegerInRange(body.rows, { field: 'rows' });
  return body;
}

function validateSessionClosePayload(payload) {
  const body = ensureObject(payload, 'session:close 参数必须是对象');
  ensureNonEmptyString(body.sessionId, 'sessionId 不能为空');
  return body;
}

function validateAnalyzeSelectionBody(payload) {
  const body = ensureObject(payload, '选区分析请求体必须是对象');
  const selectedText = ensureNonEmptyString(body.selectedText, 'selectedText 不能为空');
  if (selectedText.length > 8000) {
    throw createValidationError('selectedText 超过最大长度 8000 字符');
  }
  const hostId = ensureNonEmptyString(body.hostId, 'hostId 不能为空');
  const shellType = ensureOptionalString(body.shellType, 'shellType 必须是字符串');
  const platform = ensureOptionalString(body.platform, 'platform 必须是字符串');

  let recentCommands = undefined;
  if (hasOwn(body, 'recentCommands')) {
    const commands = ensureArray(body.recentCommands, 'recentCommands 必须是数组');
    commands.forEach((item, index) => {
      ensureOptionalString(item, `recentCommands[${index}] 必须是字符串`);
    });
    recentCommands = commands;
  }

  return {
    selectedText,
    hostId,
    shellType,
    platform,
    ...(recentCommands ? { recentCommands } : {}),
  };
}

function validateAgentStartPayload(payload) {
  const body = ensureObject(payload, 'agent:start 参数必须是对象');
  ensureNonEmptyString(body.providerId, 'providerId 不能为空');
  ensureNonEmptyString(body.hostId, 'hostId 不能为空');
  if (hasOwn(body, 'useLocalEnv') && typeof body.useLocalEnv !== 'boolean') {
    throw createValidationError('useLocalEnv 必须是布尔值');
  }
  ensureOptionalIntegerInRange(body.cols, { field: 'cols', min: 20, max: 400 });
  ensureOptionalIntegerInRange(body.rows, { field: 'rows', min: 10, max: 200 });
  // Skill 相关（可选）
  if (hasOwn(body, 'skillId')) {
    ensureOptionalString(body.skillId, 'skillId 必须是字符串');
  }
  if (hasOwn(body, 'skillInputs') && body.skillInputs != null) {
    ensureObject(body.skillInputs, 'skillInputs 必须是对象');
  }
  return body;
}

function validateAgentInputPayload(payload) {
  const body = ensureObject(payload, 'agent:input 参数必须是对象');
  ensureNonEmptyString(body.agentSessionId, 'agentSessionId 不能为空');
  if (typeof body.data !== 'string') {
    throw createValidationError('data 必须是字符串');
  }
  return body;
}

function validateAgentResizePayload(payload) {
  const body = ensureObject(payload, 'agent:resize 参数必须是对象');
  ensureNonEmptyString(body.agentSessionId, 'agentSessionId 不能为空');
  ensureIntegerInRange(body.cols, { field: 'cols', min: 20, max: 400 });
  ensureIntegerInRange(body.rows, { field: 'rows', min: 10, max: 200 });
  return body;
}

function validateAgentStopPayload(payload) {
  const body = ensureObject(payload, 'agent:stop 参数必须是对象');
  ensureNonEmptyString(body.agentSessionId, 'agentSessionId 不能为空');
  return body;
}

function validateAgentFocusPayload(payload) {
  const body = ensureObject(payload, 'agent:focus-host 参数必须是对象');
  ensureNonEmptyString(body.agentSessionId, 'agentSessionId 不能为空');
  ensureNonEmptyString(body.hostId, 'hostId 不能为空');
  return body;
}

// ─── Skill Runner（3.0 新增） ─────────────────────────────────────────────

function validateSkillRunPayload(payload) {
  const body = ensureObject(payload, 'skill:run 参数必须是对象');
  ensureNonEmptyString(body.runId, 'runId 不能为空');
  ensureNonEmptyString(body.skillId, 'skillId 不能为空');
  ensureNonEmptyString(body.hostId, 'hostId 不能为空');
  if (hasOwn(body, 'inputs') && body.inputs != null) {
    ensureObject(body.inputs, 'inputs 必须是对象');
  }
  return body;
}

function validateSkillContinuePayload(payload) {
  const body = ensureObject(payload, 'skill:continue 参数必须是对象');
  ensureNonEmptyString(body.runId, 'runId 不能为空');
  ensureNonEmptyString(body.toolUseId, 'toolUseId 不能为空');
  // answer 可以是任意 JSON 值
  return body;
}

function validateSkillStopPayload(payload) {
  const body = ensureObject(payload, 'skill:stop 参数必须是对象');
  ensureNonEmptyString(body.runId, 'runId 不能为空');
  return body;
}

// ─── 脚本库 ─────────────────────────────────────────────────────────────
//
// 4.7.6 起脚本只有 name / description / tags / content 四个字段。参数不再结构化
// 定义，改为从 content 扫描 {{变量}} 派生（见 lib/script-placeholders.js），
// 所以这里没有 parameters / category / riskLevel / icon 的校验。

function validateScriptTags(value) {
  if (value == null) return [];
  const arr = ensureArray(value, 'tags 必须是数组');
  return arr
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
    .slice(0, 20);
}

function validateScriptPayload(payload) {
  const body = ensureObject(payload, '脚本请求体必须是对象');

  const name = ensureNonEmptyString(body.name, '脚本名称不能为空');
  if (name.length > 120) {
    throw createValidationError('脚本名称不能超过 120 字符');
  }

  const content = ensureNonEmptyString(body.content, '脚本内容不能为空');
  if (content.length > 100000) {
    throw createValidationError('脚本内容不能超过 100KB');
  }

  const description = ensureOptionalString(body.description, 'description 必须是字符串');
  if (description.length > 2000) {
    throw createValidationError('description 不能超过 2000 字符');
  }

  const tags = validateScriptTags(body.tags);

  return {
    name,
    description: description.trim(),
    content,
    tags,
  };
}

module.exports = {
  ensureNonEmptyString,
  validateAgentFocusPayload,
  validateAgentInputPayload,
  validateAgentResizePayload,
  validateAgentStartPayload,
  validateAgentStopPayload,
  validateCompletionRequestBody,
  validateHostPayload,
  validateManualLocation,
  validateScriptPayload,
  validateSessionClosePayload,
  validateSessionCreatePayload,
  validateSessionInputPayload,
  validateSessionResizePayload,
  validateSkillContinuePayload,
  validateSkillRunPayload,
  validateSkillStopPayload,
  validateAnalyzeSelectionBody,
};
