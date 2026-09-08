'use strict';

/**
 * Harness Risk Rules — 高风险操作规则库。
 *
 * command-safety 只拦不可逆灾难；本文件覆盖常见高危参数和中危意图：
 * chmod 777、敏感路径 rm、curl|sh、关闭防火墙/系统安全机制等。
 *
 * 安全档位：
 *   - strict   ：critical 阻断，high/medium 必须审批
 *   - standard ：critical 阻断，high 必须审批，medium 告警放行
 *   - trusted  ：仅告警（灾难命令仍由 command-safety 红线兜底）
 */

const LEVEL_ORDER = Object.freeze({ safe: 0, low: 1, medium: 2, high: 3, critical: 4 });
const SECURITY_MODES = Object.freeze(['strict', 'standard', 'trusted']);

const SENSITIVE_PATH_PATTERN = String.raw`(?:/etc|/usr|/boot|/var|/home|/root|/opt|/srv|/lib|/lib64|/bin|/sbin)(?:/|\s|$|[;&|])`;
const SENSITIVE_CONFIG_PATTERN = String.raw`(?:/etc/sudoers(?:\.d)?|/etc/ssh/sshd_config|/etc/passwd|/etc/shadow|/etc/group)(?:\s|$|[;&|])`;
const SENSITIVE_PATH_REGEX = new RegExp(SENSITIVE_PATH_PATTERN, 'i');
const SENSITIVE_CONFIG_REGEX = new RegExp(SENSITIVE_CONFIG_PATTERN, 'i');

function normalizeForRiskRules(command) {
  return String(command || '')
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'([^']*)'/g, '$1')
    .replace(/\\(\/)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function lower(command) {
  return normalizeForRiskRules(command).toLowerCase();
}

function hasSensitivePath(text) {
  return SENSITIVE_PATH_REGEX.test(`${text} `);
}

function hasSensitiveConfig(text) {
  return SENSITIVE_CONFIG_REGEX.test(`${text} `);
}

function hasRecursiveFlag(text) {
  return /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$)/i.test(text);
}

function hasForceFlag(text) {
  return /(?:^|\s)(?:-[a-z]*f[a-z]*|--force)(?:\s|$)/i.test(text);
}

function hasWorldWritableMode(text) {
  return /\bchmod\b[^|;&]*(?:\b0?777\b|\ba\+w\b|\bo\+w\b|\bugo\+w\b)/i.test(text);
}

function hasFirewallDisableIntent(text) {
  return /\bsystemctl\b[^|;&]*\b(stop|disable|mask|kill)\b[^|;&]*\b(firewalld|ufw|iptables|nftables)\b/i.test(text)
    || /\b(service)\b[^|;&]*\b(firewalld|ufw|iptables|nftables)\b[^|;&]*\b(stop|disable)\b/i.test(text)
    || /\bufw\b[^|;&]*\b(disable|reset)\b/i.test(text)
    || /\bfirewall-cmd\b[^|;&]*(?:--panic-on|--remove(?:-[a-z-]+)?\b)/i.test(text)
    || /\biptables\b[^|;&]*(?:\s-F\b|\s-X\b|--flush\b|--delete\b)/i.test(text)
    || /\bnft\b[^|;&]*\bflush\b[^|;&]*\bruleset\b/i.test(text);
}

function hasSecurityDisableIntent(text) {
  return /\bsetenforce\b\s+0\b/i.test(text)
    || /\bsetsebool\b[^|;&]*\boff\b/i.test(text);
}

function hasRemoteScriptPipe(text) {
  return /\b(curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh)\b/i.test(text);
}

function hasUnsafeOverwriteRedirect(text) {
  const withoutNullRedirects = String(text || '')
    .replace(/(?:^|\s)(?:[12]?>|&>)\s*\/dev\/null\b/g, ' ')
    .replace(/(?:^|\s)2>&1\b/g, ' ');
  return /(?<![0-9>])>(?!>)/.test(withoutNullRedirects);
}

