'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const { ROOT_DIR } = require('../config/env');
const { createOneShellCoreTools } = require('../tools/oneshell-core.tools');
const { emitIdeEvent } = require('./ide.events');

function commandHasTruncationMarker(command) {
  const text = String(command || '');
  return text.includes('\u2026') || /\[truncated(?:\s+\d+\s+chars)?\]/i.test(text);
}

function createIdeTools({ bridgeService, hostService, auditService, mcpRegistry, localMcpService, localMcpDeployer, scriptService, aiTaskService, fileService, probeService, probeAgentService, probeAggregatorService, probeTrafficService, probeAlertService, probeDiagService, probeAgentInstallerService, dataDir, cliSandbox, harness, agentRuntime, skillRegistry }) {
  const coreTools = createOneShellCoreTools({
    bridgeService,
    hostService,
    auditService,
    mcpRegistry,
    localMcpService,
    localMcpDeployer,
    scriptService,
    fileService,
    probeService,
    probeAgentService,
    probeAggregatorService,
    probeTrafficService,
    probeAlertService,
    probeDiagService,
    probeAgentInstallerService,
    harness,
  });

  const TOOL_SCHEMAS = [
    {
      name: 'execute_command',
      description:
        '在指定主机上执行非交互式 shell 命令。' +
        '\n- 包管理器加 -y' +
        '\n- 长耗时命令把 timeout 设大（docker pull → 120000）' +
        '\n- 禁止在命令里用 ssh/scp',
      input_schema: {
        type: 'object',
        properties: {
          hostId:  { type: 'string', description: '目标主机 ID（用 list_hosts 获取）' },
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时毫秒，默认 30000' },
        },
        required: ['hostId', 'command'],
      },
    },
    {
      name: 'list_hosts',
      description: '列出 1Shell 中所有已托管主机（含本机），返回 id / name / host / port。',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'load_skill',
      description:
        '读取一个 1Shell 技能（SKILL.md）的完整说明。' +
        '\n系统提示里的「可用技能目录」只给出名称和简述；当某个技能与当前目标相关时，用本工具读取它的完整指令后再遵循。' +
        '\n若技能正文引用了额外相对文件，用 read_remote_file（hostId="local", path="data/skills/<skill_id>/<相对路径>"）按需读取。',
      input_schema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '技能 ID（来自可用技能目录的 skill_id）' },
        },
        required: ['skill_id'],
      },
    },
    {
      name: 'ask_user',
      description:
        '当缺少关键输入、验收标准或方案选择时，暂停当前 AgentRun 并向用户提问。' +
        '\n不要猜项目地址、目标主机、端口、账号、方案偏好或验收条件；缺失时调用本工具。',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题，必须具体、可直接回答' },
          reason: { type: 'string', description: '为什么需要这个信息' },
          options: { type: 'array', items: { type: 'string' }, description: '可选答案列表（可选）' },
        },
        required: ['question'],
      },
    },
    {
      name: 'request_secret',
      description:
        '当目标需要第三方 token、密码、API key 等敏感信息时，暂停当前 AgentRun 并请求用户提供 Secret 引用。' +
        '\n不要要求用户在普通文本中粘贴明文密钥；让用户先保存到 Secret Manager，再只提供 secret ref/id。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '所需 secret 的稳定名称，如 cloudflare_api_token' },
          label: { type: 'string', description: '展示给用户看的名称' },
          reason: { type: 'string', description: '为什么需要这个 secret' },
          provider: { type: 'string', description: '第三方平台或用途，如 Cloudflare/GitHub' },
        },
        required: ['name', 'reason'],
      },
    },
    {
      name: 'verify_outcome',
      description:
        '验证当前目标是否真的完成，并把证据写入 AgentRun outcome。' +
        '\n执行过部署、安装、修改文件、启动服务、配置第三方平台等副作用操作后，结束前必须尽量调用本工具验证。' +
        '\n不要只凭自然语言宣布成功；验证失败时应继续修复或明确说明 blocked/unverified。',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['command', 'http', 'file_exists', 'port', 'manual'], description: '验证类型' },
          reason: { type: 'string', description: '为什么用这个验证方式' },
          hostId: { type: 'string', description: '目标主机 ID，默认 local' },
          command: { type: 'string', description: 'type=command 时执行的只读验证命令，exitCode=0 视为通过' },
          url: { type: 'string', description: 'type=http 时请求的 URL' },
          method: { type: 'string', description: 'HTTP 方法，默认 GET' },
          expectedStatus: { type: 'number', description: '期望 HTTP 状态码；不填则 2xx/3xx 通过' },
          contains: { type: 'string', description: '期望 stdout/stderr 或 HTTP body 包含的文本（可选）' },
          path: { type: 'string', description: 'type=file_exists 时检查的文件/目录路径' },
          host: { type: 'string', description: 'type=port 时检查的主机名/IP；默认来自 hostId 或 127.0.0.1' },
          port: { type: 'number', description: 'type=port 时检查的 TCP 端口' },
          timeout: { type: 'number', description: '超时毫秒，默认 10000' },
          passed: { type: 'boolean', description: 'type=manual 时，用户或外部证据是否确认通过' },
          evidence: { type: 'string', description: '人工/外部验证证据或补充说明' },
        },
        required: ['type'],
      },
    },
    {
      name: 'list_mcp_servers',
      description: '列出 1Shell MCP Server 仓库中已登记的所有 MCP Server。返回 id / name / url / description。',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'add_mcp_server',
      description:
        '向 1Shell MCP Server 仓库添加一个新的 MCP Server。' +
        '\nurl 必须是 http(s):// 开头的远程 SSE/Streamable HTTP 端点。' +
        '\n注意：这是添加到 1Shell 平台仓库，不是修改本地配置文件。',
      input_schema: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'MCP 名称' },
          url:         { type: 'string', description: 'MCP Server URL（http(s)://...）' },
          description: { type: 'string', description: '简要描述' },
          authToken:   { type: 'string', description: '认证 token（可选）' },
          tags:        { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        },
        required: ['name', 'url'],
      },
    },
    {
      name: 'remove_mcp_server',
      description: '从 1Shell MCP Server 仓库中删除一个 MCP Server。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的 MCP Server ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'deploy_local_mcp',
      description:
        '从 GitHub 仓库部署一个本地 MCP Server。自动执行 git clone → npm install → 注册到仓库。' +
        '\n部署完成后 MCP 会注册为 local 类型，用户在工具面板选中时自动启动。' +
        '\n如果不确定启动命令，先 clone 后读 README 或 package.json 来确定。',
      input_schema: {
        type: 'object',
        properties: {
          repoUrl:     { type: 'string', description: 'GitHub 仓库 URL，如 https://github.com/user/repo' },
          name:        { type: 'string', description: 'MCP 名称' },
          command:     { type: 'string', description: '启动命令，如 "node dist/index.js" 或 "npx tsx src/index.ts"' },
          description: { type: 'string', description: '简要描述' },
          tags:        { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        },
        required: ['repoUrl', 'name', 'command'],
      },
    },

    // ── 1Shell Core：脚本管理 ─────────────────────────────────────────
    {
      name: 'list_scripts',
      description: '列出 1Shell 脚本库中的所有脚本。返回 id / name / description / category / tags。',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '按分类过滤（可选）' },
          keyword:  { type: 'string', description: '关键词搜索（可选）' },
        },
        required: [],
      },
    },
    {
      name: 'run_script',
      description:
        '在指定主机上运行一个已有的脚本。' +
        '\n返回 stdout / stderr / exitCode。支持传入参数。',
      input_schema: {
        type: 'object',
        properties: {
          scriptId: { type: 'string', description: '脚本 ID' },
          hostId:   { type: 'string', description: '目标主机 ID' },
          params:   { type: 'object', description: '脚本参数键值对（可选）' },
          timeout:  { type: 'number', description: '超时毫秒，默认 60000' },
        },
        required: ['scriptId', 'hostId'],
      },
    },

    // ── 1Shell Core：探针与审计 ───────────────────────────────────────
    {
      name: 'query_probe',
      description:
        '获取所有主机的探针监控数据快照。' +
        '\n返回每台主机的 CPU / 内存 / 磁盘 / 网络 / 负载等实时指标。',
      input_schema: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: '是否强制刷新（默认 false，使用缓存）' },
        },
        required: [],
      },
    },
    {
      name: 'query_audit',
      description:
        '查询 1Shell 审计日志。返回最近的操作记录。' +
        '\n可按 action / hostId / keyword 过滤。',
      input_schema: {
        type: 'object',
        properties: {
          limit:   { type: 'number', description: '返回条数，默认 30' },
          action:  { type: 'string', description: '按 action 过滤（可选）' },
          hostId:  { type: 'string', description: '按主机 ID 过滤（可选）' },
          keyword: { type: 'string', description: '关键词搜索（可选）' },
        },
        required: [],
      },
    },
  ];

  const TASK_AUTHORING_TOOL_SCHEMAS = [
    {
      name: 'preview_ai_task',
      description:
        '预览并规范化一个 AI 任务模板，但不保存。' +
        '\n任务模板只能表达输入项和流程步骤，不是 DSL、调度器、权限系统或执行运行时。',
      input_schema: taskPayloadSchema(),
    },
    {
      name: 'create_ai_task',
      description:
        '创建一个新的 1Shell AI 任务模板。' +
        '\n只保存 name / description / inputs / steps；真正执行仍由纯 1Shell AI 和现有工具链完成。',
      input_schema: taskPayloadSchema(),
    },
    {
      name: 'update_ai_task',
      description:
        '更新一个已有 1Shell AI 任务模板。' +
        '\n仅在用户明确要修改已有任务，或刚创建后需要修正时使用。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要更新的 AI 任务 ID' },
          ...taskPayloadSchema().properties,
        },
        required: ['id'],
      },
    },
    {
      name: 'get_ai_task',
      description: '读取一个已有 1Shell AI 任务模板，用于继续编辑或确认保存结果。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'AI 任务 ID' },
        },
        required: ['id'],
      },
    },
  ];

  function taskPayloadSchema() {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称' },
        description: { type: 'string', description: '任务说明，可为空' },
        inputs: {
          type: 'array',
          description: '用户执行任务前需要填写的输入项。保持简单，不要设计 DSL。',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '稳定字段名，如 host / service_name / api_token' },
              label: { type: 'string', description: '展示给用户看的名称' },
              type: { type: 'string', description: 'text / textarea / number / boolean / select / secret / host，也允许未来自定义类型' },
              required: { type: 'boolean', description: '是否必填' },
              default: { type: 'string', description: '默认值，可选' },
              placeholder: { type: 'string', description: '输入提示，可选' },
              help: { type: 'string', description: '补充说明，可选' },
              options: {
                type: 'array',
                description: 'type=select 时的选项',
                items: {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                    label: { type: 'string' },
                  },
                  required: ['value'],
                },
              },
            },
            required: ['key', 'label', 'type'],
          },
        },
        steps: {
          type: 'array',
          description: '流程步骤卡片。每一步是给 1Shell AI 的自然语言执行说明。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '步骤标题' },
              instruction: { type: 'string', description: '步骤说明' },
            },
            required: ['title', 'instruction'],
          },
        },
      },
      required: ['name', 'inputs', 'steps'],
    };
  }

  function buildToolSchemas() {
    const seen = new Set();
    const merged = [];
    for (const tool of coreTools.getToolSchemas('ide').concat(TOOL_SCHEMAS)) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      merged.push(tool);
    }
    return merged;
  }

  const CORE_DELEGATED_TOOL_NAMES = new Set([
    'execute_command',
    'list_hosts',
    'list_remote_dir',
    'read_remote_file',
    'write_remote_file',
    'create_directory',
    'delete_path',
    'rename_path',
    'upload_file',
    'download_file',
    'list_scripts',
    'run_script',
    'list_mcp_servers',
    'add_mcp_server',
    'remove_mcp_server',
    'deploy_local_mcp',
    'query_audit',
    'query_probe',
    'list_probes',
    'get_probe',
    'get_probe_samples',
    'get_probe_timeseries',
    'get_probe_traffic',
    'list_probe_alerts',
    'ack_probe_alert',
    'install_probe_agent',
    'restart_probe_agent',
    'uninstall_probe_agent',
    'probe_diag_ping',
    'probe_diag_http',
    'probe_diag_dns',
  ]);

  // ─── Handler 实现 ────────────────────────────────────────────────────

  const WRITE_PATTERNS = /\b(rm|mv|cp|mkdir|touch|chmod|chown|dd|mkfs|tee|install|npm|npx|pip|apt|yum|dnf|brew|git\s+clone|git\s+pull|git\s+checkout|wget|curl\s+-[^\s]*[oO]|docker\s+(run|pull|build|exec)|>\s|>>)\b/i;

  // Agent approval: approved commands (sessionId -> Set<commandHash>)
  const approvedCommands = new Map();

  function approveCommand(sessionId, command) {
    if (!approvedCommands.has(sessionId)) approvedCommands.set(sessionId, new Set());
    approvedCommands.get(sessionId).add(command.trim());
  }

  function isApproved(sessionId, command) {
    return approvedCommands.get(sessionId)?.has(command.trim()) || false;
  }

  function truncateVerifierText(value, max = 4000) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
  }

  function verifierTimeout(input) {
    const timeout = Number(input?.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) return 10000;
    return Math.max(1000, Math.min(timeout, 240000));
  }

  function normalizeVerifierType(value) {
    return String(value || '').trim().toLowerCase().replace(/-/g, '_');
  }

  function verificationToolResult(verification) {
    const normalized = {
      type: verification.type || 'unknown',
      ok: verification.ok === true,
      status: verification.status || (verification.ok ? 'passed' : 'failed'),
      taskStatus: verification.taskStatus || (verification.ok ? 'verified' : (verification.status === 'unsupported' ? 'unverified' : 'failed')),
      target: verification.target || '',
      reason: verification.reason || '',
      evidence: truncateVerifierText(verification.evidence || '', 4000),
      reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
      checkedAt: new Date().toISOString(),
      data: verification.data && typeof verification.data === 'object' ? verification.data : {},
    };
    const lines = [
      `[verification:${normalized.type}] ${normalized.status}`,
      `taskStatus: ${normalized.taskStatus}`,
      normalized.target ? `target: ${normalized.target}` : '',
      normalized.reason ? `reason: ${normalized.reason}` : '',
      normalized.reasons.length ? `reasons: ${normalized.reasons.join('; ')}` : '',
      normalized.evidence ? `evidence:\n${normalized.evidence}` : '',
    ].filter(Boolean);
    return { content: lines.join('\n'), is_error: !normalized.ok, verification: normalized };
  }

  async function runVerifierCommand(hostId, command, timeout, signal) {
    const targetHost = String(hostId || 'local').trim() || 'local';
    if (targetHost === 'local') {
      const { exec: childExec } = require('child_process');
      return await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(makeVerifierAbortError());
        let settled = false;
        const child = childExec(command, { timeout, maxBuffer: 8 * 1024 * 1024, cwd: ROOT_DIR }, (e, stdout, stderr) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener?.('abort', onAbort);
          resolve({ stdout: stdout || '', stderr: (e && !stderr) ? e.message : (stderr || ''), exitCode: e ? (e.code || 1) : 0, durationMs: 0 });
        });
        const onAbort = () => {
          if (settled) return;
          settled = true;
          try { child.kill(); } catch { /* ignore */ }
          reject(makeVerifierAbortError());
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }
    return await bridgeService.execOnHost(targetHost, command, timeout, { source: 'ide-verifier' });
  }

  function makeVerifierAbortError() {
    const e = new Error('Cancelled');
    e.name = 'AbortError';
    e.code = 'CANCELLED';
    return e;
  }

  function commandEvidence(result) {
    return [
      `exitCode=${result.exitCode}`,
      result.stdout ? `stdout:\n${truncateVerifierText(result.stdout, 1800)}` : '',
      result.stderr ? `stderr:\n${truncateVerifierText(result.stderr, 1800)}` : '',
    ].filter(Boolean).join('\n');
  }

  async function verifyCommandOutcome(input, signal) {
    const command = String(input.command || '').trim();
    const hostId = String(input.hostId || 'local').trim() || 'local';
    const contains = String(input.contains || '').trim();
    if (!command) return verificationToolResult({ type: 'command', ok: false, status: 'failed', target: hostId, reason: input.reason, reasons: ['command_required'], evidence: 'command 为空' });
    if (commandHasTruncationMarker(command)) {
      return verificationToolResult({
        type: 'command',
        ok: false,
        status: 'failed',
        target: hostId,
        reason: input.reason,
        reasons: ['command_truncated'],
        evidence: '验证命令疑似被摘要截断（包含省略号或 [truncated] 标记），未执行。',
      });
    }
    const result = await runVerifierCommand(hostId, command, verifierTimeout(input), signal);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    const reasons = [];
    if (Number(result.exitCode) !== 0) reasons.push(`exit_code_${result.exitCode}`);
    if (contains && !combined.includes(contains)) reasons.push('expected_text_missing');
    return verificationToolResult({
      type: 'command',
      ok: reasons.length === 0,
      status: reasons.length === 0 ? 'passed' : 'failed',
      target: `${hostId}: ${truncateVerifierText(command, 300)}`,
      reason: input.reason,
      reasons,
      evidence: commandEvidence(result),
      data: { hostId, command: truncateVerifierText(command, 1000), exitCode: result.exitCode, contains },
    });
  }

  async function verifyHttpOutcome(input, signal) {
    const url = String(input.url || '').trim();
    if (!url) return verificationToolResult({ type: 'http', ok: false, status: 'failed', reason: input.reason, reasons: ['url_required'], evidence: 'url 为空' });
    const timeout = verifierTimeout(input);
    const method = String(input.method || 'GET').trim().toUpperCase() || 'GET';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { method, signal: controller.signal });
      const body = await res.text();
      const expectedStatus = Number(input.expectedStatus);
      const contains = String(input.contains || '').trim();
      const statusOk = Number.isFinite(expectedStatus) && expectedStatus > 0
        ? res.status === expectedStatus
        : (res.status >= 200 && res.status < 400);
      const containsOk = !contains || body.includes(contains);
      const reasons = [];
      if (!statusOk) reasons.push(`status_${res.status}`);
      if (!containsOk) reasons.push('expected_text_missing');
      return verificationToolResult({
        type: 'http',
        ok: statusOk && containsOk,
        status: statusOk && containsOk ? 'passed' : 'failed',
        target: `${method} ${url}`,
        reason: input.reason,
        reasons,
        evidence: [`HTTP ${res.status} ${res.statusText}`, contains ? `contains=${containsOk}` : '', `body:\n${truncateVerifierText(body, 2500)}`].filter(Boolean).join('\n'),
        data: { url, method, status: res.status, expectedStatus: Number.isFinite(expectedStatus) ? expectedStatus : null, contains },
      });
    } catch (e) {
      if (e?.name === 'AbortError' && signal?.aborted) throw makeVerifierAbortError();
      return verificationToolResult({ type: 'http', ok: false, status: 'failed', target: `${method} ${url}`, reason: input.reason, reasons: ['request_failed'], evidence: e.message });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function verifyFileExistsOutcome(input, signal) {
    const targetPath = String(input.path || '').trim();
    const hostId = String(input.hostId || 'local').trim() || 'local';
    if (!targetPath) return verificationToolResult({ type: 'file_exists', ok: false, status: 'failed', reason: input.reason, reasons: ['path_required'], evidence: 'path 为空' });
    if (hostId === 'local') {
      const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(ROOT_DIR, targetPath);
      const exists = fs.existsSync(abs);
      let detail = exists ? 'exists' : 'missing';
      if (exists) {
        try {
          const stat = fs.statSync(abs);
          detail = `${stat.isDirectory() ? 'directory' : 'file'} size=${stat.size}`;
        } catch (e) {
          detail = `exists but stat failed: ${e.message}`;
        }
      }
      return verificationToolResult({
        type: 'file_exists',
        ok: exists,
        status: exists ? 'passed' : 'failed',
        target: `${hostId}:${targetPath}`,
        reason: input.reason,
        reasons: exists ? [] : ['path_missing'],
        evidence: detail,
        data: { hostId, path: targetPath, exists },
      });
    }
    const quoted = shellQuote(targetPath);
    const command = `[ -e ${quoted} ] && { if [ -d ${quoted} ]; then echo directory; else echo file; fi; } || { echo missing; exit 1; }`;
    const result = await runVerifierCommand(hostId, command, verifierTimeout(input), signal);
    const okStatus = Number(result.exitCode) === 0;
    return verificationToolResult({
      type: 'file_exists',
      ok: okStatus,
      status: okStatus ? 'passed' : 'failed',
      target: `${hostId}:${targetPath}`,
      reason: input.reason,
      reasons: okStatus ? [] : ['path_missing'],
      evidence: commandEvidence(result),
      data: { hostId, path: targetPath, exists: okStatus },
    });
  }

  function checkTcpPort(host, port, timeout, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeVerifierAbortError());
      const socket = net.createConnection({ host, port });
      let settled = false;
      const finish = (okStatus, evidence) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        try { socket.destroy(); } catch { /* ignore */ }
        resolve({ ok: okStatus, evidence });
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(makeVerifierAbortError());
      };
      const timer = setTimeout(() => finish(false, `connect timeout after ${timeout}ms`), timeout);
      socket.once('connect', () => finish(true, 'tcp connect ok'));
      socket.once('error', (e) => finish(false, e.message));
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  async function verifyPortOutcome(input, signal) {
    const port = Number(input.port);
    const hostId = String(input.hostId || 'local').trim() || 'local';
    const host = String(input.host || '').trim() || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return verificationToolResult({ type: 'port', ok: false, status: 'failed', reason: input.reason, reasons: ['invalid_port'], evidence: `port=${input.port}` });
    }
    const timeout = verifierTimeout(input);
    if (hostId === 'local') {
      const result = await checkTcpPort(host, port, timeout, signal);
      return verificationToolResult({
        type: 'port',
        ok: result.ok,
        status: result.ok ? 'passed' : 'failed',
        target: `${host}:${port}`,
        reason: input.reason,
        reasons: result.ok ? [] : ['port_unreachable'],
        evidence: result.evidence,
        data: { hostId, host, port },
      });
    }
    const py = `import socket,sys\nhost=${JSON.stringify(host)}\nport=${JSON.stringify(port)}\ntimeout=${JSON.stringify(Math.ceil(timeout / 1000))}\ns=socket.socket()\ns.settimeout(timeout)\ntry:\n    s.connect((host, port))\n    print('tcp connect ok')\n    sys.exit(0)\nexcept Exception as e:\n    print(str(e))\n    sys.exit(1)\nfinally:\n    s.close()\n`;
    const command = `(python3 -c ${shellQuote(py)} || python -c ${shellQuote(py)})`;
    const result = await runVerifierCommand(hostId, command, timeout, signal);
    const okStatus = Number(result.exitCode) === 0;
    return verificationToolResult({
      type: 'port',
      ok: okStatus,
      status: okStatus ? 'passed' : 'failed',
      target: `${hostId}:${host}:${port}`,
      reason: input.reason,
      reasons: okStatus ? [] : ['port_unreachable'],
      evidence: commandEvidence(result),
      data: { hostId, host, port },
    });
  }

  function verifyManualOutcome(input) {
    const evidence = String(input.evidence || '').trim();
    if (!evidence) {
      return verificationToolResult({
        type: 'manual',
        ok: false,
        status: 'unsupported',
        taskStatus: 'unverified',
        reason: input.reason,
        reasons: ['manual_evidence_required'],
        evidence: 'manual 验证需要用户确认或外部系统证据；不能只由 AI 自己宣布成功。',
      });
    }
    return verificationToolResult({
      type: 'manual',
      ok: false,
      status: 'unsupported',
      taskStatus: 'unverified',
      target: 'manual',
      reason: input.reason,
      reasons: ['manual_verification_recorded_without_runtime_confirmation'],
      evidence: `manual evidence recorded, but v0 cannot promote it to verified automatically:\n${evidence}`,
      data: { passed: input.passed === true },
    });
  }

  async function handleVerifyOutcome(input = {}, { signal } = {}) {
    const type = normalizeVerifierType(input.type);
    if (type === 'command') return await verifyCommandOutcome(input, signal);
    if (type === 'http') return await verifyHttpOutcome(input, signal);
    if (type === 'file_exists') return await verifyFileExistsOutcome(input, signal);
    if (type === 'port') return await verifyPortOutcome(input, signal);
    if (type === 'manual') return verifyManualOutcome(input);
    return verificationToolResult({ type: type || 'unknown', ok: false, status: 'unsupported', taskStatus: 'unverified', reason: input.reason, reasons: ['unsupported_verifier_type'], evidence: `unsupported type: ${input.type || ''}` });
  }

  function emitTaskSaved(socket, payload = {}) {
    if (!socket?.emit) return;
    emitIdeEvent(socket, 'ide:task-saved', payload);
  }

  async function handle(name, input, { socket, sessionId, runId, safeMode, session, signal, requestApproval, allowApproval, approvalGranted, preApproved, approvalMode, onToolDelta }) {
    if (CORE_DELEGATED_TOOL_NAMES.has(name)) {
      return coreTools.handle(name, input || {}, { socket, sessionId, runId, safeMode, session, signal, requestApproval, allowApproval, approvalGranted, preApproved, approvalMode, onToolDelta, source: 'ide' });
    }

    switch (name) {
      case 'load_skill': {
        if (!skillRegistry?.getSkill) return err('Skill registry 未初始化');
        const skillId = String(input?.skill_id || input?.id || '').trim();
        if (!skillId) return err('skill_id 为必填');
        const skill = skillRegistry.getSkill(skillId);
        if (!skill) return err(`技能不存在: ${skillId}`);
        const body = skillRegistry.getSkillBody?.(skillId) || '';
        const header = [
          `# Skill: ${skill.name || skill.id} (${skill.id})`,
          skill.description ? `Description: ${skill.description}` : '',
          Array.isArray(skill.tags) && skill.tags.length ? `Tags: ${skill.tags.join(', ')}` : '',
        ].filter(Boolean).join('\n');
        return ok(`${header}\n\n${body}`.trim() || `技能 ${skillId} 没有正文内容。`);
      }

      case 'preview_ai_task': {
        const blocked = requireTaskAuthoringSession(session, name, input);
        if (blocked) return blocked;
        if (!aiTaskService?.previewTask) return err('AI 任务服务未初始化');
        try {
          const task = aiTaskService.previewTask(input || {});
          return ok(formatJson({
            ok: true,
            status: 'draft',
            task,
            message: 'Preview only. Call create_ai_task to save.',
          }));
        } catch (e) {
          return err(e.message);
        }
      }

      case 'create_ai_task': {
        const blocked = requireTaskAuthoringSession(session, name, input);
        if (blocked) return blocked;
        if (!aiTaskService?.createTask) return err('AI 任务服务未初始化');
        try {
          const createdTask = aiTaskService.createTask(input || {});
          emitTaskSaved(socket, {
            sessionId,
            runId,
            action: 'created',
            taskId: createdTask.id,
            task: createdTask,
          });
          return ok(formatJson({
            ok: true,
            task: createdTask,
            message: 'AI 任务已保存。可在 功能 / AI 任务 中继续编辑或执行；执行失败时也可让 AI 直接修改该任务。',
          }));
        } catch (e) {
          return err(e.message);
        }
      }

      case 'update_ai_task': {
        const blocked = requireTaskAuthoringSession(session, name, input);
        if (blocked) return blocked;
        if (!aiTaskService?.updateTask) return err('AI 任务服务未初始化');
        const id = String(input?.id || '').trim();
        if (!id) return err('id 为必填');
        try {
          const existing = aiTaskService.getTask?.(id);
          if (!existing) return err(`AI 任务不存在: ${id}`);
          const payload = {
            name: input?.name ?? existing.name,
            description: input?.description ?? existing.description,
            inputs: input?.inputs ?? existing.inputs,
            steps: input?.steps ?? existing.steps,
          };
          const task = aiTaskService.updateTask(id, payload);
          if (!task) return err(`AI 任务不存在: ${id}`);
          emitTaskSaved(socket, {
            sessionId,
            runId,
            action: 'updated',
            taskId: task.id,
            task,
          });
          return ok(formatJson({ ok: true, task, message: 'AI 任务已更新。' }));
        } catch (e) {
          return err(e.message);
        }
      }

      case 'get_ai_task': {
        const blocked = requireTaskAuthoringSession(session, name, input);
        if (blocked) return blocked;
        if (!aiTaskService?.getTask) return err('AI 任务服务未初始化');
        const id = String(input?.id || '').trim();
        if (!id) return err('id 为必填');
        const task = aiTaskService.getTask(id);
        if (!task) return err(`AI 任务不存在: ${id}`);
        return ok(formatJson({ ok: true, task }));
      }

      case 'execute_command': {
        const hostId = String(input.hostId || '').trim();
        let command = String(input.command || '').trim();
        const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : 30000;
        if (!hostId || !command) return err('hostId 和 command 为必填');

        try {
          if (hostId === 'local') {
            const { exec: childExec } = require('child_process');
            const result = await new Promise((resolve) => {
              childExec(command, { timeout, maxBuffer: 8 * 1024 * 1024, cwd: ROOT_DIR }, (e, stdout, stderr) => {
                resolve({ stdout: stdout || '', stderr: (e && !stderr) ? e.message : (stderr || ''), exitCode: e ? (e.code || 1) : 0, durationMs: 0 });
              });
            });
            emitTool(socket, sessionId, name, { command, hostId }, result);
            return execResult(result);
          }
          const result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'ide' });
          emitTool(socket, sessionId, name, { command, hostId }, result);
          auditService?.log?.({ action: 'ide_exec', hostId, command: command.substring(0, 2000), exitCode: result.exitCode });
          return execResult(result);
        } catch (e) {
          return err(e.message);
        }
      }

      case 'list_hosts': {
        return coreTools.handle(name, input || {}, { socket, sessionId, runId, safeMode, session, signal, requestApproval, allowApproval, approvalGranted, preApproved, approvalMode, onToolDelta, source: 'ide' });
      }

      case 'verify_outcome': {
        try {
          const result = await handleVerifyOutcome(input || {}, { signal });
          emitTool(socket, sessionId, name, input || {}, result.verification || result.content);
          return result;
        } catch (e) {
          if (e?.name === 'AbortError' || e?.code === 'CANCELLED') throw e;
          return verificationToolResult({
            type: normalizeVerifierType(input?.type) || 'unknown',
            ok: false,
            status: 'failed',
            taskStatus: 'failed',
            reason: input?.reason,
            reasons: ['verifier_exception'],
            evidence: e.message,
          });
        }
      }

      case 'list_mcp_servers': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        const servers = mcpRegistry.listServers();
        if (servers.length === 0) return ok('（仓库中暂无 MCP Server）');
        const lines = servers.map(s => {
          const typeTag = (s.type === 'local' || s.command) ? '[本地]' : '[远程]';
          const loc = s.type === 'local' ? `cmd=${s.command || ''}` : `url=${s.url}`;
          return `${typeTag} id=${s.id}  name="${s.name}"  ${loc}  ${s.description ? '— ' + s.description : ''}`;
        });
        return ok(lines.join('\n'));
      }

      case 'add_mcp_server': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        try {
          const server = mcpRegistry.createServer({
            name: input.name,
            url: input.url || '',
            command: input.command || '',
            installDir: input.installDir || '',
            description: input.description || '',
            authToken: input.authToken || '',
            tags: input.tags || [],
          });
          const typeLabel = server.type === 'local' ? '本地' : '远程';
          return ok(`${typeLabel} MCP Server 已添加到 1Shell 仓库: id=${server.id} name="${server.name}"`);
        } catch (e) {
          return err(`添加失败: ${e.message}`);
        }
      }

      case 'remove_mcp_server': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        const id = String(input.id || '').trim();
        if (!id) return err('id 为空');
        if (localMcpService) localMcpService.stop(id);
        const removed = mcpRegistry.deleteServer(id);
        return removed ? ok(`MCP Server "${id}" 已从仓库中删除。`) : err(`MCP Server 不存在: ${id}`);
      }

      case 'deploy_local_mcp': {
        if (!mcpRegistry) return err('MCP Registry 未初始化');
        const repoUrl = String(input.repoUrl || '').trim();
        const mcpName = String(input.name || '').trim();
        const command = String(input.command || '').trim();
        if (!repoUrl || !mcpName || !command) return err('repoUrl、name、command 均为必填');

        const mcpDir = path.join(ROOT_DIR, 'data', 'local-mcp');
        const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'mcp';
        const installDir = path.join(mcpDir, repoName);

        try {
          fs.mkdirSync(mcpDir, { recursive: true });

          // clone
          const { exec: childExec } = require('child_process');
          const cloneResult = await new Promise((resolve) => {
            const cloneCmd = fs.existsSync(installDir)
              ? `cd "${installDir}" && git pull`
              : `git clone "${repoUrl}" "${installDir}"`;
            childExec(cloneCmd, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
              resolve({ stdout: stdout || '', stderr: (e && !stderr) ? e.message : (stderr || ''), exitCode: e ? 1 : 0 });
            });
          });
          if (cloneResult.exitCode !== 0 && !fs.existsSync(installDir)) {
            return err(`git clone 失败: ${cloneResult.stderr.slice(0, 300)}`);
          }

          // install
          const pkgJson = path.join(installDir, 'package.json');
          if (fs.existsSync(pkgJson)) {
            const installResult = await new Promise((resolve) => {
              childExec('npm install --production', { timeout: 180000, maxBuffer: 8 * 1024 * 1024, cwd: installDir }, (e, stdout, stderr) => {
                resolve({ exitCode: e ? 1 : 0, stderr: (e && !stderr) ? e.message : (stderr || '') });
              });
            });
            if (installResult.exitCode !== 0) {
              return err(`npm install 失败: ${installResult.stderr.slice(0, 300)}`);
            }
          }

          // register
          const server = mcpRegistry.createServer({
            name: mcpName,
            command,
            installDir,
            description: input.description || `部署自 ${repoUrl}`,
            tags: input.tags || ['local', 'deployed'],
          });

          return ok(
            `本地 MCP "${mcpName}" 部署成功！\n` +
            `- 仓库: ${repoUrl}\n` +
            `- 安装目录: ${installDir}\n` +
            `- 启动命令: ${command}\n` +
            `- 已注册 ID: ${server.id}\n` +
            `用户可在工具面板中选中该 MCP 来启动它。`
          );
        } catch (e) {
          return err(`部署失败: ${e.message}`);
        }
      }

      // ── 1Shell Core：脚本管理 ──────────────────────────────────────
      case 'list_scripts': {
        if (!scriptService) return err('scriptService 未初始化');
        try {
          const scripts = scriptService.listScripts({ category: input.category, keyword: input.keyword });
          if (scripts.length === 0) return ok('（脚本库为空）');
          const lines = scripts.map(s =>
            `id=${s.id}  name="${s.name}"  category=${s.category || '-'}  tags=[${(s.tags || []).join(',')}]  ${s.description ? '— ' + s.description.slice(0, 80) : ''}`
          );
          return ok(lines.join('\n'));
        } catch (e) { return err(e.message); }
      }

      case 'run_script': {
        if (!scriptService) return err('scriptService 未初始化');
        const scriptId = String(input.scriptId || '').trim();
        const hostId = String(input.hostId || '').trim();
        if (!scriptId || !hostId) return err('scriptId 和 hostId 为必填');
        try {
          const result = await scriptService.runScript(scriptId, {
            hostId,
            params: input.params || {},
            confirmed: true,
            timeoutMs: input.timeout || 60000,
          });
          return ok(formatExec(result));
        } catch (e) { return err(e.message); }
      }

      // ── 1Shell Core：探针与审计 ─────────────────────────────────────
      case 'query_probe': {
        if (!probeService) return err('probeService 未初始化');
        try {
          const snapshot = await probeService.getSnapshot({ refresh: !!input.refresh });
          if (!snapshot || !snapshot.probes || snapshot.probes.length === 0) return ok('（无探针数据）');
          const lines = snapshot.probes.map(p => {
            const h = p.host || p.name || p.hostId || '?';
            if (p.error) return `${h}  ✘ ${p.error}`;
            const cpu = p.cpuUsage != null ? `CPU=${p.cpuUsage}%` : '';
            const mem = p.memUsage != null ? `MEM=${p.memUsage}%` : '';
            const disk = p.diskUsage != null ? `DISK=${p.diskUsage}%` : '';
            const load = p.loadAvg ? `LOAD=${p.loadAvg}` : '';
            const uptime = p.uptime ? `UP=${p.uptime}` : '';
            return `${h}  ${[cpu, mem, disk, load, uptime].filter(Boolean).join('  ')}`;
          });
          return ok(lines.join('\n'));
        } catch (e) { return err(e.message); }
      }

      case 'query_audit': {
        if (!auditService) return err('auditService 未初始化');
        try {
          const result = auditService.query({
            limit: input.limit || 30,
            action: input.action,
            hostId: input.hostId,
            keyword: input.keyword,
          });
          const logs = result.logs || result || [];
          if (logs.length === 0) return ok('（无审计记录）');
          const lines = logs.map(l =>
            `[${l.createdAt || l.ts || '?'}] action=${l.action}  host=${l.hostId || '-'}  ${l.command ? 'cmd=' + l.command.slice(0, 100) : ''} ${l.source ? 'src=' + l.source : ''}`
          );
          return ok(lines.join('\n'));
        } catch (e) { return err(e.message); }
      }

      case 'invoke_claude_code':
        return handleInvokeClaudeCode(input, { session });

      default: {
        const coreResult = await coreTools.handle(name, input || {}, { socket, sessionId, runId, safeMode, session, signal, requestApproval, allowApproval, approvalGranted, preApproved, approvalMode, onToolDelta, source: 'ide' });
        if (!coreResult.is_error || !String(coreResult.content || '').startsWith('[ERROR] 未知工具:')) return coreResult;
        return err(`未知工具: ${name}`);
      }
    }
  }

  // ─── Claude Code 协作 ──────────────────────────────────────────────

  const CLAUDE_CODE_TOOL = {
    name: 'invoke_claude_code',
    description:
      '将复杂编码目标委托给 Claude Code（专业 AI 编程助手）执行。' +
      '\nClaude Code 会通过 MCP 访问 1Shell 的所有主机，自主探测环境并完成目标。' +
      '\n适用于：编写代码、多步骤调试、复杂脚本生成、架构分析。' +
      '\n注意：每次调用耗时较长（1-5 分钟），简单目标请自行处理。',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '清晰描述 Claude Code 需要完成的目标' },
        hostId: { type: 'string', description: '目标主机 ID（可选，Claude Code 也可以自行 list_hosts 查看）' },
      },
      required: ['goal'],
    },
  };

  async function handleInvokeClaudeCode(input, { session }) {
    const goal = String(input.goal || '').trim();
    if (!goal) return err('goal 为空');

    if (!cliSandbox) return err('CLI 沙箱未初始化，无法调用 Claude Code');

    const os = require('os');
    const { execFile } = require('child_process');
    const isWin = os.platform() === 'win32';

    try {
      cliSandbox.ensureSandbox('claude-code', { cwd: ROOT_DIR });
    } catch (e) {
      return err(`沙箱初始化失败: ${e.message}`);
    }

    let command = 'claude';
    let baseArgs = [];
    if (isWin) {
      const { findExecutableCommand } = require('../agents/windows-compat');
      const resolved = findExecutableCommand('claude');
      if (resolved) {
        command = resolved.command;
        baseArgs = resolved.args;
      }
    }

    const launchArgs = cliSandbox.buildLaunchArgs('claude-code', { cwd: ROOT_DIR });
    const launchEnv = cliSandbox.buildLaunchEnv('claude-code', { cwd: ROOT_DIR });

    let prompt = goal;
    if (input.hostId) {
      const host = hostService.findHost(input.hostId);
      if (host) {
        const desc = host.type === 'local' ? '本机' : `${host.username || 'root'}@${host.host}:${host.port || 22}`;
        prompt = `目标主机: ${host.name} (${desc}), hostId="${host.id}"\n\n${goal}`;
      }
    }

    const args = [...baseArgs, ...launchArgs, '-p', prompt];
    const env = { ...process.env, ...launchEnv, FORCE_COLOR: '0' };

    const TIMEOUT = 5 * 60 * 1000;

    const result = await new Promise((resolve) => {
      const child = execFile(command, args, {
        timeout: TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: ROOT_DIR,
        env,
      }, (error, stdout, stderr) => {
        if (session) session.activeChildProcess = null;
        if (error && error.killed) {
          resolve({ content: '[已中断] Claude Code 执行被取消或超时。', is_error: true });
          return;
        }
        const output = (stdout || '').trim();
        if (!output && error) {
          resolve({ content: `[ERROR] Claude Code 执行失败: ${error.message}\n${(stderr || '').trim()}`, is_error: true });
          return;
        }
        resolve({ content: output || '(Claude Code 无输出)', is_error: false });
      });

      if (session) session.activeChildProcess = child;
    });

    auditService?.log?.({ action: 'ide_invoke_claude_code', goal: goal.substring(0, 500) });
    return result;
  }

  function requireTaskAuthoringSession(session, toolName = '', input = {}) {
    if (String(session?.entry || '') === 'task') return null;
    const repair = session?.taskRepair && typeof session.taskRepair === 'object' ? session.taskRepair : {};
    const repairAuthorized = String(session?.entry || '') === 'task_run' && repair.authorized === true;
    if (repairAuthorized) {
      const name = String(toolName || '').trim();
      if (name === 'create_ai_task') return err('任务执行修复模式只能修订当前任务，不能创建新任务');
      if (!['preview_ai_task', 'update_ai_task', 'get_ai_task'].includes(name)) {
        return err('任务执行修复模式只允许预览、读取或更新当前任务');
      }
      const expectedTaskId = String(repair.taskId || '').trim();
      if (!expectedTaskId) return err('任务执行修复模式缺少当前任务 ID，已拒绝修改任务');
      const requestedTaskId = String(input?.id || input?.taskId || '').trim();
      if ((name === 'update_ai_task' || name === 'get_ai_task') && expectedTaskId && requestedTaskId && requestedTaskId !== expectedTaskId) {
        return err(`任务执行修复模式只能修改当前任务：${expectedTaskId}`);
      }
      return null;
    }
    return err('AI 任务创作工具只能在 IDE 的 /task 模式中使用');
  }

  function formatJson(value) {
    return JSON.stringify(value, null, 2);
  }

  function ok(text)  { return { content: text, is_error: false }; }
  function err(text) { return { content: `[ERROR] ${text}`, is_error: true }; }

  function execResult(result = {}) {
    const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 1;
    const raw = {
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      exitCode,
      durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : 0,
    };
    return {
      content: formatExec(raw),
      is_error: exitCode !== 0,
      raw,
      exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      durationMs: raw.durationMs,
    };
  }

  function formatExec({ stdout, stderr, exitCode, durationMs }) {
    const parts = [];
    if (stdout) parts.push(`[stdout]\n${stdout.trimEnd()}`);
    if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
    parts.push(`[exitCode] ${exitCode}`);
    parts.push(`[durationMs] ${durationMs || 0}`);
    return parts.join('\n\n');
  }

  function emitTool(socket, sessionId, toolName, input, result) {
    if (!socket) return;
    emitIdeEvent(socket, 'ide:tool-call', { sessionId, tool: toolName, input, result: {
      stdout: result.stdout?.substring(0, 4000),
      stderr: result.stderr?.substring(0, 2000),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }});
  }

  return { TOOL_SCHEMAS: buildToolSchemas(), TASK_AUTHORING_TOOL_SCHEMAS, CLAUDE_CODE_TOOL, handle, approveCommand };
}

module.exports = { createIdeTools };
