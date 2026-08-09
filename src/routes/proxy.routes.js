'use strict';

/**
 * 多协议转换代理 — 每个 CLI 独立端点，多 Provider 支持
 *
 * 每个 CLI 的活跃 Provider 决定 upstreamProtocol:
 *   'openai'    — 上游是 OpenAI 兼容 API
 *   'anthropic' — 上游是 Anthropic Messages API（透传）
 *
 * 路由根据 CLI 的 clientProtocol（CLI 发过来的格式）+ upstreamProtocol 自动选择转换方案：
 *   client=anthropic + upstream=openai  → Anthropic→OpenAI 转换
 *   client=anthropic + upstream=anthropic → 透传
 *   client=openai    + upstream=openai  → 透传
 *   ...以此类推
 */

const crypto = require('crypto');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { Router } = require('express');
const fetch = require('node-fetch');
const {
  isReasoningModel,
  injectAnthropicThinking,
  injectOpenAIReasoningEffort,
} = require('../agents/reasoning');
const { getPreset } = require('../agents/provider-presets');
const log = require('../../lib/logger');
const { TRUSTED_PROXY_IPS } = require('../config/env');

// ═══════════════════════════════════════════════════════════════════════
//  共用工具
// ═══════════════════════════════════════════════════════════════════════

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function normalizeBase(apiBase) {
  return apiBase.replace(/\/$/, '');
}

const DEFAULT_CLAUDE_MODEL_PROFILES = [
  { apiModel: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', createdAt: '2025-05-14' },
  { apiModel: 'claude-opus-4-20250514', displayName: 'Claude Opus 4', createdAt: '2025-05-14' },
  { apiModel: 'claude-haiku-4-20250514', displayName: 'Claude Haiku 4', createdAt: '2025-05-14' },
];

function getProviderModelProfiles(provider, fallbackProfiles = []) {
  const profiles = [];
  const seen = new Set();
  const push = (apiModel, displayName, createdAt = '') => {
    const id = String(apiModel || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    profiles.push({
      apiModel: id,
      displayName: String(displayName || id).trim() || id,
      createdAt: String(createdAt || '').trim(),
    });
  };

  for (const model of (Array.isArray(provider?.models) ? provider.models : [])) {
    if (model?.enabled === false) continue;
    push(model?.apiModel, model?.displayName);
  }

  if (!profiles.length) push(provider?.model, provider?.model);
  if (!profiles.length) {
    for (const model of fallbackProfiles) {
      push(model.apiModel, model.displayName, model.createdAt);
    }
  }

  return profiles;
}

function buildAnthropicProxyModelList(provider) {
  return {
    data: getProviderModelProfiles(provider, DEFAULT_CLAUDE_MODEL_PROFILES).map((model) => ({
      id: model.apiModel,
      display_name: model.displayName,
      created_at: model.createdAt,
    })),
  };
}

function buildOpenAIProxyModelList(provider) {
  const profiles = getProviderModelProfiles(provider, [{ apiModel: 'gpt-4o', displayName: 'gpt-4o' }]);
  return {
    object: 'list',
    data: profiles.map((model) => ({ id: model.apiModel, object: 'model', owned_by: '1shell-proxy' })),
  };
}

function normalizeUrlHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isLoopbackHostname(hostname) {
  const host = normalizeUrlHost(hostname);
  const ipVersion = net.isIP(host);
  return host === 'localhost' || host === '::1' || (ipVersion === 4 && host.startsWith('127.'));
}

function isBlockedIpv4(hostname) {
  const parts = normalizeUrlHost(hostname).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127
    || a === 198 && (b === 18 || b === 19)
    || a >= 224;
}

function isBlockedIpv6(hostname) {
  const host = normalizeUrlHost(hostname);
  if (host.startsWith('::ffff:')) return isBlockedIpv4(host.slice(7));
  return host === '::'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || host.startsWith('fe80')
    || host.startsWith('ff');
}

function normalizeProviderApiBase(apiBase) {
  const raw = String(apiBase || '').trim();
  if (!raw) throw new Error('apiBase 不能为空');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('apiBase 必须是合法 URL，例如 https://api.example.com');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('apiBase 只允许 http 或 https');
  if (url.username || url.password) throw new Error('apiBase 不允许包含用户名或密码');
  url.hash = '';
  url.search = '';

  const host = normalizeUrlHost(url.hostname);
  const ipVersion = net.isIP(host);
  if (!isLoopbackHostname(host) && ((ipVersion === 4 && isBlockedIpv4(host)) || (ipVersion === 6 && isBlockedIpv6(host)))) {
    throw new Error('apiBase 不允许指向内网、链路本地或保留地址；本机模型服务请使用 localhost/127.0.0.1');
  }

  return url.toString().replace(/\/$/, '');
}

// ─── requestParams(1Shell AI 请求参数,配置文件式自填)──────────────────
//   skills 槽位不再翻译 reasoning 档位语义;用户按上游 API 文档自填模型行为参数
//   (thinking / reasoning_effort / temperature / …),存于 models[].requestParams,
//   请求时原样浅合并进请求体顶层,同 key 覆盖内置注入。
//   messages / stream 属于调用方与代理机制,禁止通过 requestParams 覆盖。
const REQUEST_PARAMS_FORBIDDEN_KEYS = new Set(['messages', 'stream']);
const REQUEST_PARAMS_MAX_JSON_LENGTH = 16 * 1024;

function normalizeRequestParams(value) {
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return null;
    try {
      source = JSON.parse(text);
    } catch (err) {
      throw new Error(`requestParams 不是合法 JSON: ${err.message}`);
    }
  }
  if (source === undefined || source === null) return null;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('requestParams 必须是 JSON 对象(键值对)');
  }
  const out = {};
  for (const [key, val] of Object.entries(source)) {
    if (REQUEST_PARAMS_FORBIDDEN_KEYS.has(key) || val === undefined) continue;
    out[key] = val;
  }
  if (!Object.keys(out).length) return null;
  const serialized = JSON.stringify(out);
  if (serialized.length > REQUEST_PARAMS_MAX_JSON_LENGTH) {
    throw new Error('requestParams 过大(序列化后需 ≤ 16KB)');
  }
  return JSON.parse(serialized);
}

function applyRequestParams(body, provider) {
  const params = provider?.requestParams;
  if (!body || typeof body !== 'object' || !params || typeof params !== 'object') return body;
  for (const [key, value] of Object.entries(params)) {
    if (REQUEST_PARAMS_FORBIDDEN_KEYS.has(key)) continue;
    body[key] = value;
  }
  return body;
}

function errResponse(res, code, msg, format) {
  if (format === 'anthropic') {
    return res.status(code).json({ type: 'error', error: { type: 'api_error', message: msg } });
  }
  return res.status(code).json({ error: { message: msg } });
}

