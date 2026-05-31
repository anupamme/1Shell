'use strict';

const fetch = require('node-fetch');
const { validateChatMessages } = require('../utils/validators');

const {
  ENV_API_BASE,
  ENV_API_KEY,
  ENV_MODEL,
} = require('../config/env');

const COMPLETION_PROMPTS = Object.freeze({
  chat: '你是智能输入补全引擎。根据前缀预测并补全内容。只返回补全部分，不重复前缀，不加解释，不超过两句话。',
  command: '你是 Linux Shell 专家。根据自然语言描述返回完整可执行命令，只返回命令本身，无解释，无 markdown。危险命令前加 # DANGER: 注释。',
  terminalInline: '你是终端命令行内联补全引擎。用户正在 shell 中输入命令或参数。只返回当前光标后需要追加的补全文本（不含已有输入），不加解释，不换行，不加 markdown，不返回多条候选。补全应优先考虑常见 CLI 命令名（如 curl、grep、docker 等）或合法参数，而不是普通英文单词。若输入已是完整命令或不适合补全则返回空字符串。',
  generateScript: `你是 Linux 运维脚本专家。用户描述一个运维目标，你生成一个可复用的参数化 Bash 脚本。
返回纯 JSON（不加 markdown 包裹），格式如下：
{
  "name": "脚本名称（中文，简短）",
  "icon": "一个 emoji 图标",
  "category": "system|docker|network|backup|security|other",
  "tags": ["标签1", "标签2"],
  "riskLevel": "safe|confirm|danger",
  "description": "一段描述，说明脚本的用途（30 字以内）",
  "content": "#!/bin/bash\\nset -e\\n# 脚本内容，使用 {{变量名}} 作为参数占位符",
  "parameters": [
    {"name": "变量名", "type": "string|number|boolean|select", "label": "参数显示名", "required": true, "default": "默认值"}
  ]
}
规则：
- content 中的参数一律用 {{name}} 形式引用，不要用 $1 或 $VAR 形式。
- content 中不要出现 \`\`\` 代码块标记。
- 脚本开头加 set -e，写好注释。
- 若涉及 rm -rf / shutdown / reboot 等操作，riskLevel 设为 danger。
- 若涉及 restart / stop 等操作，riskLevel 设为 confirm。
- 只输出纯 JSON，不加任何注释、markdown 或额外文字。`,
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

const INLINE_COMPLETION_TIMEOUT_MS = 7000;
const PROGRAM_WORKFLOW_PROVIDER_TIMEOUT_MS = 45000;
const PROGRAM_WORKFLOW_FINAL_PROVIDER_TIMEOUT_MS = 120000;

function createAIService({ fetchImpl = fetch, skillsProxyUrl = '', proxyConfigStore = null, skillRegistry = null } = {}) {
  function resolveConfig(body = {}) {
    let rawBase = (body.apiBase || ENV_API_BASE) + '';
    // 自动补 /v1 后缀（兼容 One-API / New-API 等中转站）
    if (rawBase && !/\/v1$/.test(rawBase)) {
      rawBase = rawBase.replace(/\/$/, '') + '/v1';
    }
    return {
      base: rawBase.replace(/\/$/, ''),
      key: body.apiKey || ENV_API_KEY,
      model: body.model || ENV_MODEL,
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

  async function requestAnthropicMessage({ system, messages, maxTokens = 1200, model, temperature = 0.2, tools = [], retryCount = 2, timeoutMs = PROGRAM_WORKFLOW_PROVIDER_TIMEOUT_MS }) {
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

  async function createChatUpstream(body = {}) {
    validateChatMessages(body.messages);
    const { base, key, model } = resolveConfig(body);
    return fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        stream: true,
      }),
    });
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

  async function requestTerminalInlineCompletion(body = {}) {
    const currentInput = String(body.currentInput || '');
    const cursorIndex = Number.isInteger(body.cursorIndex) ? body.cursorIndex : currentInput.length;
    const inputPrefix = currentInput.slice(0, cursorIndex);
    if (inputPrefix.trim().length < 3) {
      return {
        requestId: '',
        completion: '',
        confidence: 'low',
      };
    }

    const shellType = String(body.shellType || 'bash').trim() || 'bash';
    const platform = String(body.platform || '').trim();
    const cwd = String(body.cwd || '').trim();
    const recentCommands = Array.isArray(body.recentCommands)
      ? body.recentCommands.filter((item) => typeof item === 'string' && item.trim()).slice(-3).map((item) => item.slice(0, 200))
      : [];
    const { base, key, model } = resolveConfig(body);

    const prompt = [
      `shellType: ${shellType}`,
      platform ? `platform: ${platform}` : '',
      cwd ? `cwd: ${cwd}` : '',
      recentCommands.length ? `recentCommands: ${recentCommands.join(' | ')}` : '',
      `currentInput: ${inputPrefix}`,
    ].filter(Boolean).join('\n');

    const request = async () => {
      const raw = await requestChatCompletionText({
        base,
        key,
        model,
        messages: [
          { role: 'system', content: COMPLETION_PROMPTS.terminalInline },
          { role: 'user', content: prompt },
        ],
        maxTokens: 80,
        temperature: 0.15,
      });
      const completion = sanitizeInlineCompletion(raw, inputPrefix);
      return {
        requestId: createRequestId(),
        completion,
        confidence: completion ? classifyInlineConfidence(completion, inputPrefix) : 'low',
      };
    };

    return Promise.race([
      request(),
      new Promise((resolve) => {
        setTimeout(() => resolve({
          requestId: '',
          completion: '',
          confidence: 'low',
        }), INLINE_COMPLETION_TIMEOUT_MS);
      }),
    ]);
  }
  function classifyInlineConfidence(completion, inputPrefix) {
    if (!completion) return 'low';

    const completionText = String(completion);
    const prefixText = String(inputPrefix || '');
    if (completionText.length <= 4) return 'high';
    if (/^[\w./-]+$/u.test(completionText) && prefixText.trim()) return 'high';
    if (completionText.includes(' --') || completionText.includes(' -')) return 'medium';
    return 'medium';
  }

  function sanitizeInlineCompletion(raw, inputPrefix) {
    if (!raw) return '';

    let text = String(raw)
      .replace(/\r/g, '')
      .replace(/^```[\w-]*\s*/u, '')
      .replace(/\s*```$/u, '')
      .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '')
      .split('\n')[0]
      .replace(/\s+$/u, '');

    if (!text.trim()) return '';
    if (text.startsWith(inputPrefix)) {
      text = text.slice(inputPrefix.length);
    }

    text = text
      .replace(/^[:：\-\s]+/u, '')
      .replace(/[。；;，,]+$/u, '')
      .replace(/\s{2,}/gu, ' ');

    if (!text.trim() || /[`]/.test(text)) return '';
    if (/^(补全|建议|command|completion)[:：]/iu.test(text)) return '';
    return text;
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

  function createRequestId() {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async function fetchModelList(body = {}) {
    const { base, key } = resolveConfig(body);
    const paths = ['/models', '/models'];
    for (const p of paths) {
      try {
        const res = await fetchImpl(`${base}${p}`, {
          headers: { Authorization: `Bearer ${key}` },
          timeout: 8000,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.data && Array.isArray(data.data)) {
            return data.data.map((m) => m.id).filter(Boolean);
          }
        }
      } catch { /* try next */ }
    }
    return [];
  }

  async function requestProgramWorkflowStep(body = {}) {
    const { base, key, model } = resolveConfig(body);
    const program = body.program && typeof body.program === 'object' ? body.program : {};
    const step = body.step && typeof body.step === 'object' ? body.step : {};
    const host = body.host && typeof body.host === 'object' ? body.host : {};
    const inputs = body.inputs && typeof body.inputs === 'object' ? body.inputs : {};
    const previousResults = Array.isArray(body.previousResults) ? body.previousResults : [];

    const userPayload = JSON.stringify({
      program: {
        id: program.id,
        name: program.name,
        description: program.description,
      },
      host: {
        id: host.id,
        name: host.name,
        ...(host.platform ? { platform: host.platform } : {}),
      },
      inputs,
      step: {
        id: step.id,
        label: step.label,
        goal: step.goal,
        result: step.result,
      },
      previousResults,
    }, null, 2);

    const FALLBACK_SYSTEM_PROMPT = '你是 1Shell AI 工作流 Program 的运行时 AI。你正在像真正 agent 一样连续完成当前步骤。进入重要阶段时先调用 report_phase 上报抽象进度；需要查看或修改目标主机时，使用 execute_command 工具。对于诊断、巡检、审计、报告类任务，必须在每个关键阶段后调用 update_result 更新右侧报告草稿；命令输出只保留关键证据，不要把大段原始日志交给最后一次调用总结。最终调用 publish_result 或 update_result(final=true) 完成报告。';
    const callerSystemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
    const systemPrompt = callerSystemPrompt || FALLBACK_SYSTEM_PROMPT;
    const executeCommand = typeof body.executeCommand === 'function' ? body.executeCommand : null;
    const reportPhase = typeof body.reportPhase === 'function' ? body.reportPhase : null;
    const updateResult = typeof body.updateResult === 'function' ? body.updateResult : null;
    const workflowModel = body.model || activeSkillsModel() || model;
    const incrementalResultExpected = isDirectFinalResultProgram(program, step);

    if (skillsProxyUrl && executeCommand) {
      const messages = [{ role: 'user', content: userPayload }];
      let commandResultCount = 0;
      const tools = [{
        name: 'execute_command',
        description: '在当前 Program 目标主机上执行 shell 命令，用于完成当前抽象 AI 工作流步骤。',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            timeout: { type: 'number', description: '超时时间，毫秒' },
            final_result: { type: 'boolean', description: '如果该命令 stdout 已经是最终用户报告，设为 true；1Shell 会直接把 stdout 作为 Program 结果，不再请求 AI 二次总结' },
          },
          required: ['command'],
        },
      }, {
        name: 'report_phase',
        description: '上报当前任务的抽象阶段进度，只用于 UI 进度卡片，不要包含命令日志或长文本。',
        input_schema: {
          type: 'object',
          properties: {
            phase: { type: 'string', description: '阶段 ID，例如 env_check、repo_analysis、deploy_plan、build_install、start_service、healthcheck' },
            status: { type: 'string', description: 'running、done 或 failed' },
            message: { type: 'string', description: '给用户看的短状态，不超过 40 字' },
          },
          required: ['phase'],
        },
      }, {
        name: 'update_result',
        description: '增量更新 Program 页面右侧结果草稿。诊断、巡检、审计、报告类任务必须在每个关键阶段后调用，避免最后一次性总结导致超时。',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '结果标题' },
            status: { type: 'string', description: 'running、success、warning、failed、blocked 或其他业务状态' },
            report: { type: 'string', description: '当前已经形成的用户可读报告草稿；只写结论和关键证据，不贴大段原始日志' },
            final: { type: 'boolean', description: '如果这是最终报告，设为 true' },
          },
          required: ['report'],
        },
      }, {
        name: 'publish_result',
        description: '提交当前 Program 步骤的最终用户可读结果。拿到足够证据后调用它，或用 update_result(final=true) 完成报告。',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '结果标题' },
            status: { type: 'string', description: 'success、warning、failed、blocked 或其他业务状态' },
            summary: { type: 'array', items: { type: 'string' }, description: '3-6 条核心结论' },
            report: { type: 'string', description: '完整中文排版报告，包含结论、证据、风险和下一步建议' },
            data: { type: 'object', description: '可选结构化结果数据' },
          },
          required: ['report'],
        },
      }];
      for (let turn = 0; turn < 30; turn += 1) {
        const data = await requestAnthropicMessage({
          system: systemPrompt,
          messages,
          maxTokens: 4096,
          model: workflowModel,
          temperature: 0.2,
          tools,
          retryCount: 0,
          timeoutMs: PROGRAM_WORKFLOW_FINAL_PROVIDER_TIMEOUT_MS,
        });
        const content = Array.isArray(data?.content) ? data.content : [];
        messages.push({ role: 'assistant', content });
        const toolUses = content.filter((item) => item?.type === 'tool_use');
        if (toolUses.length === 0 || data.stop_reason === 'end_turn') {
          const text = extractTextContent(content);
          if (!text) throw new Error('AI 未返回有效内容，请检查 Provider 配置或上游状态');
          if (updateResult && incrementalResultExpected) await updateResult({
            title: program.name || step.label,
            status: 'success',
            content: text,
            final: true,
          });
          return { text };
        }
        const published = toolUses.find((item) => item.name === 'publish_result');
        if (published) {
          const text = formatPublishedProgramResult(published.input);
          if (updateResult) await updateResult({
            title: published.input?.title,
            status: published.input?.status || 'success',
            content: text,
            final: true,
          });
          return { text };
        }

        const toolResults = [];
        for (const toolUse of toolUses) {
          const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
          try {
            if (toolUse.name === 'report_phase') {
              if (reportPhase) await reportPhase({
                phase: String(input.phase || ''),
                status: String(input.status || 'running'),
                message: String(input.message || '').slice(0, 80),
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: 'phase reported',
              });
              continue;
            }
            if (toolUse.name === 'update_result') {
              const text = String(input.report || input.content || '').trim();
              if (updateResult && text) await updateResult({
                title: input.title || program.name || step.label,
                status: input.status || (input.final === true ? 'success' : 'running'),
                content: text,
                final: input.final === true,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: input.final === true ? 'final result updated' : 'result draft updated',
              });
              if (input.final === true && text) return { text };
              continue;
            }
            if (toolUse.name === 'publish_result') {
              const text = formatPublishedProgramResult(input);
              if (updateResult) await updateResult({
                title: input.title || program.name || step.label,
                status: input.status || 'success',
                content: text,
                final: true,
              });
              return { text };
            }
            if (toolUse.name === 'execute_command') {
              const result = await executeCommand({
                command: String(input.command || ''),
                timeout: Number(input.timeout) > 0 ? Number(input.timeout) : undefined,
                finalResult: input.final_result === true,
              });
              commandResultCount += 1;
              if (input.final_result === true) return { text: result.content };
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: result.content,
                ...(result.is_error ? { is_error: true } : {}),
              });
              continue;
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `[ERROR] unknown tool: ${toolUse.name}`,
              is_error: true,
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `[ERROR] ${err.message}`,
              is_error: true,
            });
          }
        }
        messages.push({ role: 'user', content: toolResults });
      }
      throw new Error('AI 步骤执行轮次过多，已停止');
    }

    const text = await requestChatCompletionText({
      base,
      key,
      model: workflowModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPayload },
      ],
      maxTokens: 1200,
      temperature: 0.2,
      retryCount: 2,
    });

    if (!text) {
      throw new Error('AI 未返回有效内容，请检查 Provider 配置或上游状态');
    }
    return { text };
  }

  function isDirectFinalResultProgram(program, step) {
    const text = [
      program?.id,
      program?.name,
      program?.description,
      step?.id,
      step?.label,
      step?.goal,
      step?.result,
    ].map((item) => String(item || '')).join('\n');
    return /诊断|巡检|审计|报告|状态|资源|监控|健康|check|health|status|diagnos|audit|report|advisor/i.test(text);
  }

  function formatPublishedProgramResult(input) {
    const data = input && typeof input === 'object' ? input : {};
    const report = String(data.report || data.final_report || data.content || '').trim();
    if (!report) return JSON.stringify(data, null, 2);
    const title = String(data.title || '').trim();
    const status = String(data.status || '').trim();
    const summary = Array.isArray(data.summary) ? data.summary.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const parts = [];
    if (title && !report.startsWith('#')) parts.push(`# ${title}`);
    if (status) parts.push(`状态：${status}`);
    if (summary.length > 0) parts.push(['## 核心结论', ...summary.map((item) => `- ${item}`)].join('\n'));
    parts.push(report);
    return parts.filter(Boolean).join('\n\n');
  }

  async function requestProgramAuthoring() {
    throw new Error('requestProgramAuthoring 已移除：program 创作直接用 Studio 链路');
  }

  async function requestSkillAdaptation(body = {}) {
    const source = String(body.source || '').trim();
    if (!source) throw new Error('source 不能为空');
    const system = `你是 1Shell Skill 适配器。把 Claude Code Skill 改写成 1Shell AI 可用的原生 Skill 草稿。\n\n要求：\n- 1Shell AI 是运维/自动化 agent，不是 Claude Code coding agent。\n- 只保留适合 1Shell AI 的目标、流程、约束、输入、验收和安全边界。\n- 删除或改写 Claude Code 专属概念：hooks、slash commands、subagents、worktree、Read/Edit/Bash 工具名、CLAUDE_PLUGIN_ROOT、SessionStart、Claude Code 插件生命周期。\n- 如果源 Skill 是重型 coding-agent skill，不要硬转；recommended=false，并说明应该给内部 Claude Code 使用。\n- 返回纯 JSON，不加 markdown。\n\nJSON 格式：\n{\n  "recommended": true,\n  "targetId": "kebab-case-id",\n  "name": "中文或英文名称",\n  "description": "一句话描述",\n  "compatibility": "high|medium|low|not_recommended",\n  "warnings": ["风险或限制"],\n  "report": "转换说明",\n  "files": [\n    {"path":"SKILL.md","content":"完整文件内容"},\n    {"path":"rules/constraints.md","content":"可选"}\n  ]\n}`;
    const messages = [{ role: 'user', content: source.slice(0, 50000) }];
    const workflowModel = activeSkillsModel() || ENV_MODEL;

    if (skillsProxyUrl) {
      const data = await requestAnthropicMessage({
        system,
        messages,
        maxTokens: 7000,
        model: workflowModel,
        temperature: 0.2,
        retryCount: 1,
        timeoutMs: PROGRAM_WORKFLOW_FINAL_PROVIDER_TIMEOUT_MS,
      });
      const text = extractTextContent(data?.content);
      if (!text) throw new Error('AI 未返回有效转换结果');
      return text;
    }

    const { base, key, model } = resolveConfig(body);
    const text = await requestChatCompletionText({
      base,
      key,
      model: workflowModel || model,
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

  async function generateScript(body = {}) {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      return { error: '请描述你想要的脚本' };
    }

    const { base, key, model } = resolveConfig(body);

    const raw = await requestChatCompletionText({
      base,
      key,
      model,
      messages: [
        { role: 'system', content: COMPLETION_PROMPTS.generateScript },
        { role: 'user', content: prompt },
      ],
      maxTokens: 2000,
      temperature: 0.3,
      retryCount: 2,
    });

    if (!raw) {
      return { error: 'AI 未返回有效内容，请检查 API 配置或重试' };
    }

    try {
      const jsonText = raw
        .replace(/^```(?:json)?\s*/u, '')
        .replace(/\s*```$/u, '')
        .trim();
      const parsed = JSON.parse(jsonText);

      // 基本校验
      if (!parsed.name || !parsed.content) {
        return { error: 'AI 返回的脚本结构不完整，请重试' };
      }

      return {
        script: {
          name: String(parsed.name).slice(0, 120),
          icon: String(parsed.icon || '📜').slice(0, 4),
          category: ['system', 'docker', 'network', 'backup', 'security', 'other'].includes(parsed.category) ? parsed.category : 'other',
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 10) : [],
          riskLevel: ['safe', 'confirm', 'danger'].includes(parsed.riskLevel) ? parsed.riskLevel : 'safe',
          description: String(parsed.description || '').slice(0, 2000),
          content: String(parsed.content),
          parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
        },
      };
    } catch {
      return { error: 'AI 返回的 JSON 格式异常，请重试' };
    }
  }

  return {
    createChatUpstream,
    fetchModelList,
    generateScript,
    requestProgramWorkflowStep,
    requestProgramAuthoring,
    requestSkillAdaptation,
    requestCompletion,
    requestTerminalInlineCompletion,
    analyzeSelection,
  };
}

module.exports = {
  createAIService,
};
