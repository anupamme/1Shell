'use strict';

/**
 * Harness Guard — 确定性护栏聚合。
 *
 * 三件事，全部确定性（不调 LLM）：
 *   1. capability 准入（最小授权）—— checkCapabilities
 *   2. 灾难命令拦截（红线兜底）—— 复用 command-safety.assessCommandRisk
 *   3. 高风险操作规则库 —— chmod/rm/curl|sh/防火墙/系统安全机制等中高危参数识别
 *
 * 返回约定（见 HARNESS_DESIGN.md §7）：
 *   - { allow: false, reason }                    → 直接拦截，命令不发出
 *   - { allow: true, needApproval, summary, approval } → 放行，但可能必须人审
 */

const { assessCommandRisk } = require('../ai/command-safety');
const { checkCapabilities } = require('./capabilities');
const { classifyCommandRisk, assessMediumRisk, COMMAND_RISK_RULES } = require('./risk-rules');

function commandHasTruncationMarker(command) {
  const text = String(command || '');
  return text.includes('\u2026') || /\[truncated(?:\s+\d+\s+chars)?\]/i.test(text);
}

// 写类工具默认建议人审（人在场时）
const WRITE_TOOLS_NEEDING_APPROVAL = new Set([
  'write_remote_file', 'create_directory', 'delete_path', 'rename_path',
  'upload_file', 'download_file', 'deploy_local_mcp',
  'add_mcp_server', 'remove_mcp_server', 'install_probe_agent',
  'restart_probe_agent', 'uninstall_probe_agent', 'run_script',
  'save_script',
]);