function normalizeIp(ip) {
  if (!ip) return '';
  const value = String(ip).trim();
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function isLoopbackIp(ip) {
  const value = normalizeIp(ip).toLowerCase();
  return value === '::1' || value === 'localhost' || value.startsWith('127.');
}

function isLocalHostname(host) {
  const raw = String(host || '').trim().toLowerCase();
  const value = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1';
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hasValidProxyToken(req, proxyToken) {
  if (!proxyToken) return false;
  const authHeader = String(req.headers.authorization || '');
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const headerToken = req.headers['x-1shell-proxy-token'];
  const token = bearerMatch?.[1] || (Array.isArray(headerToken) ? headerToken[0] : headerToken);
  return timingSafeEqualString(token, proxyToken);
}

function isLocalProxyRequest(req) {
  // 只信任真实 socket 直连地址，不看 Host 头——反代后 Host 可被攻击者伪造成 localhost。
  // 且仅当未配置可信代理时才认定为"本机直连用户"：一旦配置 TRUSTED_PROXY_IPS，
  // 说明前面有反代，loopback peer 只是代理本身，必须走 PROXY_TOKEN。
  if (TRUSTED_PROXY_IPS.length > 0) return false;
  const directIp = normalizeIp(req.socket?.remoteAddress || req.ip);
  return isLoopbackIp(directIp);
}

function requireProxyAccess(proxyToken) {
  return (req, res, next) => {
    if (isLocalProxyRequest(req) || hasValidProxyToken(req, proxyToken)) return next();
    return res.status(403).json({ error: { message: '1Shell 代理仅允许 localhost 访问，远程调用请配置 PROXY_TOKEN 并通过 Authorization: Bearer <token> 或 x-1shell-proxy-token 传入。' } });
  };
}

async function callOpenAIUpstream(base, apiKey, body, signal) {
  return fetch(`${normalizeBase(base)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

async function callOpenAIResponsesUpstream(base, apiKey, body, signal) {
  return fetch(`${normalizeBase(base)}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

async function callAnthropicUpstream(base, apiKey, body, extraHeaders, signal) {
  let url = base.replace(/\/$/, '');
  if (!/\/v1$/.test(url)) url += '/v1';
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v != null && v !== '') headers[k] = String(v);
    }
  }
  return fetch(`${url}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

function createRequestAbort(req, res) {
  const ac = new AbortController();
  const abort = () => {
    if (!res.writableEnded) ac.abort();
  };
  req.on('aborted', abort);
  res.on('close', abort);
  return {
    signal: ac.signal,
    cleanup: () => {
      req.off?.('aborted', abort);
      res.off?.('close', abort);
    },
  };
}

function destroyStreamOnClose(res, stream, cleanup) {
  const onClose = () => {
    if (!res.writableEnded) {
      try { stream.destroy?.(); } catch { /* ignore */ }
    }
  };
  res.on('close', onClose);
  return () => {
    res.off?.('close', onClose);
    cleanup?.();
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Anthropic ↔ OpenAI 转换
// ═══════════════════════════════════════════════════════════════════════

/** Anthropic tools → OpenAI tools */
function convertAnthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/** OpenAI tools → Anthropic tools */
function convertOpenAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => ({
    name: tool.function?.name || tool.name || '',
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} },
  }));
}

/** OpenAI messages[] → Anthropic messages[]（处理 tool/tool_calls） */
function openaiMessagesToAnthropic(messages) {
  const result = [];
  for (const msg of (messages || [])) {
    if (msg.role === 'system') continue;
    if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of (msg.tool_calls || [])) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Date.now().toString(36)}`,
          name: tc.function?.name || 'unknown',
          input,
        });
      }
      if (content.length > 0) result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // OpenAI tool result → Anthropic tool_result，尽量合并到前一条 user 消息
      const last = result[result.length - 1];
      const tr = { type: 'tool_result', tool_use_id: msg.tool_call_id || 'unknown', content: msg.content || '' };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(tr);
      } else {
        result.push({ role: 'user', content: [tr] });
      }
    } else {
      result.push({ role: 'user', content: msg.content || '' });
    }
  }
  return result;
}

/** 将一条 Anthropic assistant 消息转为 OpenAI assistant 消息（含 tool_calls） */
function convertAnthropicAssistantMsg(msg) {
  if (typeof msg.content === 'string') {
    return msg.content ? { role: 'assistant', content: msg.content } : null;
  }
  if (!Array.isArray(msg.content)) {
    const c = String(msg.content || '');
    return c ? { role: 'assistant', content: c } : null;
  }

  const textBlocks = msg.content.filter(b => b.type === 'text' || b.type === 'thinking');
  const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');

  const textContent = textBlocks
    .map(b => b.type === 'thinking' ? (b.thinking || '') : (b.text || ''))
    .filter(Boolean).join('\n') || null;

  if (toolUseBlocks.length === 0) {
    return textContent ? { role: 'assistant', content: textContent } : null;
  }

  return {
    role: 'assistant',
    content: textContent,  // null 时 OpenAI 接受
    tool_calls: toolUseBlocks.map(tu => ({
      id: tu.id || `call_${Date.now().toString(36)}`,
      type: 'function',
      function: {
        name: tu.name,
        arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
      },
    })),
  };
}

