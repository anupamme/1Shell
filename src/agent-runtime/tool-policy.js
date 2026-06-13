'use strict';

const { checkCapabilities, isReadonlyCommand } = require('../harness/capabilities');
const { SIDE_EFFECT_TOOL_NAMES } = require('./observation-interpreter');

const READONLY_TOOL_NAMES = new Set([
  'list_hosts',
  'read_file',
  'read_remote_file',
  'list_remote_dir',
  'list_artifacts',
  'query_format',
  'list_skills',
  'load_skill',
  'list_tasks',
  'list_programs',
  'list_scripts',
  'query_audit',
  'query_probe',
  'list_probes',
  'get_probe',
  'get_probe_samples',
  'get_probe_timeseries',
  'get_probe_traffic',
  'list_probe_alerts',
  'verify_outcome',
]);

function evaluateAgentToolPolicy(state = {}, toolName = '', args = {}, options = {}) {
  const name = String(toolName || '').trim();
  const policy = state?.spec?.policy && typeof state.spec.policy === 'object' ? state.spec.policy : {};
  if (!name) return { allow: false, kind: 'invalid_tool', reason: 'toolName is required' };

  const allowlistVerdict = evaluateToolAllowlist(policy, name);
  if (!allowlistVerdict.allow) return allowlistVerdict;

  const hostScopeVerdict = evaluateHostScope(policy, name, args, options, state);
  if (!hostScopeVerdict.allow) return hostScopeVerdict;

  if (policy.readOnly === true && !READONLY_TOOL_NAMES.has(name)) {
    return {
      allow: false,
      kind: 'read_only_policy',
      reason: `Tool ${name} is not allowed while AgentRun policy is readOnly`,
    };
  }

  const capabilityVerdict = evaluateRuntimeCapabilities(policy, name, args, options);
  if (!capabilityVerdict.allow) return capabilityVerdict;

  const approval = evaluateApprovalRequirement(policy, name, args, options);
  const canAskApproval = options.allowApproval === true && typeof options.requestApproval === 'function';
  if (approval.required && !canAskApproval) {
    return {
      allow: false,
      kind: 'approval_required',
      reason: approval.reason,
      approvalRequired: true,
      interrupt: {
        type: 'request_approval',
        reason: approval.reason,
        message: approval.message,
        payload: {
          toolName: name,
          title: approval.title,
          args: redactPotentialSecrets(args),
          policy: approval.policy,
        },
        scope: options.scope || {},
      },
    };
  }

  return {
    allow: true,
    approvalRequired: approval.required,
    reason: approval.reason,
    title: approval.title,
    message: approval.message,
    approvalPolicy: approval.policy,
  };
}

function evaluateToolAllowlist(policy = {}, toolName = '') {
  const deniedTools = normalizeStringArray(policy.deniedTools || policy.denied_tools);
  if (deniedTools.includes(toolName) || deniedTools.includes('*')) {
    return { allow: false, kind: 'denied_tool', reason: `Tool ${toolName} is denied by AgentRun policy` };
  }
  const allowedTools = normalizeStringArray(policy.allowedTools || policy.allowed_tools);
  if (allowedTools.length > 0 && !allowedTools.includes('*') && !allowedTools.includes(toolName)) {
    return { allow: false, kind: 'disallowed_tool', reason: `Tool ${toolName} is not in AgentRun allowedTools` };
  }
  return { allow: true };
}

function evaluateHostScope(policy = {}, toolName = '', args = {}, options = {}, state = {}) {
  if (!requiresHostScope(toolName, args)) return { allow: true };
  const hostScope = policy.hostScope !== undefined ? policy.hostScope : policy.host_scope;
  if (hostScope === undefined) return { allow: true };
  const contextHost = String(state?.spec?.context?.hostId || state?.spec?.context?.host_id || options?.scope?.hostId || options?.scope?.host_id || 'local').trim() || 'local';
  const requestedHost = String(args?.hostId || args?.host_id || options?.scope?.hostId || options?.scope?.host_id || contextHost).trim() || contextHost;
  if (hostScope === 'current') {
    return requestedHost === contextHost
      ? { allow: true }
      : { allow: false, kind: 'host_scope', reason: `Tool ${toolName} target host ${requestedHost} is outside current host scope ${contextHost}` };
  }
  if (Array.isArray(hostScope)) {
    const allowed = hostScope.map((item) => String(item || '').trim()).filter(Boolean);
    if (allowed.length === 0 || !allowed.includes(requestedHost)) {
      return { allow: false, kind: 'host_scope', reason: `Tool ${toolName} target host ${requestedHost} is outside AgentRun hostScope [${allowed.join(', ')}]` };
    }
    return { allow: true };
  }
  return { allow: false, kind: 'host_scope', reason: `Invalid AgentRun hostScope for ${toolName}` };
}

