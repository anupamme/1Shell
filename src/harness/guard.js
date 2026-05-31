'use strict';

/**
 * Harness Guard — 确定性护栏聚合。
 *
 * 三件事，全部确定性（不调 LLM）：
 *   1. capability 准入（最小授权）—— checkCapabilities
 *   2. 灾难命令拦截（红线兜底）—— 复用 command-safety.assessCommandRisk
 *   3. 风险分级 —— 决定中危操作是否标记 needApproval（人在场时才会真正触发审批）
 *
 * 返回约定（见 HARNESS_DESIGN.md §7）：
 *   - { allow: false, reason }                    → 直接拦截，命令不发出
 *   - { allow: true, needApproval, summary }      → 放行，needApproval 由风险分级决定
 */

const { assessCommandRisk } = require('../ai/command-safety');
const { checkCapabilities } = require('./capabilities');

// ─── 中危命令模式（放行但建议人审）────────────────────────────────────────
// 这些不是灾难（不该硬挡），但有副作用，人在场时值得停一下确认。
// 无人值守路径（allowApproval=false）下，needApproval 会被忽略，照常执行。
const MEDIUM_RISK_PATTERNS = [
  { id: 'rm-recursive', test: (t) => /\brm\b[^|;&]*-{1,2}[a-z]*r/i.test(t), label: '递归删除' },
  { id: 'service-stop', test: (t) => /\bsystemctl\b[^|;&]*\b(stop|disable|mask|kill)\b/.test(t), label: '停止/禁用服务' },
  { id: 'service-restart', test: (t) => /\bsystemctl\b[^|;&]*\b(restart|reload)\b/.test(t), label: '重启服务' },
  { id: 'firewall', test: (t) => /\b(iptables|ufw|nft|firewall-cmd)\b/.test(t), label: '修改防火墙规则' },
  { id: 'reboot', test: (t) => /\b(reboot|shutdown|halt|poweroff)\b/.test(t), label: '重启/关机' },
  { id: 'pkg-remove', test: (t) => /\b(apt|apt-get|yum|dnf|pacman)\b[^|;&]*\b(remove|purge|erase|uninstall)\b/.test(t), label: '卸载软件包' },
  { id: 'user-mgmt', test: (t) => /\b(userdel|deluser|passwd|usermod)\b/.test(t), label: '用户管理' },
  { id: 'overwrite-redirect', test: (t) => /(?<![0-9>])>(?!>)/.test(t), label: '输出覆盖重定向' },
];

function assessMediumRisk(command) {
  const text = String(command || '');
  const matches = MEDIUM_RISK_PATTERNS.filter((item) => item.test(text));
  return {
    risky: matches.length > 0,
    reason: matches.map((m) => m.label).join('、'),
  };
}

// 写类工具默认建议人审（人在场时）
const WRITE_TOOLS_NEEDING_APPROVAL = new Set([
  'write_remote_file', 'upload_file', 'download_file', 'deploy_local_mcp',
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

/**
 * @param {string} toolName
 * @param {object} input
 * @param {object} context  - 至少含 { capabilities }
 * @returns {{ allow:boolean, reason?:string, needApproval?:boolean, summary?:object, riskReason?:string }}
 */
function check(toolName, input, context = {}) {
  const command = String(input?.command || '');

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

  // ── 3. 风险分级 → needApproval（仅人在场时真正触发）──────────────
  let needApproval = false;
  let riskReason = '';
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const medium = assessMediumRisk(command);
    if (medium.risky) { needApproval = true; riskReason = medium.reason; }
  } else if (WRITE_TOOLS_NEEDING_APPROVAL.has(toolName)) {
    needApproval = true;
    riskReason = '写/变更类操作';
  }

  return { allow: true, needApproval, riskReason, summary: summarize(toolName, input || {}) };
}

function createGuard() {
  return { check };
}

module.exports = { check, createGuard, assessMediumRisk, MEDIUM_RISK_PATTERNS };
