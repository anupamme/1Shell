'use strict';

/**
 * Script Service
 *
 * 脚本库的业务逻辑层。4.7.6 起定位收窄为"存脚本 + 在终端里用"：
 *   - 列表 / 查询 / 创建 / 更新 / 删除
 *   - 参数渲染：从正文扫描 {{var}} 占位符 → 逐个替换为 shell 转义后的值
 *   - 执行：仅保留单主机执行，服务于 agent 的 run_script 工具
 *     （Web 端执行入口、批量执行、执行历史表已随 4.7.6 退役）
 *
 * 参数语义：调用方必须为每个占位符提供键，值可以是空串；缺键直接抛 400 并
 * 列出缺哪些。这样 agent 漏传参数会立刻拿到明确反馈，而不是静默跑出一条
 * 带空值的命令。
 *
 * 执行结果写入 audit_logs，action='script_run'。
 */

const os = require('os');
const { execLocalScript } = require('../../lib/exec-local');
const { extractPlaceholders, placeholderPattern } = require('../../lib/script-placeholders');
const { redactCredentialPatterns } = require('../../lib/secret-redaction');
const { assessCommandRisk } = require('../ai/command-safety');
const { evaluateCommandRules } = require('../harness/command-rules');

const LOCAL_HOST_ID = 'local';
const DEFAULT_TIMEOUT_MS = 120000;

function createScriptService({ scriptRepository, hostService, bridgeService, auditService, securitySettingsService }) {

  // 本机 shell 类型：Windows → powershell, 其他 → bash
  // 影响参数的 shellQuote 风格。远程主机一律按 POSIX bash 处理。
  const LOCAL_SHELL_STYLE = os.platform() === 'win32' ? 'powershell' : 'bash';

  // ─── 列表 / 查询 ─────────────────────────────────────────────────────
  function listScripts({ keyword } = {}) {
    return scriptRepository.listScripts({ keyword });
  }

  function getScript(id) {
    return scriptRepository.findScript(id);
  }

  // ─── CRUD ────────────────────────────────────────────────────────────
  function createScript(validatedPayload) {
    return scriptRepository.createScript(validatedPayload);
  }

  function updateScript(id, validatedPayload) {
    return scriptRepository.updateScript(id, validatedPayload);
  }

  function deleteScript(id) {
    return scriptRepository.deleteScript(id);
  }

  /**
   * 选择参数转义风格。
   *
   * 远端主机按探测到的 OS 判定（Windows → powershell），探测未完成或失败时
   * 保守回落 bash —— 与本功能之前的行为一致。
   */
  function shellStyleFor(hostId) {
    if (hostId === LOCAL_HOST_ID) return LOCAL_SHELL_STYLE;
    const osName = String(hostService?.findHost?.(hostId)?.osInfo?.os || '').toLowerCase();
    return osName === 'windows' ? 'powershell' : 'bash';
  }

  // ─── 参数渲染 ────────────────────────────────────────────────────────
  /**
   * 将正文里的 {{var}} 占位符替换为 shell 转义后的参数值。
   *
   * @param {object} script - 脚本对象
   * @param {object} rawParams - 调用方提供的参数键值对
   * @param {object} [opts]
   * @param {string} [opts.hostId] - 目标主机 ID，用于选择 shell 转义风格
   * @param {boolean} [opts.allowMissing] - true 时缺键按空串处理（预览用），
   *        false/省略时缺键抛 400（执行用）
   */
  function renderContent(script, rawParams, { hostId, allowMissing = false } = {}) {
    const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) ? rawParams : {};
    const names = extractPlaceholders(script.content);
    const shellStyle = shellStyleFor(hostId);

    if (!allowMissing) {
      const missing = names.filter((name) => params[name] === undefined || params[name] === null);
      if (missing.length > 0) {
        throw validationError(`缺少脚本参数: ${missing.join(', ')}（每个占位符都必须提供键，值可以是空串）`);
      }
    }

    const normalizedParams = {};
    let rendered = script.content;
    for (const name of names) {
      const value = params[name] == null ? '' : String(params[name]);
      normalizedParams[name] = value;
      rendered = rendered.replace(placeholderPattern(name), shellQuote(value, shellStyle));
    }

    return { rendered, normalizedParams, placeholders: names, shellStyle };
  }

  // ─── 执行脚本 ────────────────────────────────────────────────────────
  /**
   * 在单台主机上执行脚本。仅供 agent 的 run_script 工具调用。
   *
   * 渲染完成后对成品命令跑一次灾难命令拦截与用户自定义命令规则：harness
   * guard 的检查只覆盖 execute_command / host_exec（它们的 input 里有
   * command），run_script 传进 guard 的只有 scriptId，规则库看不到任何正文。
   * 不在这里拦，脚本库就成了绕过整套命令安全规则的通道。
   * （自定义 allow 规则不在此豁免风险——run_script 本就无分级审批路径；
   * 黑名单 deny 与红线一样无条件拦。）
   */
  async function runScript(id, { hostId, params, timeoutMs, signal }, { clientIp, source } = {}) {
    const script = scriptRepository.findScript(id);
    if (!script) {
      throw notFoundError('脚本不存在');
    }

    // 目标主机存在性校验
    const host = hostService.findHost(hostId);
    if (!host && hostId !== LOCAL_HOST_ID) {
      throw validationError('目标主机不存在');
    }
    const hostName = host?.name || (hostId === LOCAL_HOST_ID ? '本机' : hostId);

    const { rendered } = renderContent(script, params || {}, { hostId });

    const risk = assessCommandRisk(rendered);
    if (risk.dangerous) {
      throw validationError(`已拦截灾难性命令：${risk.reason}`);
    }
    const commandRules = securitySettingsService?.getSettings?.()?.commandRules;
    const customVerdict = evaluateCommandRules(rendered, commandRules);
    if (customVerdict.denied) {
      throw validationError(`自定义黑名单拦截（规则「${customVerdict.matchedRule?.pattern || ''}」）：脚本渲染出的命令命中黑名单`);
    }

    const auditSource = source || 'agent';
    // 审计/桥接层记录的命令按键名与常见凭据格式脱敏：参数不再有 secret 标记，
    // 改由 redactCredentialPatterns 兜住 PASSWORD=xxx / Bearer xxx / sk-xxx 这类写法。
    const auditCommand = redactCredentialPatterns(rendered);
    const startAt = Date.now();
    try {
      const result = hostId === LOCAL_HOST_ID
        ? await execLocalScript(rendered, { timeout: timeoutMs || DEFAULT_TIMEOUT_MS, signal })
        : await bridgeService.execOnHost(
            hostId,
            rendered,
            timeoutMs || DEFAULT_TIMEOUT_MS,
            { source: 'script_run', clientIp, signal, auditCommand },
          );

      const status = result.exitCode === 0 ? 'success' : 'failed';

      auditService?.log({
        action: 'script_run',
        source: auditSource,
        hostId,
        hostName,
        command: `[${script.name}] ${auditCommand}`.substring(0, 2000),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        clientIp,
        details: JSON.stringify({ scriptId: script.id }),
      });

      return {
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        renderedCommand: auditCommand,
      };
    } catch (err) {
      const durationMs = Date.now() - startAt;

      auditService?.log({
        action: 'script_run',
        source: auditSource,
        hostId,
        hostName,
        command: `[${script.name}] ${auditCommand}`.substring(0, 2000),
        error: err.message,
        durationMs,
        clientIp,
        details: JSON.stringify({ scriptId: script.id }),
      });

      throw err;
    }
  }

  return {
    listScripts,
    getScript,
    createScript,
    updateScript,
    deleteScript,
    renderContent, // 暴露用于"命令预览"接口
    runScript,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

function shellQuote(value, style = 'bash') {
  const s = String(value ?? '');
  if (style === 'powershell') {
    // PowerShell 单引号字符串：单引号字面量用 '' 表示
    return `'${s.replace(/'/g, "''")}'`;
  }
  // POSIX bash：'foo' → "'foo'"，嵌入的单引号 → '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

module.exports = { createScriptService };