function evaluateRuntimeCapabilities(policy = {}, toolName = '', args = {}, options = {}) {
  const capabilities = options.capabilities !== undefined
    ? options.capabilities
    : (policy.capabilities !== undefined ? policy.capabilities : undefined);
  if (capabilities === undefined) return { allow: true };
  const capabilityList = normalizeStringArray(capabilities);
  if (capabilityList.includes('read_only') && READONLY_TOOL_NAMES.has(toolName) && !['execute_command', 'host_exec'].includes(toolName)) {
    return { allow: true };
  }
  const verdict = checkCapabilities(toolName, args || {}, capabilities);
  if (verdict.allow) return { allow: true };
  return {
    allow: false,
    kind: 'capability_policy',
    reason: verdict.reason || `Tool ${toolName} is not allowed by AgentRun capabilities`,
  };
}

function requiresHostScope(toolName = '', args = {}) {
  const name = String(toolName || '').trim();
  if (args?.hostId || args?.host_id) return true;
  return ['execute_command', 'host_exec', 'read_remote_file', 'list_remote_dir', 'write_remote_file', 'upload_file', 'download_file', 'run_skill'].includes(name);
}

function evaluateApprovalRequirement(policy = {}, toolName = '', args = {}, options = {}) {
  const requireApproval = Array.isArray(policy.requireApproval) ? policy.requireApproval : [];
  const approvalPolicy = String(policy.approvalPolicy || policy.approval_policy || '').trim();
  const sideEffect = SIDE_EFFECT_TOOL_NAMES.has(toolName);
  const commandSideEffect = isCommandSideEffect(toolName, args);
  const explicit = requireApproval.includes('*') || requireApproval.includes(toolName);
  const allSideEffects = approvalPolicy === 'all_side_effects' && sideEffect;
  const agentSideEffects = approvalPolicy === 'agent_side_effects' && (
    (sideEffect && !isCommandTool(toolName))
    || commandSideEffect
  );
  const sideEffectsExceptCommands = approvalPolicy === 'side_effects_except_commands'
    && sideEffect
    && !['execute_command', 'host_exec'].includes(toolName);
  const optionRequested = options.approvalRequired === true || options.requiresApproval === true || options.needApproval === true;
  const required = explicit || allSideEffects || agentSideEffects || sideEffectsExceptCommands || optionRequested;
  const description = describeApprovalRequirement(toolName, args, {
    explicit,
    allSideEffects,
    agentSideEffects,
    sideEffectsExceptCommands,
    optionRequested,
  });
  return {
    required,
    reason: description.reason,
    title: description.title,
    message: description.detail,
    policy: explicit
      ? 'requireApproval'
      : (allSideEffects
        ? 'all_side_effects'
        : (agentSideEffects
          ? 'agent_side_effects'
          : (sideEffectsExceptCommands ? 'side_effects_except_commands' : (optionRequested ? 'tool_option' : 'none')))),
  };
}

function isCommandTool(toolName = '') {
  return toolName === 'execute_command' || toolName === 'host_exec';
}

function isCommandSideEffect(toolName = '', args = {}) {
  if (!isCommandTool(toolName)) return false;
  const command = String(args?.command || '');
  if (!command.trim()) return false;
  if (isReadonlyCommand(command)) return false;
  return looksLikeMutatingCommand(command);
}

function looksLikeMutatingCommand(command = '') {
  const text = String(command || '').toLowerCase();
  if (!text.trim()) return false;
  if (/[^0-9]>>?/.test(text) || /\btee\b/.test(text)) return true;
  return /\b(rm|mv|cp|dd|mkfs|chmod|chown|chgrp|ln|truncate|install|kill|pkill|mkdir|rmdir|touch)\b/.test(text)
    || /\b(systemctl|service)\b[^|;&\n]*(start|stop|restart|reload|enable|disable|mask|unmask|reset-failed|daemon-reload)\b/.test(text)
    || /\b(docker|podman)\b[^|;&\n]*(run|rm|rmi|stop|start|restart|exec|compose\b[^|;&\n]*(up|down|pull|build|restart|stop|start))\b/.test(text)
    || /\b(git)\b[^|;&\n]*(clone|pull|checkout|switch|merge|rebase|reset|clean|submodule\s+update)\b/.test(text)
    || /\b(apt|apt-get|yum|dnf|pacman|apk|zypper|pip|pip3|npm|pnpm|yarn|bun)\b[^|;&\n]*(install|add|remove|purge|erase|uninstall|update|upgrade|ci|build)\b/.test(text)
    || /\b(useradd|adduser|userdel|deluser|usermod|groupadd|groupdel|passwd|gpasswd)\b/.test(text)
    || /\b(reboot|shutdown|halt|poweroff|iptables|ufw|nft|firewall-cmd)\b/.test(text)
    || /\bsed\b[^|;&\n]*\s-i\b/.test(text);
}

