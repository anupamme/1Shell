'use strict';

const DEFAULT_MAX_ACTIVE_SKILLS = 3;
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
    if (score.explicit) requested.push({ skill: full, score });
    else if (score.value > 0) scored.push({ skill: full, score });
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

  const lines = [
    '<oneshell_active_skills>',
    '1Shell has selected the following SKILL.md instructions for this AI run.',
    'These instructions are injected by 1Shell before the model call, so they apply regardless of the upstream model/provider.',
    'Follow the active skills when they are relevant to the user goal. They augment the core 1Shell AI policy and do not override safety, approval, or verification requirements.',
    'If a skill body refers to extra relative files, read them only when needed with read_remote_file using hostId="local" and path="data/skills/<skill-id>/<relative-path>".',
  ];

  let used = lines.join('\n').length;
  for (const skill of selected) {
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
