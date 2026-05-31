'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./registry');

function previewClaudeCodeSkillConversion({ packageInfo, skillsDir }) {
  const sourceSkills = getConvertibleSkills(packageInfo);
  const used = new Set();
  return {
    packageId: packageInfo.id,
    packageName: packageInfo.name || packageInfo.id,
    conversions: sourceSkills.map((skill) => buildConversionPreview({ packageInfo, skill, skillsDir, used })),
  };
}

function convertClaudeCodeSkillPackage({ packageInfo, skillsDir }) {
  const preview = previewClaudeCodeSkillConversion({ packageInfo, skillsDir });
  const converted = [];

  for (const item of preview.conversions) {
    const sourcePath = path.resolve(packageInfo.sourceDir, item.sourcePath);
    const sourceDir = path.dirname(sourcePath);
    const targetDir = path.join(skillsDir, item.targetId);
    if (!isInside(skillsDir, targetDir)) throw new Error(`目标 Skill 路径不合法: ${item.targetId}`);
    if (!isInside(packageInfo.sourceDir, sourcePath)) throw new Error(`源 Skill 路径不合法: ${item.sourcePath}`);
    if (!fs.existsSync(sourcePath)) throw new Error(`源 SKILL.md 不存在: ${item.sourcePath}`);
    if (fs.existsSync(targetDir)) throw new Error(`目标 1Shell Skill 已存在: ${item.targetId}`);

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: shouldCopySkillPath,
    });

    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), buildConvertedSkillMd({ sourcePath, item, packageInfo }), 'utf8');
    converted.push({ ...item, targetDir });
  }

  return { ...preview, converted };
}

function buildSkillAdaptationSource({ packageInfo }) {
  const files = collectPackageFiles(packageInfo.sourceDir, 20, 50000);
  const lines = [];
  lines.push(`# Claude Code Skill Package: ${packageInfo.name || packageInfo.id}`);
  lines.push(`packageId: ${packageInfo.id}`);
  if (packageInfo.description) lines.push(`description: ${packageInfo.description}`);
  if (packageInfo.repoUrl) lines.push(`repoUrl: ${packageInfo.repoUrl}`);
  lines.push('');
  lines.push('## Discovered skills');
  for (const skill of packageInfo.skills || []) {
    lines.push(`- ${skill.id}: ${skill.path}${skill.description ? ` — ${skill.description}` : ''}`);
  }
  lines.push('');
  lines.push('## Compatibility signals');
  lines.push(...scanCompatibilitySignals(files).map((item) => `- ${item}`));
  lines.push('');
  lines.push('## Source files');
  for (const file of files) {
    lines.push(`\n### ${file.path}\n\`\`\``);
    lines.push(file.content);
    lines.push('```');
  }
  return lines.join('\n').slice(0, 60000);
}

function normalizeSkillAdaptationProposal(raw, { packageInfo, skillsDir }) {
  const parsed = parseJsonObject(raw);
  const targetId = uniqueSkillId(safeSegment(parsed.targetId || packageInfo.id), skillsDir, new Set());
  const files = normalizeProposalFiles(parsed.files);
  if (!files.some((file) => file.path === 'SKILL.md')) {
    files.unshift({ path: 'SKILL.md', content: buildFallbackAdaptedSkillMd({ parsed, packageInfo }) });
  }
  return {
    packageId: packageInfo.id,
    packageName: packageInfo.name || packageInfo.id,
    recommended: parsed.recommended !== false,
    targetId,
    name: String(parsed.name || targetId).trim(),
    description: String(parsed.description || '').trim(),
    compatibility: ['high', 'medium', 'low', 'not_recommended'].includes(parsed.compatibility) ? parsed.compatibility : 'medium',
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String).filter(Boolean) : [],
    report: String(parsed.report || '').trim(),
    files,
  };
}

