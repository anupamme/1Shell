'use strict';

const fetch = require('node-fetch');

const {
  ENV_API_BASE,
  ENV_API_KEY,
  ENV_MODEL,
} = require('../config/env');

const COMPLETION_PROMPTS = Object.freeze({
  chat: '你是智能输入补全引擎。根据前缀预测并补全内容。只返回补全部分，不重复前缀，不加解释，不超过两句话。',
  command: '你是 Linux Shell 专家。根据自然语言描述返回完整可执行命令，只返回命令本身，无解释，无 markdown。危险命令前加 # DANGER: 注释。',
  analyzeSelection: `你是终端输出诊断专家。用户在终端中选中了一段文本，请分析并返回如下 JSON（无任何额外字段，无 markdown 包裹）：
{
  "summary": "一句话摘要，说明选中内容是什么（命令输出/错误/普通文本）",
  "errorType": "若识别为错误返回分类，如 permission_denied / command_not_found / oom / network_error / syntax_error / other，否则返回 null",
  "fixSuggestion": "若有修复建议返回可执行命令字符串（仅命令本身），否则返回 null",
  "riskLevel": "若 fixSuggestion 非 null，返回 safe / caution / danger，否则返回 null"
}
规则：
- summary 必须是字符串，不超过 30 字。
- 若无法判断错误类型，errorType 返回 null。
- fixSuggestion 只返回单条命令，不加解释，不加 markdown，不带换行。
- riskLevel=danger 仅用于 rm -rf / dd / mkfs / shutdown 等破坏性命令。
- 只输出纯 JSON，不加任何注释或包裹。`,
});

const AI_PROVIDER_TIMEOUT_MS = 45000;
const SKILL_ADAPTATION_PROVIDER_TIMEOUT_MS = 120000;