function hasDockerMutationIntent(text) {
  return /\b(?:docker|podman)\s+compose\b[^|;&\n]*\b(?:up|down|pull|build|restart|stop|start|rm|create)\b/i.test(text)
    || /\b(?:docker|podman)\b[^|;&\n]*\b(?:run|rm|rmi|stop|start|restart|pull|build)\b/i.test(text)
    || /\b(?:docker|podman)\b[^|;&\n]*\b(?:volume\s+(?:rm|prune)|system\s+prune|container\s+(?:rm|prune)|image\s+(?:rm|prune))\b/i.test(text)
    || /\bxargs\b[^|;&\n]*\b(?:docker|podman)\b[^|;&\n]*\b(?:rm|rmi|stop|restart)\b/i.test(text);
}

// docker 的"高破坏性"动词：删镜像/容器/卷、prune、xargs 批量删
// —— run/up/stop/restart 等日常运维动词不再算 high（见 docker-service-mutation 的 medium 拆分）。
// 注意动词须处于子命令位（(?:^|\s)），避免把 docker run 的 --rm 参数误判成 rm 子命令。
function hasDockerDestructiveIntent(text) {
  return /\b(?:docker|podman)\b[^|;&\n]*\b(?:volume\s+(?:rm|prune)|system\s+prune|container\s+(?:rm|prune)|image\s+(?:rm|prune))\b/i.test(text)
    || /\b(?:docker|podman)\b[^|;&\n]*\s(?:rmi|rm)\b/i.test(text)
    || /\bxargs\b[^|;&\n]*\b(?:docker|podman)\b[^|;&\n]*\b(?:rm|rmi|stop|restart)\b/i.test(text);
}

// docker 的日常变更动词：run/start/stop/restart/pull/build/compose up 等
function hasDockerRoutineIntent(text) {
  return /\b(?:docker|podman)\s+compose\b[^|;&\n]*\b(?:up|down|pull|build|restart|stop|start|create)\b/i.test(text)
    || /\b(?:docker|podman)\b[^|;&\n]*\b(?:run|start|restart|stop|pull|build)\b/i.test(text);
}

function hasOperationalStateFile(text) {
  return /(?:^|[\/\s])(?:data\.key|usage\.sqlite|[^\/\s]+\.(?:sqlite|sqlite3|db)|config\.ya?ml|docker-compose\.ya?ml|\.env)(?:[\s;&|>]|$)/i.test(text)
    || /(?:secret|credential|api[-_]?key|auth)[^\/\s]*\.(?:txt|json|ya?ml|env|key|sqlite|db)(?:[\s;&|>]|$)/i.test(text);
}

function hasOperationalStateMutationIntent(text) {
  return /\b(rm|mv|cp|sed|tee|truncate|install|touch|chmod|chown|chgrp)\b/i.test(text)
    || hasUnsafeOverwriteRedirect(text);
}

// ── Windows 规则辅助 ────────────────────────────────────────────────────────
// 归一化只剥引号、不动反斜杠，故按 C:\Windows 的真实形态书写。

const WIN_SENSITIVE_PATH_REGEX = /[a-z]:[\\/]+(?:windows|program files(?:\s*\(x86\))?|programdata|users|boot|recovery|\$recycle\.bin)(?:[\\/]|\s|$|[;&|,])/i;
const WIN_SENSITIVE_VAR_REGEX = /\$env:(?:systemroot|windir|systemdrive|programfiles(?:\(x86\))?|programdata|allusersprofile)\b/i;

function hasWindowsSensitivePath(text) {
  return WIN_SENSITIVE_PATH_REGEX.test(`${text} `) || WIN_SENSITIVE_VAR_REGEX.test(text);
}

function hasWindowsRecursiveFlag(text) {
  return /(?:^|\s)(?:-r(?:ecurse)?\b|\/s\b)/i.test(text);
}

function hasWindowsForceFlag(text) {
  return /(?:^|\s)(?:-f(?:orce)?\b|\/f\b|\/q\b)/i.test(text)
    || /-confirm:\s*\$false/i.test(text);
}

function hasWindowsDeleteVerb(text) {
  return /\b(?:remove-item|rd|rmdir|del|erase)\b/i.test(text)
    || /(?:^|[|;&\s])ri\s/i.test(text);
}