function commitSkillAdaptationProposal({ proposal, skillsDir }) {
  const targetId = safeSegment(proposal?.targetId);
  if (!targetId) throw new Error('targetId 不能为空');
  const targetDir = path.join(skillsDir, targetId);
  if (!isInside(skillsDir, targetDir)) throw new Error('目标 Skill 路径不合法');
  if (fs.existsSync(targetDir)) throw new Error(`目标 1Shell Skill 已存在: ${targetId}`);
  const files = normalizeProposalFiles(proposal.files);
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error('转换草稿缺少 SKILL.md');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const target = path.join(targetDir, file.path);
    if (!isInside(targetDir, target)) throw new Error(`文件路径不合法: ${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  return { ...proposal, targetId, targetDir, files };
}

function getConvertibleSkills(packageInfo) {
  if (!packageInfo?.sourceDir || !Array.isArray(packageInfo.skills)) return [];
  return packageInfo.skills
    .filter((skill) => skill?.path && fs.existsSync(path.resolve(packageInfo.sourceDir, skill.path)))
    .filter((skill) => isInside(packageInfo.sourceDir, path.resolve(packageInfo.sourceDir, skill.path)));
}

function buildConversionPreview({ packageInfo, skill, skillsDir, used }) {
  const sourcePath = path.resolve(packageInfo.sourceDir, skill.path);
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { meta } = parseFrontmatter(raw);
  const name = String(meta.name || skill.name || skill.id || packageInfo.name || packageInfo.id).trim();
  const description = String(meta.description || skill.description || packageInfo.description || '').trim();
  const targetId = uniqueSkillId(safeSegment(skill.id || name || packageInfo.id), skillsDir, used);
  used.add(targetId);
  return {
    sourceSkillId: skill.id || path.basename(path.dirname(sourcePath)),
    sourcePath: String(skill.path).replace(/\\/g, '/'),
    targetId,
    name,
    description,
    tags: normalizeTags(meta.tags || skill.tags || packageInfo.tags),
  };
}

function buildConvertedSkillMd({ sourcePath, item, packageInfo }) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { body } = parseFrontmatter(raw);
  const tags = Array.from(new Set(['converted', 'claude-code-skill', ...normalizeTags(item.tags)]));
  const frontmatter = [
    '---',
    `name: ${quoteYaml(item.name || item.targetId)}`,
    'icon: "skill"',
    'hidden: false',
    'forceLocal: true',
    `description: ${quoteYaml(item.description || `Converted from Claude Code Skill ${packageInfo.id}`)}`,
    'category: imported',
    'tags:',
    ...tags.map((tag) => `  - ${quoteYaml(tag)}`),
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${String(body || '').trim()}\n`;
}

function uniqueSkillId(base, skillsDir, used) {
  const cleanBase = safeSegment(base) || 'imported-skill';
  let id = cleanBase;
  let counter = 2;
  while (used.has(id) || fs.existsSync(path.join(skillsDir, id))) {
    id = `${cleanBase}-${counter}`;
    counter += 1;
  }
  return id;
}

function collectPackageFiles(sourceDir, maxFiles, maxChars) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return [];
  const out = [];
  let total = 0;
  walk(sourceDir);
  return out;

  function walk(dir) {
    if (out.length >= maxFiles || total >= maxChars) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !['.git', 'node_modules', 'dist', 'build'].includes(entry.name))
      .sort((a, b) => Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md') || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles || total >= maxChars) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!isTextLikeFile(entry.name)) continue;
      const content = fs.readFileSync(full, 'utf8').slice(0, 8000);
      total += content.length;
      out.push({ path: path.relative(sourceDir, full).replace(/\\/g, '/'), content });
    }
  }
}

function scanCompatibilitySignals(files) {
  const text = files.map((file) => `${file.path}\n${file.content}`).join('\n');
  const signals = [];
  if (/hooks\//i.test(text) || /SessionStart|run-hook|hooks\.json/i.test(text)) signals.push('检测到 Claude Code hooks/plugin 生命周期，不能直接转换为 1Shell AI 执行逻辑。');
  if (/subagent|Agent\(|parallel agent|Task\(/i.test(text)) signals.push('检测到子代理/并行代理语义，需要改写为 1Shell 可理解的流程。');
  if (/\b(Read|Edit|Bash|Grep|Glob|Write)\b/.test(text)) signals.push('检测到 Claude Code 工具名，需要改写为 1Shell AI 的能力描述。');
  if (/mcp__/i.test(text)) signals.push('检测到 MCP 工具引用，需要在 1Shell 仓库中单独配置 MCP。');
  if (/worktree|git worktree/i.test(text)) signals.push('检测到 git worktree 开发流程，通常只适合 Claude Code。');
  if (signals.length === 0) signals.push('未检测到明显 Claude Code 重型运行时依赖。');
  return signals;
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI 返回不是对象');
    return parsed;
  } catch (err) {
    throw new Error(`AI 转换结果不是有效 JSON: ${err.message}`);
  }
}

function normalizeProposalFiles(files) {
  if (!Array.isArray(files)) throw new Error('转换草稿缺少 files 数组');
  return files.map((file) => {
    const rel = normalizeRelativeFilePath(file?.path);
    const content = String(file?.content || '');
    if (!rel || !content.trim()) return null;
    return { path: rel, content: content.endsWith('\n') ? content : `${content}\n` };
  }).filter(Boolean);
}

function normalizeRelativeFilePath(value) {
  const rel = String(value || '').trim().replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return '';
  const normalized = path.posix.normalize(rel);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  if (!/\.(md|json|txt|yaml|yml)$/i.test(normalized)) return '';
  return normalized;
}

function buildFallbackAdaptedSkillMd({ parsed, packageInfo }) {
  const targetId = safeSegment(parsed.targetId || packageInfo.id) || 'adapted-skill';
  return [
    '---',
    `name: ${quoteYaml(parsed.name || packageInfo.name || targetId)}`,
    'icon: "skill"',
    'hidden: false',
    'forceLocal: true',
    `description: ${quoteYaml(parsed.description || `AI adapted from Claude Code Skill ${packageInfo.id}`)}`,
    'category: imported',
    'tags:',
    '  - "ai-adapted"',
    '  - "claude-code-skill"',
    '---',
    '',
    `# ${parsed.name || packageInfo.name || targetId}`,
    '',
    parsed.report || '这个 Skill 由 Claude Code Skill AI 适配生成。',
    '',
  ].join('\n');
}

function isTextLikeFile(name) {
  return /(^SKILL\.md$|\.(md|txt|json|yaml|yml)$)/i.test(name);
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
}

function quoteYaml(value) {
  return JSON.stringify(String(value || ''));
}

function shouldCopySkillPath(src) {
  const parts = path.resolve(src).split(path.sep);
  return !parts.some((part) => part === '.git' || part === 'node_modules');
}

function safeSegment(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  buildSkillAdaptationSource,
  commitSkillAdaptationProposal,
  convertClaudeCodeSkillPackage,
  normalizeSkillAdaptationProposal,
  previewClaudeCodeSkillConversion,
};
