'use strict';

/**
 * Harness Executors — toolName → 底层执行器 的派发表。
 *
 * 不重写执行逻辑：execute_command 的 local 走 execLocalCommand、remote 走 bridge.execOnHost。
 * 其余工具暂时通过可选 fallback 委托，未提供 fallback 时报错。
 * local 与 remote 都从这里进，guard 已在 dispatch 步骤 1 统一施加。
 */

const os = require('os');
const { execLocalCommand } = require('../../lib/exec-local');
const { isReadonlyCommand } = require('./capabilities');

const READONLY_SUDO_PREFIXES = new Set([
  'journalctl', 'ss', 'lsof', 'systemctl', 'ps', 'df', 'du', 'ip', 'uname', 'hostname',
]);

function createExecutors({ bridgeService, hostService, fallback = null } = {}) {
  function isLocalHost(hostId) {
    if (hostId === 'local' || !hostId) return true;
    const host = hostService?.findHost?.(hostId);
    return host?.type === 'local';
  }

  async function run(toolName, input, context) {
    if (toolName === 'execute_command' || toolName === 'host_exec') {
      const hostId = String(input.hostId || context.hostId || 'local').trim();
      const command = String(input.command || '').trim();
      const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : undefined;

      if (!command) {
        return { stdout: '', stderr: 'command 为空', exitCode: 1, durationMs: 0 };
      }

      const isolatedCommand = prepareCommandForExecution(command, context);
      if (!isolatedCommand.ok) {
        return { stdout: '', stderr: isolatedCommand.error, exitCode: 1, durationMs: 0 };
      }

      if (isLocalHost(hostId)) {
        if (context.agentPrivilegeIsolation === true && os.platform() === 'win32') {
          return {
            stdout: '',
            stderr: '当前本机是 Windows，暂不支持 oneshell-agent 非 root 包裹；请关闭“Agent 权限隔离”或在 Linux 主机上执行。',
            exitCode: 1,
            durationMs: 0,
          };
        }
        return execLocalCommand(isolatedCommand.command, { timeout: timeout || 30000, signal: context.signal, onOutput: context.onOutput });
      }

      if (!bridgeService?.execOnHost) {
        return { stdout: '', stderr: 'bridgeService 未初始化', exitCode: 1, durationMs: 0 };
      }
      // 注意：bridge 内部仍挂着 commandGuard（双保险），且会写 audit_logs。
      // auditCommand 传打码后的命令由调用方在 input 里准备，或这里直接用原命令。
      return bridgeService.execOnHost(hostId, isolatedCommand.command, timeout, {
        source: context.source || 'harness',
        auditCommand: context.auditCommand || isolatedCommand.command,
        signal: context.signal,
        onOutput: context.onOutput,
      });
    }

    // 其余工具：委托给 fallback（后续 Phase 接入 file/mcp 等）
    if (typeof fallback === 'function') {
      return fallback(toolName, input, context);
    }
    return { stdout: '', stderr: `[harness] 工具 ${toolName} 尚未接入执行层`, exitCode: 1, durationMs: 0 };
  }

  return { run };
}

function prepareCommandForExecution(command, context = {}) {
  if (context.agentPrivilegeIsolation !== true) {
    return { ok: true, command, isolated: false };
  }
  const user = cleanUser(context.agentUser || 'oneshell-agent');
  if (!user) {
    return { ok: false, error: 'Agent 权限隔离用户非法，请在设置中使用普通 Linux 用户名（如 oneshell-agent）' };
  }
  const innerCommand = isReadonlyCommand(command) ? withReadonlySudo(command) : command;
  return {
    ok: true,
    command: `runuser -u ${user} -- bash -lc ${shellQuote(innerCommand)}`,
    isolated: true,
    user,
    readonlySudo: innerCommand !== command,
  };
}

function withReadonlySudo(command) {
  return String(command || '')
    .split(/(\s*(?:&&|\|\||;|\|)\s*)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return prefixSegmentWithSudo(part);
    })
    .join('');
}

function prefixSegmentWithSudo(segment) {
  const text = String(segment || '');
  const leading = text.match(/^\s*/)?.[0] || '';
  const body = text.trimStart();
  if (!body || body.startsWith('sudo ')) return text;
  if (!needsReadonlySudo(body)) return text;
  return `${leading}sudo -n ${body}`;
}

function needsReadonlySudo(segment) {
  const token = firstToken(segment);
  return READONLY_SUDO_PREFIXES.has(token);
}

function firstToken(command) {
  const tokens = String(command || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  return (tokens[i] || '').replace(/^.*\//, '').toLowerCase();
}

function cleanUser(value) {
  const text = String(value || '').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(text)) return '';
  return text;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { createExecutors, prepareCommandForExecution };
