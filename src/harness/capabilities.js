'use strict';

/**
 * Harness Capabilities — 能力词表 + 准入规则。
 *
 * capability 回答的是"这次任务被授权能做什么"（最小授权），
 * 与 command-safety 的灾难拦截（"什么绝对不能做"）正交。
 *
 * 设计原则（见 HARNESS_DESIGN.md §6）：
 *   - 声明式映射，新增能力只改本文件
 *   - 这一版只落地 read_only / exec_command 两档，词表预留扩展位
 */

// ─── 只读命令前缀白名单 ────────────────────────────────────────────────────
// read_only 能力下，命令首 token 必须命中其一。覆盖巡检/诊断常用只读命令。
const READ_ONLY_COMMAND_PREFIXES = [
  'cat', 'less', 'more', 'head', 'tail', 'ls', 'll', 'dir', 'stat', 'file',
  'pwd', 'whoami', 'id', 'hostname', 'uname', 'uptime', 'date', 'env', 'printenv',
  'ps', 'top', 'htop', 'free', 'df', 'du', 'lsblk', 'mount', 'vmstat', 'iostat',
  'who', 'w', 'last', 'lscpu', 'lsmem', 'lsof', 'nproc',
  'set', 'cd',
  'systemctl', // 仅放行 status/show/list-*，见 isReadonlySystemctl
  'journalctl',
  'ip', 'ifconfig', 'ss', 'netstat', 'route', 'ping', 'traceroute', 'dig', 'nslookup', 'host',
  'grep', 'egrep', 'fgrep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc', 'tr', 'find', 'locate',
  'echo', 'printf', 'true', 'false', 'test', 'which', 'whereis', 'type', 'command',
  'git',
  'docker', // 仅放行 ps/images/inspect/logs/stats，见 isReadonlyDocker
  'curl', 'wget', // 仅放行 GET 类探测；写副作用由命令参数判断，这里只做最小限制
];

// systemctl 的只读子命令（read_only 下只允许这些）
const SYSTEMCTL_READONLY_SUBCOMMANDS = new Set([
  'status', 'show', 'list-units', 'list-unit-files', 'list-timers',
  'is-active', 'is-enabled', 'is-failed', 'cat', 'get-default',
]);

// docker 的只读子命令
const DOCKER_READONLY_SUBCOMMANDS = new Set([
  'ps', 'images', 'image', 'inspect', 'logs', 'stats', 'top', 'port', 'version', 'info', 'system',
]);

const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'branch', 'remote', 'ls-files',
  'describe', 'tag', 'config', 'symbolic-ref', 'name-rev', 'shortlog',
]);