function hasWindowsFirewallDisableIntent(text) {
  return /\bnetsh\b[^|;&\n]*\badvfirewall\b[^|;&\n]*\b(?:set\b[^|;&\n]*\bstate\s+off|reset)\b/i.test(text)
    || /\bset-netfirewallprofile\b[^|;&\n]*-enabled\s+(?:false|0)\b/i.test(text)
    || /\bnetsh\b[^|;&\n]*\bfirewall\b[^|;&\n]*\bset\b[^|;&\n]*\bopmode\s+disable\b/i.test(text)
    || /\bremove-netfirewallrule\b/i.test(text);
}

function hasWindowsSecurityDisableIntent(text) {
  // Defender / UAC / SmartScreen / 事件日志 —— 关掉它们是典型的入侵后动作
  return /\bset-mppreference\b[^|;&\n]*-disable(?:realtimemonitoring|antispyware|behaviormonitoring|ioavprotection|scriptscanning)\s*(?:\$true|1|true)?/i.test(text)
    || /\badd-mppreference\b[^|;&\n]*-exclusionpath\b/i.test(text)
    || /\buninstall-windowsfeature\b[^|;&\n]*windows-defender/i.test(text)
    || /\benablelua\b[^|;&\n]*(?:\/d\s*0|0\b)/i.test(text)
    || /\bwevtutil\b[^|;&\n]*\b(?:cl|clear-log)\b/i.test(text)
    || /\bclear-eventlog\b/i.test(text)
    || /\bset-executionpolicy\b[^|;&\n]*\bbypass\b[^|;&\n]*-scope\s+localmachine/i.test(text)
    || /\bbcdedit\b[^|;&\n]*\/set\b[^|;&\n]*\b(?:testsigning|nointegritychecks)\s+on\b/i.test(text);
}

function hasWindowsRemoteScriptPipe(text) {
  // iwr/curl … | iex 与 DownloadString(...) | iex —— PowerShell 版 curl|sh
  return /\b(?:invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget)\b[^|;&\n]*\|\s*(?:iex|invoke-expression)\b/i.test(text)
    || /\bdownloadstring\b[^|;&\n]*\)\s*\|\s*(?:iex|invoke-expression)\b/i.test(text)
    || /(?:iex|invoke-expression)\s*\(\s*(?:new-object\s+net\.webclient|\(?\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod))/i.test(text);
}

function hasWindowsServiceMutationIntent(text) {
  return /\b(?:stop-service|set-service|suspend-service)\b/i.test(text)
    || /\bsc(?:\.exe)?\s+(?:stop|delete|config)\b/i.test(text)
    || /\bnet\s+stop\b/i.test(text)
    || /\bdisable-(?:scheduledtask|windowsoptionalfeature)\b/i.test(text);
}

function hasWindowsUserManagementIntent(text) {
  return /\bnet\s+(?:user|localgroup)\b[^|;&\n]*\/(?:add|delete)\b/i.test(text)
    || /\b(?:new|remove|set)-localuser\b/i.test(text)
    || /\b(?:add|remove)-localgroupmember\b/i.test(text);
}

function hasWindowsRebootIntent(text) {
  return /\b(?:restart-computer|stop-computer)\b/i.test(text)
    || /\bshutdown(?:\.exe)?\s+\/[rsh]\b/i.test(text);
}

