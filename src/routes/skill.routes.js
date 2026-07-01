'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/env');
const {
  buildSkillAdaptationSource,
  commitSkillAdaptationProposal,
  normalizeSkillAdaptationProposal,
} = require('../skills/skill-ai-adapter');

/**
 * Skill Library Routes
 *
 * Skill 仓库（可复用能力）：
 *   GET  /api/skills          列表
 *   GET  /api/skills/:id      详情
 *   POST /api/skills/reload   重扫
 */
function createSkillRouter({ libraryService, skillRunner, skillImportStager, aiService }) {
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

  // AI 导入：GitHub clone → 读取源 Skill → AI 适配成 1Shell 原生 Skill → 落库。
  // 中转区只作为本次导入的临时 clone 位置，成功或失败都会清理。
  router.post('/skills/ai-import', async (req, res) => {
    if (!skillImportStager) return res.status(503).json({ ok: false, error: 'Skill AI 导入功能未启用' });
    if (!aiService?.requestSkillAdaptation) return res.status(503).json({ ok: false, error: 'AI 适配服务不可用' });

    let stagedId = null;
    try {
      const pkg = await skillImportStager.register(req.body || {});
      stagedId = pkg?.id || null;
      if (!Array.isArray(pkg?.skills) || pkg.skills.length === 0) {
        const error = new Error('未在仓库中发现标准 SKILL.md，无法进行 Skill AI 导入。');
        error.statusCode = 400;
        throw error;
      }

      const skillsDir = path.join(ROOT_DIR, 'data', 'skills');
      const source = buildSkillAdaptationSource({ packageInfo: pkg });
      const raw = await aiService.requestSkillAdaptation({ source });
      const proposal = normalizeSkillAdaptationProposal(raw, { packageInfo: pkg, skillsDir });
      const result = commitSkillAdaptationProposal({ proposal, skillsDir });
      libraryService.reload();

      const skill = libraryService.getSkill(result.targetId);
      return res.status(201).json({
        ok: true,
        skill: stripDir(skill) || {
          id: result.targetId,
          name: result.name,
          description: result.description,
          category: 'imported',
          tags: [],
        },
        proposal: {
          packageId: proposal.packageId,
          targetId: result.targetId,
          name: proposal.name,
          description: proposal.description,
          compatibility: proposal.compatibility,
          recommended: proposal.recommended,
          warnings: proposal.warnings,
          report: proposal.report,
        },
      });
    } catch (err) {
      return res.status(err.statusCode || 400).json({ ok: false, error: err.message });
    } finally {
      if (stagedId) {
        try { skillImportStager.deleteImport(stagedId); } catch { /* ignore cleanup failures */ }
      }
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
