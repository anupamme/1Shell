'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const toml = require('toml');
const { parseFrontmatter } = require('../skills/registry');

function createHostCapabilityScanner(options = {}) {
  const {
    dataDir,
    homeDir,
    logger,
  } = options;
  const explicitHomeDir = Object.prototype.hasOwnProperty.call(options, 'homeDir');
  const rootDataDir = dataDir ? path.resolve(dataDir) : path.join(process.cwd(), 'data');
  const rootHomeDir = homeDir ? path.resolve(homeDir) : os.homedir();
  let bundledSkillCatalogCache = null;

  function scanAll() {
    const warnings = [];
    const mcp = scanMcpCapabilities(warnings);
    const skills = scanUnmanagedSkillCapabilities(warnings);
    return { mcp, skills, unmanagedSkills: skills, warnings };
  }

  function scanMcpCapabilities(warnings = []) {
    const rowsById = new Map();
    for (const target of mcpConfigTargets()) {
      for (const filePath of target.paths) {
        if (!filePath || !fs.existsSync(filePath)) continue;
        let parsed;
        try {
          parsed = readConfigFile(filePath);
        } catch (err) {
          addWarning(warnings, `MCP 配置解析失败: ${displayPath(filePath)} (${err.message})`);
          continue;
        }

        for (const entry of collectMcpEntries(parsed, filePath)) {
          const id = normalizeCapabilityId(entry.id);
          if (!id) continue;
          const spec = normalizeMcpSpec(entry.spec);
          if (!spec) continue;
          mergeDiscoveredMcp(rowsById, {
            id,
            nativeId: entry.id,
            name: id === '1shell' ? '1Shell MCP Bridge' : String(entry.spec?.name || entry.id || id),
            description: String(entry.spec?.description || ''),
            tags: id === '1shell' ? ['oneshell', 'bridge', target.agentId] : ['host', target.agentId],
            source: id === '1shell' ? 'oneshell' : 'external',
            transport: spec.url ? 'remote' : 'stdio',
            originPath: filePath,
            foundIn: target.agentId,
            config: spec,
            fingerprint: hashObject(spec),
          });
        }
      }
    }
    return Array.from(rowsById.values()).sort(sortByName);
  }

  function scanSkillCapabilities(warnings = []) {
    return scanSkillRoots(skillRoots({ includeManaged: true, includeNative: true }), warnings);
  }

  function scanManagedSkillCapabilities(warnings = []) {
    return scanSkillRoots(skillRoots({ includeManaged: true, includeNative: false }), warnings);
  }

  function scanUnmanagedSkillCapabilities(warnings = []) {
    return scanSkillRoots(skillRoots({ includeManaged: false, includeNative: true }), warnings)
      .filter((item) => item.managed !== true);
  }

  function scanSkillRoots(targets, warnings = []) {
    const rowsById = new Map();
    for (const target of targets) {
      const skillDirs = listSkillDirs(target, warnings);
      for (const skillDir of skillDirs) {
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        try {
          const content = fs.readFileSync(skillMdPath, 'utf8');
          const { meta } = parseFrontmatter(content);
          if (meta.hidden === true || meta.hidden === 'true') continue;
          const id = normalizeCapabilityId(path.basename(skillDir));
          if (!id) continue;
          const classification = classifyNativeSkill({ id, meta, content, target });
          mergeDiscoveredSkill(rowsById, {
            id,
            name: String(meta.name || path.basename(skillDir)),
            description: String(meta.description || ''),
            category: String(meta.category || 'other'),
            tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
            source: classification.source,
            sourcePackage: classification.sourcePackage,
            bundledCompanion: classification.bundledCompanion,
            originPath: skillDir,
            sourceDir: skillDir,
            foundIn: target.agentId,
            managedByOneShell: target.managedByOneShell === true,
            system: target.system === true,
          });
        } catch (err) {
          addWarning(warnings, `Skill 解析失败: ${displayPath(skillMdPath)} (${err.message})`);
        }
      }
    }
    return Array.from(rowsById.values()).sort(sortByName);
  }

  function importMcpToRegistry(item, mcpRegistry) {
    if (!item || !item.config) throw new Error('未找到可导入的 MCP');
    if (item.source === 'oneshell') throw new Error('1Shell MCP Bridge 是内置能力，不需要导入');
    if (!mcpRegistry?.createServer) throw new Error('MCP Registry 未初始化');
    if (mcpRegistry.getServer?.(item.id)) throw new Error(`MCP 已存在: ${item.id}`);

    const tags = Array.from(new Set([...(item.tags || []), 'imported'].filter(Boolean)));
    const input = {
      id: item.id,
      name: item.name || item.id,
      description: item.description || `从 ${displayPath(item.originPaths?.[0] || '')} 导入`,
      tags,
      enabled: true,
      autoStart: false,
      exposeToIde: false,
    };

    if (item.config.url) {
      input.url = item.config.url;
      const token = extractAuthToken(item.config);
      if (token) input.authToken = token;
    } else {
      input.command = mcpSpecToCommand(item.config);
      if (item.config.cwd) input.installDir = item.config.cwd;
    }

    return mcpRegistry.createServer(input);
  }

  function importSkillToDirectory(item, targetRoot) {
    if (!item?.sourceDir) throw new Error('未找到可导入的 Skill');
    const sourceDir = path.resolve(item.sourceDir);
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) throw new Error('源 Skill 缺少 SKILL.md');
    const root = path.resolve(targetRoot || path.join(rootDataDir, 'skills'));
    const targetDir = path.join(root, safePathSegment(item.id));
    if (fs.existsSync(targetDir)) throw new Error(`Skill 已存在: ${item.id}`);
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
    return { id: item.id, sourceDir, targetDir };
  }

  function mcpConfigTargets() {
    const homes = hostHomes();
    const targets = [];

    for (const home of homes) {
      const xdgConfig = firstPath(process.env.XDG_CONFIG_HOME, path.join(home, '.config'));
      const appData = firstPath(process.env.APPDATA, path.join(home, 'AppData', 'Roaming'));
      const localAppData = firstPath(process.env.LOCALAPPDATA, path.join(home, 'AppData', 'Local'));
      const codexHome = firstPath(process.env.CODEX_HOME, path.join(home, '.codex'));
      const claudeHome = firstPath(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
      const opencodeHome = firstPath(process.env.OPENCODE_CONFIG_HOME, path.join(xdgConfig, 'opencode'));

      targets.push(
        {
          agentId: 'claude-code',
          paths: [
            path.join(home, '.claude.json'),
            path.join(claudeHome, 'mcp-config.json'),
            path.join(claudeHome, 'settings.json'),
            path.join(claudeHome, 'config.json'),
          ],
        },
        {
          agentId: 'codex',
          paths: [
            path.join(codexHome, 'mcp.json'),
            path.join(codexHome, 'config.toml'),
          ],
        },
        {
          agentId: 'opencode',
          paths: [
            path.join(opencodeHome, 'opencode.json'),
            path.join(opencodeHome, 'mcp.json'),
            path.join(home, '.opencode', 'opencode.json'),
            path.join(home, '.opencode', 'mcp.json'),
            path.join(appData, 'opencode', 'opencode.json'),
            path.join(appData, 'opencode', 'mcp.json'),
            path.join(localAppData, 'opencode', 'opencode.json'),
            path.join(localAppData, 'opencode', 'mcp.json'),
          ],
        },
        {
          agentId: 'host',
          paths: [
            path.join(home, '.mcp.json'),
            path.join(home, '.cursor', 'mcp.json'),
            path.join(home, '.continue', 'config.json'),
            path.join(xdgConfig, 'Claude', 'claude_desktop_config.json'),
            path.join(xdgConfig, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
            path.join(xdgConfig, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
            path.join(xdgConfig, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
            path.join(xdgConfig, 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
            path.join(xdgConfig, 'Windsurf', 'mcp_config.json'),
            path.join(xdgConfig, 'zed', 'settings.json'),
            path.join(appData, 'Claude', 'claude_desktop_config.json'),
            path.join(appData, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
            path.join(appData, 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
            path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
            path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
            path.join(appData, 'Windsurf', 'mcp_config.json'),
            path.join(localAppData, 'Claude', 'claude_desktop_config.json'),
          ],
        },
      );
    }

    targets.push(...profileMcpTargets());
    return mergeTargets(targets);
  }

  function skillRoots({ includeManaged = true, includeNative = true } = {}) {
    const roots = [];
    if (includeManaged) {
      roots.push({ agentId: 'oneshell-ai', dir: path.join(rootDataDir, 'skills'), managedByOneShell: true });
    }

    if (includeNative) {
      for (const home of hostHomes()) {
        const xdgConfig = firstPath(process.env.XDG_CONFIG_HOME, path.join(home, '.config'));
        const codexHome = firstPath(process.env.CODEX_HOME, path.join(home, '.codex'));
        const claudeHome = firstPath(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
        const opencodeHome = firstPath(process.env.OPENCODE_CONFIG_HOME, path.join(xdgConfig, 'opencode'));

        roots.push(
          { agentId: 'claude-code', dir: path.join(claudeHome, 'skills') },
          { agentId: 'claude-code', dir: path.join(claudeHome, 'plugins'), pluginRoot: true },
          { agentId: 'codex', dir: path.join(codexHome, 'skills') },
          { agentId: 'codex', dir: path.join(codexHome, 'plugins'), pluginRoot: true },
          { agentId: 'opencode', dir: path.join(opencodeHome, 'skills') },
          { agentId: 'opencode', dir: path.join(home, '.opencode', 'skills') },
          { agentId: 'host', dir: path.join(home, '.agents', 'skills') },
          { agentId: 'host', dir: path.join(home, '.agents', 'plugins'), pluginRoot: true },
        );
      }
    }

    return uniqueTargets(roots);
  }

  function readConfigFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (/\.toml$/i.test(filePath)) return toml.parse(raw);
    return JSON.parse(raw);
  }

  function collectMcpEntries(parsed, filePath = '') {
    if (!parsed || typeof parsed !== 'object') return [];
    const entries = [];
    const seen = new Set();
    const add = (map) => addMcpMap(entries, map, seen);

    add(parsed.mcpServers);
    add(parsed.mcp_servers);
    add(parsed.mcp?.servers);
    add(parsed.mcp?.mcpServers);
    add(parsed.context_servers);
    if (looksLikeMcpMap(parsed.mcp)) add(parsed.mcp);
    if (isLikelyMcpConfigFile(filePath) && looksLikeMcpMap(parsed)) add(parsed);

    visitMcpContainers(parsed, add);
    return entries;
  }

  function addMcpMap(entries, map, seen = new Set()) {
    if (!looksLikeMcpMap(map)) return;
    for (const [id, spec] of Object.entries(map)) {
      if (!id || !looksLikeMcpSpec(spec)) continue;
      const key = `${id}:${hashObject(spec)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ id, spec });
    }
  }

  function visitMcpContainers(root, add, depth = 0, trail = []) {
    if (!root || typeof root !== 'object' || Array.isArray(root) || depth > 7) return;
    if (looksLikeMcpSpec(root)) return;

    for (const [key, value] of Object.entries(root)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (isMcpMapKey(key)) {
        add(value);
        continue;
      }
      if (key === 'mcp') {
        add(value.servers);
        add(value.mcpServers);
        if (looksLikeMcpMap(value)) add(value);
      }
      visitMcpContainers(value, add, depth + 1, [...trail, key]);
    }
  }

  function isMcpMapKey(key) {
    return ['mcpServers', 'mcp_servers', 'context_servers'].includes(String(key));
  }

  function isLikelyMcpConfigFile(filePath) {
    const base = path.basename(String(filePath || '')).toLowerCase();
    return base === 'mcp.json'
      || base === 'mcp-config.json'
      || base === 'mcp_config.json'
      || base === 'cline_mcp_settings.json'
      || base === 'mcp_settings.json'
      || base === 'claude_desktop_config.json';
  }

  function looksLikeMcpMap(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.values(value).some(looksLikeMcpSpec);
  }

  function looksLikeMcpSpec(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Boolean(value.command || value.url || value.serverUrl || value.endpoint || value.type || value.args || value.env || value.headers || value.cwd);
  }

  function normalizeMcpSpec(raw) {
    if (typeof raw === 'string') {
      const command = raw.trim();
      return command ? { type: 'stdio', command, args: [], env: {}, headers: {} } : null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const url = firstString(raw.url, raw.serverUrl, raw.endpoint);
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const env = normalizeStringMap(raw.env);
    const headers = normalizeStringMap(raw.headers);
    const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
    if (url) return { type: raw.type || 'remote', url, headers, env, cwd };
    if (command) return { type: raw.type || 'stdio', command, args, env, cwd };
    return null;
  }

  function normalizeStringMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [String(key), String(val)]));
  }

  function mergeDiscoveredMcp(rowsById, item) {
    const existing = rowsById.get(item.id);
    if (!existing) {
      rowsById.set(item.id, {
        id: item.id,
        nativeId: item.nativeId,
        kind: 'mcp',
        name: item.name,
        description: item.description,
        tags: item.tags,
        source: item.source || 'external',
        transport: item.transport,
        originPaths: [item.originPath],
        foundIn: [item.foundIn],
        managed: item.source === 'oneshell',
        external: item.source !== 'oneshell',
        readonly: true,
        config: item.config,
        fingerprints: [item.fingerprint],
      });
      return;
    }
    pushUnique(existing.originPaths, item.originPath);
    pushUnique(existing.foundIn, item.foundIn);
    for (const tag of item.tags || []) pushUnique(existing.tags, tag);
    if (!existing.fingerprints.includes(item.fingerprint)) {
      existing.fingerprints.push(item.fingerprint);
      pushUnique(existing.tags, 'variant');
    }
  }

  function mergeDiscoveredSkill(rowsById, item) {
    const source = item.managedByOneShell ? 'managed' : (item.source || 'installed');
    const existing = rowsById.get(item.id);
    if (!existing) {
      rowsById.set(item.id, {
        id: item.id,
        kind: 'skill',
        name: item.name,
        description: item.description,
        category: item.category,
        tags: Array.from(new Set([...(item.tags || []), 'host'].filter(Boolean))),
        source,
        sourcePackage: item.sourcePackage || '',
        originPaths: [item.originPath],
        sourceDir: item.sourceDir,
        foundIn: [item.foundIn],
        managed: item.managedByOneShell,
        external: !item.managedByOneShell,
        readonly: !item.managedByOneShell,
        bundledCompanion: item.bundledCompanion === true,
        system: item.system === true,
      });
      return;
    }
    pushUnique(existing.originPaths, item.originPath);
    pushUnique(existing.foundIn, item.foundIn);
    for (const tag of item.tags || []) pushUnique(existing.tags, tag);
    if (item.managedByOneShell) {
      existing.source = 'managed';
      existing.managed = true;
      existing.external = false;
      existing.readonly = false;
    } else if (existing.source !== 'installed' && source === 'installed') {
      existing.source = 'installed';
    }
    if (item.sourcePackage && !existing.sourcePackage) existing.sourcePackage = item.sourcePackage;
    if (item.bundledCompanion !== true) existing.bundledCompanion = false;
  }

  function classifyNativeSkill({ id, meta, content, target }) {
    if (target.managedByOneShell === true) return { source: 'managed' };
    const bundled = matchBundledSkill(id, content, meta);
    if (bundled) {
      return {
        source: 'bundled',
        sourcePackage: bundled.packageName,
        bundledCompanion: true,
      };
    }
    return { source: 'installed' };
  }

  function matchBundledSkill(id, content, meta = {}) {
    const catalog = getBundledSkillCatalog();
    const exact = catalog.byId.get(id);
    if (!exact) return null;
    const contentHash = hashString(content);
    if (exact.hashes.has(contentHash)) return { packageName: exact.packageName };
    const author = String(meta.metadata?.author || meta.author || '').trim().toLowerCase();
    if (author === 'claudekit') return { packageName: exact.packageName };
    return null;
  }

  function getBundledSkillCatalog() {
    if (bundledSkillCatalogCache) return bundledSkillCatalogCache;
    const byId = new Map();
    for (const skillsRoot of bundledSkillRoots()) {
      let entries = [];
      try {
        entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const id = normalizeCapabilityId(entry.name);
        const skillMd = path.join(skillsRoot, entry.name, 'SKILL.md');
        if (!id || !fs.existsSync(skillMd)) continue;
        let content = '';
        try {
          content = fs.readFileSync(skillMd, 'utf8');
        } catch {
          continue;
        }
        if (!byId.has(id)) byId.set(id, { packageName: 'ui-ux-pro-max-cli', hashes: new Set() });
        byId.get(id).hashes.add(hashString(content));
      }
    }
    bundledSkillCatalogCache = { byId };
    return bundledSkillCatalogCache;
  }

  function bundledSkillRoots() {
    const roots = [];
    for (const home of hostHomes()) {
      const npxRoot = path.join(home, '.npm', '_npx');
      let entries = [];
      try {
        entries = fs.readdirSync(npxRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        roots.push(path.join(npxRoot, entry.name, 'node_modules', 'ui-ux-pro-max-cli', 'assets', 'skills'));
      }
    }
    return uniquePaths(roots);
  }

  function listSkillDirs(target, warnings = []) {
    if (!target?.dir || !fs.existsSync(target.dir)) return [];
    if (target.pluginRoot) return listPluginSkillDirs(target, warnings);
    let entries;
    try {
      entries = fs.readdirSync(target.dir, { withFileTypes: true });
    } catch (err) {
      addWarning(warnings, `Skill 目录读取失败: ${displayPath(target.dir)} (${err.message})`);
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && shouldScanSkillDirectoryName(entry.name, target))
      .map((entry) => path.join(target.dir, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')));
  }

  function listPluginSkillDirs(target, warnings = []) {
    let pluginDirs;
    try {
      pluginDirs = fs.readdirSync(target.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && shouldScanSkillDirectoryName(entry.name, target))
        .map((entry) => path.join(target.dir, entry.name));
    } catch (err) {
      addWarning(warnings, `Plugin Skill 目录读取失败: ${displayPath(target.dir)} (${err.message})`);
      return [];
    }

    const dirs = [];
    for (const pluginDir of pluginDirs) {
      const skillsDir = path.join(pluginDir, 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      dirs.push(...listSkillDirs({ ...target, dir: skillsDir, pluginRoot: false }, warnings));
    }
    return dirs;
  }

  function shouldScanSkillDirectoryName(name, target = {}) {
    const text = String(name || '');
    if (!text || text === '.' || text === '..') return false;
    if (text.startsWith('.') && target.includeHidden !== true) return false;
    if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(text)) return false;
    return true;
  }

  function hostHomes() {
    const homes = [rootHomeDir];
    if (!explicitHomeDir) {
      homes.push(os.homedir(), process.env.HOME, process.env.USERPROFILE);
    }
    return uniquePaths(homes);
  }

  function profileMcpTargets() {
    const roots = [];
    for (const home of hostHomes()) {
      roots.push(path.join(home, '.ai-profiles', 'claude'), path.join(home, '.ai-profiles', 'codex'), path.join(home, '.ai-profiles', 'opencode'));
    }

    const targets = [];
    for (const root of uniquePaths(roots)) {
      if (!fs.existsSync(root)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      const agentId = root.includes(`${path.sep}claude`) ? 'claude-code'
        : root.includes(`${path.sep}codex`) ? 'codex'
          : root.includes(`${path.sep}opencode`) ? 'opencode'
            : 'host';
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        targets.push({
          agentId,
          paths: [
            path.join(root, entry.name, 'mcp.json'),
            path.join(root, entry.name, 'mcp-config.json'),
            path.join(root, entry.name, 'settings.json'),
            path.join(root, entry.name, 'config.toml'),
            path.join(root, entry.name, 'opencode.json'),
          ],
        });
      }
    }
    return targets;
  }

  function mergeTargets(targets) {
    const byAgent = new Map();
    for (const target of targets) {
      const agentId = target.agentId || 'host';
      if (!byAgent.has(agentId)) byAgent.set(agentId, { agentId, paths: [] });
      for (const filePath of target.paths || []) pushUnique(byAgent.get(agentId).paths, filePath);
    }
    return Array.from(byAgent.values());
  }

  function uniqueTargets(targets) {
    const seen = new Set();
    const out = [];
    for (const target of targets) {
      const key = `${target.agentId}:${target.dir}:${target.pluginRoot ? 'plugin' : 'root'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
    return out;
  }

  function uniquePaths(values) {
    const out = [];
    for (const value of values || []) {
      if (!value) continue;
      const text = path.normalize(String(value));
      if (!text || out.includes(text)) continue;
      out.push(text);
    }
    return out;
  }

  function firstPath(...values) {
    return values.find((value) => typeof value === 'string' && value.trim()) || '';
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function extractAuthToken(config) {
    const auth = config.headers?.Authorization || config.headers?.authorization || '';
    return auth.replace(/^Bearer\s+/i, '').trim();
  }

  function mcpSpecToCommand(config) {
    const command = String(config.command || '').trim();
    if (!command) throw new Error('MCP 缺少 command');
    const envPrefix = Object.entries(config.env || {})
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([key, value]) => `${key}=${shellQuote(value)}`);
    const args = Array.isArray(config.args) ? config.args.map(shellQuote) : [];
    return [...envPrefix, shellQuote(command), ...args].join(' ');
  }

  function shellQuote(value) {
    const text = String(value ?? '');
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
  }

  function addWarning(warnings, message) {
    warnings.push(message);
    logger?.warn?.(`[host-capability-scan] ${message}`);
  }

  function displayPath(filePath) {
    const text = String(filePath || '');
    if (!text) return '';
    return text.startsWith(rootHomeDir) ? `~${text.slice(rootHomeDir.length)}` : text;
  }

  return {
    scanAll,
    scanMcpCapabilities,
    scanSkillCapabilities,
    scanManagedSkillCapabilities,
    scanUnmanagedSkillCapabilities,
    importMcpToRegistry,
    importSkillToDirectory,
  };
}

function normalizeCapabilityId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function safePathSegment(value) {
  return normalizeCapabilityId(value) || 'skill';
}

function hashObject(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 12);
}

function hashString(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function pushUnique(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function sortByName(a, b) {
  return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN');
}

module.exports = { createHostCapabilityScanner };
