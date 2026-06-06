'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { EventEmitter } = require('events');
const { ROOT_DIR } = require('../config/env');
const { createOneShellCoreTools } = require('../tools/oneshell-core.tools');
const { emitIdeEvent } = require('./ide.events');
const { parseFrontmatter } = require('../skills/registry');
const { normalizeProgram } = require('../programs/program-schema');

const ALLOWED_DIRS = ['data/skills', 'data/programs'];

function isPathAllowed(relPath) {
  const resolved = path.resolve(ROOT_DIR, relPath);
  return ALLOWED_DIRS.some(d => {
    const abs = path.join(ROOT_DIR, d);
    return resolved.startsWith(abs + path.sep) || resolved === abs;
  });
}

function createIdeTools({ bridgeService, hostService, skillRegistry, programEngine, programRegistry, skillRunner, auditService, mcpRegistry, localMcpService, localMcpDeployer, scriptService, fileService, probeService, probeAgentService, probeAggregatorService, probeTrafficService, probeAlertService, probeDiagService, probeAgentInstallerService, dataDir, onFileWritten, cliSandbox, harness }) {
  const coreTools = createOneShellCoreTools({
    bridgeService,
    hostService,
    auditService,
    mcpRegistry,
    localMcpService,
    localMcpDeployer,
    scriptService,
    fileService,
    programEngine,
    programRegistry,
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
      name: 'read_file',
      description:
        '读取 1Shell 产物文件（data/skills/ / data/programs/ 内）。' +
        '\n返回文件内容（UTF-8）。路径是相对于 1Shell 根目录的相对路径。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，如 data/skills/my-skill/SKILL.md' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        '将内容写入 1Shell 产物文件（data/skills/ / data/programs/）。' +
        '\n自动创建父目录。路径越界会被拒绝。',
      input_schema: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: '相对路径' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'list_artifacts',
      description:
        '列出已有的 Skill / Program 产物。' +
        '\n返回每个产物的 id / name / kind / description。',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['skill', 'program', 'all'], description: '筛选类型，默认 all' },
        },
        required: [],
      },
    },
    {
      name: 'list_skills',
      description:
        '列出当前 1Shell 装载的所有 Skill 的 id 与 description。' +
        '\nSkill 是给当前 AI 的"行为指令包"——写在 markdown 里，决定该如何完成某类任务。' +
        '\n本工具不返回 SKILL.md body，只返回元信息；判断 description 是否匹配当前任务后，用 load_skill 加载具体 body 再按其指示执行。',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'load_skill',
      description:
        '加载指定 Skill 的 SKILL.md body 到当前对话上下文。' +
        '\n返回 markdown 全文。把它当成"当前任务该怎么做"的权威指令——按里面写的步骤、约束、风格执行。' +
        '\n常见用法：用户说"创建一个 program" → list_skills 看哪个匹配 → load_skill 读 body → 按 body 推进。',
      input_schema: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Skill id（来自 list_skills）' },
        },
        required: ['skillId'],
      },
    },
    {
      name: 'write_program',
      description:
        '原子写入或更新一个 1Shell Program 的所有文件到 data/programs/<programId>/，写完自动 reload registry。' +
        '\n用于完成创作意图后一次性落盘——避免逐个 write_file 反复弹审批。' +
        '\nfiles 里 path 可写完整 data/programs/<id>/...，也可写 program.yaml / ui/App.jsx 这种相对路径，工具按 programId 自动归一化。' +
        '\n安全模式下只弹一次审批，列出所有要写的文件路径。',
      input_schema: {
        type: 'object',
        properties: {
          programId: { type: 'string', description: 'Program ID（kebab-case）' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '相对 data/programs/<programId>/ 或完整路径' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['programId', 'files'],
      },
    },
    {
      name: 'run_skill',
      description:
        '触发运行一个已有的 Skill（走完整 Skill Runner AI-Loop）。' +
        '\n同步等待执行完成，返回所有执行输出（命令结果、AI 思考、渲染结果等）。' +
        '\n适合"写完 → 跑 → 看结果 → 改"的闭环。注意：AI-Loop 型 Skill 可能需要较长时间。',
      input_schema: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Skill ID' },
          hostId:  { type: 'string', description: '目标主机 ID' },
          inputs:  { type: 'object', description: 'Skill inputs 键值对' },
        },
        required: ['skillId', 'hostId'],
      },
    },
    {
      name: 'trigger_program',
      description:
        '手动触发一个 Program 的一次执行。' +
        '\n返回 runId 列表。用于测试刚创建的 Program。',
      input_schema: {
        type: 'object',
        properties: {
          programId:  { type: 'string', description: 'Program ID' },
          hostId:     { type: 'string', description: '目标主机 ID（或 "all"）' },
          actionName: { type: 'string', description: '要触发的 action 名（可选，默认取第一个）' },
        },
        required: ['programId'],
      },
    },
    {
      name: 'query_format',
      description:
        '查询 1Shell 产物的文件格式规范。按需调用——只在你不确定格式时才查。' +
        '\n返回对应类型的完整 schema 文档。',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['skill', 'program', 'tool-api'], description: '要查询的产物类型' },
        },
        required: ['type'],
      },
    },
    {
      name: 'reload_registry',
      description: '重新加载 Skill / Program 注册表，使刚写入的产物立即可被系统识别。写完产物文件后应调用。',
      input_schema: { type: 'object', properties: {}, required: [] },
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
    'list_scripts',
    'run_script',
    'list_programs',
    'trigger_program',
    'list_mcp_servers',
    'add_mcp_server',
    'remove_mcp_server',
    'deploy_local_mcp',
    'query_audit',
    'query_probe',
  ]);

  // ─── Handler 实现 ────────────────────────────────────────────────────

  const WRITE_PATTERNS = /\b(rm|mv|cp|mkdir|touch|chmod|chown|dd|mkfs|tee|install|npm|npx|pip|apt|yum|dnf|brew|git\s+clone|git\s+pull|git\s+checkout|wget|curl\s+-[^\s]*[oO]|docker\s+(run|pull|build|exec)|>\s|>>)\b/i;

  // 安全模式：已批准的命令（sessionId → Set<commandHash>）
  const approvedCommands = new Map();

  function approveCommand(sessionId, command) {
    if (!approvedCommands.has(sessionId)) approvedCommands.set(sessionId, new Set());
    approvedCommands.get(sessionId).add(command.trim());
  }

  function isApproved(sessionId, command) {
    return approvedCommands.get(sessionId)?.has(command.trim()) || false;
  }

  function registerNestedRun(session, runner, runId) {
    if (!session) return () => {};
    if (!session.activeSkillRunIds) session.activeSkillRunIds = new Set();
    if (!session.cancelHandlers) session.cancelHandlers = new Set();
    session.skillRunner = runner;
    session.activeSkillRunIds.add(runId);
    const cancel = () => runner?.cancelRun?.(runId);
    session.cancelHandlers.add(cancel);
    return () => {
      session.activeSkillRunIds?.delete(runId);
      session.cancelHandlers?.delete(cancel);
    };
  }

  function getCurrentAuthoringSession(session, input) {
    const current = session?.authoringSession;
    if (!current) return { error: '当前没有 Authoring Session' };
    if (input?.sessionId && String(input.sessionId).trim() !== current.id) return { error: `Authoring Session 不匹配: ${input.sessionId}` };
    return { current };
  }

  function emitAuthoringArtifact(socket, sessionId, current, artifact) {
    socket?.emit?.('ide:authoring-artifact', { sessionId, artifact });
    socket?.emit?.('ide:authoring-session', { sessionId, session: serializeAuthoringSession(current) });
  }

  function emitAuthoringInteraction(socket, sessionId, current, interaction) {
    socket?.emit?.('ide:authoring-interaction', { sessionId, interaction });
    socket?.emit?.('ide:authoring-session', { sessionId, session: serializeAuthoringSession(current) });
  }

  function getDraftArtifact(current, artifactId = '', expectedTypes = ['program_draft', 'skill_draft']) {
    let artifact = null;
    if (artifactId) {
      artifact = (current.artifacts || []).find((item) => item.id === artifactId) || null;
    } else {
      const preferred = String(current.intent || '').includes('skill') ? ['skill_draft', 'program_draft'] : expectedTypes;
      for (const type of preferred) {
        artifact = latestArtifact(current, type);
        if (artifact) break;
      }
    }
    if (!artifact) return { error: `Draft artifact 不存在: ${artifactId || '(latest)'}` };
    if (!expectedTypes.includes(artifact.type)) return { error: `artifact 类型不是 ${expectedTypes.join(' / ')}: ${artifact.type}` };
    return { artifact };
  }

  function getProgramDraftArtifact(current, artifactId = '') {
    return getDraftArtifact(current, artifactId, ['program_draft']);
  }

  function getSkillDraftArtifact(current, artifactId = '') {
    return getDraftArtifact(current, artifactId, ['skill_draft']);
  }

  function draftFilesForCommit(artifact) {
    const files = Array.isArray(artifact?.data?.files) ? artifact.data.files.map((file) => ({
      path: String(file?.path || '').trim(),
      content: String(file?.content || ''),
    })).filter((file) => file.path) : [];
    if (artifact?.type !== 'program_draft') return files;
    return normalizeProgramDraftFiles(files, String(artifact?.data?.programId || artifact?.title || '').trim()).files;
  }

  function validateBasicDraftFiles(files) {
    const validation = { ok: true, errors: [], warnings: [] };
    if (!Array.isArray(files) || files.length === 0) {
      validation.ok = false;
      validation.errors.push('draft 至少需要一个文件');
      return validation;
    }
    for (const file of files) {
      const relPath = String(file?.path || '').trim();
      if (!relPath) {
        validation.ok = false;
        validation.errors.push('存在空 path 文件');
        continue;
      }
      if (!isPathAllowed(relPath)) {
        validation.ok = false;
        validation.errors.push(`路径越界: ${relPath}`);
      }
    }
    return validation;
  }

  function reloadAuthoringRegistries() {
    const result = { skillCount: null, program: null };
    if (typeof skillRegistry.reload === 'function') result.skillCount = skillRegistry.reload();
    if (typeof programEngine.reload === 'function') result.program = programEngine.reload();
    return result;
  }

  function programReloadErrors(reloadResult) {
    if (Array.isArray(reloadResult?.errors)) return reloadResult.errors;
    if (Array.isArray(reloadResult?.program?.errors)) return reloadResult.program.errors;
    return [];
  }

  function cleanupEmptyArtifactDirs(relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/');
    const root = normalized.startsWith('data/programs/')
      ? path.resolve(ROOT_DIR, 'data', 'programs')
      : normalized.startsWith('data/skills/')
        ? path.resolve(ROOT_DIR, 'data', 'skills')
        : null;
    if (!root) return;
    let dir = path.dirname(path.resolve(ROOT_DIR, normalized));
    while (dir.startsWith(root + path.sep) && dir !== root) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        else break;
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  function createRollbackSnapshot(files) {
    return files.map((file) => {
      const abs = path.resolve(ROOT_DIR, file.path);
      const existed = fs.existsSync(abs);
      return {
        path: file.path,
        existed,
        content: existed ? fs.readFileSync(abs, 'utf8') : '',
      };
    });
  }

  function attachRollbackSnapshot(artifact, snapshot) {
    Object.defineProperty(artifact, '_commitRollbackSnapshot', {
      value: snapshot,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  function rollbackFiles(snapshot = []) {
    const result = { ok: true, restored: [], removed: [], errors: [] };
    for (const entry of [...snapshot].reverse()) {
      const abs = path.resolve(ROOT_DIR, entry.path);
      try {
        if (entry.existed) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, entry.content, 'utf8');
          result.restored.push(entry.path);
        } else {
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
          cleanupEmptyArtifactDirs(entry.path);
          result.removed.push(entry.path);
        }
      } catch (e) {
        result.ok = false;
        result.errors.push(`${entry.path}: ${e.message}`);
      }
    }
    return result;
  }

  function rollbackCommittedArtifact(artifact) {
    const snapshot = artifact?._commitRollbackSnapshot;
    if (!Array.isArray(snapshot) || snapshot.length === 0) return { ok: true, restored: [], removed: [], errors: [] };
    const result = rollbackFiles(snapshot);
    delete artifact._commitRollbackSnapshot;
    try {
      reloadAuthoringRegistries();
    } catch (e) {
      result.ok = false;
      result.errors.push(`reload after rollback: ${e.message}`);
    }
    return result;
  }

  function programIdFromDraft(artifact) {
    const fromData = String(artifact?.data?.programId || '').trim();
    if (fromData) return fromData;
    for (const file of draftFilesForCommit(artifact)) {
      if (!file.path.endsWith('.yaml') && !file.path.endsWith('.yml')) continue;
      try {
        const parsed = yaml.load(file.content);
        if (parsed?.id) return String(parsed.id).trim();
      } catch { /* validation reports YAML errors elsewhere */ }
    }
    return String(artifact?.title || '').trim();
  }

  function skillIdFromDraft(artifact) {
    const fromData = String(artifact?.data?.skillId || '').trim();
    if (fromData) return fromData;
    const skillFile = draftFilesForCommit(artifact).find((file) => file.path.startsWith('data/skills/') && file.path.endsWith('/SKILL.md'));
    if (skillFile) return skillFile.path.split('/')[2] || '';
    return String(artifact?.title || '').trim();
  }

  function labelForDraftArtifact(artifact) {
    return artifact?.type === 'skill_draft' ? 'Skill' : 'Program';
  }

  function idForDraftArtifact(artifact) {
    return artifact?.type === 'skill_draft' ? skillIdFromDraft(artifact) : programIdFromDraft(artifact);
  }

  function validateDraftForArtifact(artifact, files = draftFilesForCommit(artifact)) {
    return artifact?.type === 'skill_draft' ? validateSkillDraftFiles(files, skillIdFromDraft(artifact)) : validateDraftFiles(files);
  }

  function mergeDraftFiles(existingFiles, patchFiles, artifact) {
    const programId = artifact?.type === 'program_draft' ? programIdFromDraft(artifact) : '';
    const normalizedPatch = artifact?.type === 'program_draft'
      ? normalizeProgramDraftFiles(patchFiles, programId)
      : { files: patchFiles.map((file) => ({ path: String(file?.path || '').trim(), content: String(file?.content || '') })).filter((file) => file.path), warnings: [] };
    const byPath = new Map((existingFiles || []).map((file) => [String(file.path || '').replace(/\\/g, '/'), {
      path: String(file.path || '').replace(/\\/g, '/'),
      content: String(file.content || ''),
    }]));
    for (const file of normalizedPatch.files) {
      byPath.set(String(file.path || '').replace(/\\/g, '/'), {
        path: String(file.path || '').replace(/\\/g, '/'),
        content: String(file.content || ''),
      });
    }
    const mergedFiles = Array.from(byPath.values()).filter((file) => file.path);
    if (artifact?.type !== 'program_draft') return { files: mergedFiles, warnings: normalizedPatch.warnings || [] };
    const normalizedMerged = normalizeProgramDraftFiles(mergedFiles, programId);
    return {
      files: normalizedMerged.files,
      warnings: [...new Set([...(normalizedPatch.warnings || []), ...(normalizedMerged.warnings || [])])],
    };
  }

  function formatDraftValidationRepairHint(label, validation) {
    const details = [...(validation.errors || []).map((e) => `ERROR: ${e}`), ...(validation.warnings || []).map((w) => `WARN: ${w}`)].join('\n');
    const hint = `${label} Draft validation 失败。请基于现有 Draft artifact 用 update_authoring_draft 增量修复，只替换报错相关文件/字段；不要要求用户手动处理，也不要整份重建，除非现有 artifact 结构已经无法复用。`;
    return `${hint}${details ? '\n' + details : ''}`;
  }

  function errorsForProgram(reloadErrors, programId) {
    if (!programId || !Array.isArray(reloadErrors)) return [];
    return reloadErrors.filter((item) => String(item || '').startsWith(`${programId}:`) || String(item || '').includes(`/${programId}/`) || String(item || '').includes(`\\${programId}\\`));
  }

  function recordVerificationArtifact(current, sourceArtifact, verification) {
    const label = verification.kind === 'skill' ? verification.skillId : verification.programId;
    const artifact = recordAuthoringArtifact(current, {
      type: 'authoring_verification',
      title: `Verification · ${label || sourceArtifact.title}`,
      status: verification.ok ? 'passed' : 'failed',
      data: {
        sourceArtifactId: sourceArtifact.id,
        ...verification,
      },
      warnings: verification.warnings || [],
      validation: { ok: verification.ok, errors: verification.errors || [], warnings: verification.warnings || [] },
    });
    current.approvals.commit = verification.ok ? current.approvals.commit : false;
    if (!verification.ok) delete current.approvals.commitArtifactId;
    return artifact;
  }

  function programIdFromPath(relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[0] === 'data' && parts[1] === 'programs' && parts[2] ? parts[2] : '';
  }

  function normalizeProgramDraftPath(relPath, programId) {
    const normalized = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const id = String(programId || '').trim();
    if (!normalized || normalized.startsWith('data/programs/')) return normalized;
    if (!id) return normalized;
    if (normalized === 'program.yaml' || normalized === 'program.yml') return `data/programs/${id}/program.yaml`;
    if (normalized.startsWith('ui/')) return `data/programs/${id}/${normalized}`;
    if (normalized.startsWith(`${id}/`)) return `data/programs/${normalized}`;
    if (normalized.startsWith(`programs/${id}/`)) return `data/${normalized}`;
    return normalized;
  }

  function draftRunActionsFromSource(source) {
    const actions = new Set();
    for (const match of String(source || '').matchAll(/\$oneShell\.runAction\s*\(\s*['"]([^'"]+)['"]/g)) actions.add(match[1]);
    for (const match of String(source || '').matchAll(/\brunAction\s*\(\s*['"]([^'"]+)['"]/g)) actions.add(match[1]);
    return [...actions];
  }

  function usesBridgeMethod(source, method) {
    const text = String(source || '');
    return new RegExp(`\\$oneShell\\.${method}\\b`).test(text) || new RegExp(`\\b${method}\\s*\\(`).test(text);
  }

  function normalizeInputFields(inputs) {
    let changed = false;
    const entries = Array.isArray(inputs)
      ? inputs
      : (inputs && typeof inputs === 'object' ? Object.values(inputs) : []);
    for (const input of entries) {
      if (String(input?.type || '').trim() === 'secret') {
        input.type = 'password';
        input.secret = true;
        changed = true;
      }
      if (String(input?.type || '').trim() === 'number') {
        if (input.min == null) {
          input.min = /port|端口/i.test(`${input.name || ''} ${input.label || ''}`) ? 1 : 0;
          changed = true;
        }
        if (input.max == null) {
          input.max = /port|端口/i.test(`${input.name || ''} ${input.label || ''}`) ? 65535 : 999999999;
          changed = true;
        }
      }
    }
    return changed;
  }

  function normalizeProgramYamlContent(file, warnings) {
    if (!file.path.endsWith('/program.yaml')) return { file, parsed: null };
    try {
      const parsed = yaml.load(file.content);
      if (!parsed || typeof parsed !== 'object') return { file, parsed: null };
      let changed = false;
      if (normalizeInputFields(parsed.inputs)) changed = true;
      const actions = parsed.actions && typeof parsed.actions === 'object' && !Array.isArray(parsed.actions) ? parsed.actions : {};
      for (const action of Object.values(actions)) {
        if (normalizeInputFields(action?.inputs)) changed = true;
      }
      const instanceActions = Array.isArray(parsed.ui?.instance_actions) ? parsed.ui.instance_actions : [];
      for (const item of instanceActions) {
        const actionName = String(item?.action || '').trim();
        if (actionName && !String(item?.id || '').trim()) {
          item.id = actionName;
          changed = true;
        }
      }
      if (!changed) return { file, parsed };
      warnings.push(`${file.path}: 已归一化 input 类型/range 与 ui.instance_actions.id 等机械字段`);
      return { file: { ...file, content: yaml.dump(parsed, { lineWidth: 120, noRefs: true, sortKeys: false }) }, parsed };
    } catch {
      return { file, parsed: null };
    }
  }

  function normalizeManifestContent(file, appSource, programActions, warnings) {
    if (!file.path.endsWith('/ui/manifest.json')) return file;
    try {
      const manifest = JSON.parse(file.content);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return file;
      let changed = false;
      if (manifest.schemaVersion !== 1) {
        manifest.schemaVersion = 1;
        changed = true;
      }
      if (!manifest.runtime) {
        manifest.runtime = 'react-jsx';
        changed = true;
      }
      if (!manifest.entry) {
        manifest.entry = 'App.jsx';
        changed = true;
      }
      if (typeof manifest.styles === 'string') {
        manifest.styles = [manifest.styles];
        changed = true;
      } else if (!Array.isArray(manifest.styles)) {
        manifest.styles = ['style.css'];
        changed = true;
      }
      if (typeof manifest.design !== 'string') {
        manifest.design = 'DESIGN.md';
        changed = true;
      }
      if (!manifest.permissions || typeof manifest.permissions !== 'object' || Array.isArray(manifest.permissions)) {
        manifest.permissions = {};
        changed = true;
      }
      const permissions = manifest.permissions;
      const declared = new Set(Array.isArray(permissions.actions) ? permissions.actions.map(String) : []);
      for (const action of draftRunActionsFromSource(appSource)) {
        if (programActions.includes(action) && !declared.has(action)) {
          declared.add(action);
          changed = true;
        }
      }
      if (declared.size && (!Array.isArray(permissions.actions) || permissions.actions.length !== declared.size)) {
        permissions.actions = [...declared];
        changed = true;
      }
      for (const [method, permission] of [['getRuns', 'readRuns'], ['getResults', 'readResults'], ['getEvents', 'readEvents']]) {
        if (usesBridgeMethod(appSource, method) && permissions[permission] !== true) {
          permissions[permission] = true;
          changed = true;
        }
      }
      if (!changed) return file;
      warnings.push(`${file.path}: 已归一化 manifest schema/runtime/design/styles 与 bridge permissions`);
      return { ...file, content: `${JSON.stringify(manifest, null, 2)}\n` };
    } catch {
      return file;
    }
  }

  function normalizeProgramDraftContents(files, warnings) {
    let parsedProgram = null;
    const programNormalized = files.map((file) => {
      const result = normalizeProgramYamlContent(file, warnings);
      if (result.parsed) parsedProgram = result.parsed;
      return result.file;
    });
    const programActions = parsedProgram?.actions && typeof parsedProgram.actions === 'object' && !Array.isArray(parsedProgram.actions) ? Object.keys(parsedProgram.actions) : [];
    const appSource = programNormalized.find((file) => file.path.endsWith('/ui/App.jsx'))?.content || '';
    return programNormalized.map((file) => normalizeManifestContent(file, appSource, programActions, warnings));
  }

  function normalizeProgramDraftFiles(files, programId) {
    const warnings = [];
    const normalizedFiles = files.map((file) => {
      const originalPath = String(file?.path || '').trim();
      const normalizedPath = normalizeProgramDraftPath(originalPath, programId);
      if (originalPath && normalizedPath && originalPath.replace(/\\/g, '/') !== normalizedPath) {
        warnings.push(`已将 ${originalPath} 归一化为 ${normalizedPath}`);
      }
      return { path: normalizedPath, content: String(file?.content || '') };
    }).filter((file) => file.path);
    return { files: normalizeProgramDraftContents(normalizedFiles, warnings), warnings: [...new Set(warnings)] };
  }

  function requiredProgramArtifactPaths(programId) {
    return [`data/programs/${programId}/program.yaml`];
  }

  function applyUiArtifactChecks() {
    // ui artifact 校验已移除：AI 创作 program 不再产出 React 前端
  }

  function validateDraftUiArtifact() {
    // ui artifact 校验已移除
  }

  function validateCommittedProgramArtifact(programId) {
    const validation = { ok: true, errors: [], warnings: [], checks: [] };
    const yamlPath = path.resolve(ROOT_DIR, 'data', 'programs', programId, 'program.yaml');
    try {
      if (!fs.existsSync(yamlPath)) {
        validation.errors.push(`Program YAML 不存在: data/programs/${programId}/program.yaml`);
      } else {
        const parsed = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
        normalizeProgram(parsed, programId, yamlPath);
      }
    } catch (e) {
      validation.errors.push(`Program YAML 校验失败: ${e.message}`);
    }
    validation.ok = validation.errors.length === 0;
    return validation;
  }

  function pushInputTypeHints(validation, relPath, inputs, scope) {
    const allowed = new Set(['string', 'number', 'boolean', 'select', 'password', 'text']);
    const entries = Array.isArray(inputs)
      ? inputs.map((input, idx) => [idx, input])
      : (inputs && typeof inputs === 'object' ? Object.entries(inputs) : []);
    for (const [idx, input] of entries) {
      const type = String(input?.type || '').trim();
      if (!type) continue;
      if (type === 'secret') {
        validation.errors.push(`${relPath}: ${scope} inputs[${idx}] type 不支持 "secret"；密钥字段请使用 type: password 并设置 secret: true`);
      } else if (!allowed.has(type)) {
        validation.errors.push(`${relPath}: ${scope} inputs[${idx}] type "${type}" 未知；允许 string/number/boolean/select/password/text`);
      }
    }
  }


  function pushProgramSchemaErrors(validation, parsed, relPath, programId) {
    const actions = parsed?.actions && typeof parsed.actions === 'object' && !Array.isArray(parsed.actions) ? parsed.actions : null;
    const actionNames = actions ? Object.keys(actions) : [];
    pushInputTypeHints(validation, relPath, parsed?.inputs, 'program');
    if (!parsed.hosts) validation.errors.push(`${relPath}: 缺少 hosts 字段，必须是 all、hostId 或 hostId 数组`);
    if (!Array.isArray(parsed.triggers) || parsed.triggers.length === 0) validation.errors.push(`${relPath}: triggers 数组不能为空，至少需要一个 manual trigger`);
    if (!actions || actionNames.length === 0) validation.errors.push(`${relPath}: actions 必须是非空对象`);
    for (const trigger of Array.isArray(parsed.triggers) ? parsed.triggers : []) {
      const triggerId = String(trigger?.id || '').trim();
      const actionName = String(trigger?.action || '').trim();
      if (!triggerId) validation.errors.push(`${relPath}: trigger 缺少 id`);
      if (!actionName) validation.errors.push(`${relPath}: trigger ${triggerId || '(unnamed)'} 缺少 action 字段`);
      else if (actions && !actions[actionName]) validation.errors.push(`${relPath}: trigger ${triggerId || '(unnamed)'} 指向不存在的 action: ${actionName}`);
    }

    for (const [actionName, action] of actions ? Object.entries(actions) : []) {
      pushInputTypeHints(validation, relPath, action?.inputs, `action="${actionName}"`);
      const steps = Array.isArray(action?.steps) ? action.steps : [];
      if (steps.length === 0) validation.errors.push(`${relPath}: action="${actionName}" 必须至少有一个 step`);
      const seenStepIds = new Set();
      for (const [idx, step] of steps.entries()) {
        const stepId = String(step?.id || '').trim();
        const type = String(step?.type || 'exec').trim();
        if (!stepId) validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}] 缺少 id`);
        else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(stepId)) validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}].id "${stepId}" 不合法，必须以字母或下划线开头且仅含字母数字下划线`);
        else if (seenStepIds.has(stepId)) validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}].id "${stepId}" 重复`);
        seenStepIds.add(stepId);
        if (type === 'exec' && !String(step?.run || '').trim()) {
          validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}](${stepId || 'unnamed'}) 类型为 exec，必须有 run 字段；不要使用 command 字段`);
        }
        if (type === 'render' && !['table', 'keyvalue', 'list', 'message'].includes(String(step?.format || '').trim())) {
          validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}](${stepId || 'unnamed'}) 类型为 render，format 必须是 table/keyvalue/list/message`);
        }
        if (type === 'ai' && !String(step?.goal || step?.task || step?.prompt || step?.label || '').trim()) {
          validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}](${stepId || 'unnamed'}) 类型为 ai，必须有 goal 字段`);
        }
        if (!['exec', 'render', 'ai'].includes(type)) validation.errors.push(`${relPath}: action="${actionName}" steps[${idx}] 未知 type "${type}"`);
      }
      if (!isGenericMode) {
        if (!steps.some((step) => step?.type === 'render')) validation.errors.push(`${relPath}: action="${actionName}" 缺少 render step，且 render 必须放在 action 最后`);
        if (steps.length > 0 && steps[steps.length - 1]?.type !== 'render') validation.errors.push(`${relPath}: action="${actionName}" 最后一个 step 必须是 render`);
      }
    }

    try {
      normalizeProgram(parsed, programId, relPath);
    } catch (e) {
      const message = String(e.message || 'Program schema 校验失败');
      if (!validation.errors.includes(message)) validation.errors.push(message);
    }
  }

  function validateDraftFiles(files) {
    const validation = validateBasicDraftFiles(files);
    validation.checks = [];
    if (!validation.ok) return validation;
    let programYaml = null;
    let parsedProgram = null;
    let draftProgramId = '';
    for (const file of files) {
      const relPath = String(file?.path || '').trim().replace(/\\/g, '/');
      const content = String(file?.content || '');
      if (!relPath.startsWith('data/programs/')) validation.errors.push(`Program 路径必须位于 data/programs/: ${relPath}`);
      if (relPath.endsWith('.yaml') || relPath.endsWith('.yml')) {
        if (programYaml) validation.errors.push(`${relPath}: Program draft 只能包含一个 program.yaml`);
        try {
          const parsed = yaml.load(content);
          if (!parsed || typeof parsed !== 'object') {
            validation.errors.push(`${relPath}: YAML 顶层必须是对象`);
          } else {
            const programId = programIdFromPath(relPath) || String(parsed.id || '').trim();
            if (path.basename(relPath) !== 'program.yaml') validation.errors.push(`${relPath}: Program YAML 必须命名为 program.yaml`);
            if (!programId) validation.errors.push(`${relPath}: 无法从路径或 id 推断 Program ID`);
            if (parsed.id && String(parsed.id).trim() !== programId) validation.errors.push(`${relPath}: id 必须与目录名一致: ${programId}`);
            if (!parsed.name) validation.errors.push(`${relPath}: 缺少 name 字段`);
            if (parsed.enabled !== false) validation.errors.push(`${relPath}: 新建 Program 必须 enabled: false`);
            pushProgramSchemaErrors(validation, parsed, relPath, programId);
            programYaml = { path: relPath, content };
            parsedProgram = parsed;
            draftProgramId = programId;
          }
        } catch (e) {
          validation.errors.push(`${relPath}: YAML 解析失败: ${e.message}`);
        }
      }
    }
    if (!programYaml) validation.errors.push('Program draft 必须包含 data/programs/<id>/program.yaml');
    if (programYaml && parsedProgram && draftProgramId) validateDraftUiArtifact(validation, files, parsedProgram, programYaml.path, draftProgramId);
    validation.ok = validation.errors.length === 0;
    return validation;
  }

  function validateSkillDraftFiles(files, skillId = '') {
    const validation = validateBasicDraftFiles(files);
    if (!validation.ok) return validation;
    const id = String(skillId || '').trim();
    const skillRoot = id ? `data/skills/${id}/` : '';
    const paths = files.map((file) => String(file.path || '').trim());
    const skillMd = files.find((file) => String(file.path || '').trim() === `${skillRoot}SKILL.md` || (!skillRoot && String(file.path || '').endsWith('/SKILL.md')));
    if (!skillMd) {
      validation.ok = false;
      validation.errors.push('Skill draft 必须包含 SKILL.md');
    }
    for (const relPath of paths) {
      if (!relPath.startsWith('data/skills/')) {
        validation.ok = false;
        validation.errors.push(`Skill 路径必须位于 data/skills/: ${relPath}`);
      }
      if (skillRoot && !relPath.startsWith(skillRoot)) {
        validation.ok = false;
        validation.errors.push(`Skill draft 只能写入 ${skillRoot}: ${relPath}`);
      }
    }
    if (skillMd) {
      try {
        const parsed = parseFrontmatter(String(skillMd.content || ''));
        if (!parsed.meta || Object.keys(parsed.meta).length === 0) validation.warnings.push('SKILL.md 缺少 frontmatter 元数据');
        if (!parsed.meta.name) validation.warnings.push('SKILL.md frontmatter 缺少 name');
        if (!parsed.meta.description) validation.warnings.push('SKILL.md frontmatter 缺少 description');
      } catch (e) {
        validation.ok = false;
        validation.errors.push(`SKILL.md frontmatter 解析失败: ${e.message}`);
      }
    }
    if (!paths.some((item) => item.includes('/rules/'))) validation.warnings.push('建议包含 rules/ 目录承载硬约束');
    if (!paths.some((item) => item.includes('/workflows/'))) validation.warnings.push('建议包含 workflows/ 目录承载执行流程');
    return validation;
  }

  async function handle(name, input, { socket, sessionId, runId, safeMode, session, signal, requestApproval, onToolDelta }) {
    const authoringBlocked = null;
    if (authoringBlocked) return authoringBlocked;

    if (CORE_DELEGATED_TOOL_NAMES.has(name)) {
      return coreTools.handle(name, input || {}, { socket, sessionId, runId, safeMode, session, signal, requestApproval, onToolDelta, source: 'ide' });
    }

    switch (name) {

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
            return ok(formatExec(result));
          }
          const result = await bridgeService.execOnHost(hostId, command, timeout, { source: 'ide' });
          emitTool(socket, sessionId, name, { command, hostId }, result);
          auditService?.log?.({ action: 'ide_exec', hostId, command: command.substring(0, 2000), exitCode: result.exitCode });
          return ok(formatExec(result));
        } catch (e) {
          return err(e.message);
        }
      }

      case 'list_hosts': {
        const hosts = (hostService.listHosts?.() || []).map(h => `id=${h.id}  name=${h.name}  ${h.host || '127.0.0.1'}:${h.port || '-'}  type=${h.type || 'ssh'}`);
        return ok(hosts.length > 0 ? hosts.join('\n') : '（无已托管主机）');
      }

      case 'read_file': {
        const p = String(input.path || '').trim();
        if (!p) return err('path 为空');
        if (!isPathAllowed(p)) return err(`路径越界：只能读 ${ALLOWED_DIRS.join(' / ')} 内的文件`);
        const abs = path.resolve(ROOT_DIR, p);
        try {
          const content = fs.readFileSync(abs, 'utf8');
          return ok(content);
        } catch (e) {
          if (e.code === 'ENOENT') return err(`文件不存在: ${p}`);
          if (e.code === 'EISDIR') {
            const entries = fs.readdirSync(abs, { withFileTypes: true });
            const listing = entries.map(e => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`));
            return ok(`目录 ${p} 的内容:\n${listing.join('\n')}`);
          }
          return err(e.message);
        }
      }

      case 'write_file': {
        const p = String(input.path || '').trim();
        const content = input.content != null ? String(input.content) : '';
        if (!p) return err('path 为空');
        if (!isPathAllowed(p)) return err(`路径越界：只能写 ${ALLOWED_DIRS.join(' / ')} 内的文件`);
        const abs = path.resolve(ROOT_DIR, p);
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
          if (typeof onFileWritten === 'function') {
            try { onFileWritten(p); } catch { /* ignore */ }
          }
          return ok(`文件已写入: ${p} (${Buffer.byteLength(content, 'utf8')} bytes)`);
        } catch (e) {
          return err(`写入失败: ${e.message}`);
        }
      }

      case 'list_artifacts': {
        const filter = input.type || 'all';
        if (!['skill', 'program', 'all'].includes(filter)) return err(`未知产物类型: ${filter}。可选: skill, program, all`);
        const items = [];
        if (filter === 'all' || filter === 'skill') {
          for (const s of (skillRegistry.listSkills?.() || [])) {
            items.push(`[skill] ${s.id}  name="${s.name || s.id}"  ${s.description ? '— ' + s.description.slice(0, 100) : ''}`);
          }
        }
        if (filter === 'all' || filter === 'program') {
          const progDir = path.join(ROOT_DIR, 'data', 'programs');
          if (fs.existsSync(progDir)) {
            for (const d of fs.readdirSync(progDir, { withFileTypes: true })) {
              if (!d.isDirectory()) continue;
              const yamlPath = path.join(progDir, d.name, 'program.yaml');
              if (!fs.existsSync(yamlPath)) continue;
              let pName = d.name;
              try {
                const raw = fs.readFileSync(yamlPath, 'utf8');
                const m = raw.match(/^name:\s*(.+)$/m);
                if (m) pName = m[1].trim();
              } catch { /* ignore */ }
              items.push(`[program] ${d.name}  name="${pName}"`);
            }
          }
        }
        return ok(items.length > 0 ? items.join('\n') : '（暂无产物）');
      }

      case 'list_skills': {
        const skills = (skillRegistry.listSkills?.() || [])
          .filter((s) => !s.hidden)
          .map((s) => `- ${s.id}: ${(s.description || '').replace(/\s+/g, ' ').trim() || '(无 description)'}`);
        auditService?.log?.({ action: 'ide_list_skills', details: JSON.stringify({ count: skills.length }) });
        if (skills.length === 0) return ok('（当前没有装载任何 Skill）');
        return ok(['可用 1Shell Skill 列表（看 description 决定是否匹配，匹配则用 load_skill 加载 body）：', ...skills].join('\n'));
      }

      case 'load_skill': {
        const skillId = String(input.skillId || '').trim();
        auditService?.log?.({ action: 'ide_load_skill', details: JSON.stringify({ skillId }) });
        if (!skillId) return err('skillId 不能为空');
        const skill = skillRegistry.getSkill?.(skillId);
        if (!skill) return err(`Skill 不存在: ${skillId}（用 list_skills 查可用列表）`);
        const body = String(skill.body || '').trim();
        if (!body) return err(`Skill ${skillId} 的 SKILL.md body 为空`);
        return ok([
          `# Loaded Skill: ${skill.name || skillId}`,
          '',
          'The following is the SKILL.md body. Treat it as authoritative guidance for the current task — follow its steps, constraints, and style verbatim.',
          '',
          '---',
          '',
          body,
        ].join('\n'));
      }

      case 'ask_authoring_question':
      case 'propose_options':
      case 'create_program_spec':
      case 'create_skill_spec':
      case 'create_authoring_plan':
      case 'start_program_draft':
      case 'create_program_draft':
      case 'create_skill_draft':
      case 'validate_program_draft':
      case 'update_authoring_draft':
      case 'validate_skill_draft':
      case 'request_commit_approval':
      case 'commit_authoring_artifact':
      case 'verify_authoring_artifact':
        return err(`工具 "${name}" 已废弃。请改用 list_skills + load_skill 加载相关 skill，再用 write_program / write_file 写入文件。`);

      case 'write_program': {
        const programId = String(input.programId || '').trim();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(programId)) return err('programId 不合法（必须 kebab-case）');
        const rawFiles = Array.isArray(input.files) ? input.files : [];
        if (rawFiles.length === 0) return err('files 不能为空');
        const programDir = `data/programs/${programId}`;
        const normalized = [];
        for (const file of rawFiles) {
          const rawPath = String(file?.path || '').trim().replace(/\\/g, '/');
          if (!rawPath) return err('file.path 不能为空');
          let relPath = rawPath;
          if (!relPath.startsWith('data/programs/')) {
            relPath = `${programDir}/${relPath.replace(/^\//, '')}`;
          }
          if (!relPath.startsWith(`${programDir}/`)) {
            return err(`路径不在 ${programDir}/ 范围内: ${rawPath}`);
          }
          if (!isPathAllowed(relPath)) return err(`路径越界: ${relPath}`);
          normalized.push({ path: relPath, content: String(file?.content || '') });
        }
        const written = [];
        for (const file of normalized) {
          const abs = path.resolve(ROOT_DIR, file.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, file.content, 'utf8');
          if (typeof onFileWritten === 'function') {
            try { onFileWritten(file.path); } catch { /* ignore */ }
          }
          written.push(`${file.path} (${Buffer.byteLength(file.content, 'utf8')} bytes)`);
        }
        let reloadInfo = '';
        try {
          if (typeof programEngine?.reload === 'function') {
            const result = programEngine.reload();
            const errors = Array.isArray(result?.errors) ? result.errors : [];
            const ownErrors = errors
              .filter((item) => String(item?.id || item?.programId || '').trim() === programId)
              .map((item) => item.message || item.error || JSON.stringify(item));
            if (ownErrors.length) {
              reloadInfo = `\n[reload errors for ${programId}]\n${ownErrors.join('\n')}`;
            } else {
              reloadInfo = '\nreload registry: ok';
            }
          }
        } catch (e) {
          reloadInfo = `\n[reload threw] ${e.message}`;
        }
        auditService?.log?.({ action: 'ide_write_program', programId, files: normalized.map((file) => file.path) });
        return ok(`已写入 ${normalized.length} 个文件到 ${programDir}/：\n${written.map((item) => `- ${item}`).join('\n')}${reloadInfo}`);
      }

      case 'run_skill': {
        const skillId = String(input.skillId || '').trim();
        const hostId = String(input.hostId || '').trim();
        if (!skillId) return err('skillId 为空');
        if (!hostId) return err('hostId 为空');
        const skill = skillRegistry.getSkill?.(skillId);
        if (!skill) return err(`Skill 不存在: ${skillId}。请先 reload_registry。`);
        if (!skillRunner) return err('Skill Runner 未初始化');

        const runId = 'ide-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const unregister = registerNestedRun(session, skillRunner, runId);
        try {
          const result = await runViaCollector(runId, (collector) =>
            skillRunner.run({ socket: collector, runId, skillId, hostId, inputs: input.inputs || {} })
          );
          auditService?.log?.({ action: 'ide_run_skill', skillId, hostId, runId });
          return ok(result);
        } finally {
          unregister();
        }
      }

      case 'trigger_program': {
        const programId = String(input.programId || '').trim();
        const hostId = input.hostId ? String(input.hostId).trim() : undefined;
        const actionName = input.actionName ? String(input.actionName).trim() : undefined;
        if (!programId) return err('programId 为空');
        try {
          const runIds = await programEngine.triggerManual({ programId, hostId, actionName });
          return ok(`Program "${programId}" 已触发。runId: ${runIds.join(', ')}\n结果将在前端"程序"页面展示。`);
        } catch (e) {
          return err(`触发失败: ${e.message}`);
        }
      }

      case 'query_format': {
        const type = String(input.type || '').trim();
        const docMap = {
          'skill':       'skill-format.md',
          'program':     'program-schema.md',
          'tool-api':    'tool-api.md',
        };
        const fileName = docMap[type];
        if (!fileName) return err(`未知类型: ${type}。可选: ${Object.keys(docMap).join(', ')}`);
        const docPath = path.join(ROOT_DIR, 'data', 'skills', 'skill-authoring', 'references', fileName);
        try {
          return ok(fs.readFileSync(docPath, 'utf8'));
        } catch {
          return err(`格式文档不存在: ${docPath}`);
        }
      }

      case 'reload_registry': {
        try {
          if (typeof skillRegistry.reload === 'function') skillRegistry.reload();
          let programMsg = '';
          if (typeof programEngine.reload === 'function') {
            const result = programEngine.reload();
            if (result?.errors?.length) {
              programMsg = `\n⚠ Program 加载失败（${result.errors.length} 个）：\n` + result.errors.map(e => `  - ${e}`).join('\n');
            }
          }
          return ok('Skill / Program 注册表已重新加载。' + programMsg);
        } catch (e) {
          return err(`重载失败: ${e.message}`);
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
        const coreResult = await coreTools.handle(name, input || {}, { socket, sessionId, runId, safeMode, session, signal, requestApproval, onToolDelta, source: 'ide' });
        if (!coreResult.is_error || !String(coreResult.content || '').startsWith('[ERROR] 未知工具:')) return coreResult;
        return err(`未知工具: ${name}`);
      }
    }
  }

  // ─── Claude Code 协作 ──────────────────────────────────────────────

  const CLAUDE_CODE_TOOL = {
    name: 'invoke_claude_code',
    description:
      '将复杂创作任务委托给 Claude Code（专业 AI 编程助手）执行。' +
      '\nClaude Code 会通过 MCP 访问 1Shell 的所有主机，自主探测环境并完成任务。' +
      '\n适用于：编写 Program / Skill、多步骤调试、复杂脚本生成、架构分析。' +
      '\nAuthoring Session 中必须先生成 draft/approval，再用 commit_authoring_artifact 和 verify_authoring_artifact 完成落盘验证。' +
      '\n注意：每次调用耗时较长（1-5 分钟），简单任务请自行处理。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '清晰描述 Claude Code 需要完成的任务' },
        hostId: { type: 'string', description: '目标主机 ID（可选，Claude Code 也可以自行 list_hosts 查看）' },
      },
      required: ['task'],
    },
  };

  async function handleInvokeClaudeCode(input, { session }) {
    const task = String(input.task || '').trim();
    if (!task) return err('task 为空');

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

    let prompt = task;
    if (input.hostId) {
      const host = hostService.findHost(input.hostId);
      if (host) {
        const desc = host.type === 'local' ? '本机' : `${host.username || 'root'}@${host.host}:${host.port || 22}`;
        prompt = `目标主机: ${host.name} (${desc}), hostId="${host.id}"\n\n${task}`;
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

    auditService?.log?.({ action: 'ide_invoke_claude_code', task: task.substring(0, 500) });
    return result;
  }

  function ok(text)  { return { content: text, is_error: false }; }
  function err(text) { return { content: `[ERROR] ${text}`, is_error: true }; }

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

  // 创建 mock socket 收集 skill:* 事件，同步等待运行结束，返回拼合的文本结果
  function runViaCollector(runId, fn) {
    return new Promise((resolve) => {
      const collector = new EventEmitter();
      const lines = [];
      const MAX_OUTPUT = 30000;
      let totalLen = 0;

      const push = (text) => {
        if (totalLen > MAX_OUTPUT) return;
        const s = String(text);
        totalLen += s.length;
        lines.push(totalLen > MAX_OUTPUT ? s.slice(0, 500) + '\n...[output truncated]' : s);
      };

      let resolved = false;
      const safeResolve = (text) => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(text); } };

      collector.emit = function (event, data) {
        if (!event.startsWith('skill:')) return EventEmitter.prototype.emit.apply(this, arguments);

        switch (event) {
          case 'skill:run-started':
            push(`[started] mode=${data?.mode || 'ai-loop'} host=${data?.hostId || '?'}`);
            break;
          case 'skill:thinking':
            break;
          case 'skill:thought':
            if (data?.text) push(`[thought] ${data.text.slice(0, 500)}`);
            break;
          case 'skill:exec':
            push(`[exec] $ ${data?.command || ''}`);
            break;
          case 'skill:exec-result':
            if (data?.stdout) push(`[stdout] ${data.stdout.slice(0, 4000)}`);
            if (data?.stderr) push(`[stderr] ${data.stderr.slice(0, 2000)}`);
            push(`[exit] code=${data?.exitCode ?? '?'} ${data?.durationMs ?? 0}ms`);
            break;
          case 'skill:info':
            push(`[info] ${data?.message || ''}`);
            break;
          case 'skill:render':
            push(`[render] ${JSON.stringify(data?.payload || {}).slice(0, 2000)}`);
            break;
          case 'skill:done':
            push(`\n[done] 共 ${data?.turns ?? 0} 轮`);
            safeResolve(lines.join('\n'));
            break;
          case 'skill:error':
            push(`\n[error] ${data?.error || '未知错误'}`);
            safeResolve(lines.join('\n'));
            break;
          case 'skill:cancelled':
            push('\n[cancelled]');
            safeResolve(lines.join('\n'));
            break;
          case 'skill:ask':
            push(`[ask] ${data?.payload?.question || data?.payload?.title || '需要用户确认'}`);
            // IDE 模式自动确认，不阻塞 Skill 执行
            if (data?.toolUseId && skillRunner?.continueRun) {
              const answer = data.payload?.type === 'confirm' ? 'yes' : '(auto-confirmed by IDE)';
              push(`[auto-reply] ${answer}`);
              setTimeout(() => skillRunner.continueRun({ runId, toolUseId: data.toolUseId, answer }), 0);
            }
            break;
          case 'skill:mode':
            push(`[mode] ${data?.mode || ''} goal=${data?.goal || ''}`);
            break;
          default:
            break;
        }
        return true;
      };

      const timer = setTimeout(() => {
        push('\n[timeout] 执行超过 5 分钟，已中断');
        safeResolve(lines.join('\n'));
      }, 5 * 60 * 1000);

      fn(collector)
        .then(() => { safeResolve(lines.join('\n')); })
        .catch((e) => { push(`\n[exception] ${e.message}`); safeResolve(lines.join('\n')); });
    });
  }

  return { TOOL_SCHEMAS: buildToolSchemas(), CLAUDE_CODE_TOOL, handle, approveCommand };
}

module.exports = { createIdeTools };
