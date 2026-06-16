'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/env');
const {
  buildSkillAdaptationSource,
  commitSkillAdaptationProposal,
  convertClaudeCodeSkillPackage,
  normalizeSkillAdaptationProposal,
  previewClaudeCodeSkillConversion,
} = require('../skills/claude-code-skill-converter');

/**
 * Skill Library Routes
 *
 * Skill 仓库（可复用能力）：
 *   GET  /api/skills          列表
 *   GET  /api/skills/:id      详情
 *   POST /api/skills/reload   重扫
 */
function createSkillRouter({ libraryService, skillRunner, claudeCodeSkillRegistry, aiService }) {
  const router = express.Router();

  const stripDir = (obj) => { if (!obj) return obj; const { dir, ...rest } = obj; return rest; };

  // ── 运行状态 ──────────────────────────────────────────
  router.get('/runs/active', (_req, res) => {
    try {
      const runs = skillRunner?.listActiveRuns?.() || [];
      res.json({ ok: true, runs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/runs/:runId/cancel', (req, res) => {
    try {
      skillRunner?.cancelRun?.(req.params.runId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Skill 仓库 ─────────────────────────────────────
  router.get('/skills', (_req, res) => {
    res.json({ ok: true, skills: libraryService.listSkills() });
  });

  router.get('/skills/:id', (req, res) => {
    const item = libraryService.getItem(req.params.id);
    if (!item || item.kind !== 'skill') {
      return res.status(404).json({ ok: false, error: 'Skill 不存在' });
    }
    res.json({ ok: true, skill: stripDir(item) });
  });

  router.post('/skills/reload', (_req, res) => {
    try {
      const counts = libraryService.reload();
      res.json({ ok: true, ...counts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 一气导入：从 GitHub clone → 转换成 1Shell 标准 SKILL.md → 落进唯一的 skill 库。
  // 中转区（claude-code-skills）只作为 clone 暂存的实现细节，导入成功后清理。
  router.post('/skills/import', async (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Skill 导入功能未启用' });
    let stagedId = null;
    try {
      const pkg = await claudeCodeSkillRegistry.register(req.body || {});
      stagedId = pkg?.id || null;
      if (!Array.isArray(pkg?.skills) || pkg.skills.length === 0) {
        if (stagedId) { try { claudeCodeSkillRegistry.deleteSkill(stagedId); } catch { /* ignore */ } }
        return res.status(400).json({ ok: false, error: '未在仓库中发现标准 SKILL.md，无法导入。' });
      }
      const result = convertClaudeCodeSkillPackage({
        packageInfo: pkg,
        skillsDir: path.join(ROOT_DIR, 'data', 'skills'),
      });
      libraryService.reload();
      // 已落 native 库，清理中转暂存（builtin 不可删，导入的都不是 builtin）。
      try { claudeCodeSkillRegistry.deleteSkill(stagedId); } catch { /* ignore */ }
      return res.status(201).json({ ok: true, imported: result.converted || [] });
    } catch (err) {
      if (stagedId) { try { claudeCodeSkillRegistry.deleteSkill(stagedId); } catch { /* ignore */ } }
      return res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  // 启用/禁用 skill（控制它是否进 1Shell AI 的可用技能目录；默认全关，由用户手动开启）
  router.patch('/skills/:id', (req, res) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled 必须是布尔值' });
      }
      const skill = libraryService.setSkillEnabled(req.params.id, req.body.enabled);
      if (!skill) return res.status(404).json({ ok: false, error: 'Skill 不存在' });
      return res.json({ ok: true, skill: stripDir(skill) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Claude Code Skill 托管仓库 ─────────────────────
  router.get('/claude-code-skills', (_req, res) => {
    if (!claudeCodeSkillRegistry) return res.json({ ok: true, skills: [] });
    res.json({ ok: true, skills: claudeCodeSkillRegistry.listSkills() });
  });

  router.get('/claude-code-skills/:id', (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    const item = claudeCodeSkillRegistry.getSkill(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
    res.json({ ok: true, skill: item });
  });

  router.post('/claude-code-skills/import/inspect', async (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const result = await claudeCodeSkillRegistry.inspect(req.body || {});
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.post('/claude-code-skills/import/register', async (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const skill = await claudeCodeSkillRegistry.register(req.body || {});
      res.status(201).json({ ok: true, skill });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.post('/claude-code-skills/:id/convert/preview', (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const item = claudeCodeSkillRegistry.getSkill(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
      const result = previewClaudeCodeSkillConversion({
        packageInfo: item,
        skillsDir: path.join(ROOT_DIR, 'data', 'skills'),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.post('/claude-code-skills/:id/convert', (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const item = claudeCodeSkillRegistry.getSkill(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
      const result = convertClaudeCodeSkillPackage({
        packageInfo: item,
        skillsDir: path.join(ROOT_DIR, 'data', 'skills'),
      });
      libraryService.reload();
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.post('/claude-code-skills/:id/adapt/preview', async (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    if (!aiService?.requestSkillAdaptation) return res.status(503).json({ ok: false, error: 'AI 适配服务不可用' });
    try {
      const item = claudeCodeSkillRegistry.getSkill(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
      const skillsDir = path.join(ROOT_DIR, 'data', 'skills');
      const source = buildSkillAdaptationSource({ packageInfo: item });
      const raw = await aiService.requestSkillAdaptation({ source });
      const proposal = normalizeSkillAdaptationProposal(raw, { packageInfo: item, skillsDir });
      res.json({ ok: true, proposal });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.post('/claude-code-skills/:id/adapt/commit', (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const item = claudeCodeSkillRegistry.getSkill(req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
      const result = commitSkillAdaptationProposal({
        proposal: req.body?.proposal || {},
        skillsDir: path.join(ROOT_DIR, 'data', 'skills'),
      });
      libraryService.reload();
      res.status(201).json({ ok: true, skill: result });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.put('/claude-code-skills/:id', (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const skill = claudeCodeSkillRegistry.updateSkill(req.params.id, req.body || {});
      if (!skill) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
      res.json({ ok: true, skill });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/claude-code-skills/:id', (req, res) => {
    if (!claudeCodeSkillRegistry) return res.status(503).json({ ok: false, error: 'Claude Code Skill 仓库未启用' });
    try {
      const ok = claudeCodeSkillRegistry.deleteSkill(req.params.id);
      if (!ok) return res.status(404).json({ ok: false, error: 'Claude Code Skill 不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/skills/:id — 删除 Skill 目录（禁止删系统 Skill）
  router.delete('/skills/:id', (req, res) => {
    const id = req.params.id;
    const item = libraryService.getItem(id);
    if (!item || item.kind !== 'skill') {
      return res.status(404).json({ ok: false, error: `Skill 不存在: ${id}` });
    }
    if (item.category === 'system') {
      return res.status(403).json({ ok: false, error: '系统 Skill 不允许删除' });
    }
    const dir = path.join(ROOT_DIR, 'data', 'skills', id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      libraryService.reload();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSkillRouter };
