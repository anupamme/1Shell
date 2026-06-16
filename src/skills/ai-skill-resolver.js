'use strict';

// 渐进式披露后，目录项只占 name+description，可以列更多 skill 而几乎不增加 token。
const DEFAULT_MAX_ACTIVE_SKILLS = 12;
const DEFAULT_MAX_SKILL_BODY_CHARS = 18000;
const DEFAULT_MAX_TOTAL_CHARS = 36000;

function resolveAiSkillContext({
  skillRegistry,
  message = '',
  context = null,
  entry = 'core',
  maxSkills = DEFAULT_MAX_ACTIVE_SKILLS,
  maxSkillBodyChars = DEFAULT_MAX_SKILL_BODY_CHARS,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
} = {}) {
  if (!skillRegistry?.listSkills) return emptyContext();

  const selected = selectAiSkills({
    skillRegistry,
    message,
    context,
    entry,
    maxSkills,
  });
  const prompt = buildAiSkillPrompt(selected, {
    maxSkillBodyChars,
    maxTotalChars,
  });

  return {
    skills: selected.map(summarizeSkillSelection),
    prompt,
  };
}

function composeSystemPrompt(baseSystem, skillContext = null) {
  const base = String(baseSystem || '').trim();
  const prompt = String(skillContext?.prompt || '').trim();
  if (!prompt) return base;
  return [base, prompt].filter(Boolean).join('\n\n');
}