function firstToken(command) {
  const text = String(command || '').trim();
  if (!text) return '';
  // 取第一个 token（去掉前导 sudo / env 赋值）
  const tokens = text.split(/\s+/);
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i += 1;
  return (tokens[i] || '').replace(/^.*\//, ''); // 去掉路径前缀 /usr/bin/cat -> cat
}

function secondToken(command) {
  const tokens = String(command || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i += 1;
  return (tokens[i + 1] || '').toLowerCase();
}

function isReadonlySystemctl(command) {
  return SYSTEMCTL_READONLY_SUBCOMMANDS.has(secondToken(command));
}

function isReadonlyDocker(command) {
  const sub = secondToken(command);
  if (DOCKER_READONLY_SUBCOMMANDS.has(sub)) return true;
  return false;
}

function isReadonlyGit(command) {
  return GIT_READONLY_SUBCOMMANDS.has(secondToken(command));
}

function splitShellSegments(command) {
  const text = String(command || '');
  const out = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|') {
      pushSegment(out, current);
      current = '';
      if (ch === '|' && next === '|') i += 1;
      continue;
    }
    if (ch === '&' && next === '&') {
      pushSegment(out, current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
  }
  pushSegment(out, current);
  return out;
}

function pushSegment(out, segment) {
  const normalized = String(segment || '').trim();
  if (normalized) out.push(normalized);
}

function isAssignmentOnly(command) {
  return /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)?$/.test(String(command || '').trim());
}

function hasWriteRedirection(command) {
  const text = String(command || '')
    .replace(/(?:^|\s)(?:[12]?>|&>)\s*\/dev\/null\b/g, ' ')
    .replace(/(?:^|\s)2>&1\b/g, ' ');
  return /(?<![0-9>])>(?!>)/.test(text) || />>/.test(text);
}

function isReadonlySed(command) {
  return !/\s-i(?:\.[^\s]+)?(?:\s|$)/i.test(String(command || ''));
}

function isReadonlyFind(command) {
  const text = String(command || '');
  if (/\s-delete(?:\s|$)/i.test(text)) return false;
  const execMatch = text.match(/\s-exec(?:dir)?\s+([^\s;\\]+)/i);
  if (!execMatch) return true;
  const execCmd = execMatch[1].replace(/^.*\//, '');
  if (!READ_ONLY_COMMAND_PREFIXES.includes(execCmd)) return false;
  if (execCmd === 'sed') return isReadonlySed(text.slice(execMatch.index));
  if (execCmd === 'systemctl') return isReadonlySystemctl(text);
  if (execCmd === 'docker') return isReadonlyDocker(text);
  if (execCmd === 'git') return isReadonlyGit(text);
  return true;
}

/**
 * 命令是否属于"只读"——用于 read_only capability 准入。
 * 保守策略：含 shell 串联/重定向写入/管道到写命令时，一律视为非只读。
 */
function isReadonlyCommand(command) {
  const text = String(command || '').trim();
  if (!text) return false;

  // 含输出重定向（> >>）视为写
  if (hasWriteRedirection(text) || /\btee\b/.test(text)) return false;
  // 含明显写命令关键字，视为非只读（即便作为子命令）

  // 命令可能用 ; && || | 串联，逐段判断，全部只读才算只读
  const segments = splitShellSegments(text);
  if (segments.length === 0) return false;

  for (const seg of segments) {
    if (isAssignmentOnly(seg)) continue;
    const cmd = firstToken(seg);
    if (!cmd) return false;
    if (!READ_ONLY_COMMAND_PREFIXES.includes(cmd)) return false;
    if (cmd === 'systemctl' && !isReadonlySystemctl(seg)) return false;
    if (cmd === 'docker' && !isReadonlyDocker(seg)) return false;
    if (cmd === 'git' && !isReadonlyGit(seg)) return false;
    if (cmd === 'sed' && !isReadonlySed(seg)) return false;
    if (cmd === 'find' && !isReadonlyFind(seg)) return false;
  }
  return true;
}

// ─── capability 准入规则表（声明式）────────────────────────────────────────
// 每个 capability 声明它对哪些工具放行、以及命令级的额外判断。
const CAPABILITY_RULES = {
  read_only: {
    label: '只读',
    // 只读能力下允许的工具
    allowedTools: new Set(['execute_command', 'host_exec', 'read_remote_file', 'list_remote_dir', 'list_hosts', 'query_probe', 'list_probes']),
    // 对 execute_command 的命令级判断
    commandCheck: isReadonlyCommand,
  },
  exec_command: {
    label: '执行命令',
    // 执行能力：放行命令执行与读类工具（写文件需额外 write_file 能力，词表后续扩）
    allowedTools: new Set([
      'execute_command', 'host_exec', 'read_remote_file', 'list_remote_dir', 'list_hosts',
      'write_remote_file', 'create_directory', 'delete_path', 'rename_path',
      'upload_file', 'download_file', 'run_script',
      'query_probe', 'list_probes', 'query_audit',
    ]),
    commandCheck: null, // 不做命令级限制（灾难拦截由 guard 兜底）
  },
  agent_control: {
    label: 'Agent 控制',
    allowedTools: new Set([
      'ask_user', 'request_secret', 'verify_outcome',
    ]),
    commandCheck: null,
  },
  task_artifact: {
    label: '任务产物',
    allowedTools: new Set([
      'create_task', 'write_task', 'package_agent_run', 'trigger_task',
      'list_tasks', 'list_programs',
    ]),
    commandCheck: null,
  },
};

const DEFAULT_CAPABILITIES = ['exec_command'];

/**
 * 判断本次 capabilities 是否允许调用某工具（及命令级判断）。
 *
 * 授权语义（fail-closed）：
 *   - capabilities === undefined：调用方未声明，回退默认能力（向后兼容，未声明的 step 等价旧版）。
 *   - capabilities === []（显式空集）或 null：明确声明"无任何能力"，拒绝一切工具调用。
 *   - 非空数组：按声明的能力集判断。
 *
 * @returns {{ allow: boolean, reason?: string }}
 */
function checkCapabilities(toolName, input, capabilities) {
  // 显式空集 / null（区别于 undefined 的"未声明"）→ fail-closed 拒绝
  if (capabilities === null || (Array.isArray(capabilities) && capabilities.length === 0)) {
    return { allow: false, reason: `本次未授权任何能力，拒绝调用工具 ${toolName}` };
  }
  const caps = Array.isArray(capabilities) && capabilities.length > 0 ? capabilities : DEFAULT_CAPABILITIES;

  // 任一 capability 放行即放行（能力是并集授权）
  let anyToolAllowed = false;
  for (const cap of caps) {
    const rule = CAPABILITY_RULES[cap];
    if (!rule) continue;
    if (!rule.allowedTools.has(toolName)) continue;
    anyToolAllowed = true;

    // 命令级判断：若该 capability 对命令有额外限制，必须通过
    if (rule.commandCheck && (toolName === 'execute_command' || toolName === 'host_exec')) {
      if (rule.commandCheck(input.command)) {
        return { allow: true };
      }
      // 这个 capability 的命令检查没过，继续看其它 capability
      continue;
    }
    return { allow: true };
  }

  if (!anyToolAllowed) {
    return { allow: false, reason: `当前授权能力 [${caps.join(', ')}] 不允许调用工具 ${toolName}` };
  }
  // 工具允许但命令级检查全部没过（典型：read_only 下试图跑写命令）
  return { allow: false, reason: `当前授权能力 [${caps.join(', ')}] 下该命令不被允许（疑似超出只读范围）` };
}

module.exports = {
  CAPABILITY_RULES,
  DEFAULT_CAPABILITIES,
  checkCapabilities,
  isReadonlyCommand,
};
