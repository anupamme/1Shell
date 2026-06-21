'use strict';

/**
 * Reasoning effort 映射 + reasoning model 白名单。
 *
 * v3 plan §4.2 双轨策略的"轨 2"(proxy 请求体注入)由本模块提供数据;
 * "轨 1"(manifest 配置写入)由 cli-sandbox 的 template builder 消费 `getEffortLabel()`。
 *
 * 数据原则:
 *   - 白名单宁缺勿滥,只列已知支持 reasoning 的模型前缀(模型迭代快,4.3 用户反馈再扩)
 *   - effort 档位与上游 API 字段含义对齐;不发明 1Shell 自有档位
 */

const EFFORT_LABELS = ['auto', 'low', 'medium', 'high'];

// Anthropic thinking.budget_tokens 映射(单位:输出 token 数)
// 参考:claude-3.7-sonnet thinking 上限 64000;>=1024 才有效
const ANTHROPIC_BUDGET_TOKENS = {
  low: 4000,
  medium: 16000,
  high: 64000,
};

// OpenAI reasoning_effort 字符串(o-series / gpt-5-thinking 都接受这种枚举)
const OPENAI_EFFORT_VALUES = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

// reasoning model 前缀白名单(按上游 protocol 分组)
// 命中前缀的 model 才注入 reasoning;其它跳过(避免给非 reasoning 模型加无效字段)
const REASONING_MODEL_PREFIXES = {
  openai: [
    'gpt-5',
    'o1',
    'o3',
    'o4-mini',
  ],
  anthropic: [
    'claude-3-7-sonnet',
    'claude-3.7-sonnet',
    'claude-opus-4',
    'claude-sonnet-4',
    'claude-fable-5',
  ],
  // deepseek 用 openai 协议但有自己的 reasoner 系列,放 openai 组
  // (调用方按 provider preset 的 reasoningModels 字段补判,见 isReasoningModel)
};

function isValidEffort(effort) {
  return EFFORT_LABELS.includes(effort);
}

/**
 * 判断 model 是否为 reasoning model。
 *
 * @param {string} model — 模型名,如 'gpt-5-thinking-2026' / 'claude-3-7-sonnet-20250219'
 * @param {string} protocol — 'openai' | 'anthropic'(provider 的 upstreamProtocol)
 * @param {string[]} [extraPrefixes] — provider preset 提供的 reasoningModels(用于 deepseek-reasoner 这种白名单外的)
 * @returns {boolean}
 */
function isReasoningModel(model, protocol, extraPrefixes = []) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();
  const prefixes = [
    ...(REASONING_MODEL_PREFIXES[protocol] || []),
    ...(extraPrefixes || []),
  ].map(p => p.toLowerCase());
  return prefixes.some(p => m.startsWith(p));
}

/**
 * 对 Anthropic 协议请求体注入 thinking 块(用于 claude provider + 1Shell AI claude 模式)。
 * 调用方负责先判断 effort != 'auto' 且 isReasoningModel = true。
 *
 * @param {object} body — Anthropic messages API 请求体(会被原地修改)
 * @param {string} effort — 'low' | 'medium' | 'high'
 * @returns {object} — 修改后的 body
 */
function injectAnthropicThinking(body, effort) {
  if (!body || typeof body !== 'object') return body;
  const budget = ANTHROPIC_BUDGET_TOKENS[effort];
  if (!budget) return body;
  body.thinking = { type: 'enabled', budget_tokens: budget };
  return body;
}

/**
 * 对 OpenAI 协议请求体注入 reasoning_effort 字段(用于 1Shell AI openai 模式 + 各 openai 兼容 reasoning model)。
 *
 * @param {object} body — OpenAI chat/responses API 请求体(会被原地修改)
 * @param {string} effort — 'low' | 'medium' | 'high'
 * @returns {object}
 */
function injectOpenAIReasoningEffort(body, effort) {
  if (!body || typeof body !== 'object') return body;
  const value = OPENAI_EFFORT_VALUES[effort];
  if (!value) return body;
  body.reasoning_effort = value;
  return body;
}

/**
 * 给 codex `config.toml` template builder 用 — 把 1Shell 的 effort 翻译成 codex `model_reasoning_effort` 行。
 * codex 在 config.toml 里也用 low/medium/high 三档(auto = 不写这一行,让 codex 默认决定)。
 *
 * @param {string} effort
 * @returns {string|null} — TOML 行(不含换行)或 null(表示不写)
 */
function codexConfigTomlReasoningLine(effort) {
  if (!effort || effort === 'auto') return null;
  if (!OPENAI_EFFORT_VALUES[effort]) return null;
  return `model_reasoning_effort = "${effort}"`;
}

module.exports = {
  EFFORT_LABELS,
  ANTHROPIC_BUDGET_TOKENS,
  OPENAI_EFFORT_VALUES,
  REASONING_MODEL_PREFIXES,
  isValidEffort,
  isReasoningModel,
  injectAnthropicThinking,
  injectOpenAIReasoningEffort,
  codexConfigTomlReasoningLine,
};
