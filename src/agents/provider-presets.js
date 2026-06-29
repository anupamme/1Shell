'use strict';

/**
 * Provider preset 数据(v3 plan §4.1)
 *
 * 用户在添加 provider 时可选一个 preset,自动填好 apiBase/protocol/apiKeyField/models/reasoningModels/docsUrl,
 * 只剩 API key 要填。也保留"自定义"路径,完全手填。
 *
 * 字段含义:
 *   id              — 内部唯一 id
 *   name            — 显示名
 *   apiBase         — 默认 API base(用户可改)
 *   protocol        — 'openai' | 'anthropic' — provider 的 upstreamProtocol
 *   apiKeyField     — 该 provider 的 key env 字段名(给 UI 当 placeholder 提示,非强制)
 *   models          — 常用模型列表(给 model 输入框做 datalist 补全)
 *   reasoningModels — 该 provider 的 reasoning model 前缀,补 src/agents/reasoning.js 白名单
 *   docsUrl         — 官方文档链接
 *   category        — 'domestic' | 'overseas' | 'relay' — 分组用
 *
 * 数据原则:
 *   - 只做"自动填",不做"模型清单的真理来源"
 *   - apiBase 不带 /v1 后缀(由调用方按协议补)— 但 OpenAI 兼容服务历史习惯参差,以官方文档为准
 *   - reasoningModels 只列已知前缀,模型迭代快不强求齐全
 */

const PROVIDER_PRESETS = [
  // ── 国内 6 家 ──
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiBase: 'https://api.deepseek.com',
    protocol: 'openai',
    apiKeyField: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    reasoningModels: ['deepseek-reasoner'],
    docsUrl: 'https://platform.deepseek.com/api-docs',
    category: 'domestic',
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    apiBase: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    apiKeyField: 'MOONSHOT_API_KEY',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0905-preview'],
    reasoningModels: [],
    docsUrl: 'https://platform.moonshot.cn/docs',
    category: 'domestic',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    apiKeyField: 'ZHIPUAI_API_KEY',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4.6'],
    reasoningModels: [],
    docsUrl: 'https://open.bigmodel.cn/dev/api',
    category: 'domestic',
  },
  {
    id: 'qwen',
    name: '通义 Qwen (DashScope)',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    apiKeyField: 'DASHSCOPE_API_KEY',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus'],
    reasoningModels: [],
    docsUrl: 'https://help.aliyun.com/zh/dashscope/',
    category: 'domestic',
  },
  {
    id: 'doubao',
    name: '豆包 (火山引擎)',
    apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'openai',
    apiKeyField: 'ARK_API_KEY',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k', 'doubao-1-5-pro-256k'],
    reasoningModels: [],
    docsUrl: 'https://www.volcengine.com/docs/82379',
    category: 'domestic',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    apiBase: 'https://api.minimaxi.com/v1',
    protocol: 'openai',
    apiKeyField: 'MINIMAX_API_KEY',
    models: ['MiniMax-Text-01', 'MiniMax-M1'],
    reasoningModels: [],
    docsUrl: 'https://platform.minimaxi.com/document',
    category: 'domestic',
  },

  // ── 海外 4 家 ──
  {
    id: 'openai',
    name: 'OpenAI',
    apiBase: 'https://api.openai.com',
    protocol: 'openai',
    apiKeyField: 'OPENAI_API_KEY',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
    reasoningModels: ['gpt-5', 'o1', 'o3', 'o4-mini'],
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    category: 'overseas',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    apiBase: 'https://api.anthropic.com',
    protocol: 'anthropic',
    apiKeyField: 'ANTHROPIC_API_KEY',
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
    reasoningModels: ['claude-3-7-sonnet', 'claude-opus-4', 'claude-sonnet-4', 'claude-fable-5'],
    docsUrl: 'https://docs.claude.com/en/api',
    category: 'overseas',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiBase: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    apiKeyField: 'OPENROUTER_API_KEY',
    models: ['anthropic/claude-opus-4-8', 'openai/gpt-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-reasoner'],
    reasoningModels: [],
    docsUrl: 'https://openrouter.ai/docs',
    category: 'overseas',
  },
  {
    id: 'groq',
    name: 'Groq',
    apiBase: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    apiKeyField: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-4-scout', 'mixtral-8x7b-32768'],
    reasoningModels: [],
    docsUrl: 'https://console.groq.com/docs',
    category: 'overseas',
  },

  // ── 中转模板 2 ──
  {
    id: 'one-api',
    name: 'One-API 模板(自填 base)',
    apiBase: '',
    protocol: 'openai',
    apiKeyField: 'OPENAI_API_KEY',
    models: [],
    reasoningModels: [],
    docsUrl: 'https://github.com/songquanpeng/one-api',
    category: 'relay',
    isTemplate: true,
  },
  {
    id: 'new-api',
    name: 'New-API 模板(自填 base)',
    apiBase: '',
    protocol: 'openai',
    apiKeyField: 'OPENAI_API_KEY',
    models: [],
    reasoningModels: [],
    docsUrl: 'https://github.com/QuantumNous/new-api',
    category: 'relay',
    isTemplate: true,
  },
];

const PRESET_CATEGORIES = [
  { id: 'domestic', label: '国内' },
  { id: 'overseas', label: '海外' },
  { id: 'relay', label: '中转模板' },
];

function getPreset(id) {
  return PROVIDER_PRESETS.find(p => p.id === id) || null;
}

function getAllPresets() {
  return PROVIDER_PRESETS;
}

function getPresetsByCategory(category) {
  return PROVIDER_PRESETS.filter(p => p.category === category);
}

module.exports = {
  PROVIDER_PRESETS,
  PRESET_CATEGORIES,
  getPreset,
  getAllPresets,
  getPresetsByCategory,
};