const COMMAND_RISK_RULES = Object.freeze([
  {
    id: 'chmod-world-writable-sensitive',
    level: 'critical',
    label: '递归放开系统敏感路径权限',
    test: (text) => /\bchmod\b/i.test(text) && hasWorldWritableMode(text) && hasRecursiveFlag(text) && hasSensitivePath(text),
  },
  {
    id: 'chmod-world-writable',
    level: 'high',
    label: '不安全权限修改 chmod 777 / 世界可写',
    test: hasWorldWritableMode,
  },
  {
    id: 'rm-sensitive-recursive-force',
    level: 'critical',
    label: '递归强制删除系统敏感路径',
    test: (text) => /\brm\b/i.test(text) && hasRecursiveFlag(text) && hasForceFlag(text) && hasSensitivePath(text),
  },
  {
    id: 'rm-sensitive-recursive',
    level: 'high',
    label: '递归删除系统敏感路径',
    test: (text) => /\brm\b/i.test(text) && hasRecursiveFlag(text) && hasSensitivePath(text),
  },
  {
    id: 'remote-script-pipe-shell',
    level: 'high',
    label: '远程脚本管道执行 curl/wget | shell',
    test: hasRemoteScriptPipe,
  },
  {
    id: 'disable-firewall',
    level: 'high',
    label: '关闭或清空防火墙规则',
    test: hasFirewallDisableIntent,
  },
  {
    id: 'disable-security-mechanism',
    level: 'high',
    label: '关闭系统安全机制',
    test: hasSecurityDisableIntent,
  },
  {
    id: 'sensitive-config-change',
    level: 'high',
    label: '修改安全敏感配置文件',
    test: (text) => hasSensitiveConfig(text) && /\b(chmod|chown|chgrp|rm|mv|cp|sed|tee|truncate|install|printf|echo|cat)\b|>/.test(text),
  },
  {
    id: 'docker-service-mutation',
    level: 'medium',
    label: 'Docker/Compose service or image mutation',
    // 4.7.7：docker run/up/stop/restart 等日常运维动词从 high 降 medium——
    // standard 挡直接放行，外部 agent 不再被审批卡死；破坏性动词见 docker-destructive。
    test: hasDockerRoutineIntent,
  },
  {
    id: 'docker-destructive',
    level: 'high',
    label: 'Docker 批量删除/prune/删卷删镜像',
    test: hasDockerDestructiveIntent,
  },
  {
    id: 'operational-state-file-change',
    level: 'high',
    label: 'Operational config, database, key, or secret file mutation',
    test: (text) => hasOperationalStateFile(text) && hasOperationalStateMutationIntent(text),
  },
  // ── Windows 规则 ──（红线级灾难由 command-safety 兜底，这里是分级档）
  {
    id: 'win-delete-sensitive-recursive-force',
    level: 'critical',
    label: '递归强制删除 Windows 系统路径',
    test: (text) => hasWindowsDeleteVerb(text) && hasWindowsRecursiveFlag(text) && hasWindowsForceFlag(text) && hasWindowsSensitivePath(text),
  },
  {
    id: 'win-delete-sensitive-recursive',
    level: 'high',
    label: '递归删除 Windows 系统路径',
    test: (text) => hasWindowsDeleteVerb(text) && hasWindowsRecursiveFlag(text) && hasWindowsSensitivePath(text),
  },
  {
    id: 'win-remote-script-pipe',
    level: 'high',
    label: '远程脚本管道执行 iwr/curl | iex',
    test: hasWindowsRemoteScriptPipe,
  },
  {
    id: 'win-disable-firewall',
    level: 'high',
    label: '关闭或重置 Windows 防火墙',
    test: hasWindowsFirewallDisableIntent,
  },
  {
    id: 'win-disable-security-mechanism',
    level: 'high',
    label: '关闭 Windows 安全机制 (Defender/UAC/日志)',
    test: hasWindowsSecurityDisableIntent,
  },
  {
    id: 'win-registry-write',
    level: 'high',
    label: '写入/删除系统注册表',
    test: (text) => /\b(?:reg(?:\.exe)?\s+(?:add|delete|import)|new-itemproperty|set-itemproperty|remove-itemproperty)\b/i.test(text)
      && /\bhk(?:lm|cu|cr|u|cc)\b[:\\]|\bhkey_/i.test(text),
  },
  {
    id: 'win-service-mutation',
    level: 'medium',
    label: '停止/禁用 Windows 服务或计划任务',
    test: hasWindowsServiceMutationIntent,
  },
  {
    id: 'win-user-management',
    level: 'medium',
    label: 'Windows 用户/组管理',
    test: hasWindowsUserManagementIntent,
  },
  {
    id: 'win-reboot-poweroff',
    level: 'medium',
    label: 'Windows 重启/关机',
    test: hasWindowsRebootIntent,
  },
  {
    id: 'win-delete-recursive',
    level: 'medium',
    label: 'Windows 递归删除',
    test: (text) => hasWindowsDeleteVerb(text) && hasWindowsRecursiveFlag(text),
  },
  {
    id: 'service-stop',
    level: 'medium',
    label: '停止/禁用服务',
    test: (text) => /\bsystemctl\b[^|;&]*\b(stop|disable|mask|kill)\b/i.test(text),
  },
  {
    id: 'service-restart',
    level: 'medium',
    label: '重启/重载服务',
    test: (text) => /\bsystemctl\b[^|;&]*\b(restart|reload)\b/i.test(text),
  },
  {
    id: 'reboot-poweroff',
    level: 'medium',
    label: '重启/关机',
    test: (text) => /\b(reboot|shutdown|halt|poweroff)\b/i.test(text),
  },
  {
    id: 'package-remove',
    level: 'medium',
    label: '卸载软件包',
    test: (text) => /\b(apt|apt-get|yum|dnf|pacman)\b[^|;&]*\b(remove|purge|erase|uninstall|autoremove)\b/i.test(text),
  },
  {
    id: 'user-management',
    level: 'medium',
    label: '用户/权限账户管理',
    test: (text) => /\b(userdel|deluser|passwd|usermod|groupdel|gpasswd)\b/i.test(text),
  },
  {
    id: 'rm-recursive',
    level: 'medium',
    label: '递归删除',
    test: (text) => /\brm\b/i.test(text) && hasRecursiveFlag(text),
  },
  {
    id: 'overwrite-redirect',
    level: 'medium',
    label: '输出覆盖重定向',
    test: hasUnsafeOverwriteRedirect,
  },
]);