function selectAiSkills({
  skillRegistry,
  message = '',
  context = null,
  entry = 'core',
  maxSkills = DEFAULT_MAX_ACTIVE_SKILLS,
} = {}) {
  const registrySkills = safeListSkills(skillRegistry);
  if (!registrySkills.length) return [];

  const requestText = buildRequestText({ message, context, entry });
  const explicitIds = extractExplicitSkillIds({ text: requestText, context });
  const requested = [];
  const scored = [];

  for (const listed of registrySkills) {
    const full = skillRegistry.getSkill?.(listed.id) || listed;
    if (!full?.id) continue;
    const score = scoreSkill(full, requestText, explicitIds);
    if (score.explicit) {
      requested.push({ skill: full, score });
      continue;
    }
    // 渐进式披露 + 默认全关：用户在 Tools 面板手动开启的 skill 强制纳入可见目录，
    // 不再依赖关键词评分。enabled === false 明确禁用则跳过。
    // enabled 字段缺失（如纯函数单测的 mock）时保留旧的关键词自动匹配，向后兼容。
    if (full.enabled === true) {
      requested.push({ skill: full, score: { value: 50, explicit: false, reason: '已在 Tools 面板启用' } });
    } else if (full.enabled === false) {
      continue;
    } else if (score.value > 0) {
      scored.push({ skill: full, score });
    }
  }

  requested.sort(sortSelection);
  scored.sort(sortSelection);

  const picked = [];
  const seen = new Set();
  for (const item of requested.concat(scored)) {
    const id = String(item.skill.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    picked.push({ ...item.skill, _match: item.score });
    if (picked.length >= maxSkills) break;
  }

  return expandReferencedSkills(picked, skillRegistry, maxSkills);
}

function buildAiSkillPrompt(skills = [], {
  maxSkillBodyChars = DEFAULT_MAX_SKILL_BODY_CHARS,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
} = {}) {
  const selected = Array.isArray(skills) ? skills.filter(Boolean) : [];
  if (!selected.length) return '';

  // 渐进式披露（progressive disclosure）：
  //   - inline：被显式点名 / 系统强制的 skill（如 task authoring 工作手册）直接给全文，立即可用。
  //   - catalog：用户启用的其余 skill 只列 name + description + id，由 agent 自己判断是否需要，
  //     再用 load_skill 读完整 SKILL.md。这与 Claude Code / Codex 的通用 skill 用法一致，
  //     skill 文件跨 agent 通用，且只有 metadata 常驻上下文、正文按需加载。
  const inline = selected.filter((s) => s?._match?.explicit);
  const catalog = selected.filter((s) => !s?._match?.explicit);

  const lines = [
    '<oneshell_active_skills>',
    '1Shell 维护一组 SKILL.md 知识包。它们是跨 agent 通用的技能文件，由 1Shell 在调用模型前注入，与上游模型/provider 无关。',
    '下面分两部分：已展开的技能（全文，可直接遵循）和可用技能目录（仅名称与说明）。',
    '当某个目录中的技能与当前目标相关时，调用 load_skill 工具（参数 skill_id）读取它的完整说明后再遵循。',
    '技能补充 1Shell AI 核心策略，不覆盖安全、审批或验证要求。',
  ];

  let used = lines.join('\n').length;

  if (catalog.length) {
    lines.push('');
    lines.push('## 可用技能目录（按需用 load_skill 展开）');
    for (const skill of catalog) {
      const entry = `- ${safeLine(skill.name || skill.id)} (skill_id=${safeLine(skill.id)})`
        + (skill.description ? `: ${safeLine(skill.description)}` : '');
      lines.push(entry);
      used += entry.length;
    }
  }

  for (const skill of inline) {
    const body = truncate(String(skill.body || ''), maxSkillBodyChars);
    const block = [
      '',
      `## Skill: ${safeLine(skill.name || skill.id)} (${safeLine(skill.id)})`,
      skill.description ? `Description: ${safeLine(skill.description)}` : '',
      Array.isArray(skill.tags) && skill.tags.length ? `Tags: ${skill.tags.map(safeLine).join(', ')}` : '',
      skill._match?.reason ? `Selected because: ${safeLine(skill._match.reason)}` : '',
      skill._referencedBy ? `Referenced by: ${safeLine(skill._referencedBy)}` : '',
      '',
      '```skill',
      body,
      '```',
    ].filter((line) => line !== '').join('\n');

    if (used + block.length > maxTotalChars) {
      lines.push('');
      lines.push('[additional active skill content omitted because the skill prompt budget was reached]');
      break;
    }
    lines.push(block);
    used += block.length;
  }

  lines.push('</oneshell_active_skills>');
  return lines.join('\n');
}

function expandReferencedSkills(selected, skillRegistry, maxSkills) {
  const out = [];
  const seen = new Set();

  for (const skill of selected) {
    const id = String(skill.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(skill);

    const refs = Array.isArray(skill.referencedSkills) ? skill.referencedSkills : [];
    for (const refId of refs) {
      if (out.length >= maxSkills) break;
      const normalizedRefId = String(refId || '').trim();
      if (!normalizedRefId || seen.has(normalizedRefId)) continue;
      const ref = skillRegistry.getSkill?.(normalizedRefId);
      if (!ref) continue;
      seen.add(normalizedRefId);
      out.push({
        ...ref,
        _referencedBy: id,
        _match: {
          value: 1,
          explicit: false,
          reason: `referenced by ${id}`,
        },
      });
    }
  }

  return out;
}

function scoreSkill(skill, requestText, explicitIds = new Set()) {
  const id = String(skill.id || '').trim();
  const name = String(skill.name || '').trim();
  const description = String(skill.description || '').trim();
  const tags = Array.isArray(skill.tags) ? skill.tags.map(String).filter(Boolean) : [];
  const haystack = normalizeForSearch(requestText);
  const explicitAliases = aliasesForSkill(skill);

  for (const alias of explicitAliases) {
    if (explicitIds.has(alias) || containsAlias(haystack, alias)) {
      return {
        value: 100,
        explicit: true,
        reason: `explicit skill reference: ${alias}`,
      };
    }
  }

  let value = 0;
  const reasons = [];
  for (const token of meaningfulTokens([id, name].join(' '))) {
    if (containsAlias(haystack, token)) {
      value += 8;
      reasons.push(`name:${token}`);
    }
  }

  for (const tag of tags) {
    const normalizedTag = normalizeForSearch(tag);
    if (normalizedTag && containsAlias(haystack, normalizedTag)) {
      value += 10;
      reasons.push(`tag:${normalizedTag}`);
    }
  }

  const requestTokens = new Set(meaningfulTokens(requestText));
  const descriptionTokens = new Set(meaningfulTokens(description));
  for (const token of descriptionTokens) {
    if (requestTokens.has(token)) value += 1;
  }
  if (value > 0 && reasons.length === 0) reasons.push('description overlap');

  return {
    value,
    explicit: false,
    reason: reasons.slice(0, 4).join(', ') || '',
  };
}

function extractExplicitSkillIds({ text, context }) {
  const out = new Set();
  const normalized = normalizeForSearch(text);
  const patterns = [
    /\$([a-z0-9][a-z0-9_-]{1,80})/g,
    /@([a-z0-9][a-z0-9_-]{1,80})/g,
    /\bskill\s*:\s*([a-z0-9][a-z0-9_-]{1,80})/g,
    /\buse\s+skill\s+([a-z0-9][a-z0-9_-]{1,80})/g,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) out.add(match[1]);
  }

  const requested = []
    .concat(context?.skillId || [])
    .concat(context?.skillIds || [])
    .concat(context?.activeSkillIds || [])
    .concat(context?.skills || []);
  for (const item of requested) {
    if (typeof item === 'string') out.add(normalizeForSearch(item));
    else if (item?.id) out.add(normalizeForSearch(item.id));
  }
  return out;
}

function aliasesForSkill(skill) {
  const id = String(skill.id || '');
  const name = String(skill.name || '');
  return [
    id,
    name,
    `${id}-skill`,
    `${name}-skill`,
    id.replace(/-/g, '_'),
    name.replace(/-/g, '_'),
    `${id.replace(/-/g, '_')}_skill`,
    `${name.replace(/-/g, '_')}_skill`,
  ].map(normalizeForSearch).filter(Boolean);
}

function buildRequestText({ message, context, entry }) {
  const parts = [message, entry];
  if (context && typeof context === 'object') {
    for (const key of ['title', 'goal', 'intent', 'route', 'page', 'source']) {
      if (context[key]) parts.push(context[key]);
    }
    if (Array.isArray(context.files)) {
      for (const file of context.files.slice(0, 12)) parts.push(file?.path || file);
    }
  }
  return parts.map((item) => String(item || '')).filter(Boolean).join('\n');
}

function meaningfulTokens(text) {
  const normalized = normalizeForSearch(text);
  const ascii = normalized
    .split(/[^a-z0-9_+-]+/g)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  const cjk = normalized
    .match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set(ascii.concat(cjk))];
}