function createAIService({ fetchImpl = fetch, skillsProxyUrl = '', proxyConfigStore = null, skillRegistry = null } = {}) {
  function resolveConfig() {
    let rawBase = `${ENV_API_BASE || ''}`;
    // 自动补 /v1 后缀（兼容 One-API / New-API 等中转站）
    if (rawBase && !/\/v1$/.test(rawBase)) {
      rawBase = rawBase.replace(/\/$/, '') + '/v1';
    }
    return {
      base: rawBase.replace(/\/$/, ''),
      key: ENV_API_KEY,
      model: ENV_MODEL,
    };
  }

  function isTransientProviderError(err) {
    const message = String(err?.message || err || '');
    return /Provider 返回 (429|500|502|503|504)|Gateway Time-out|gateway timeout|api_error|ECONNRESET|socket hang up|ETIMEDOUT|premature close/i.test(message);
  }

  function activeSkillsModel() {
    try {
      const provider = proxyConfigStore?.getActiveProvider?.('skills') || proxyConfigStore?.getActiveProvider?.('claude-code');
      return provider?.model || '';
    } catch {
      return '';
    }
  }

  function extractTextContent(content) {
    if (typeof content === 'string') {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
      .trim();
  }

  async function requestAnthropicMessage({ system, messages, maxTokens = 1200, model, temperature = 0.2, tools = [], retryCount = 2, timeoutMs = AI_PROVIDER_TIMEOUT_MS }) {
    if (!skillsProxyUrl) return null;
    let lastError = null;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const response = await fetchImpl(skillsProxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-20250514',
            max_tokens: maxTokens,
            stream: false,
            system,
            messages,
            temperature,
            ...(tools.length > 0 ? { tools } : {}),
          }),
          signal: ac.signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`Provider 返回 ${response.status}: ${errText.substring(0, 300)}`);
        }
        return response.json();
      } catch (err) {
        lastError = ac.signal.aborted
          ? new Error(`AI Provider 请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回`)
          : err;
        if (!isTransientProviderError(lastError) || attempt >= retryCount) throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('Provider 请求失败');
  }

  async function requestChatCompletionText({
    base,
    key,
    maxTokens,
    messages,
    model,
    retryCount = 2,
    temperature,
  }) {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          // 防止上游 socket 永久挂起占用连接
          timeout: 60000,
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: false,
          }),
        });

        if (!response.ok) {
          continue;
        }

        const data = await response.json();
        const message = data.choices?.[0]?.message || {};
        const text = extractTextContent(message.content);

        if (text) {
          return text;
        }

        if (message.content == null && attempt + 1 < retryCount) {
          continue;
        }

        return '';
      } catch {
        if (attempt + 1 >= retryCount) {
          return '';
        }
      }
    }

    return '';
  }

  async function requestCompletion(body = {}) {
    const prefix = String(body.prefix || '');
    if (prefix.trim().length < 3) return '';

    const mode = body.mode || 'chat';
    const { base, key, model } = resolveConfig(body);

    const request = async () => {
      return requestChatCompletionText({
        base,
        key,
        model,
        messages: [
          { role: 'system', content: COMPLETION_PROMPTS[mode] || COMPLETION_PROMPTS.chat },
          { role: 'user', content: prefix },
        ],
        maxTokens: 120,
        temperature: 0.2,
      });
    };

    return Promise.race([
      request(),
      new Promise((resolve) => {
        setTimeout(() => resolve(''), 6000);
      }),
    ]);
  }

  const VALID_RISK_LEVELS = new Set(['safe', 'caution', 'danger']);
  const VALID_ERROR_TYPES = new Set([
    'permission_denied', 'command_not_found', 'oom', 'network_error', 'syntax_error', 'other',
  ]);

  function parseAnalyzeSelectionResponse(raw) {
    const fallback = {
      summary: '无法解析分析结果',
      errorType: null,
      fixSuggestion: null,
      riskLevel: null,
    };

    if (!raw) return fallback;

    try {
      const jsonText = raw
        .replace(/^```(?:json)?\s*/u, '')
        .replace(/\s*```$/u, '')
        .trim();
      const parsed = JSON.parse(jsonText);

      const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 60)
        : '无摘要';

      const errorType = typeof parsed.errorType === 'string' && VALID_ERROR_TYPES.has(parsed.errorType)
        ? parsed.errorType
        : null;

      const fixSuggestion = typeof parsed.fixSuggestion === 'string' && parsed.fixSuggestion.trim()
        ? parsed.fixSuggestion.trim().split('\n')[0].trim()
        : null;

      const riskLevel = fixSuggestion && typeof parsed.riskLevel === 'string' && VALID_RISK_LEVELS.has(parsed.riskLevel)
        ? parsed.riskLevel
        : (fixSuggestion ? 'caution' : null);

      return { summary, errorType, fixSuggestion, riskLevel };
    } catch {
      return fallback;
    }
  }

  async function analyzeSelection(body = {}) {
    const selectedText = String(body.selectedText || '').trim();
    if (!selectedText) {
      return { summary: '选区为空', errorType: null, fixSuggestion: null, riskLevel: null };
    }

    const shellType = String(body.shellType || 'bash').trim() || 'bash';
    const platform = String(body.platform || '').trim();
    const recentCommands = Array.isArray(body.recentCommands)
      ? body.recentCommands.filter((item) => typeof item === 'string' && item.trim()).slice(-3).map((item) => item.slice(0, 200))
      : [];
    const { base, key, model } = resolveConfig(body);

    const contextLines = [
      `shellType: ${shellType}`,
      platform ? `platform: ${platform}` : '',
      recentCommands.length ? `recentCommands: ${recentCommands.join(' | ')}` : '',
      `selectedText:\n${selectedText.slice(0, 2000)}`,
    ].filter(Boolean).join('\n');

    const request = async () => {
      const raw = await requestChatCompletionText({
        base,
        key,
        model,
        messages: [
          { role: 'system', content: COMPLETION_PROMPTS.analyzeSelection },
          { role: 'user', content: contextLines },
        ],
        maxTokens: 300,
        temperature: 0.1,
        retryCount: 2,
      });
      return parseAnalyzeSelectionResponse(raw);
    };

    return Promise.race([
      request(),
      new Promise((resolve) => {
        setTimeout(() => resolve({
          summary: '分析超时',
          errorType: null,
          fixSuggestion: null,
          riskLevel: null,
        }), 10000);
      }),
    ]);
  }

  async function requestSkillAdaptation(body = {}) {
    const source = String(body.source || '').trim();
    if (!source) throw new Error('source 不能为空');
    const system = `你是 1Shell Skill 适配器。把 GitHub 仓库里的外部 Skill 改写成 1Shell AI 可用的原生 Skill 草稿。\n\n要求：\n- 1Shell AI 是运维/自动化 agent，不是 coding agent。\n- 只保留适合 1Shell AI 的目标、流程、约束、输入、验收和安全边界。\n- 删除或改写外部 agent 专属概念：hooks、slash commands、subagents、worktree、Read/Edit/Bash 工具名、CLAUDE_PLUGIN_ROOT、SessionStart、Claude Code 插件生命周期。\n- 如果源 Skill 是重型 coding-agent skill，不要硬转；recommended=false，并说明更适合暴露给对应原生 coding agent。\n- 返回纯 JSON，不加 markdown。\n\nJSON 格式：\n{\n  "recommended": true,\n  "targetId": "kebab-case-id",\n  "name": "中文或英文名称",\n  "description": "一句话描述",\n  "compatibility": "high|medium|low|not_recommended",\n  "warnings": ["风险或限制"],\n  "report": "转换说明",\n  "files": [\n    {"path":"SKILL.md","content":"完整文件内容"},\n    {"path":"rules/constraints.md","content":"可选"}\n  ]\n}`;
    const messages = [{ role: 'user', content: source.slice(0, 50000) }];
    const skillModel = activeSkillsModel() || ENV_MODEL;

    if (skillsProxyUrl) {
      const data = await requestAnthropicMessage({
        system,
        messages,
        maxTokens: 7000,
        model: skillModel,
        temperature: 0.2,
        retryCount: 1,
        timeoutMs: SKILL_ADAPTATION_PROVIDER_TIMEOUT_MS,
      });
      const text = extractTextContent(data?.content);
      if (!text) throw new Error('AI 未返回有效转换结果');
      return text;
    }

    const { base, key, model } = resolveConfig(body);
    const text = await requestChatCompletionText({
      base,
      key,
      model: skillModel || model,
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      maxTokens: 7000,
      temperature: 0.2,
      retryCount: 1,
    });
    if (!text) throw new Error('AI 未返回有效转换结果');
    return text;
  }

  return {
    requestSkillAdaptation,
    requestCompletion,
    analyzeSelection,
  };
}

module.exports = {
  createAIService,
};
