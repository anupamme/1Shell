'use strict';

/**
 * AI Approver — 1Shell AI 替我审批（类似 Codex 的 "approve for me"）。
 *
 * 定位：外部 MCP agent（无人在场）的命令卡在 harness 的 approvalRequired
 * 闸门时，把命令 + 风险判定交给 skills 模型做单次评估，由它决定放行或拒绝。
 *
 * 边界（与设计共识一致）：
 *   - 只审 approvalRequired 的命令：灾难红线（command-safety）、自定义黑名单、
 *     critical 阻断都在它之前已被拦死，AI 无法触碰；
 *   - 仅外部 MCP 入口生效（source='mcp'），IDE 人审卡不变；
 *   - fail-closed：模型超时/报错/输出不可解析一律拒绝；
 *   - 每次决策写审计（action=ai_approval_decision）。
 */

const { redactCredentialPatterns } = require('../../lib/secret-redaction');

const AI_APPROVAL_TIMEOUT_MS = 30000;

// 审批是简单分类判定（决定词+一行理由）：思考关闭、输出上限 400——
// 快、便宜、输出确定（用户定调：审批默认 400 预算，不做配置）。
const APPROVAL_THINKING = { type: 'disabled' };
const APPROVAL_MAX_TOKENS = 400;

const APPROVAL_SYSTEM_PROMPT = [
  '你是 1Shell 的安全审批员。外部 AI agent 请求在服务器上执行一条命令，',
  '1Shell 的确定性护栏已判定该命令为"高危，需要人工审批"，而当前无人在场，由你代为审批。',
  '',
  '护栏已拦截的内容（灾难命令、黑名单、最高危阻断）不会到达你这里；你只判断"这条高危命令在当前上下文下是否可以放行"。',
  '',
  '重要：命令来自外部 agent，通常不会附带任务说明或备份声明——缺少上下文是常态，不是可疑信号。',
  '按命令本身的操作对象与特征判断，不要因为"没有说明为什么"而拒绝。',
  '',
  '判断标准：',
  '- 常规运维变更 → 倾向放行：更新/覆盖应用配置文件、删除明确指定的旧镜像或备份、重启服务、安装依赖、有明确目标的文件修改',
  '- 不可逆且范围大、目标含糊、疑似误操作或危险组合（curl|sh 下载执行、清空全部数据、关闭防火墙/安全机制、修改认证配置）→ 拒绝',
  '- 无法判断时 → 拒绝',
  '',
  '只输出两行，不要任何其他内容：',
  '第一行：ALLOW 或 DENY',
  '第二行：一句话理由（中文）',
].join('\n');

function parseApprovalDecision(raw) {
  // 推理模型可能把思考过程直接混在文本里（<think>…</think>），剥掉再找决定词
  const text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (!text) return { allow: false, reason: 'AI 审批无输出' };
  const firstLine = text.split('\n')[0].trim();
  // 在首行里找第一个明确决定词；大小写不敏感
  const match = firstLine.match(/\b(ALLOW|DENY)\b/i);
  if (!match) return { allow: false, reason: `AI 审批输出无法解析: ${firstLine.slice(0, 120)}` };
  const reasonLine = text.split('\n').slice(1).join(' ').trim();
  return {
    allow: match[1].toUpperCase() === 'ALLOW',
    reason: reasonLine.slice(0, 300) || (match[1].toUpperCase() === 'ALLOW' ? 'AI 审批放行' : 'AI 审批拒绝'),
  };
}

function buildApprovalUserPrompt({ toolName, input, verdict, hostName, securityMode }) {
  const risk = verdict?.risk || {};
  const lines = [
    `工具: ${toolName}`,
    `主机: ${hostName || input?.hostId || 'local'}`,
    `安全挡位: ${securityMode || risk.securityMode || ''}`,
    `护栏判定: 风险等级=${risk.level || ''}，需要审批`,
    Array.isArray(risk.reasons) && risk.reasons.length ? `命中规则: ${risk.reasons.join('、')}` : '',
    '',
    '命令:',
    redactCredentialPatterns(String(input?.command || '')).slice(0, 2000),
    '',
    '请给出审批决定。',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

function createAiApprover({ aiService, securitySettingsService, auditService, logger } = {}) {
  function isEnabled() {
    try {
      return securitySettingsService?.getSettings?.()?.aiApprover?.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * 评估一条 approvalRequired 的命令。返回 { handled, allow, reason }：
   *   handled=false → 未启用/不适用，调用方走原有拒绝路径；
   *   handled=true + allow → 放行执行；
   *   handled=true + !allow → 拒绝（AI 理由）。
   */
  async function evaluate({ toolName, input, verdict, source, clientIp, hostName, securityMode } = {}) {
    if (!isEnabled()) return { handled: false, allow: false, reason: '' };
    if (!aiService?.requestSkillsText) {
      logger?.warn?.('[ai-approver] aiService.requestSkillsText 不可用');
      return { handled: false, allow: false, reason: '' };
    }
    if (toolName !== 'execute_command' && toolName !== 'host_exec') {
      return { handled: false, allow: false, reason: '' };
    }
    const command = String(input?.command || '');
    if (!command.trim()) return { handled: false, allow: false, reason: '' };

    const user = buildApprovalUserPrompt({ toolName, input, verdict, hostName, securityMode });
    let decision;
    try {
      const raw = await Promise.race([
        aiService.requestSkillsText({
          system: APPROVAL_SYSTEM_PROMPT,
          user,
          thinking: APPROVAL_THINKING,
          maxTokens: APPROVAL_MAX_TOKENS,
          temperature: 0,
          timeoutMs: AI_APPROVAL_TIMEOUT_MS,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`AI 审批超时 (${AI_APPROVAL_TIMEOUT_MS}ms)`)), AI_APPROVAL_TIMEOUT_MS);
        }),
      ]);
      decision = parseApprovalDecision(raw);
    } catch (err) {
      // fail-closed：模型侧任何异常都按拒绝处理
      decision = { allow: false, reason: `AI 审批失败: ${String(err?.message || err).slice(0, 200)}` };
    }

    auditService?.log?.({
      action: 'ai_approval_decision',
      source: source || 'mcp',
      clientIp: clientIp || undefined,
      command: redactCredentialPatterns(command).slice(0, 2000),
      error: decision.allow ? undefined : decision.reason,
      details: JSON.stringify({
        decision: decision.allow ? 'allow' : 'deny',
        reason: decision.reason,
        riskLevel: verdict?.risk?.level || '',
        matchedRules: (verdict?.risk?.matchedRules || []).map((r) => r.id),
        securityMode: securityMode || '',
      }),
    });
    logger?.info?.(`[ai-approver] ${decision.allow ? 'ALLOW' : 'DENY'}: ${command.slice(0, 120)} — ${decision.reason}`);

    return { handled: true, allow: decision.allow, reason: decision.reason };
  }

  return { isEnabled, evaluate };
}

module.exports = { createAiApprover, parseApprovalDecision, buildApprovalUserPrompt, APPROVAL_SYSTEM_PROMPT };