function containsAlias(haystack, alias) {
  const needle = normalizeForSearch(alias);
  if (!needle) return false;
  if (/^[a-z0-9_+-]+$/.test(needle)) {
    return new RegExp(`(^|[^a-z0-9_+-])${escapeRegExp(needle)}($|[^a-z0-9_+-])`).test(haystack);
  }
  return haystack.includes(needle);
}

function normalizeForSearch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeListSkills(skillRegistry) {
  try {
    const skills = skillRegistry.listSkills?.();
    return Array.isArray(skills) ? skills : [];
  } catch {
    return [];
  }
}

function summarizeSkillSelection(skill) {
  return {
    id: String(skill.id || ''),
    name: String(skill.name || skill.id || ''),
    description: String(skill.description || ''),
    reason: String(skill._match?.reason || ''),
    score: Number(skill._match?.value || 0),
    referencedBy: String(skill._referencedBy || ''),
  };
}

function sortSelection(a, b) {
  return (b.score.value - a.score.value)
    || String(a.skill.id || '').localeCompare(String(b.skill.id || ''));
}

function safeLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  const text = String(value || '');
  if (!Number.isFinite(Number(max)) || text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyContext() {
  return { skills: [], prompt: '' };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your', 'are',
  'was', 'were', 'will', 'have', 'has', 'had', 'use', 'using', 'skill',
  'one', 'two', 'new', 'old', 'make', 'create', 'build', 'fix', 'task',
]);

module.exports = {
  buildAiSkillPrompt,
  composeSystemPrompt,
  resolveAiSkillContext,
  selectAiSkills,
};
