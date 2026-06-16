'use strict';

const assert = require('assert');
const {
  composeSystemPrompt,
  resolveAiSkillContext,
  selectAiSkills,
} = require('../src/skills/ai-skill-resolver');

const skills = [
  {
    id: 'ui-ux-pro-max',
    name: 'ui-ux-pro-max',
    description: 'UI/UX design intelligence for frontend, dashboard, landing page, color, typography and accessibility.',
    tags: ['frontend', 'ui', 'ux'],
    referencedSkills: [],
    body: '# UI/UX Pro Max\n\nAlways start from design requirements.',
  },
  {
    id: 'vps-hardening',
    name: 'VPS Hardening',
    description: 'Linux VPS security baseline, ssh hardening, firewall and fail2ban.',
    tags: ['linux', 'security'],
    referencedSkills: ['shared-verification'],
    body: '# VPS Hardening\n\nVerify firewall and SSH settings.',
  },
  {
    id: 'shared-verification',
    name: 'Shared Verification',
    description: 'Common verification rules.',
    tags: ['verification'],
    referencedSkills: [],
    body: '# Shared Verification\n\nCollect external evidence before reporting success.',
  },
];

const registry = {
  listSkills: () => skills.map(({ body, ...rest }) => rest),
  getSkill: (id) => skills.find((skill) => skill.id === id) || null,
};

{
  const selected = selectAiSkills({
    skillRegistry: registry,
    message: 'Please use $vps-hardening-skill to secure this server.',
  });
  assert.strictEqual(selected[0].id, 'vps-hardening', 'explicit $skill-id should activate that skill first');
  assert.ok(selected.some((skill) => skill.id === 'shared-verification'), 'referenced skills should be included');
}

{
  const selected = selectAiSkills({
    skillRegistry: registry,
    message: 'Build a polished frontend dashboard with strong accessibility and typography.',
  });
  assert.strictEqual(selected[0].id, 'ui-ux-pro-max', 'matching description/tags should activate the frontend skill');
}

{
  const selected = selectAiSkills({
    skillRegistry: registry,
    message: 'Unrelated wording.',
    context: { activeSkillIds: ['ui-ux-pro-max'] },
  });
  assert.strictEqual(selected[0].id, 'ui-ux-pro-max', 'activeSkillIds context should force skill activation');
}

{
  // 渐进式披露：关键词匹配（非显式）的 skill 进「可用技能目录」，只给 name+id+desc，不再注入全文。
  const context = resolveAiSkillContext({
    skillRegistry: registry,
    message: 'Build a polished frontend dashboard.',
  });
  assert.ok(context.prompt.includes('<oneshell_active_skills>'), 'active skill prompt should be generated');
  assert.ok(context.prompt.includes('skill_id=ui-ux-pro-max'), 'matched skill should appear in the catalog by id');
  assert.ok(!context.prompt.includes('# UI/UX Pro Max'), 'catalog entries must not inline the full skill body');
  assert.ok(context.prompt.includes('load_skill'), 'catalog must instruct the agent to load skills on demand');
  const composed = composeSystemPrompt('CORE SYSTEM', context);
  assert.ok(composed.startsWith('CORE SYSTEM'), 'core system prompt should remain first');
  assert.ok(composed.includes('<oneshell_active_skills>'), 'skill prompt should be appended to system prompt');
}

{
  // 显式点名 / 强制注入（activeSkillIds）的 skill 直接展开全文，立即可用。
  const context = resolveAiSkillContext({
    skillRegistry: registry,
    message: 'Unrelated wording.',
    context: { activeSkillIds: ['ui-ux-pro-max'] },
  });
  assert.ok(context.prompt.includes('# UI/UX Pro Max'), 'explicitly requested skills should inline the full body');
}

{
  const context = resolveAiSkillContext({
    skillRegistry: registry,
    message: 'What time is it?',
  });
  assert.deepStrictEqual(context.skills, [], 'unrelated requests should not activate a skill');
  assert.strictEqual(composeSystemPrompt('CORE SYSTEM', context), 'CORE SYSTEM', 'empty skill context should not change system prompt');
}

console.log('ai-skill resolver checks passed');
