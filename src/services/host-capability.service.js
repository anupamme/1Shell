'use strict';

const fs = require('fs');
const path = require('path');
const { getAllManifests } = require('../agents/cli-manifest');
const { getAllMcpPresets, getMcpPreset } = require('../agents/mcp-presets');

const ONESHELL_AI_AGENT = {
  id: 'oneshell-ai',
  label: '1Shell AI',
  icon: 'spark',
  kind: 'internal',
  supports: { mcp: true, skill: true },
};

function createHostCapabilityService({
  dataDir,
  mcpRegistry,
  libraryService,
  nativeCliConfig,
  mcpPresetStore,
  hostCapabilityScanner,
  logger,
} = {}) {
  const stateDir = path.join(dataDir, 'host-capabilities');
  const exposurePath = path.join(stateDir, 'exposure.json');

  function listAgents() {
    const toolsById = new Map();
    try {
      for (const tool of nativeCliConfig?.getScanInfo?.() || []) {
        toolsById.set(tool.id, tool);
      }
    } catch { /* ignore scan failures */ }

    const cliAgents = getAllManifests().map((manifest) => {
      const tool = toolsById.get(manifest.id);
      return {
        id: manifest.id,
        label: manifest.name,
        icon: manifest.id,
        kind: 'native-cli',
        installed: tool?.binary?.installed !== false,
        configured: tool?.status === 'configured',
        status: tool?.status || 'unknown',
        supports: {
          mcp: Boolean(manifest.nativeConfig?.mcp || manifest.nativeConfig?.configFiles?.length),
          skill: true,
        },
      };
    });

    return [ONESHELL_AI_AGENT, ...cliAgents];
  }

  function listMcpCapabilities() {
    const agents = listAgents();
    const policy = readExposureState().mcp || {};
    const scannedMcp = safeScanHostMcp();
    const rows = [];
    const seen = new Set();

    const oneShellBridge = scannedMcp.find((item) => item.id === '1shell');
    rows.push(toOneShellMcpRow(oneShellBridge, agents));
    seen.add('1shell');

    for (const server of safeListMcpServers()) {
      if (seen.has(server.id)) continue;
      const discovered = scannedMcp.find((item) => item.id === server.id);
      const exposure = buildMcpExposure(server, policy[server.id], agents, discovered);
      rows.push({
        id: server.id,
        kind: 'mcp',
        name: server.name || server.id,
        description: server.description || '',
        tags: Array.isArray(server.tags) ? server.tags : [],
        source: 'managed',
        transport: server.type === 'local' || server.command ? 'stdio' : 'remote',
        origin: server.installDir || server.url || '',
        runtimeStatus: server.runtimeStatus || '',
        runtimeError: server.runtimeError || '',
        toolCount: Number(server.toolCount || 0),
        managed: true,
        exposure,
      });
      seen.add(server.id);
    }

    for (const preset of getAppliedPresetRows(policy, agents)) {
      if (seen.has(preset.id)) continue;
      rows.push(preset);
      seen.add(preset.id);
    }

    for (const item of scannedMcp) {
      if (seen.has(item.id)) continue;
      if (item.source === 'oneshell') continue;
      rows.push(toExternalMcpRow(item, agents));
      seen.add(item.id);
    }

    return rows.sort(sortCapabilityRows);
  }

  function listSkillCapabilities() {
    const agents = listAgents();
    const policy = readExposureState().skill || {};
    const rows = [];
    const seen = new Set();

    for (const skill of safeListSkills()) {
      const stored = policy[skill.id] || {};
      const exposure = {};
      for (const agent of agents) {
        if (agent.id === 'oneshell-ai') {
          exposure[agent.id] = Boolean(skill.enabled);
        } else {
          exposure[agent.id] = Boolean(stored[agent.id]);
        }
      }
      rows.push({
        id: skill.id,
        kind: 'skill',
        name: skill.name || skill.id,
        description: skill.description || '',
        tags: Array.isArray(skill.tags) ? skill.tags : [],
        category: skill.category || '',
        source: skill.category === 'system' ? 'oneshell' : 'managed',
        origin: 'data/skills',
        managed: true,
        exposure,
      });
      seen.add(skill.id);
    }

    for (const item of safeScanHostSkills()) {
      if (item.managed || item.bundledCompanion || item.source !== 'installed' || seen.has(item.id)) continue;
      rows.push(toExternalSkillRow(item, agents));
      seen.add(item.id);
    }

    return rows.sort(sortCapabilityRows);
  }

  function listUnmanagedSkillCapabilities() {
    const agents = listAgents();
    const managedIds = new Set(safeListSkills().map((skill) => skill.id));
    const rows = [];
    const seen = new Set();

    for (const item of safeScanHostSkills()) {
      if (item.managed || item.bundledCompanion || item.source !== 'unmanaged' || managedIds.has(item.id) || seen.has(item.id)) continue;
      rows.push(toExternalSkillRow(item, agents));
      seen.add(item.id);
    }

    return rows.sort(sortCapabilityRows);
  }

  function scanHostCapabilities() {
    const result = hostCapabilityScanner?.scanAll?.() || { mcp: [], skills: [], warnings: [] };
    const scannedSkills = (Array.isArray(result.unmanagedSkills) ? result.unmanagedSkills : (result.skills || []))
      .filter((item) => item.bundledCompanion !== true && item.source !== 'bundled');
    const installedSkills = scannedSkills.filter((item) => item.source === 'installed');
    const unmanagedSkills = scannedSkills.filter((item) => item.source === 'unmanaged');
    return {
      mcpCount: result.mcp?.length || 0,
      skillCount: scannedSkills.length,
      externalMcpCount: result.mcp?.filter((item) => item.source === 'external').length || 0,
      externalSkillCount: scannedSkills.length,
      installedSkillCount: installedSkills.length,
      unmanagedSkillCount: unmanagedSkills.length,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  }

  function importCapability(kind, id) {
    const normalizedKind = normalizeKind(kind);
    const cleanId = String(id || '').trim();
    if (!cleanId) throw new Error('capability id 不能为空');
    if (!hostCapabilityScanner) throw new Error('Host Capability Scanner 未初始化');

    if (normalizedKind === 'mcp') {
      const item = safeScanHostMcp().find((candidate) => candidate.id === cleanId);
      if (!item) throw new Error(`未找到可导入的 MCP: ${cleanId}`);
      hostCapabilityScanner.importMcpToRegistry(item, mcpRegistry);
      return listMcpCapabilities().find((row) => row.id === cleanId) || null;
    }

    const item = safeScanHostSkills().find((candidate) => candidate.id === cleanId && candidate.bundledCompanion !== true);
    if (!item) throw new Error(`未找到可导入的 Skill: ${cleanId}`);
    hostCapabilityScanner.importSkillToDirectory(item, path.join(dataDir, 'skills'));
    libraryService?.reload?.();
    return listSkillCapabilities().find((row) => row.id === cleanId) || null;
  }

  function setExposure(kind, id, agentId, enabled) {
    const normalizedKind = normalizeKind(kind);
    const cleanId = String(id || '').trim();
    const cleanAgentId = String(agentId || '').trim();
    const nextEnabled = enabled === true;
    if (!cleanId) throw new Error('capability id 不能为空');
    if (!listAgents().some((agent) => agent.id === cleanAgentId)) {
      throw new Error(`未知 Agent: ${cleanAgentId}`);
    }

    if (cleanAgentId === 'oneshell-ai') {
      applyOneShellAiExposure(normalizedKind, cleanId, nextEnabled);
    } else {
      validateNativeExposure(normalizedKind, cleanId, cleanAgentId, nextEnabled);
      applyNativeExposure(normalizedKind, cleanId, cleanAgentId, nextEnabled);
    }

    const state = readExposureState();
    if (!state[normalizedKind]) state[normalizedKind] = {};
    if (!state[normalizedKind][cleanId]) state[normalizedKind][cleanId] = {};
    state[normalizedKind][cleanId][cleanAgentId] = nextEnabled;
    writeExposureState(state);

    return normalizedKind === 'mcp'
      ? listMcpCapabilities().find((item) => item.id === cleanId) || null
      : listSkillCapabilities().find((item) => item.id === cleanId) || null;
  }

  function applyOneShellAiExposure(kind, id, enabled) {
    if (kind === 'skill') {
      const updated = libraryService?.setSkillEnabled?.(id, enabled);
      if (!updated) throw new Error(`Skill 不存在: ${id}`);
      return;
    }

    const server = mcpRegistry?.getServer?.(id);
    if (!server && enabled) {
      const imported = importPresetToOneShellMcp(id);
      if (imported) return;
    }
    if (!server) throw new Error(`MCP 不存在: ${id}`);
    const patch = enabled ? { exposeToIde: true, enabled: true } : { exposeToIde: false };
    mcpRegistry.updateServer(id, patch);
  }

  function validateNativeExposure(kind, id, agentId, enabled) {
    if (!enabled || kind !== 'mcp') return;
    if (isNativeMcpConfiguredForAgent(id, agentId)) return;
    const preset = getMcpPreset(id);
    if (!preset) return;
    const missing = missingPresetConfigKeys(preset, {});
    if (missing.length === 0) return;
    const existing = (mcpPresetStore?.getAppliedRaw?.(agentId) || []).find((item) => item.presetId === id);
    if (missingPresetConfigKeys(preset, existing?.config || {}).length === 0) return;
    throw new Error(`${preset.name || id} 需要配置 ${missing.join(', ')}，请先在 Agent MCP preset 配置中填写后再暴露。`);
  }

  function applyNativeExposure(kind, id, agentId, enabled) {
    if (kind !== 'mcp' || !mcpPresetStore) return;
    if (enabled && isNativeMcpConfiguredForAgent(id, agentId)) return;
    const preset = getMcpPreset(id);
    if (!preset) return;
    if (enabled) {
      const existing = (mcpPresetStore.getAppliedRaw?.(agentId) || []).find((item) => item.presetId === id);
      mcpPresetStore.apply(agentId, id, existing?.config || {});
    } else {
      mcpPresetStore.remove(agentId, id);
    }
  }

  function importPresetToOneShellMcp(id) {
    if (!mcpRegistry?.createServer) throw new Error('MCP Registry 未初始化');
    const preset = getMcpPreset(id);
    if (!preset) return null;
    const missing = missingPresetConfigKeys(preset, {});
    if (missing.length > 0) {
      throw new Error(`${preset.name || id} 需要配置 ${missing.join(', ')}，当前矩阵页暂不直接导入带配置的 preset。`);
    }
    const command = presetServerToCommand(preset.server);
    const server = mcpRegistry?.createServer?.({
      id: preset.id,
      name: preset.name || preset.id,
      command,
      installDir: '',
      description: preset.description || '',
      tags: Array.isArray(preset.tags) ? preset.tags : [],
      enabled: true,
      autoStart: false,
      exposeToIde: true,
    });
    logger?.info?.(`[host-capability] imported MCP preset for 1Shell AI: ${id}`);
    return server;
  }

  function missingPresetConfigKeys(preset, config) {
    const missing = [];
    for (const key of preset?.needsConfig || []) {
      if (!config || !config[key]) missing.push(key);
    }
    return missing;
  }

  function presetServerToCommand(server = {}) {
    const command = String(server.command || '').trim();
    if (!command) throw new Error('preset MCP 缺少 command');
    const args = Array.isArray(server.args) ? server.args.map(String) : [];
    const envEntries = server.env && typeof server.env === 'object'
      ? Object.entries(server.env).map(([key, value]) => [String(key), String(value)])
      : [];
    for (const value of [...args, ...envEntries.map(([, value]) => value)]) {
      if (/\{[^}]+\}/.test(value)) {
        throw new Error('preset MCP 启动配置仍包含占位符，请先填写配置后再导入。');
      }
    }
    const envPrefix = envEntries
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([key, value]) => `${key}=${shellQuote(value)}`);
    return [...envPrefix, shellQuote(command), ...args.map(shellQuote)].join(' ');
  }

  function shellQuote(value) {
    const text = String(value ?? '');
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
  }

  function buildMcpExposure(server, stored = {}, agents = [], discovered = null) {
    const found = new Set(Array.isArray(discovered?.foundIn) ? discovered.foundIn : []);
    const exposure = {};
    for (const agent of agents) {
      if (agent.id === 'oneshell-ai') {
        exposure[agent.id] = server.enabled !== false && server.exposeToIde !== false;
      } else {
        exposure[agent.id] = found.has(agent.id) || Boolean(stored?.[agent.id]);
      }
    }
    return exposure;
  }

  function isNativeMcpConfiguredForAgent(id, agentId) {
    if (!id || !agentId) return false;
    return safeScanHostMcp().some((item) => item.id === id && Array.isArray(item.foundIn) && item.foundIn.includes(agentId));
  }

  function toExternalMcpRow(item, agents) {
    return {
      id: item.id,
      kind: 'mcp',
      name: item.name || item.id,
      description: item.description || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      source: 'external',
      transport: item.transport || 'mcp',
      origin: formatOrigin(item),
      originPaths: Array.isArray(item.originPaths) ? item.originPaths : [],
      foundIn: Array.isArray(item.foundIn) ? item.foundIn : [],
      runtimeStatus: '',
      runtimeError: '',
      toolCount: 0,
      managed: false,
      external: true,
      readonly: true,
      importable: true,
      exposure: buildDiscoveredExposure(item, agents),
    };
  }

  function toOneShellMcpRow(item, agents) {
    return {
      id: '1shell',
      kind: 'mcp',
      name: '1Shell MCP Bridge',
      description: '1Shell 暴露给原生 Agent 的内置 MCP Bridge。',
      tags: ['oneshell', 'bridge', 'mcp'],
      source: 'oneshell',
      transport: item?.transport || 'remote',
      origin: item ? formatOrigin(item) : '/mcp/sse',
      originPaths: Array.isArray(item?.originPaths) ? item.originPaths : [],
      foundIn: Array.isArray(item?.foundIn) ? item.foundIn : [],
      runtimeStatus: '',
      runtimeError: '',
      toolCount: 0,
      managed: true,
      external: false,
      readonly: true,
      importable: false,
      exposure: buildOneShellBridgeExposure(item, agents),
    };
  }

  function buildOneShellBridgeExposure(item, agents) {
    const found = new Set(Array.isArray(item?.foundIn) ? item.foundIn : []);
    const exposure = {};
    for (const agent of agents) {
      exposure[agent.id] = agent.id === 'oneshell-ai' ? true : found.has(agent.id);
    }
    return exposure;
  }

  function toExternalSkillRow(item, agents) {
    return {
      id: item.id,
      kind: 'skill',
      name: item.name || item.id,
      description: item.description || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      category: item.category || '',
      source: item.source || 'unmanaged',
      origin: formatOrigin(item),
      originPaths: Array.isArray(item.originPaths) ? item.originPaths : [],
      foundIn: Array.isArray(item.foundIn) ? item.foundIn : [],
      managed: false,
      external: true,
      readonly: true,
      importable: true,
      exposure: buildDiscoveredExposure(item, agents),
    };
  }

  function buildDiscoveredExposure(item, agents) {
    const found = new Set(Array.isArray(item.foundIn) ? item.foundIn : []);
    const exposure = {};
    for (const agent of agents) {
      exposure[agent.id] = found.has(agent.id);
    }
    return exposure;
  }

  function formatOrigin(item) {
    const paths = Array.isArray(item.originPaths) ? item.originPaths : [];
    if (paths.length === 0) return '';
    if (paths.length === 1) return paths[0];
    return `${paths[0]} +${paths.length - 1}`;
  }

  function getAppliedPresetRows(policy, agents) {
    const rowsById = new Map();
    const presetsById = new Map(getAllMcpPresets().map((preset) => [preset.id, preset]));
    for (const agent of agents) {
      if (agent.id === 'oneshell-ai') continue;
      const applied = mcpPresetStore?.listApplied?.(agent.id) || [];
      for (const item of applied) {
        const preset = presetsById.get(item.presetId);
        if (!preset) continue;
        let row = rowsById.get(preset.id);
        if (!row) {
          row = {
            id: preset.id,
            kind: 'mcp',
            name: preset.name || preset.id,
            description: preset.description || '',
            tags: Array.isArray(preset.tags) ? preset.tags : [],
            source: 'preset',
            transport: 'stdio',
            origin: preset.homepage || preset.docs || '',
            runtimeStatus: '',
            runtimeError: '',
            toolCount: 0,
            managed: true,
            exposure: Object.fromEntries(agents.map((a) => [a.id, false])),
          };
          rowsById.set(preset.id, row);
        }
        row.exposure[agent.id] = true;
      }
    }

    for (const [id, agentMap] of Object.entries(policy || {})) {
      const preset = presetsById.get(id);
      if (!preset) continue;
      let row = rowsById.get(id);
      if (!row) {
        row = {
          id,
          kind: 'mcp',
          name: preset.name || id,
          description: preset.description || '',
          tags: Array.isArray(preset.tags) ? preset.tags : [],
          source: 'preset',
          transport: 'stdio',
          origin: preset.homepage || preset.docs || '',
          runtimeStatus: '',
          runtimeError: '',
          toolCount: 0,
          managed: true,
          exposure: Object.fromEntries(agents.map((a) => [a.id, false])),
        };
        rowsById.set(id, row);
      }
      for (const [agentId, enabled] of Object.entries(agentMap || {})) {
        if (agentId in row.exposure) row.exposure[agentId] = Boolean(enabled);
      }
    }

    return Array.from(rowsById.values());
  }

  function safeListMcpServers() {
    try {
      return mcpRegistry?.listServers?.() || [];
    } catch {
      return [];
    }
  }

  function safeListSkills() {
    try {
      return libraryService?.listSkills?.() || [];
    } catch {
      return [];
    }
  }

  function safeScanHostMcp() {
    try {
      return hostCapabilityScanner?.scanMcpCapabilities?.() || [];
    } catch (err) {
      logger?.warn?.(`[host-capability] host MCP scan failed: ${err.message}`);
      return [];
    }
  }

  function safeScanHostSkills() {
    try {
      return hostCapabilityScanner?.scanUnmanagedSkillCapabilities?.() || [];
    } catch (err) {
      logger?.warn?.(`[host-capability] host skill scan failed: ${err.message}`);
      return [];
    }
  }

  function readExposureState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(exposurePath, 'utf8'));
      return normalizeExposureState(parsed);
    } catch {
      return { mcp: {}, skill: {} };
    }
  }

  function writeExposureState(state) {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = path.join(stateDir, `.exposure.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(normalizeExposureState(state), null, 2), 'utf8');
    fs.renameSync(tmp, exposurePath);
  }

  function normalizeExposureState(value) {
    return {
      mcp: value?.mcp && typeof value.mcp === 'object' && !Array.isArray(value.mcp) ? value.mcp : {},
      skill: value?.skill && typeof value.skill === 'object' && !Array.isArray(value.skill) ? value.skill : {},
    };
  }

  function normalizeKind(kind) {
    const value = String(kind || '').trim().toLowerCase();
    if (value === 'mcp' || value === 'skill') return value;
    throw new Error(`未知 Capability 类型: ${kind}`);
  }

  function sortCapabilityRows(a, b) {
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN');
  }

  return {
    listAgents,
    listMcpCapabilities,
    listSkillCapabilities,
    listUnmanagedSkillCapabilities,
    scanHostCapabilities,
    importCapability,
    setExposure,
  };
}

module.exports = { createHostCapabilityService };
