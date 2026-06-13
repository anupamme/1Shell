'use strict';

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/env');

/**
 * Skill Studio Routes
 *
 * 创作台的后端仅做一件事：把表单字段（主机、容器、文件、MCP、自然语言）
 * 拼成一段结构化 Markdown，作为对应创作 Skill 的 task 输入。
 * 真正的创作由 Skill 本身完成（走 runner.js AI-loop + write_local_file）。
 *
 * 不引入新的 AI 调用路径，保持单一执行模型。
 */
function normalizeCleanupPath(input) {
  const rel = String(input || '').trim().replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return '';
  const normalized = path.posix.normalize(rel);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  return normalized;
}

function cleanupRootForPath(relPath) {
  if (relPath.startsWith('data/programs/')) return path.resolve(ROOT_DIR, 'data', 'programs');
  if (relPath.startsWith('data/skills/')) return path.resolve(ROOT_DIR, 'data', 'skills');
  return null;
}

function artifactIdFromPath(relPath, kind) {
  const parts = relPath.split('/');
  if (kind === 'program' && parts[0] === 'data' && parts[1] === 'programs') return parts[2] || '';
  if (kind === 'skill' && parts[0] === 'data' && parts[1] === 'skills') return parts[2] || '';
  return '';
}

function cleanupEmptyArtifactDirs(relPath) {
  const root = cleanupRootForPath(relPath);
  if (!root) return;
  let dir = path.dirname(path.resolve(ROOT_DIR, relPath));
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

function createSkillStudioRouter({ hostService, libraryService, mcpRegistry, programRegistry }) {
  const router = Router();

  // GET /api/skill-studio/context — 返回创作台需要的上下文（主机列表等）
  router.get('/skill-studio/context', (_req, res) => {
    const hosts = (hostService.listHosts?.() || []).map((h) => ({
      id: h.id,
      name: h.name,
      host: h.host,
      username: h.username,
      port: h.port,
    }));
    res.json({ ok: true, hosts });
  });

  router.post('/skill-studio/cleanup-residuals', (req, res) => {
    const rawPaths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const paths = [...new Set(rawPaths.map(normalizeCleanupPath).filter(Boolean))];
    const deleted = [];
    const missing = [];
    const rejected = [];

    try { programRegistry?.reload?.(); } catch { /* best effort */ }
    try { libraryService?.reload?.(); } catch { /* best effort */ }

    const blockedProgramIds = new Set();
    const blockedSkillIds = new Set();
    for (const relPath of paths) {
      const abs = path.resolve(ROOT_DIR, relPath);
      const root = cleanupRootForPath(relPath);
      if (!root || !(abs.startsWith(root + path.sep) || abs === root)) {
        rejected.push({ path: relPath, reason: '路径不在 data/programs 或 data/skills 下' });
        continue;
      }
      if (relPath.startsWith('data/programs/')) {
        const programId = artifactIdFromPath(relPath, 'program');
        if (!programId || programRegistry?.get?.(programId)) blockedProgramIds.add(programId || relPath);
      } else if (relPath.startsWith('data/skills/')) {
        const skillId = artifactIdFromPath(relPath, 'skill');
        if (!skillId || libraryService?.getSkill?.(skillId)) blockedSkillIds.add(skillId || relPath);
      }
    }

    for (const relPath of paths) {
      const abs = path.resolve(ROOT_DIR, relPath);
      const root = cleanupRootForPath(relPath);
      if (!root || !(abs.startsWith(root + path.sep) || abs === root)) continue;
      const programId = artifactIdFromPath(relPath, 'program');
      const skillId = artifactIdFromPath(relPath, 'skill');
      if (programId && blockedProgramIds.has(programId)) {
        rejected.push({ path: relPath, reason: `任务已被 registry 加载，跳过: ${programId}` });
        continue;
      }
      if (skillId && blockedSkillIds.has(skillId)) {
        rejected.push({ path: relPath, reason: `Skill 已被 registry 加载，跳过: ${skillId}` });
        continue;
      }
      try {
        if (!fs.existsSync(abs)) {
          missing.push(relPath);
          continue;
        }
        const stat = fs.statSync(abs);
        if (!stat.isFile()) {
          rejected.push({ path: relPath, reason: '只允许清理文件，不直接删除目录' });
          continue;
        }
        fs.unlinkSync(abs);
        cleanupEmptyArtifactDirs(relPath);
        deleted.push(relPath);
      } catch (err) {
        rejected.push({ path: relPath, reason: err.message });
      }
    }

    try { programRegistry?.reload?.(); } catch { /* best effort */ }
    try { libraryService?.reload?.(); } catch { /* best effort */ }
    res.json({ ok: true, deleted, missing, rejected });
  });

  // POST /api/skill-studio/compose
  //   { mode: 'classify'|'create-skill'|'create-program'|'create-bundle'|'refine',
  //     targetSkillId?, task,
  //     hosts?, containers?, files?, mcpServers?,
  //     cronSchedule? }
  //   → { ok, composedTask, targetSkillId, mode }
  router.post('/skill-studio/compose', (req, res) => {
    const body = req.body || {};
    const ALLOWED_MODES = [
      'classify', 'create-skill', 'create-program', 'create-bundle',
      'refine',
      'edit-program', // 精准修改已有任务
      'generate', // legacy alias
    ];
    const rawMode = ALLOWED_MODES.includes(body.mode) ? body.mode : 'classify';
    const mode = rawMode === 'generate' ? 'create-program' : rawMode;
    const task = String(body.task || '').trim();
    if (!task) {
      return res.status(400).json({ ok: false, error: 'task 不能为空' });
    }

    const lines = [];
    lines.push(`**用户意图**：${task}`);
    lines.push('');

    const hosts = Array.isArray(body.hosts) ? body.hosts : [];
    if (hosts.length > 0) {
      lines.push('**目标主机**：');
      for (const h of hosts) {
        const hostInfo = hostService.findHost?.(h.id);
        const desc = hostInfo
          ? `${hostInfo.name} (${hostInfo.username || 'root'}@${hostInfo.host}:${hostInfo.port || 22})`
          : String(h.name || h.id);
        lines.push(`  - \`${h.id}\` · ${desc}${h.note ? ` — ${h.note}` : ''}`);
      }
      lines.push('');
    }

    const containers = Array.isArray(body.containers) ? body.containers : [];
    if (containers.length > 0) {
      lines.push('**相关容器**：');
      for (const c of containers) {
        lines.push(`  - hostId=\`${c.hostId}\` container=\`${c.name || c.id}\`${c.image ? ` image=${c.image}` : ''}`);
      }
      lines.push('');
    }

    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > 0) {
      lines.push('**相关文件路径**（生成的脚本应通过 execute_command 读取，不要假设内容）：');
      for (const f of files) {
        lines.push(`  - hostId=\`${f.hostId}\` path=\`${f.path}\`${f.purpose ? ` — ${f.purpose}` : ''}`);
      }
      lines.push('');
    }

    const mcpServers = Array.isArray(body.mcpServers) ? body.mcpServers : [];
    // 支持两种输入：
    //  1) { id }                     ← 创作台从仓库选的工具，按 id 从 registry 展开（含 token）
    //  2) { name, url, authToken }   ← 兼容旧调用
    const cleanMcp = mcpServers
      .map((s) => {
        if (s && s.id && mcpRegistry) {
          const hit = mcpRegistry.listServersWithSecrets().find(x => x.id === s.id);
          if (hit && hit.enabled !== false && hit.exposeToIde !== false) {
            return {
              name: hit.name,
              url: hit.url,
              authToken: hit.authToken || '',
              id: hit.id,
            };
          }
        }
        return {
          name: String((s && s.name) || '').trim(),
          url: String((s && s.url) || '').trim(),
          authToken: (s && s.authToken) ? String(s.authToken) : '',
        };
      })
      .filter((s) => s.name && s.url);
    if (cleanMcp.length > 0) {
      lines.push('**MCP Server（远程 URL 类，将自动挂载到运行时）**：');
      for (const s of cleanMcp) {
        lines.push(`  - \`${s.name}\` → ${s.url}${s.authToken ? ' (带鉴权)' : ''}`);
      }
      lines.push('');
      lines.push('生成的 SKILL.md frontmatter 必须包含 `mcpServers` 数组，原样保留上面的 name/url/authToken 字段。');
      lines.push('');
    }

    // 引用已有 Skill（能力组合）
    const referencedSkillIds = Array.isArray(body.referencedSkills) ? body.referencedSkills : [];
    const refs = referencedSkillIds
      .map((id) => {
        const item = libraryService.getItem(String(id));
        return item && item.kind === 'skill' ? item : null;
      })
      .filter(Boolean);
    if (refs.length > 0) {
      lines.push('**引用 Skill（可复用能力，生成时可调用其命令风格或直接引用）**：');
      for (const r of refs) {
        const desc = String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        lines.push(`  - \`${r.id}\` · ${r.name}${desc ? ` — ${desc}` : ''}`);
      }
      lines.push('');
      lines.push('生成的 SKILL.md frontmatter 应包含 `referencedSkills: [...]` 数组。');
      lines.push('');
    }

    // 改进模式：上一次执行的错误上下文（供 refine 使用）
    const errorContext = typeof body.errorContext === 'string' ? body.errorContext.trim() : '';
    if (errorContext) {
      lines.push('**上一次执行的错误摘要（请分析并在修改时规避）**：');
      lines.push('```');
      lines.push(errorContext.slice(0, 4000));
      lines.push('```');
      lines.push('');
    }

    if (mode === 'classify') {
      lines.push('**模式**：AI 推荐产物类型');
      lines.push('');
      lines.push('请读取 `data/skills/skill-authoring/workflows/classify.md`，按其决策树分析用户意图，');
      lines.push('用 `render_result format=keyvalue` 展示推荐方案，再用 `ask_user type=select` 让用户确认后路由到对应 generate workflow。');

    } else if (mode === 'create-skill') {
      lines.push('**模式**：创建 AI Skill（能力包）');
      lines.push('**产物位置**：`data/skills/<skill-id>/`');
      lines.push('**约束**：严格按 `data/skills/skill-authoring/workflows/generate-skill.md` 执行。');

    } else if (mode === 'create-program') {
      lines.push('**模式**：创建自动化任务草稿');
      lines.push('**产物位置**：`data/programs/<task-id>/program.yaml`（内部兼容路径）');
      lines.push('**约束**：优先通过 1Shell AI 真实 AgentRun 验证流程，再从运行记录打包为 draft_from_trace；不要依赖旧任务创作 Skill 猜流程。');
      lines.push('**硬规则**：缺少 verified AgentRun 时只能生成低可信草稿；涉及密钥必须使用 Secret Manager 引用，不能在聊天或 YAML 中保存明文。');
      lines.push('');
      // Task-specific extras
      const cronSchedule = String(body.cronSchedule || '').trim();
      if (cronSchedule) {
        lines.push(`**Cron 表达式（用户指定）**：\`${cronSchedule}\``);
        lines.push('');
      }
    } else if (mode === 'create-bundle') {
      lines.push('**模式**：Bundle 组合创作（Skill + 任务）');
      lines.push('**产物位置**：`data/skills/<skill-id>/` 和 `data/programs/<task-id>/program.yaml`');
      lines.push('**约束**：严格按 `data/skills/skill-authoring/workflows/generate-bundle.md` 执行。');

    } else if (mode === 'refine') {
      const rawIds = String(body.targetSkillId || '').trim();
      if (!rawIds) {
        return res.status(400).json({ ok: false, error: 'refine 模式必须提供 targetSkillId' });
      }
      // 支持逗号分隔的多目标
      const targetIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
      const items = targetIds.map(id => ({ id, item: libraryService.getItem(id) }));
      const missing = items.filter(({ item }) => !item).map(({ id }) => id);
      if (missing.length > 0) {
        return res.status(404).json({ ok: false, error: `待改进的项目不存在: ${missing.join(', ')}` });
      }
      lines.push(`**模式**：改进以下 ${items.length} 个项目`);
      for (const { id, item } of items) {
        const subdir = item.kind === 'program' ? 'programs' : 'skills';
        const typeLabel = item.kind === 'program' ? '任务' : 'Skill';
        lines.push(`- \`${id}\`（${typeLabel}）→ \`data/${subdir}/${id}/\``);
        lines.push(`  先用 execute_command 读取 data/${subdir}/${id}/ 下所有文件，再按用户意图做最小必要修改。`);
      }

    } else if (mode === 'edit-program') {
      const programId = String(body.programId || '').trim();
      if (!programId) {
        return res.status(400).json({ ok: false, error: 'edit-program 模式必须提供 programId' });
      }
      const yamlPath = path.join(ROOT_DIR, 'data', 'programs', programId, 'program.yaml');
      let currentYaml = '';
      try {
        currentYaml = fs.readFileSync(yamlPath, 'utf8');
      } catch {
        return res.status(404).json({ ok: false, error: `program.yaml 不存在: ${programId}` });
      }

      lines.push('**模式**：精准修改已有任务');
      lines.push(`**任务 ID**：\`${programId}\``);
      lines.push(`**产物路径**：\`data/programs/${programId}/program.yaml\``);
      lines.push('**约束**：直接读取并最小修改当前 program.yaml；不要依赖旧任务创作 Skill。');
      lines.push('**硬规则**：保持现有任务 schema、输入、触发器和安全边界；除非用户明确要求，不要扩大权限或改写无关字段。');
      lines.push('**可信度**：修改后仍需通过任务 schema 校验；涉及运行路径变化时，需要重新执行或 replay 验证。');
      lines.push('');
      lines.push('## 当前 program.yaml');
      lines.push('```yaml');
      lines.push(currentYaml.trim());
      lines.push('```');
    }

    const composedTask = lines.join('\n');

    return res.json({
      ok: true,
      mode,
      targetSkillId: body.targetSkillId || null,
      cronSchedule: body.cronSchedule || null,
      composedTask,
    });
  });

  return router;
}

module.exports = { createSkillStudioRouter };
