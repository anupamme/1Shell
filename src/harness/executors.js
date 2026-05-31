'use strict';

/**
 * Harness Executors — toolName → 底层执行器 的派发表。
 *
 * 不重写执行逻辑：execute_command 的 local 走 execLocalCommand、remote 走 bridge.execOnHost。
 * 其余工具暂时通过可选 fallback 委托（后续 Phase 接入），未提供 fallback 时报错。
 *
 * 关键修复（HARNESS_DESIGN.md §8）：local 与 remote 都从这里进，guard 已在 dispatch
 * 步骤 1 统一施加，所以原先 local 分支裸奔的问题自动消失。
 */

const { execLocalCommand } = require('../../lib/exec-local');

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

      if (isLocalHost(hostId)) {
        return execLocalCommand(command, { timeout: timeout || 30000, signal: context.signal });
      }

      if (!bridgeService?.execOnHost) {
        return { stdout: '', stderr: 'bridgeService 未初始化', exitCode: 1, durationMs: 0 };
      }
      // 注意：bridge 内部仍挂着 commandGuard（双保险），且会写 audit_logs。
      // auditCommand 传打码后的命令由调用方在 input 里准备，或这里直接用原命令。
      return bridgeService.execOnHost(hostId, command, timeout, {
        source: context.source || 'harness',
        auditCommand: context.auditCommand || command,
        signal: context.signal,
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

module.exports = { createExecutors };