function summarize(toolName, input) {
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const command = String(input.command || '');
    return {
      title: '执行命令',
      detail: `主机: ${input.hostId || 'local'}\n命令: ${command.slice(0, 300)}`,
      actionKind: 'command',
      actionText: command,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'write_remote_file') {
    return {
      title: '写入远程文件',
      detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
      actionKind: 'file_write',
      actionText: [
        'write_remote_file',
        `hostId: ${input.hostId || 'local'}`,
        `path: ${input.path || ''}`,
        `contentLength: ${String(input.content || '').length}`,
      ].join('\n'),
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'create_directory') {
    return {
      title: '创建目录',
      detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
      actionKind: 'file_change',
      actionText: `mkdir ${input.path || ''}`,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'delete_path') {
    return {
      title: '删除文件/目录',
      detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
      actionKind: 'file_delete',
      actionText: `delete_path ${input.path || ''}`,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'rename_path') {
    return {
      title: '重命名/移动',
      detail: `主机: ${input.hostId || 'local'}\n原路径: ${input.path || ''}\n新路径: ${input.newPath || ''}`,
      actionKind: 'file_change',
      actionText: `rename_path ${input.path || ''} -> ${input.newPath || ''}`,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'upload_file') {
    return {
      title: '上传文件',
      detail: `主机: ${input.hostId || 'local'}\n目标目录: ${input.dirPath || ''}\n文件名: ${input.filename || ''}`,
      actionKind: 'file_transfer',
      actionText: `upload_file ${input.filename || ''} -> ${input.hostId || 'local'}:${input.dirPath || ''}`,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'download_file') {
    return {
      title: '下载文件',
      detail: `主机: ${input.hostId || 'local'}\n源路径: ${input.path || ''}\n本地路径: ${input.localPath || ''}`,
      actionKind: 'file_transfer',
      actionText: `download_file ${input.hostId || 'local'}:${input.path || ''} -> ${input.localPath || '(return content)'}`,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'run_script') {
    return {
      title: '运行脚本',
      detail: `主机: ${input.hostId || 'local'}\n脚本: ${input.scriptId || input.name || ''}`,
      actionKind: 'script',
      actionText: `run_script ${input.scriptId || input.name || ''}`,
      hostId: input.hostId || 'local',
    };
  }
  if (toolName === 'save_script') {
    // 审批这张卡的人要判断的是"这段以后会在主机上跑的正文该不该入库"，
    // 所以直接贴正文；不贴的话会落到下面的 JSON fallback，转义后不可读。
    // 不返回 hostId：这是与主机无关的库内写操作。
    const isUpdate = Boolean(String(input.id || '').trim());
    const content = String(input.content || '');
    return {
      title: isUpdate ? '覆盖脚本' : '新建脚本',
      detail: [
        `脚本: ${input.name || ''}`,
        isUpdate ? `覆盖 ID: ${input.id}` : '（新建）',
        `正文长度: ${content.length}`,
      ].join('\n'),
      actionKind: 'script',
      actionText: [
        `save_script ${isUpdate ? `id=${input.id}` : '(new)'} name=${input.name || ''}`,
        '',
        content.slice(0, 800),
        content.length > 800 ? `…[truncated ${content.length - 800} chars]` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    title: toolName,
    detail: JSON.stringify(input || {}, null, 2).slice(0, 600),
    actionKind: 'tool',
    actionText: `${toolName}\n${JSON.stringify(input || {}, null, 2).slice(0, 1200)}`,
    hostId: input.hostId || 'local',
  };
}

function formatRiskReason(verdict) {
  if (!verdict?.risky) return '';
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.filter(Boolean) : [];
  const mode = verdict.securityMode ? `安全档位=${verdict.securityMode}` : '';
  const level = verdict.level ? `风险等级=${verdict.level}` : '';
  return [reasons.join('、'), level, mode].filter(Boolean).join('；');
}

function riskLevelForApproval(risk, riskReason, toolName) {
  const level = String(risk?.level || '').trim().toLowerCase();
  if (level) return level;
  if (WRITE_TOOLS_NEEDING_APPROVAL.has(toolName)) return 'medium';
  return riskReason ? 'medium' : 'low';
}

function compactRisk(risk) {
  if (!risk || typeof risk !== 'object') return null;
  return {
    risky: risk.risky === true,
    level: String(risk.level || ''),
    action: String(risk.action || ''),
    reasons: Array.isArray(risk.reasons) ? risk.reasons.map(String).filter(Boolean).slice(0, 8) : [],
    matchedRules: Array.isArray(risk.matchedRules)
      ? risk.matchedRules.slice(0, 8).map((rule) => ({
        id: String(rule.id || ''),
        level: String(rule.level || ''),
        label: String(rule.label || ''),
      }))
      : [],
    securityMode: String(risk.securityMode || ''),
  };
}

function createApprovalFacts(toolName, input, { summary, needApproval, approvalRequired, riskReason, risk, context } = {}) {
  const normalizedSummary = summary || summarize(toolName, input || {});
  const required = approvalRequired === true;
  const reason = riskReason
    ? `harness 判断需要人工确认：${riskReason}`
    : (required ? 'harness 判断该操作必须人工确认。' : 'harness 判断这是会改变系统状态的操作，建议先确认。');
  return {
    schemaVersion: 1,
    source: 'harness',
    toolName,
    title: normalizedSummary.title || toolName,
    reason,
    riskReason: riskReason || '',
    riskLevel: riskLevelForApproval(risk, riskReason, toolName),
    required,
    recommended: needApproval === true && !required,
    actionKind: normalizedSummary.actionKind || 'tool',
    actionText: String(normalizedSummary.actionText || normalizedSummary.detail || ''),
    detail: String(normalizedSummary.detail || ''),
    hostId: String(normalizedSummary.hostId || input?.hostId || context?.hostId || 'local'),
    summary: {
      title: normalizedSummary.title || toolName,
      detail: String(normalizedSummary.detail || ''),
    },
    risk: compactRisk(risk),
  };
}

function checkHostScope(input = {}, context = {}) {
  const hostScope = context.hostScope;
  if (hostScope === undefined) return { allow: true };

  const requestedHostId = String(input.hostId || context.hostId || 'local').trim() || 'local';
  const currentHostId = String(context.hostId || 'local').trim() || 'local';
  if (hostScope === 'current') {
    return requestedHostId === currentHostId
      ? { allow: true }
      : { allow: false, reason: `目标主机 ${requestedHostId} 超出当前主机范围 ${currentHostId}` };
  }

  if (Array.isArray(hostScope)) {
    const allowed = hostScope.map((item) => String(item).trim()).filter(Boolean);
    if (allowed.length === 0) return { allow: false, reason: `目标主机 ${requestedHostId} 未被授权` };
    return allowed.includes(requestedHostId)
      ? { allow: true }
      : { allow: false, reason: `目标主机 ${requestedHostId} 不在授权范围 [${allowed.join(', ')}] 内` };
  }

  return { allow: false, reason: `hostScope 配置非法：${String(hostScope)}` };
}

/**
 * @param {string} toolName
 * @param {object} input
 * @param {object} context  - 至少含 { capabilities }
 * @returns {{ allow:boolean, reason?:string, needApproval?:boolean, approvalRequired?:boolean, summary?:object, riskReason?:string, risk?:object }}
 */
function check(toolName, input, context = {}) {
  const command = String(input?.command || '');

  // ── 0. 主机范围准入：防止 input.hostId 覆盖 context.hostId 越权 ───────
  const hostVerdict = checkHostScope(input || {}, context);
  if (!hostVerdict.allow) {
    return { allow: false, reason: hostVerdict.reason };
  }

  // ── 1. capability 准入（最小授权）──────────────────────────────
  const capVerdict = checkCapabilities(toolName, input || {}, context.capabilities);
  if (!capVerdict.allow) {
    return { allow: false, reason: capVerdict.reason };
  }

  // ── 2. 灾难命令拦截（红线，复用现有 command-safety）──────────────
  if ((toolName === 'execute_command' || toolName === 'host_exec') && command) {
    if (commandHasTruncationMarker(command)) {
      return { allow: false, reason: '命令疑似被摘要截断（包含省略号或 [truncated] 标记），请重新生成完整命令后再执行。' };
    }
    const risk = assessCommandRisk(command);
    if (risk.dangerous) {
      return { allow: false, reason: `已拦截灾难性命令：${risk.reason}` };
    }
  }

  // ── 3. 高风险操作规则库────────────────────────────────────
  let needApproval = false;
  let approvalRequired = false;
  let riskReason = '';
  let risk = null;

  if (toolName === 'execute_command' || toolName === 'host_exec') {
    risk = classifyCommandRisk(command, { securityMode: context.securityMode });
    if (risk.shouldBlock) {
      return { allow: false, reason: `高风险操作阻断：${formatRiskReason(risk)}`, risk };
    }
    if (risk.approvalRequired) {
      needApproval = true;
      approvalRequired = true;
      riskReason = formatRiskReason(risk);
    } else if (risk.risky) {
      riskReason = formatRiskReason(risk);
    }
  } else if (WRITE_TOOLS_NEEDING_APPROVAL.has(toolName)) {
    needApproval = true;
    approvalRequired = false;
    riskReason = '写/变更类操作';
  }

  const summary = summarize(toolName, input || {});
  const approval = createApprovalFacts(toolName, input || {}, {
    summary,
    needApproval,
    approvalRequired,
    riskReason,
    risk,
    context,
  });

  return {
    allow: true,
    needApproval,
    approvalRequired,
    riskReason,
    risk,
    summary,
    approval,
  };
}

function createGuard() {
  return { check };
}

module.exports = {
  check,
  createGuard,
  assessMediumRisk,
  MEDIUM_RISK_PATTERNS: COMMAND_RISK_RULES,
  COMMAND_RISK_RULES,
};
