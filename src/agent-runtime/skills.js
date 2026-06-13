'use strict';

function createSkillResolver({ skillRegistry, builtins = {} } = {}) {
  return {
    async resolve(spec = {}) {
      return resolveAgentSkills({ spec, skillRegistry, builtins });
    },
  };
}

async function resolveAgentSkills({ spec = {}, skillResolver = null, skillRegistry = null, builtins = {} } = {}) {
  if (skillResolver?.resolve && skillResolver.resolve !== resolveAgentSkills) {
    const resolved = await skillResolver.resolve(spec);
    return normalizeResolvedSkills(resolved, spec.skills);
  }

  const names = normalizeStringArray(spec.skills);
  const skills = [];
  for (const name of names) {
    const body = await resolveSkillBody(name, { skillRegistry, builtins });
    if (!body) continue;
    skills.push({ name, body, source: builtins[name] ? 'builtin' : 'registry' });
  }
  return skills;
}

async function resolveSkillBody(name, { skillRegistry, builtins } = {}) {
  if (Object.prototype.hasOwnProperty.call(builtins || {}, name)) {
    return String(builtins[name] || '').trim();
  }
  try {
    const body = skillRegistry?.getSkillBody?.(name);
    return String(await Promise.resolve(body || '')).trim();
  } catch {
    return '';
  }
}

function normalizeResolvedSkills(value, requestedNames = []) {
  if (!Array.isArray(value)) return [];
  const requested = normalizeStringArray(requestedNames);
  return value
    .map((item, index) => {
      if (typeof item === 'string') {
        return { name: requested[index] || `skill-${index + 1}`, body: item.trim(), source: 'resolver' };
      }
      if (!item || typeof item !== 'object') return null;
      const body = String(item.body || item.content || '').trim();
      if (!body) return null;
      return {
        name: String(item.name || requested[index] || `skill-${index + 1}`).trim(),
        body,
        source: String(item.source || 'resolver'),
      };
    })
    .filter(Boolean);
}

function renderSkillSystemPrompt(skills = []) {
  return normalizeResolvedSkills(skills)
    .map((skill) => skill.body)
    .filter(Boolean)
    .join('\n\n');
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

module.exports = {
  createSkillResolver,
  renderSkillSystemPrompt,
  resolveAgentSkills,
};