function normalizeSecurityMode(mode) {
  const value = String(mode || process.env.ONESHELL_SECURITY_MODE || 'standard').trim().toLowerCase();
  return SECURITY_MODES.includes(value) ? value : 'standard';
}

function highestLevel(matches) {
  return matches.reduce((current, item) => {
    return LEVEL_ORDER[item.level] > LEVEL_ORDER[current] ? item.level : current;
  }, 'safe');
}

function actionFor(level, mode) {
  const securityMode = normalizeSecurityMode(mode);
  if (level === 'safe' || level === 'low') return 'allow';
  if (securityMode === 'trusted') return 'warn';
  if (level === 'critical') return 'block';
  if (level === 'high') return 'approval';
  if (level === 'medium') return securityMode === 'strict' ? 'approval' : 'warn';
  return 'allow';
}

function classifyCommandRisk(command, { securityMode } = {}) {
  const text = lower(command);
  if (!text) {
    return {
      risky: false,
      level: 'safe',
      action: 'allow',
      reasons: [],
      matchedRules: [],
      securityMode: normalizeSecurityMode(securityMode),
    };
  }

  const matchedRules = COMMAND_RISK_RULES
    .filter((rule) => rule.test(text))
    .map(({ id, level, label }) => ({ id, level, label }));
  const level = highestLevel(matchedRules);
  const mode = normalizeSecurityMode(securityMode);
  const action = actionFor(level, mode);
  const reasons = matchedRules.map((rule) => rule.label);

  return {
    risky: matchedRules.length > 0,
    level,
    action,
    reasons,
    matchedRules,
    securityMode: mode,
    needApproval: action === 'approval',
    approvalRequired: action === 'approval',
    shouldBlock: action === 'block',
  };
}

function assessMediumRisk(command) {
  const verdict = classifyCommandRisk(command, { securityMode: 'strict' });
  const matches = verdict.matchedRules.filter((rule) => LEVEL_ORDER[rule.level] >= LEVEL_ORDER.medium);
  return {
    risky: matches.length > 0,
    reason: matches.map((rule) => rule.label).join('、'),
    matches,
  };
}

module.exports = {
  COMMAND_RISK_RULES,
  SECURITY_MODES,
  LEVEL_ORDER,
  normalizeSecurityMode,
  classifyCommandRisk,
  assessMediumRisk,
};
