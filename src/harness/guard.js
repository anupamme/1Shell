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
 *   - { allow: true, needApproval, summary }      → 放行，但可能必须人审
 */

const { assessCommandRisk } = require('../ai/command-safety');
const { checkCapabilities } = require('./capabilities');
const { classifyCommandRisk, assessMediumRisk, COMMAND_RISK_RULES } = require('./risk-rules');

// 写类工具默认建议人审（人在场时）
const WRITE_TOOLS_NEEDING_APPROVAL = new Set([
  'write_remote_file', 'create_directory', 'delete_path', 'rename_path',
  'upload_file', 'download_file', 'deploy_local_mcp',
  'add_mcp_server', 'remove_mcp_server', 'install_probe_agent',
  'restart_probe_agent', 'uninstall_probe_agent', 'run_script',
]);

function summarize(toolName, input) {
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    return { title: '执行命令', detail: `主机: ${input.hostId || 'local'}\n命令: ${String(input.command || '').slice(0, 300)}` };
  }
  if (toolName === 'write_remote_file') {
    return { title: '写入远程文件', detail: `路径: ${input.path || ''}` };
  }
  return { title: toolName, detail: JSON.stringify(input || {}).slice(0, 300) };
}

function formatRiskReason(verdict) {
  if (!verdict?.risky) return '';
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.filter(Boolean) : [];
  const mode = verdict.securityMode ? `安全档位=${verdict.securityMode}` : '';
  const level = verdict.level ? `风险等级=${verdict.level}` : '';
  return [reasons.join('、'), level, mode].filter(Boolean).join('；');
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

  return {
    allow: true,
    needApproval,
    approvalRequired,
    riskReason,
    risk,
    summary: summarize(toolName, input || {}),
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
