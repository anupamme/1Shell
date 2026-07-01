'use strict';

/**
 * 用户给 CLI 原生配置添加的 MCP preset 持久化存储。
 *
 * data/agent-mcp-presets.json:
 *   {
 *     "claude-code": [
 *       { "presetId": "fetch", "addedAt": 1234567890, "config": {} },
 *       { "presetId": "github", "addedAt": 1234567891, "config": { "githubToken": "ghp_xxx" } }
 *     ],
 *     "codex": [...],
 *     "opencode": [...]
 *   }
 *
 * 设计原则:
 *   - 同 cliId 同 presetId 重复 apply,后写覆盖前(用最新 config)
 *   - secret 字段(github token 等)以原文存(同 proxy-configs.json 的 apiKey),
 *     listApplied 时按 needsConfig 标记脱敏返回(*** 替换)
 *   - 没 apply 任何 preset 时,store 不影响原生配置生成
 */

const fs = require('fs');
const path = require('path');
const { getMcpPreset } = require('./mcp-presets');

function createMcpPresetStore({ dataDir }) {
  const configPath = path.join(dataDir, 'agent-mcp-presets.json');

  function _readAll() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
  }
  function _writeAll(data) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  }

  function _maskConfig(presetId, rawConfig) {
    const preset = getMcpPreset(presetId);
    if (!preset || !rawConfig || typeof rawConfig !== 'object') return rawConfig || {};
    // needsConfig 列出的字段都视为可能含密,脱敏
    const masked = {};
    const sensitiveKeys = new Set(preset.needsConfig || []);
    for (const [k, v] of Object.entries(rawConfig)) {
      if (sensitiveKeys.has(k) && typeof v === 'string' && v.length > 0) {
        masked[k] = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-2)}` : '***';
      } else {
        masked[k] = v;
      }
    }
    return masked;
  }

  /** 列出 cliId 已应用的 preset(脱敏 config) */
  function listApplied(cliId) {
    const all = _readAll();
    const items = Array.isArray(all[cliId]) ? all[cliId] : [];
    return items.map(item => ({
      presetId: item.presetId,
      addedAt: item.addedAt,
      config: _maskConfig(item.presetId, item.config),
      configSet: !!item.config && Object.keys(item.config).length > 0,
    }));
  }

  /** 获取 cliId 已应用的 preset 原始数据(含未脱敏 config) — 给原生配置写入器用 */
  function getAppliedRaw(cliId) {
    const all = _readAll();
    return Array.isArray(all[cliId]) ? all[cliId] : [];
  }

  /** 应用一个 preset(同 cliId 同 presetId 重复 apply 用最新 config 覆盖) */
  function apply(cliId, presetId, config) {
    const preset = getMcpPreset(presetId);
    if (!preset) throw new Error(`未知 MCP preset: ${presetId}`);
    // 校验 needsConfig 字段都已提供(空字符串视为未提供)
    for (const key of (preset.needsConfig || [])) {
      if (!config || !config[key]) {
        throw new Error(`preset ${presetId} 需要配置字段 "${key}"`);
      }
    }
    const all = _readAll();
    if (!Array.isArray(all[cliId])) all[cliId] = [];
    const idx = all[cliId].findIndex(x => x.presetId === presetId);
    const entry = {
      presetId,
      addedAt: Date.now(),
      config: config && typeof config === 'object' ? config : {},
    };
    if (idx >= 0) all[cliId][idx] = entry;
    else all[cliId].push(entry);
    _writeAll(all);
    return true;
  }

  /** 移除某 cliId 下的某 preset */
  function remove(cliId, presetId) {
    const all = _readAll();
    if (!Array.isArray(all[cliId])) return false;
    const before = all[cliId].length;
    all[cliId] = all[cliId].filter(x => x.presetId !== presetId);
    if (all[cliId].length === before) return false;
    _writeAll(all);
    return true;
  }

  return { listApplied, getAppliedRaw, apply, remove };
}

module.exports = { createMcpPresetStore };