function describeApprovalRequirement(toolName = '', args = {}, flags = {}) {
  const title = approvalTitleForTool(toolName);
  const detail = summarizeToolArgs(toolName, args);
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const effects = describeCommandSideEffects(args?.command || '');
    return {
      title,
      reason: effects.length > 0
        ? `这条命令会${effects.join('、')}，需要你确认。`
        : '这条命令包含未能精确归类的写入/变更动作；请核对命令内容、目标主机和影响范围后确认。',
      detail,
    };
  }
  if (flags.explicit) {
    return {
      title,
      reason: '当前运行策略要求这一步先经过你确认。',
      detail,
    };
  }
  if (flags.optionRequested) {
    return {
      title,
      reason: '这个工具请求人工确认后再继续。',
      detail,
    };
  }
  return {
    title,
    reason: '这一步会修改外部状态，需要你确认。',
    detail,
  };
}

function approvalTitleForTool(toolName = '') {
  if (toolName === 'execute_command' || toolName === 'host_exec') return '执行命令需要确认';
  return '操作需要确认';
}

function summarizeToolArgs(toolName, args = {}) {
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    return [
      `主机：${String(args.hostId || args.host_id || 'local')}`,
      '命令：',
      String(args.command || '').slice(0, 1200),
    ].join('\n');
  }
  try {
    return JSON.stringify(redactPotentialSecrets(args)).slice(0, 1000);
  } catch {
    return '';
  }
}

function describeCommandSideEffects(command = '') {
  const text = String(command || '').toLowerCase();
  const effects = [];
  const add = (label) => {
    if (label && !effects.includes(label)) effects.push(label);
  };

  if (/\bgit\b[^|;&\n]*\bclone\b/.test(text)) add('克隆代码仓库');
  if (/\bgit\b[^|;&\n]*\b(fetch|pull)\b/.test(text)) add('拉取代码更新');
  if (/\bgit\b[^|;&\n]*\b(reset|clean|checkout|switch|merge|rebase)\b/.test(text)) add('改变工作目录里的 Git 状态');
  if (/\bdocker\s+compose\b[^|;&\n]*\b(up|start|restart|down|stop|pull|build)\b/.test(text)) add('修改 Docker Compose 服务');
  if (/\bdocker\b[^|;&\n]*\b(run|rm|rmi|stop|start|restart|pull|build)\b/.test(text)) add('修改 Docker 容器或镜像');
  if (/\bsystemctl\b[^|;&\n]*\b(daemon-reload)\b/.test(text)) add('刷新 systemd 配置');
  if (/\bsystemctl\b[^|;&\n]*\b(start|stop|restart|reload|enable|disable|mask|unmask|reset-failed)\b/.test(text)) add('修改 systemd 服务状态');
  if (/\b(service)\b[^|;&\n]*\b(start|stop|restart|reload|enable|disable)\b/.test(text)) add('修改服务状态');
  if (/\b(apt|apt-get|yum|dnf|pacman|apk|zypper)\b[^|;&\n]*\b(install|add|remove|purge|erase|update|upgrade|autoremove)\b/.test(text)) add('安装、更新或删除系统软件包');
  if (/\b(npm|pnpm|yarn|bun|pip|pip3)\b[^|;&\n]*\b(install|add|remove|uninstall|update|upgrade|ci|build)\b/.test(text)) add('安装依赖或生成构建产物');
  if (/\brm\b/.test(text)) add('删除文件或目录');
  if (/\b(mv|cp|mkdir|rmdir|touch|truncate|install|ln)\b/.test(text)) add('创建、移动或覆盖文件');
  if (/\b(chmod|chown|chgrp)\b/.test(text)) add('修改文件权限或所有者');
  if (/\bsed\b[^|;&\n]*\s-i(?:\.[^\s]+)?(?:\s|$)/.test(text)) add('原地修改文件内容');
  if (/[^0-9]>>?/.test(text) || /\btee\b/.test(text)) add('写入文件内容');
  if (/\b(kill|pkill)\b/.test(text)) add('终止进程');
  if (/\b(reboot|shutdown|halt|poweroff)\b/.test(text)) add('重启或关闭主机');
  if (/\b(iptables|ufw|nft|firewall-cmd)\b/.test(text)) add('修改防火墙规则');
  if (/\b(useradd|adduser|userdel|deluser|usermod|groupadd|groupdel|passwd|gpasswd)\b/.test(text)) add('修改用户或权限账户');

  return effects.slice(0, 5);
}

function redactPotentialSecrets(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}, (key, item) => {
      if (/token|key|secret|password|auth|credential/i.test(key)) return '<redacted>';
      if (typeof item === 'string' && item.length > 1000) return `${item.slice(0, 1000)}\n...[truncated ${item.length - 1000} chars]`;
      return item;
    }));
  } catch {
    return {};
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

module.exports = {
  READONLY_TOOL_NAMES,
  describeCommandSideEffects,
  evaluateAgentToolPolicy,
};