/** 将一条 Anthropic user 消息转为 OpenAI 消息列表（tool_result → tool role） */
function convertAnthropicUserMsg(msg) {
  if (typeof msg.content === 'string') {
    return msg.content ? [{ role: 'user', content: msg.content }] : [];
  }
  if (!Array.isArray(msg.content)) {
    const c = String(msg.content || '');
    return c ? [{ role: 'user', content: c }] : [];
  }

  const result = [];
  const toolResults = msg.content.filter(b => b.type === 'tool_result');
  const userBlocks = [];

  for (const tr of toolResults) {
    const content = typeof tr.content === 'string' ? tr.content
      : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n') : '';
    result.push({ role: 'tool', tool_call_id: tr.tool_use_id || 'unknown', content: content || '' });
  }

  for (const block of msg.content) {
    if (!block || block.type === 'tool_result') continue;
    if (block.type === 'text' && block.text) {
      userBlocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
      const mediaType = block.source.media_type || 'image/png';
      userBlocks.push({
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${block.source.data}` },
      });
      continue;
    }
    if (block.type === 'document') {
      const title = block.title || block.name || 'document';
      userBlocks.push({ type: 'text', text: `[Document attachment: ${title}. This OpenAI-compatible upstream cannot receive the raw document block through the 1Shell proxy yet.]` });
    }
  }

  if (userBlocks.length === 1 && userBlocks[0].type === 'text') result.push({ role: 'user', content: userBlocks[0].text });
  else if (userBlocks.length > 0) result.push({ role: 'user', content: userBlocks });

  return result;
}

function anthropicToOpenAIMessages(anthropicSystem, anthropicMessages) {
  const messages = [];
  if (anthropicSystem) {
    const sysText = typeof anthropicSystem === 'string'
      ? anthropicSystem
      : (Array.isArray(anthropicSystem) ? anthropicSystem.map(b => b.text || '').join('\n') : '');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const msg of anthropicMessages || []) {
    if (msg.role === 'assistant') {
      const m = convertAnthropicAssistantMsg(msg);
      if (m) messages.push(m);
    } else {
      const ms = convertAnthropicUserMsg(msg);
      messages.push(...ms);
    }
  }
  return messages;
}

function openaiToAnthropicResponse(openaiResp, requestModel) {
  const choice = openaiResp.choices?.[0] || {};
  const content = [];

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const tc of (choice.message?.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${Date.now().toString(36)}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const stop_reason = choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';

  return {
    id: `msg_${openaiResp.id || Date.now().toString(36)}`,
    type: 'message', role: 'assistant', model: requestModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function normalizeOpenAIToolName(name) {
  let value = String(name || '');
  if (!value) return value;

  let changed = true;
  while (changed && value.length > 1) {
    changed = false;
    if (value.length % 2 !== 0) break;
    const half = value.length / 2;
    const left = value.slice(0, half);
    const right = value.slice(half);
    if (left && left === right) {
      value = left;
      changed = true;
    }
  }

  return value;
}

function mergeOpenAIToolName(currentName, nextChunk) {
  const current = normalizeOpenAIToolName(currentName);
  const next = normalizeOpenAIToolName(nextChunk);

  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  return normalizeOpenAIToolName(current + next);
}

function streamOpenAIToAnthropic(res, stream, requestModel, cleanupRequest) {
  const cleanupClose = destroyStreamOnClose(res, stream, cleanupRequest);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  sendSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant',
      model: requestModel, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let outputTokens = 0, buffer = '';
  const decoder = new StringDecoder('utf8');
  let textBlockStarted = false;
  let nextBlockIndex = 0;
  // Map<openaiToolIndex, { id, name, anthropicIndex, started }>
  const toolBlocks = new Map();
  let finishReason = null;

  function processLine(line) {
    if (!line.startsWith('data: ')) return false;
    const data = line.slice(6).trim();
    if (data === '[DONE]') {
      cleanupClose();
      flushAndFinishAnthropic(res, outputTokens, textBlockStarted, toolBlocks, finishReason);
      return true;
    }
    try {
      const parsed = JSON.parse(data);
      const choice = parsed.choices?.[0];
      if (!choice) return false;
      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta || {};

      // 文本内容
      if (delta.content) {
        if (!textBlockStarted) {
          sendSSE(res, 'content_block_start', {
            type: 'content_block_start', index: nextBlockIndex,
            content_block: { type: 'text', text: '' },
          });
          textBlockStarted = true;
          nextBlockIndex++;
        }
        outputTokens++;
        sendSSE(res, 'content_block_delta', {
          type: 'content_block_delta', index: nextBlockIndex - 1,
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      // 工具调用
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0;
          if (!toolBlocks.has(tcIdx)) {
            const anthropicIdx = nextBlockIndex++;
            toolBlocks.set(tcIdx, {
              id: tc.id || `toolu_${Date.now().toString(36)}_${tcIdx}`,
              name: tc.function?.name || '',
              anthropicIndex: anthropicIdx,
              started: false,
            });
          }
          const block = toolBlocks.get(tcIdx);
          if (tc.id) block.id = tc.id;
          if (tc.function?.name) {
            block.name = mergeOpenAIToolName(block.name, tc.function.name);
          }

          // 拿到 name 之后才能发 content_block_start
          if (!block.started && block.name) {
            block.started = true;
            sendSSE(res, 'content_block_start', {
              type: 'content_block_start', index: block.anthropicIndex,
              content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
            });
          }

          if (tc.function?.arguments && block.started) {
            outputTokens++;
            sendSSE(res, 'content_block_delta', {
              type: 'content_block_delta', index: block.anthropicIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  stream.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (processLine(line)) return;
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer && processLine(buffer)) return;
    cleanupClose();
    if (!res.writableEnded) flushAndFinishAnthropic(res, outputTokens, textBlockStarted, toolBlocks, finishReason);
  });
  stream.on('error', (err) => {
    cleanupClose();
    log.error('代理流错误', { error: err.message });
    if (!res.writableEnded) { sendSSE(res, 'error', { type: 'error', error: { message: err.message } }); res.end(); }
  });
}

function flushAndFinishAnthropic(res, outputTokens, textBlockStarted, toolBlocks, finishReason) {
  if (res.writableEnded) return;

  let blocksClosed = 0;
  if (textBlockStarted) {
    sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: blocksClosed });
    blocksClosed++;
  }
  for (const [, block] of toolBlocks) {
    if (block.started) {
      sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: block.anthropicIndex });
    }
  }

  // 保底：如果一个块都没开，补一个空文本块（防止 Claude Code 解析出错）
  if (!textBlockStarted && toolBlocks.size === 0) {
    sendSSE(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  }

  const stopReason = finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'length' ? 'max_tokens' : 'end_turn';

  sendSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sendSSE(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ═══════════════════════════════════════════════════════════════════════
//  OpenAI / Anthropic 流式透传
// ═══════════════════════════════════════════════════════════════════════

function streamPassthrough(res, stream, contentType, cleanupRequest) {
  const cleanupClose = destroyStreamOnClose(res, stream, cleanupRequest);
  res.setHeader('Content-Type', contentType || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  stream.on('end', cleanupClose);
  stream.on('error', (err) => {
    cleanupClose();
    log.error('代理透传流错误', { error: err.message });
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}

// ═══════════════════════════════════════════════════════════════════════
//  Router — 按 clientProtocol × upstreamProtocol 分发
// ═══════════════════════════════════════════════════════════════════════

function createProxyRouter({ proxyConfigStore, proxyToken = '', oneshellAiConfig = null }) {
  const router = Router();

  router.use(requireProxyAccess(proxyToken));

  /** 获取某个 CLI 的活跃 provider 配置 */
  function getActive(cliId) {
    return proxyConfigStore.getActiveProvider(cliId);
  }

  // ─── Reasoning 注入(v3 plan §4.2 轨 2)─────────────────────────────
  //   provider.reasoningEffort 非 'auto' 且当前 model 是 reasoning model 时,
  //   按上游协议向请求体注入 thinking / reasoning_effort。
  //   非 reasoning model 跳过,避免给不支持的模型送无效字段。
  function maybeInjectReasoning(body, provider, targetModel, upstreamProtocol) {
    const effort = provider?.reasoningEffort;
    if (!effort || effort === 'auto') return;
    const extraPrefixes = provider?.presetId
      ? (getPreset(provider.presetId)?.reasoningModels || [])
      : [];
    if (!isReasoningModel(targetModel, upstreamProtocol, extraPrefixes)) return;
    if (upstreamProtocol === 'anthropic') {
      injectAnthropicThinking(body, effort);
    } else if (upstreamProtocol === 'openai') {
      injectOpenAIReasoningEffort(body, effort);
    }
  }

  function getPositiveInteger(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function applyMaxOutputTokens(body, provider, protocol) {
    if (!body || typeof body !== 'object') return body;
    const limit = getPositiveInteger(provider?.maxOutputTokens);
    if (!limit) return body;

    const clamp = (value) => {
      const current = getPositiveInteger(value);
      return current ? Math.min(current, limit) : limit;
    };

    if (protocol === 'anthropic') {
      body.max_tokens = clamp(body.max_tokens);
      return body;
    }

    if (protocol === 'openai-responses') {
      body.max_output_tokens = clamp(body.max_output_tokens);
      return body;
    }

    if (body.max_completion_tokens != null) {
      body.max_completion_tokens = clamp(body.max_completion_tokens);
    } else if (body.max_tokens != null) {
      body.max_tokens = clamp(body.max_tokens);
    } else {
      body.max_tokens = limit;
    }
    return body;
  }

  function requireProvider(cliId, cliLabel, res) {
    const p = getActive(cliId);
    if (!p || !p.apiBase || !p.apiKey) {
      errResponse(res, 503, `1Shell 代理未配置 ${cliLabel} 的 API，请在接入页「⚙ 配置」中添加 Provider`, 'anthropic');
      return null;
    }
    try {
      normalizeProviderApiBase(p.apiBase);
    } catch (err) {
      errResponse(res, 400, `${cliLabel} Provider 配置不安全: ${err.message}`, 'anthropic');
      return null;
    }
    return p;
  }

  // ─── Skill Runner 专用端点 ─────────────────────────────────────────
  //   Skill SDK 模式下的内部回环调用。读 'skills' 槽位的 provider，
  //   未配置时回退到 'claude-code' 的 provider，实现"零配置开箱可用"。
  async function handleSkillsClient(req, res) {
    // 配置解析顺序:1shell-ai.json(配置文件生成器产物,运行时权威)
    //   → skills 槽位活跃 provider → claude-code 槽位回退(零配置开箱可用)
    // 文件缺字段(手工草稿漏填 apiBase/apiKey)不算"已配置",继续回退 provider,
    // 否则半成品文件会永久遮蔽本来可用的 provider 导致全部 503。
    const runtimeConfig = oneshellAiConfig?.readRuntimeConfig?.() || null;
    const active = (runtimeConfig && runtimeConfig.apiBase && runtimeConfig.apiKey ? runtimeConfig : null)
                || proxyConfigStore.getActiveProvider('skills')
                || proxyConfigStore.getActiveProvider('claude-code');
    if (!active || !active.apiBase || !active.apiKey) {
      return errResponse(res, 503, '1Shell Skill Runner 未配置 Provider，请在"接入"页给 Claude Code 或 Skills 添加 Provider', 'anthropic');
    }
    try {
      normalizeProviderApiBase(active.apiBase);
    } catch (err) {
      return errResponse(res, 400, `Skill Runner Provider 配置不安全: ${err.message}`, 'anthropic');
    }

    const body = req.body || {};
    const isStream = body.stream === true;
    const upstream = active.upstreamProtocol || 'openai';
    const requestAbort = createRequestAbort(req, res);

    if (upstream === 'anthropic') {
      const targetModel = active.model || body.model || '';
      if (active.model) body.model = active.model;
      maybeInjectReasoning(body, active, targetModel, 'anthropic');
      applyMaxOutputTokens(body, active, 'anthropic');
      applyRequestParams(body, active);
      try {
        // 若请求体包含 mcp_servers，自动附带 mcp-client beta header
        const extra = {};
        if (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0) {
          extra['anthropic-beta'] = 'mcp-client-2025-04-04';
        }
        const upResp = await callAnthropicUpstream(active.apiBase, active.apiKey, body, extra, requestAbort.signal);
        if (isStream) {
          streamPassthrough(res, upResp.body, 'text/event-stream', requestAbort.cleanup);
        } else {
          const data = await upResp.json();
          requestAbort.cleanup();
          res.status(upResp.status).json(data);
        }
      } catch (err) {
        requestAbort.cleanup();
        log.error('Skill Runner Anthropic 透传失败', { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'anthropic');
      }
    } else {
      const targetModel = active.model || 'gpt-4o';
      const openaiTools = convertAnthropicToolsToOpenAI(body.tools);
      const openaiBody = {
        model: targetModel,
        messages: anthropicToOpenAIMessages(body.system, body.messages),
        max_tokens: body.max_tokens || active.maxOutputTokens || 4096,
        stream: isStream,
      };
      if (body.temperature != null) openaiBody.temperature = body.temperature;
      if (body.top_p != null) openaiBody.top_p = body.top_p;
      if (openaiTools && openaiTools.length > 0) {
        openaiBody.tools = openaiTools;
        openaiBody.tool_choice = 'auto';
      }
      maybeInjectReasoning(openaiBody, active, targetModel, 'openai');
      applyMaxOutputTokens(openaiBody, active, 'openai-chat');
      applyRequestParams(openaiBody, active);
      try {
        const upResp = await callOpenAIUpstream(active.apiBase, active.apiKey, openaiBody, requestAbort.signal);
        if (!upResp.ok) {
          const errText = await upResp.text().catch(() => '');
          requestAbort.cleanup();
          return errResponse(res, upResp.status, `上游 API 返回 ${upResp.status}: ${errText.substring(0, 500)}`, 'anthropic');
        }
        if (isStream) {
          streamOpenAIToAnthropic(res, upResp.body, body.model || targetModel, requestAbort.cleanup);
        } else {
          const data = await upResp.json();
          requestAbort.cleanup();
          res.json(openaiToAnthropicResponse(data, body.model || targetModel));
        }
      } catch (err) {
        requestAbort.cleanup();
        log.error('Skill Runner 代理请求失败', { error: err.message });
        errResponse(res, 502, `代理请求失败: ${err.message}`, 'anthropic');
      }
    }
  }

  router.post('/skills/v1/messages', handleSkillsClient);

  return router;
}

// ═══════════════════════════════════════════════════════════════════════
//  Anthropic → OpenAI 反向转换 (给 Codex/OpenCode 调 Anthropic 上游)
// ═══════════════════════════════════════════════════════════════════════

function anthropicToOpenAIResponse(anthropicResp) {
  const content = anthropicResp.content || [];
  const text = content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  const toolUseBlocks = content.filter(b => b.type === 'tool_use');

  const message = { role: 'assistant', content: text || null };
  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map(tu => {
      const args = typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {});
      return {
        id: tu.id || `call_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: tu.name, arguments: args },
      };
    });
  }
  if (!text && toolUseBlocks.length === 0) message.content = '';

  const finish_reason = anthropicResp.stop_reason === 'tool_use' ? 'tool_calls'
    : anthropicResp.stop_reason === 'max_tokens' ? 'length' : 'stop';

  return {
    id: `chatcmpl-${anthropicResp.id || Date.now().toString(36)}`,
    object: 'chat.completion',
    model: anthropicResp.model || 'unknown',
    choices: [{ index: 0, message, finish_reason }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  };
}

