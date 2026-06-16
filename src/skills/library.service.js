'use strict';

function createLibraryService({ skillRegistry }) {
  function getItem(id) {
    const skill = skillRegistry.getSkill(id);
    return skill ? { ...skill, kind: 'skill' } : null;
  }

  function listSkills() {
    return (skillRegistry.listSkills() || []).map((skill) => ({ ...skill, kind: 'skill' }));
  }

  function reload() {
    return { skills: skillRegistry.reload() };
  }

  function setSkillEnabled(id, enabled) {
    if (!skillRegistry.setSkillEnabled) return null;
    const skill = skillRegistry.setSkillEnabled(id, enabled);
    return skill ? { ...skill, kind: 'skill' } : null;
  }

  function getSkill(id) {
    return getItem(id);
  }

  function renderInputsSummary(item, userInputs) {
    return skillRegistry.renderInputsSummary(item, userInputs);
  }

  return {
    getItem,
    getSkill,
    listSkills,
    reload,
    setSkillEnabled,
    renderInputsSummary,
  };
}

module.exports = { createLibraryService };