function streamAnthropicToOpenAI(res, stream, cleanupRequest) {
  const cleanupClose = destroyStreamOnClose(res, stream, cleanupRequest);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let buffer = '';
  const decoder = new StringDecoder('utf8');
  // Map<anthropicBlockIndex, { id, name, openaiIndex }>
  const toolBlocks = new Map();
  let nextToolCallIndex = 0;

  function processLine(line) {
    if (!line.startsWith('data: ')) return false;
    const data = line.slice(6).trim();
    if (!data) return false;
    try {
      const parsed = JSON.parse(data);

      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        const cb = parsed.content_block;
        const openaiIdx = nextToolCallIndex++;
        toolBlocks.set(parsed.index, { id: cb.id, name: cb.name, openaiIndex: openaiIdx });
        res.write(`data: ${JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {
            tool_calls: [{ index: openaiIdx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }],
          }, finish_reason: null }],
        })}\n\n`);

      } else if (parsed.type === 'content_block_delta') {
        if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
          res.write(`data: ${JSON.stringify({
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: parsed.delta.text }, finish_reason: null }],
          })}\n\n`);
        } else if (parsed.delta?.type === 'input_json_delta') {
          const block = toolBlocks.get(parsed.index);
          if (block) {
            res.write(`data: ${JSON.stringify({
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {
                tool_calls: [{ index: block.openaiIndex, function: { arguments: parsed.delta.partial_json || '' } }],
              }, finish_reason: null }],
            })}\n\n`);
          }
        }

      } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
        const fr = parsed.delta.stop_reason === 'tool_use' ? 'tool_calls'
          : parsed.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
        res.write(`data: ${JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: fr }],
        })}\n\n`);

      } else if (parsed.type === 'message_stop') {
        cleanupClose();
        res.write('data: [DONE]\n\n');
        res.end();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  stream.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (processLine(line)) return;
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer && processLine(buffer)) return;
    cleanupClose();
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
  stream.on('error', (err) => {
    cleanupClose();
    log.error('Anthropic→OpenAI 流错误', { error: err.message });
    if (!res.writableEnded) res.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  Multi-Provider 配置持久化
// ═══════════════════════════════════════════════════════════════════════

function createProxyConfigStore(dataDir) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const configPath = path.join(dataDir, 'proxy-configs.json');
  const GLOBAL_PROVIDERS_KEY = '__globalProviders';
  const DEFAULT_PROVIDER_SLOTS = ['skills', 'claude-code', 'codex', 'opencode'];
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

  function _readAll() {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (migrateLegacyProviderPools(data)) _writeAll(data);
      return data;
    } catch {
      return {};
    }
  }
  function _writeAll(data) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  }
  function _ensureCli(all, cliId) {
    if (!all[cliId]) all[cliId] = { providers: [], activeProviderId: null };
    if (!Array.isArray(all[cliId].providers)) all[cliId].providers = [];
    return all[cliId];
  }
  function _getGlobalProviders(all) {
    return Array.isArray(all[GLOBAL_PROVIDERS_KEY]) ? all[GLOBAL_PROVIDERS_KEY] : [];
  }
  function isCliEntry(key, value) {
    return key !== GLOBAL_PROVIDERS_KEY && value && typeof value === 'object' && !Array.isArray(value);
  }

  function getCliEntries(all) {
    return Object.entries(all || {}).filter(([key, value]) => isCliEntry(key, value));
  }

  function cloneProviderForLocal(provider) {
    const cloned = JSON.parse(JSON.stringify(provider || {}));
    if (!cloned.id) cloned.id = crypto.randomBytes(4).toString('hex');
    persistActiveModelProjection(cloned);
    return cloned;
  }

  function copyProviderIntoCli(cli, provider) {
    if (!provider || typeof provider !== 'object') return false;
    const providerId = provider.id || crypto.randomBytes(4).toString('hex');
    if (cli.providers.some(p => p?.id === providerId)) return false;
    cli.providers.push(cloneProviderForLocal({ ...provider, id: providerId }));
    return true;
  }

  function migrateLegacyProviderPools(all) {
    if (!all || typeof all !== 'object' || Array.isArray(all)) return false;
    const globalProviders = _getGlobalProviders(all).filter(p => p && typeof p === 'object');
    if (!globalProviders.length) {
      if (hasOwn(all, GLOBAL_PROVIDERS_KEY)) {
        delete all[GLOBAL_PROVIDERS_KEY];
        return true;
      }
      return false;
    }
    let changed = false;

    const targetIds = new Set([...DEFAULT_PROVIDER_SLOTS, ...getCliEntries(all).map(([cliId]) => cliId)]);
    for (const cliId of targetIds) {
      const cli = _ensureCli(all, cliId);
      const hadRoute = Boolean(cli.activeRoute?.providerId || cli.activeProviderId);
      for (const provider of globalProviders) {
        changed = copyProviderIntoCli(cli, provider) || changed;
      }
      if (!hadRoute && globalProviders[0]?.id) {
        const { activeModelId } = normalizeProviderModels(globalProviders[0]);
        cli.activeProviderId = globalProviders[0].id;
        cli.activeRoute = { providerId: globalProviders[0].id, modelId: activeModelId || null };
        changed = true;
      }
      persistActiveRoute(cli, getProviderRecordsForCli(all, cli));
    }

    delete all[GLOBAL_PROVIDERS_KEY];
    changed = true;
    return changed;
  }

  function maskKey(key) {
    if (!key || key.length < 10) return '****';
    return key.substring(0, 5) + '…' + key.substring(key.length - 4);
  }

  function normalizeReasoningEffort(value) {
    const v = String(value || '').trim().toLowerCase();
    return ['auto', 'low', 'medium', 'high', 'max', 'xhigh'].includes(v) ? v : 'auto';
  }

  function normalizeClaudeRoleModel(input = {}) {
    const source = input && typeof input === 'object' ? input : { model: input };
    const model = String(source.model ?? source.apiModel ?? '').trim();
    const displayName = String(source.displayName ?? source.name ?? model.replace(/\s*\[1m\]\s*$/i, '')).trim();
    return { model, displayName: displayName || model };
  }

  function normalizeClaudeModels(input) {
    const source = input && typeof input === 'object' ? input : {};
    const roles = ['sonnet', 'opus', 'fable', 'haiku'];
    const out = {};
    let hasAny = false;
    for (const role of roles) {
      const normalized = normalizeClaudeRoleModel(source[role]);
      out[role] = normalized;
      if (normalized.model || normalized.displayName) hasAny = true;
    }
    return hasAny ? out : null;
  }

  function setClaudeProviderOptions(provider, source) {
    if (hasOwn(source, 'claudeModels')) {
      const normalized = normalizeClaudeModels(source.claudeModels);
      if (normalized) provider.claudeModels = normalized;
      else delete provider.claudeModels;
    }
    if (typeof source.enableToolSearch === 'boolean') {
      provider.enableToolSearch = source.enableToolSearch;
    }
    if (typeof source.includeCoAuthoredBy === 'boolean') {
      provider.includeCoAuthoredBy = source.includeCoAuthoredBy;
    }
  }

  function normalizeOptionalPositiveInteger(value, fieldName) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${fieldName} must be a positive integer`);
    }
    return n;
  }

  function setOptionalPositiveInteger(target, fieldName, value) {
    const normalized = normalizeOptionalPositiveInteger(value, fieldName);
    if (normalized === null) {
      delete target[fieldName];
    } else {
      target[fieldName] = normalized;
    }
  }

  function readOptionalPositiveInteger(source, fieldName) {
    return hasOwn(source, fieldName)
      ? normalizeOptionalPositiveInteger(source[fieldName], fieldName)
      : undefined;
  }

  function makeModelId() {
    return `model-${crypto.randomBytes(3).toString('hex')}`;
  }

  function normalizeModelProfile(input = {}, fallback = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const apiModel = String(source.apiModel ?? source.model ?? fallback.apiModel ?? fallback.model ?? '').trim();
    const displayName = String(source.displayName ?? source.name ?? fallback.displayName ?? apiModel).trim();
    const profile = {
      id: String(source.id || fallback.id || makeModelId()).trim() || makeModelId(),
      apiModel,
      displayName: displayName || apiModel,
      enabled: source.enabled !== false,
      reasoningEffort: normalizeReasoningEffort(source.reasoningEffort ?? fallback.reasoningEffort),
    };
    const contextTokenLimit = readOptionalPositiveInteger(
      hasOwn(source, 'contextTokenLimit') ? source : fallback,
      'contextTokenLimit',
    );
    const maxOutputTokens = readOptionalPositiveInteger(
      hasOwn(source, 'maxOutputTokens') ? source : fallback,
      'maxOutputTokens',
    );
    if (contextTokenLimit !== undefined && contextTokenLimit !== null) profile.contextTokenLimit = contextTokenLimit;
    if (maxOutputTokens !== undefined && maxOutputTokens !== null) profile.maxOutputTokens = maxOutputTokens;
    const requestParams = normalizeRequestParams(
      hasOwn(source, 'requestParams') ? source.requestParams : fallback.requestParams,
    );
    if (requestParams) profile.requestParams = requestParams;
    return profile;
  }

  function normalizeProviderModels(provider) {
    const storedModels = Array.isArray(provider.models) ? provider.models : [];
    let models = storedModels.map((model) => normalizeModelProfile(model));
    if (!models.length) {
      models = [normalizeModelProfile({}, {
        id: provider.activeModelId || 'default',
        model: provider.model,
        displayName: provider.model,
        reasoningEffort: provider.reasoningEffort,
        contextTokenLimit: provider.contextTokenLimit,
        maxOutputTokens: provider.maxOutputTokens,
        requestParams: provider.requestParams,
      })];
    }
    const activeModelId = models.some((model) => model.id === provider.activeModelId)
      ? provider.activeModelId
      : (models.find((model) => model.enabled !== false)?.id || models[0]?.id || null);
    const activeModel = models.find((model) => model.id === activeModelId) || models[0] || null;
    return { models, activeModelId, activeModel };
  }

  function projectActiveModel(provider, modelId) {
    if (!provider) return null;
    const projected = { ...provider };
    const normalized = normalizeProviderModels(provider);
    const routeModel = modelId
      ? normalized.models.find((model) => model.id === modelId)
      : null;
    const activeModel = routeModel || normalized.activeModel;
    const activeModelId = activeModel?.id || normalized.activeModelId;
    projected.models = normalized.models;
    projected.activeModelId = activeModelId;
    if (activeModel) {
      projected.model = activeModel.apiModel || '';
      projected.reasoningEffort = activeModel.reasoningEffort || 'auto';
      if (hasOwn(activeModel, 'contextTokenLimit')) projected.contextTokenLimit = activeModel.contextTokenLimit;
      else delete projected.contextTokenLimit;
      if (hasOwn(activeModel, 'maxOutputTokens')) projected.maxOutputTokens = activeModel.maxOutputTokens;
      else delete projected.maxOutputTokens;
      if (hasOwn(activeModel, 'requestParams')) projected.requestParams = activeModel.requestParams;
      else delete projected.requestParams;
    }
    return projected;
  }

  function getProviderRecordsForCli(all, cli) {
    const records = [];
    const seen = new Set();
    for (const provider of (cli?.providers || [])) {
      if (!provider?.id || seen.has(provider.id)) continue;
      seen.add(provider.id);
      records.push({ provider, scope: 'local' });
    }
    return records;
  }

  function findProviderRecord(records, providerId) {
    return (records || []).find((record) => record.provider?.id === providerId) || null;
  }

  function normalizeRoute(route, providerRecords, fallbackProviderId = null) {
    const list = Array.isArray(providerRecords) ? providerRecords : [];
    if (!list.length) return null;
    const requestedProviderId = typeof route?.providerId === 'string' ? route.providerId : fallbackProviderId;
    const record = findProviderRecord(list, requestedProviderId) || list[0];
    const provider = record?.provider;
    if (!provider) return null;
    const { models, activeModelId } = normalizeProviderModels(provider);
    const requestedModelId = typeof route?.modelId === 'string' ? route.modelId : null;
    const modelId = models.some((model) => model.id === requestedModelId)
      ? requestedModelId
      : activeModelId;
    return { providerId: provider.id, modelId: modelId || null };
  }

  function resolveActiveRoute(cli, providerRecords) {
    return normalizeRoute(cli?.activeRoute, providerRecords, cli?.activeProviderId || null);
  }

  function persistActiveRoute(cli, providerRecords) {
    const route = resolveActiveRoute(cli, providerRecords);
    cli.activeProviderId = route?.providerId || null;
    if (route?.providerId) cli.activeRoute = route;
    else delete cli.activeRoute;
    return route;
  }

  function getRoutedProvider(cli, providerRecords) {
    const route = resolveActiveRoute(cli, providerRecords);
    if (!route) return null;
    const record = findProviderRecord(providerRecords, route.providerId);
    const provider = record?.provider;
    const projected = projectActiveModel(provider, route.modelId);
    if (projected) projected.activeRoute = route;
    return projected;
  }

  function persistActiveModelProjection(provider) {
    const projected = projectActiveModel(provider);
    provider.models = projected.models;
    provider.activeModelId = projected.activeModelId;
    provider.model = projected.model || '';
    provider.reasoningEffort = projected.reasoningEffort || 'auto';
    if (hasOwn(projected, 'contextTokenLimit')) provider.contextTokenLimit = projected.contextTokenLimit;
    else delete provider.contextTokenLimit;
    if (hasOwn(projected, 'maxOutputTokens')) provider.maxOutputTokens = projected.maxOutputTokens;
    else delete provider.maxOutputTokens;
    if (hasOwn(projected, 'requestParams')) provider.requestParams = projected.requestParams;
    else delete provider.requestParams;
  }

  function updateActiveModelFromLegacyFields(provider, partial) {
    const { models, activeModelId } = normalizeProviderModels(provider);
    provider.models = models;
    provider.activeModelId = activeModelId;
    let activeModel = provider.models.find((model) => model.id === provider.activeModelId);
    if (!activeModel) {
      activeModel = normalizeModelProfile({}, { id: provider.activeModelId || 'default' });
      provider.models.push(activeModel);
      provider.activeModelId = activeModel.id;
    }
    if (typeof partial.model === 'string') {
      const previousApiModel = activeModel.apiModel || '';
      const previousDisplayName = activeModel.displayName || '';
      activeModel.apiModel = partial.model.trim();
      if (!previousDisplayName || previousDisplayName === previousApiModel) {
        activeModel.displayName = activeModel.apiModel;
      }
    }
    if (typeof partial.reasoningEffort === 'string') {
      activeModel.reasoningEffort = normalizeReasoningEffort(partial.reasoningEffort);
    }
    if (hasOwn(partial, 'contextTokenLimit')) {
      setOptionalPositiveInteger(activeModel, 'contextTokenLimit', partial.contextTokenLimit);
    }
    if (hasOwn(partial, 'maxOutputTokens')) {
      setOptionalPositiveInteger(activeModel, 'maxOutputTokens', partial.maxOutputTokens);
    }
    if (hasOwn(partial, 'requestParams')) {
      const requestParams = normalizeRequestParams(partial.requestParams);
      if (requestParams) activeModel.requestParams = requestParams;
      else delete activeModel.requestParams;
    }
  }

  function maskModelProfile(model) {
    return {
      id: model.id,
      apiModel: model.apiModel || '',
      displayName: model.displayName || model.apiModel || '',
      enabled: model.enabled !== false,
      reasoningEffort: model.reasoningEffort || 'auto',
      contextTokenLimit: model.contextTokenLimit || null,
      maxOutputTokens: model.maxOutputTokens || null,
      requestParams: model.requestParams || null,
    };
  }

  function maskProvider(p, modelId, scope = 'local') {
    const projected = projectActiveModel(p, modelId);
    return {
      id: projected.id, name: projected.name || '',
      apiBase: projected.apiBase || '',
      apiKey: projected.apiKey ? maskKey(projected.apiKey) : '',
      apiKeySet: Boolean(projected.apiKey),
      model: projected.model || '',
      upstreamProtocol: projected.upstreamProtocol || 'openai',
      reasoningEffort: projected.reasoningEffort || 'auto',
      contextTokenLimit: projected.contextTokenLimit || null,
      maxOutputTokens: projected.maxOutputTokens || null,
      requestParams: projected.requestParams || null,
      presetId: projected.presetId || '',
      enabled: projected.enabled !== false,
      activeModelId: projected.activeModelId || null,
      routeModelId: modelId || null,
      scope,
      models: (projected.models || []).map(maskModelProfile),
      claudeModels: normalizeClaudeModels(projected.claudeModels) || undefined,
      enableToolSearch: projected.enableToolSearch === true,
      includeCoAuthoredBy: typeof projected.includeCoAuthoredBy === 'boolean' ? projected.includeCoAuthoredBy : undefined,
      nativeSource: projected.nativeSource || '',
      nativeProviderId: projected.nativeProviderId || '',
    };
  }

  function makeNativeProviderId(cliId, imported) {
    const raw = String(imported?.nativeProviderId || imported?.codexProviderId || imported?.opencodeProviderId || imported?.name || 'default')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `native-${cliId}-${raw || 'default'}`;
  }

  function findNativeProvider(cli, imported, desiredId) {
    const nativeProviderId = String(imported?.nativeProviderId || '').trim();
    return (cli.providers || []).find((provider) => {
      if (!provider) return false;
      if (provider.id === desiredId) return true;
      return provider.nativeSource === 'host-config'
        && provider.nativeCliId === imported.nativeCliId
        && String(provider.nativeProviderId || '').trim() === nativeProviderId;
    }) || null;
  }

  function applyImportedProvider(target, imported) {
    if (!imported?.apiBase) throw new Error('原生配置缺少 apiBase，无法导入到配置界面');
    target.name = String(imported.name || target.name || 'Native Provider').trim();
    target.apiBase = normalizeProviderApiBase(imported.apiBase);
    if (typeof imported.apiKey === 'string' && imported.apiKey.trim()) {
      target.apiKey = imported.apiKey.trim();
    } else if (!target.apiKey) {
      target.apiKey = '';
    }
    target.upstreamProtocol = imported.upstreamProtocol || target.upstreamProtocol || 'openai';
    target.presetId = String(imported.presetId || target.presetId || '').trim();
    target.enabled = imported.enabled !== false;
    target.nativeSource = 'host-config';
    target.nativeCliId = imported.nativeCliId;
    target.nativeProviderId = String(imported.nativeProviderId || '').trim() || 'default';
    if (typeof imported.codexProviderId === 'string') target.codexProviderId = imported.codexProviderId.trim();
    if (typeof imported.opencodeProviderId === 'string') target.opencodeProviderId = imported.opencodeProviderId.trim();
    setClaudeProviderOptions(target, imported);
    if (Array.isArray(imported.models) && imported.models.length) {
      target.models = imported.models.map((model) => normalizeModelProfile(model));
      target.activeModelId = imported.activeModelId || target.activeModelId || target.models[0]?.id || null;
    } else {
      target.model = String(imported.model || target.model || '').trim();
      target.reasoningEffort = normalizeReasoningEffort(imported.reasoningEffort);
      updateActiveModelFromLegacyFields(target, {
        model: target.model,
        reasoningEffort: target.reasoningEffort,
      });
    }
    if (typeof imported.activeModelId === 'string') target.activeModelId = imported.activeModelId;
    persistActiveModelProjection(target);
  }

  function upsertNativeProvider(cliId, importedProvider) {
    if (!importedProvider || typeof importedProvider !== 'object') {
      return { imported: false, changed: false, id: null };
    }
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const desiredId = makeNativeProviderId(cliId, importedProvider);
    const imported = {
      ...importedProvider,
      nativeCliId: cliId,
      nativeProviderId: String(importedProvider.nativeProviderId || desiredId).trim(),
    };
    let provider = findNativeProvider(cli, imported, desiredId);
    const created = !provider;
    if (!provider) {
      provider = { id: desiredId };
      cli.providers.push(provider);
    }
    applyImportedProvider(provider, imported);
    if (!cli.activeRoute?.providerId && !cli.activeProviderId) {
      cli.activeProviderId = provider.id;
      cli.activeRoute = { providerId: provider.id, modelId: provider.activeModelId || null };
    }
    persistActiveRoute(cli, getProviderRecordsForCli(all, cli));
    _writeAll(all);
    return { imported: true, changed: true, created, id: provider.id };
  }

  /** 列出某 CLI 的所有 Provider（脱敏） */
  function listProviders(cliId) {
    const all = _readAll();
    const cli = all[cliId] || { providers: [], activeProviderId: null };
    const providerRecords = getProviderRecordsForCli(all, cli);
    if (!providerRecords.length) return { providers: [], activeProviderId: null, activeRoute: null };
    const activeRoute = resolveActiveRoute(cli, providerRecords);
    return {
      providers: providerRecords.map((record) => maskProvider(
        record.provider,
        record.provider.id === activeRoute?.providerId ? activeRoute.modelId : undefined,
        record.scope,
      )),
      activeProviderId: activeRoute?.providerId || cli.activeProviderId || null,
      activeRoute,
    };
  }

  /** 获取某 CLI 的活跃 Provider（原始，含 apiKey） */
  function getActiveProvider(cliId) {
    const all = _readAll();
    const cli = all[cliId] || { providers: [], activeProviderId: null };
    const providerRecords = getProviderRecordsForCli(all, cli);
    if (!providerRecords.length) return null;
    return getRoutedProvider(cli, providerRecords);
  }

  /** 获取某 CLI 的指定 Provider（原始，含 apiKey） */
  function getProvider(cliId, providerId, modelId = null) {
    const all = _readAll();
    const cli = all[cliId] || { providers: [], activeProviderId: null };
    const providerRecords = getProviderRecordsForCli(all, cli);
    const record = findProviderRecord(providerRecords, providerId);
    if (!record?.provider) return null;
    return projectActiveModel(record.provider, modelId);
  }

  /** 添加 Provider，返回新 ID */
  function addProvider(cliId, data) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const hadRoute = Boolean(cli.activeRoute?.providerId || cli.activeProviderId);
    const id = crypto.randomBytes(4).toString('hex');
    const provider = {
      id,
      name: data.name || `Provider ${cli.providers.length + 1}`,
      apiBase: normalizeProviderApiBase(data.apiBase),
      apiKey: (data.apiKey || '').trim(),
      upstreamProtocol: data.upstreamProtocol || 'openai',
      presetId: (data.presetId || '').trim(),
      enabled: true,
    };
    setClaudeProviderOptions(provider, data);
    if (Array.isArray(data.models)) {
      provider.models = data.models.map((model) => normalizeModelProfile(model));
      provider.activeModelId = data.activeModelId || provider.models[0]?.id || null;
    } else {
      provider.model = (data.model || '').trim();
      provider.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort);
      setOptionalPositiveInteger(provider, 'contextTokenLimit', data.contextTokenLimit);
      setOptionalPositiveInteger(provider, 'maxOutputTokens', data.maxOutputTokens);
      const requestParams = normalizeRequestParams(data.requestParams);
      if (requestParams) provider.requestParams = requestParams;
    }
    persistActiveModelProjection(provider);
    cli.providers.push(provider);
    if (!hadRoute) {
      cli.activeProviderId = id;
      cli.activeRoute = { providerId: id, modelId: provider.activeModelId || null };
    }
    persistActiveRoute(cli, getProviderRecordsForCli(all, cli));
    _writeAll(all);
    return id;
  }

  /** 复制 Provider，返回新 ID */
  function copyProvider(cliId, providerId) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const providerRecords = getProviderRecordsForCli(all, cli);
    const record = findProviderRecord(providerRecords, providerId);
    if (!record?.provider) return null;

    const copied = cloneProviderForLocal({
      ...JSON.parse(JSON.stringify(record.provider)),
      id: crypto.randomBytes(4).toString('hex'),
      name: `${record.provider.name || 'Provider'}-copy`,
    });
    cli.providers.push(copied);
    persistActiveRoute(cli, getProviderRecordsForCli(all, cli));
    _writeAll(all);
    return copied.id;
  }

  /** 更新 Provider */
  function updateProvider(cliId, providerId, partial) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const providerRecords = getProviderRecordsForCli(all, cli);
    const record = findProviderRecord(providerRecords, providerId);
    const p = record?.provider;
    if (!p) return false;
    const activeRoute = resolveActiveRoute(cli, providerRecords);
    if (typeof partial.name === 'string') p.name = partial.name.trim();
    if (typeof partial.apiBase === 'string') p.apiBase = normalizeProviderApiBase(partial.apiBase);
    if (typeof partial.apiKey === 'string') p.apiKey = partial.apiKey.trim();
    if (typeof partial.upstreamProtocol === 'string') p.upstreamProtocol = partial.upstreamProtocol;
    setClaudeProviderOptions(p, partial);
    if (Array.isArray(partial.models)) {
      p.models = partial.models.map((model) => normalizeModelProfile(model));
      p.activeModelId = partial.activeModelId || p.activeModelId || p.models[0]?.id || null;
    }
    if (typeof partial.activeModelId === 'string') p.activeModelId = partial.activeModelId;
    if (
      typeof partial.model === 'string'
      || typeof partial.reasoningEffort === 'string'
      || hasOwn(partial, 'contextTokenLimit')
      || hasOwn(partial, 'maxOutputTokens')
      || hasOwn(partial, 'requestParams')
    ) {
      updateActiveModelFromLegacyFields(p, partial);
    }
    if (typeof partial.presetId === 'string') p.presetId = partial.presetId.trim();
    if (typeof partial.enabled === 'boolean') { p.enabled = partial.enabled; }
    persistActiveModelProjection(p);
    if (activeRoute?.providerId === providerId && typeof partial.activeModelId === 'string') {
      cli.activeRoute = { providerId, modelId: partial.activeModelId };
    }
    persistActiveRoute(cli, getProviderRecordsForCli(all, cli));
    _writeAll(all);
    return true;
  }

  /** 删除 Provider */
  function deleteProvider(cliId, providerId) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const list = cli.providers;
    const idx = cli.providers.findIndex(x => x.id === providerId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (cli.activeProviderId === providerId) cli.activeProviderId = null;
    if (cli.activeRoute?.providerId === providerId) delete cli.activeRoute;
    persistActiveRoute(cli, getProviderRecordsForCli(all, cli));
    _writeAll(all);
    return true;
  }

  /** 设为活跃 Provider */
  function setActive(cliId, providerId, modelId = null) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const providerRecords = getProviderRecordsForCli(all, cli);
    const record = findProviderRecord(providerRecords, providerId);
    const provider = record?.provider;
    if (!provider) return false;
    const { models, activeModelId } = normalizeProviderModels(provider);
    const selectedModelId = models.some((model) => model.id === modelId) ? modelId : activeModelId;
    cli.activeProviderId = providerId;
    cli.activeRoute = { providerId, modelId: selectedModelId || null };
    _writeAll(all);
    return true;
  }

  /** 设为活跃 Route（Provider + Model Profile） */
  function setRoute(cliId, route) {
    const all = _readAll();
    const cli = _ensureCli(all, cliId);
    const activeRoute = normalizeRoute(route, getProviderRecordsForCli(all, cli), cli.activeProviderId);
    if (!activeRoute) return false;
    cli.activeProviderId = activeRoute.providerId;
    cli.activeRoute = activeRoute;
    _writeAll(all);
    return activeRoute;
  }

  /** 获取所有 CLI 的摘要（前端 scan 用） */
  function getAllSummary() {
    const all = _readAll();
    const result = {};
    for (const [cliId, cli] of Object.entries(all)) {
      if (!isCliEntry(cliId, cli)) continue;
      const providerRecords = getProviderRecordsForCli(all, cli);
      const active = getRoutedProvider(cli, providerRecords);
      result[cliId] = {
        providerCount: providerRecords.length,
        activeProvider: active ? {
          name: active.name,
          model: active.model,
          upstreamProtocol: active.upstreamProtocol,
          apiKeySet: Boolean(active.apiKey),
          contextTokenLimit: active.contextTokenLimit || null,
          maxOutputTokens: active.maxOutputTokens || null,
          activeModelId: active.activeModelId || null,
          activeRoute: active.activeRoute || null,
        } : null,
      };
    }
    return result;
  }

  return { listProviders, getActiveProvider, getProvider, addProvider, copyProvider, updateProvider, deleteProvider, setActive, setRoute, upsertNativeProvider, getAllSummary, maskKey };
}

module.exports = {
  createProxyRouter,
  createProxyConfigStore,
  buildAnthropicProxyModelList,
  buildOpenAIProxyModelList,
  __private: {
    streamAnthropicToOpenAI,
    streamOpenAIToAnthropic,
    normalizeRequestParams,
    applyRequestParams,
  },
};
