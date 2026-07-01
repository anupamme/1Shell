'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const toml = require('toml');
const { getManifest, getAllManifests, UPSTREAM_LABELS } = require('./cli-manifest');
const { codexConfigTomlReasoningLine } = require('./reasoning');
const { getMcpPreset } = require('./mcp-presets');

function createNativeCliConfig({
  dataDir,
  bridgeToken,
  port,
  proxyConfigStore,
  claudeCodeSkillRegistry,
  mcpPresetStore,
  logger,
  homeDir = os.homedir(),
} = {}) {
  const stateRoot = path.join(dataDir, 'native-cli-config');
  const configBackupRoot = path.join(dataDir, 'cli-config-backups');
  const binaryOverridesPath = path.join(stateRoot, 'binary-overrides.json');
  const configOverridesPath = path.join(stateRoot, 'config-overrides.json');
  const enabledMetaPath = path.join(stateRoot, 'enabled-meta.json');
  const serverOrigin = `http://127.0.0.1:${port}`;
  const home = homeDir || os.homedir();

  function getActiveProviderConfig(cliId) {
    try {
      return proxyConfigStore?.getActiveProvider?.(cliId) || null;
    } catch {
      return null;
    }
  }

  function readBinaryOverrides() {
    return safeReadJSON(binaryOverridesPath) || {};
  }

  function writeBinaryOverrides(overrides) {
    safeWriteJSON(binaryOverridesPath, overrides || {});
  }

  function getBinaryOverride(cliId) {
    const value = readBinaryOverrides()[cliId];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function setBinaryOverride(cliId, binaryPath) {
    if (!getManifest(cliId)) throw new Error(`未知 CLI: ${cliId}`);
    const cleanPath = normalizeManualBinaryPath(binaryPath);
    if (!cleanPath) throw new Error('可执行文件路径不能为空');
    const overrides = readBinaryOverrides();
    overrides[cliId] = cleanPath;
    writeBinaryOverrides(overrides);
    return getScanInfo().find((tool) => tool.id === cliId) || null;
  }

  function clearBinaryOverride(cliId) {
    const overrides = readBinaryOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, cliId)) {
      delete overrides[cliId];
      writeBinaryOverrides(overrides);
    }
    return getScanInfo().find((tool) => tool.id === cliId) || null;
  }

  function readConfigOverrides() {
    return safeReadJSON(configOverridesPath) || {};
  }

  function writeConfigOverrides(overrides) {
    safeWriteJSON(configOverridesPath, overrides || {});
  }

  function getConfigOverrideKey(cliId, fileName) {
    return `${cliId}:${fileName}`;
  }

  function getConfigFileOverride(cliId, fileName) {
    const overrides = readConfigOverrides();
    const value = overrides[getConfigOverrideKey(cliId, fileName)];
    return typeof value === 'string' ? value : null;
  }

  function setConfigFileOverride(cliId, fileName, content) {
    const overrides = readConfigOverrides();
    overrides[getConfigOverrideKey(cliId, fileName)] = String(content ?? '');
    writeConfigOverrides(overrides);
  }

  function removeConfigFileOverride(cliId, fileName) {
    const overrides = readConfigOverrides();
    const key = getConfigOverrideKey(cliId, fileName);
    const existed = Object.prototype.hasOwnProperty.call(overrides, key);
    if (existed) {
      delete overrides[key];
      writeConfigOverrides(overrides);
    }
    return existed;
  }

  function removeConfigFileOverridesForCli(cliId) {
    const overrides = readConfigOverrides();
    const prefix = `${cliId}:`;
    let changed = false;
    for (const key of Object.keys(overrides)) {
      if (key.startsWith(prefix)) {
        delete overrides[key];
        changed = true;
      }
    }
    if (changed) writeConfigOverrides(overrides);
    return changed;
  }

  function installCli(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);
    const installInfo = getInstallInfo(manifest);
    const command = installInfo.command;
    if (!command) throw new Error(`${manifest.name} 暂未配置自动安装命令`);

    return new Promise((resolve, reject) => {
      execFile(installInfo.executable || command, installInfo.args || [], {
        cwd: process.cwd(),
        timeout: manifest.install?.timeoutMs || 10 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          npm_config_audit: process.env.npm_config_audit || 'false',
          npm_config_fund: process.env.npm_config_fund || 'false',
        },
      }, (err, stdout = '', stderr = '') => {
        const isWindows = os.platform() === 'win32';
        const binary = detectBinary(manifest, isWindows, getBinaryOverride(manifest.id));
        const result = {
          command,
          stdout: tailInstallOutput(stdout),
          stderr: tailInstallOutput(stderr),
          installed: Boolean(binary.installed),
          binary,
          tool: getScanInfo().find((tool) => tool.id === cliId) || null,
        };
        if (err) {
          err.message = buildInstallErrorMessage(err, stdout, stderr);
          err.result = result;
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  function getInstallInfo(manifest) {
    const pkg = manifest.install?.npmPackage;
    if (!pkg) return manifest.install || {};
    return {
      ...manifest.install,
      executable: getNpmExecutable(),
      args: ['install', '-g', pkg, '--no-audit', '--no-fund'],
      command: manifest.install.command || buildGlobalNpmInstallCommand(pkg),
    };
  }

  function getNpmExecutable() {
    return os.platform() === 'win32' ? 'npm.cmd' : 'npm';
  }

  function buildGlobalNpmInstallCommand(pkg) {
    return ['npm', 'install', '-g', quoteInstallArg(pkg), '--no-audit', '--no-fund'].join(' ');
  }

  function quoteInstallArg(value) {
    return quoteShellArg(value);
  }

  function buildMcpEntry(cliId = null) {
    // 默认走 SSE(claude-code 形态);cliId=null 调用来自 buildClaudeMcpConfig
    const mcp = cliId ? (getManifest(cliId)?.nativeConfig?.mcp) : { transport: 'sse' };
    const transport = mcp?.transport || 'sse';

    if (transport === 'stdio-bridge') {
      return {
        command: mcp.stdioCommand || 'node',
        args: [path.join(dataDir, mcp.stdioBridgeScript)],
        env: {
          ONESHELL_URL: serverOrigin,
          ONESHELL_TOKEN: bridgeToken,
        },
      };
    }

    return {
      type: 'sse',
      url: `${serverOrigin}/mcp/sse`,
      headers: { 'X-Bridge-Token': bridgeToken },
    };
  }

  // 把 preset.server 的模板变量({rootDir}/{githubToken}/...)用 applied.config 替换
  function renderPresetServer(presetServer, appliedConfig) {
    const replacePlaceholders = (val) => {
      if (typeof val !== 'string') return val;
      return val.replace(/\{(\w+)\}/g, (_m, key) => {
        const v = appliedConfig && appliedConfig[key];
        return v != null ? String(v) : `{${key}}`;
      });
    };
    const rendered = { command: presetServer.command };
    if (Array.isArray(presetServer.args)) {
      rendered.args = presetServer.args.map(replacePlaceholders);
    }
    if (presetServer.env && typeof presetServer.env === 'object') {
      rendered.env = {};
      for (const [k, v] of Object.entries(presetServer.env)) {
        rendered.env[k] = replacePlaceholders(v);
      }
    }
    return rendered;
  }

  /**
   * 返回 cliId 原生配置应写入的所有 MCP entries:
   *   '1shell' 基础 entry + 用户 apply 过的所有 preset(用 mcpPresetStore.getAppliedRaw)
   * 用户没 apply 任何 preset 时返回 `{ '1shell': base }` ── 与 Sprint B baseline 字节级一致。
   */
  function buildAllMcpEntries(cliId) {
    const entries = { '1shell': buildMcpEntry(cliId) };
    const applied = mcpPresetStore?.getAppliedRaw?.(cliId) || [];
    for (const item of applied) {
      const preset = getMcpPreset(item.presetId);
      if (!preset) {
        logger?.warn?.(`[native-cli-config] applied 列表里有未知 preset: ${item.presetId} (cliId=${cliId}),跳过`);
        continue;
      }
      entries[preset.id] = renderPresetServer(preset.server, item.config);
    }
    return entries;
  }

  function safeReadJSON(filePath) {
    if (!filePath) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  }

  function safeWriteJSON(filePath, data) {
    atomicWriteText(filePath, JSON.stringify(data, null, 2));
  }

  function atomicWriteText(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.1shell-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, String(text ?? ''), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  }

  function writeConfigTargetText(cliId, fileName, targetPath, content) {
    const text = validateConfigFileContent(fileName, content);
    if (fs.existsSync(targetPath)) {
      const current = fs.readFileSync(targetPath, 'utf8');
      if (current === text) return false;
      backupHostConfigFile(cliId, targetPath);
    }
    atomicWriteText(targetPath, text);
    return true;
  }

  function writeConfigTargetJSON(cliId, fileName, targetPath, data) {
    return writeConfigTargetText(cliId, fileName, targetPath, JSON.stringify(data, null, 2));
  }

  function backupHostConfigFile(cliId, targetPath) {
    try {
      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(configBackupRoot, cliId, stamp);
      const backupPath = path.join(backupDir, path.basename(targetPath));
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(targetPath, backupPath);
      safeWriteJSON(path.join(backupDir, 'manifest.json'), {
        cliId,
        mode: 'host',
        sourcePath: targetPath,
        backupPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        createdAt: new Date().toISOString(),
      });
      return backupPath;
    } catch (err) {
      logger?.warn?.(`[native-cli-config] 备份配置文件失败: ${targetPath} ${err.message}`);
      return null;
    }
  }

  function deepSet(obj, pointer, value) {
    const keys = pointer.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }

  function getHostConfigDir(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return null;

    if (manifest.nativeConfig.configHome === 'xdg') {
      const xdgConfigHome = path.join(home, '.config');
      return manifest.nativeConfig.configSubDir
        ? path.join(xdgConfigHome, manifest.nativeConfig.configSubDir)
        : xdgConfigHome;
    }

    return path.join(home, manifest.nativeConfig.defaultConfigDir || manifest.nativeConfig.dirName);
  }

  function getConfigDir(cliId) {
    return getHostConfigDir(cliId);
  }

  function getNativeConfigDir(cliId) {
    return getConfigDir(cliId);
  }

  function getWorkspaceConfigPath(manifest, configFile, cwd) {
    if (!configFile?.scope || configFile.scope !== 'workspace' || !cwd) return null;
    return path.join(cwd, manifest.nativeConfig.workspaceConfigDir || manifest.nativeConfig.defaultConfigDir, configFile.name);
  }

  function hasWorkspaceConfig(cliId, { cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;
    const workspaceFiles = (manifest.nativeConfig.configFiles || []).filter(file => file.scope === 'workspace');
    if (workspaceFiles.length === 0) return true;
    if (!cwd) return false;

    return workspaceFiles.every((configFile) => {
      const targetPath = getWorkspaceConfigPath(manifest, configFile, cwd);
      if (!targetPath || !fs.existsSync(targetPath)) return false;
      if (configFile.mergeStrategy !== 'deep-merge') return true;
      const data = safeReadJSON(targetPath);
      if (!data) return false;
      const keys = String(configFile.mergePointer || '').split('.').filter(Boolean);
      let cur = data;
      for (const key of keys) {
        if (cur == null || typeof cur !== 'object' || !(key in cur)) return false;
        cur = cur[key];
      }
      return cur != null;
    });
  }

  // 把 buildAllMcpEntries(cliId) 写入 userConfig 的 mcpServers 父节点。
  // mergePointer = 'mcpServers.1shell' 形式:取 'mcpServers' 为父路径,
  // 把 entries map 里每个 entry deep-set 到 `parent.<entryKey>`,从而:
  //   - 覆盖 1Shell 的 entry(老的 1shell key 被新的覆盖)
  //   - 同时写入所有 applied preset 的 entry
  //   - 不动 user 已有的其它 entry(如 user 自己加的别的 MCP server)
  // 用户没 apply 任何 preset 时:只写一个 1shell entry,等价于原 deepSet 行为,字节级一致。
  function writeMcpEntries(userConfig, configFile, cliId) {
    const pointer = String(configFile.mergePointer || '');
    const dotIdx = pointer.lastIndexOf('.');
    const parentPath = dotIdx > 0 ? pointer.slice(0, dotIdx) : pointer;
    const entries = buildAllMcpEntries(cliId);
    for (const [entryKey, entryValue] of Object.entries(entries)) {
      deepSet(userConfig, `${parentPath}.${entryKey}`, entryValue);
    }
  }

  function enableNativeConfig(cliId, { cwd, files = null, activeProvider = undefined } = {}) {
    if (Array.isArray(files)) {
      return enableNativeConfigFromFiles(cliId, files);
    }

    return enableGeneratedNativeConfig(cliId, { cwd, activeProvider });
  }

  function ensureNativeConfig(cliId, options = {}) {
    return enableNativeConfig(cliId, options);
  }

  function enableNativeConfigFromFiles(cliId, files) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);

    const dir = getNativeConfigDir(cliId);
    fs.mkdirSync(dir, { recursive: true });

    const editableFiles = (manifest.nativeConfig.configFiles || [])
      .filter(file => file.scope !== 'workspace');
    const allowedNames = new Set(editableFiles.map(file => file.name));
    const incoming = new Map();
    for (const file of files || []) {
      const name = String(file?.name || '').trim();
      if (!allowedNames.has(name)) throw new Error(`未知或不可编辑配置文件: ${name}`);
      incoming.set(name, String(file?.content ?? ''));
    }

    for (const configFile of editableFiles) {
      if (!incoming.has(configFile.name)) continue;
      const targetPath = getConfigFileTargetPath(cliId, configFile);
      writeConfigTargetText(cliId, configFile.name, targetPath, incoming.get(configFile.name));
    }

    runPostEnableHooks(manifest, cliId);
    writeManifestMeta(cliId, { updatedAt: new Date().toISOString(), enabledBy: 'files' });
    return dir;
  }

  function enableGeneratedNativeConfig(cliId, { cwd, activeProvider = undefined } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);

    const resolvedProvider = activeProvider ?? getActiveProviderConfig(cliId);
    const dir = getNativeConfigDir(cliId);
    fs.mkdirSync(dir, { recursive: true });

    for (const configFile of manifest.nativeConfig.configFiles) {
      if (configFile.scope === 'workspace') {
        if (!cwd) continue;
        const workspaceDir = path.join(cwd, manifest.nativeConfig.workspaceConfigDir || manifest.nativeConfig.defaultConfigDir);
        const targetPath = path.join(workspaceDir, configFile.name);
        if (configFile.mergeStrategy === 'deep-merge') {
          let userConfig = safeReadJSON(targetPath) || {};
          userConfig = cleanNativeConfigEnv(userConfig, configFile);
          writeMcpEntries(userConfig, configFile, cliId);
          writeConfigTargetJSON(cliId, configFile.name, targetPath, userConfig);
        }
        continue;
      }

      const targetPath = path.join(dir, configFile.name);
      const overrideContent = getConfigFileOverride(cliId, configFile.name);
      if (overrideContent != null) {
        writeConfigTargetText(cliId, configFile.name, targetPath, overrideContent);
        continue;
      }
      if (shouldSkipProviderConfigWrite(configFile, resolvedProvider)) {
        continue;
      }

      if (configFile.mergeStrategy === 'deep-merge') {
        let userConfig = safeReadJSON(targetPath) || {};
        userConfig = cleanNativeConfigEnv(userConfig, configFile);
        writeMcpEntries(userConfig, configFile, cliId);
        writeConfigTargetJSON(cliId, configFile.name, targetPath, userConfig);

      } else if (configFile.mergeStrategy === 'template') {
        const content = renderTemplate(cliId, configFile.name, { cwd, activeProvider: resolvedProvider });
        if (content) {
          writeConfigTargetText(cliId, configFile.name, targetPath, content);
        }

      } else if (configFile.mergeStrategy === 'overwrite') {
        const content = generateOverwriteContent(cliId, configFile.name, configFile, { activeProvider: resolvedProvider });
        writeConfigTargetJSON(cliId, configFile.name, targetPath, content);
      }
    }

    runPostEnableHooks(manifest, cliId);
    writeManifestMeta(cliId, {
      updatedAt: new Date().toISOString(),
      enabledBy: 'generated',
      providerId: resolvedProvider?.id || '',
      activeModelId: resolvedProvider?.activeModelId || resolvedProvider?.routeModelId || '',
    });
    return dir;
  }

  function runPostEnableHooks(manifest, cliId) {
    for (const hookId of (manifest.postEnsureHooks || [])) {
      const hook = POST_ENSURE_HOOKS[hookId];
      if (!hook) {
        logger?.warn?.(`[native-cli-config] 未知 postEnsureHook: ${hookId} (cliId=${cliId})`);
        continue;
      }
      try {
        hook(cliId);
      } catch (err) {
        logger?.warn?.(`[native-cli-config] postEnsureHook '${hookId}' 失败: ${err.message}`);
      }
    }
  }

  function syncClaudeCodeSkills() {
    if (!claudeCodeSkillRegistry?.listSkills) return;

      const dir = getConfigDir('claude-code');
    const skillsDir = path.join(dir, 'skills');
    const metaPath = path.join(skillsDir, '.1shell-managed.json');
    const previous = safeReadJSON(metaPath);
    const previousDirs = Array.isArray(previous?.dirs) ? previous.dirs : [];

    for (const name of previousDirs) {
      const target = path.join(skillsDir, safeSkillSegment(name));
      if (isInside(skillsDir, target) && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    }

    const synced = [];
    for (const pkg of claudeCodeSkillRegistry.listSkills()) {
      if (pkg.enabled === false || !pkg.sourceDir || !Array.isArray(pkg.skills)) continue;
      for (const skill of pkg.skills) {
        const sourcePath = path.resolve(pkg.sourceDir, skill.path || 'SKILL.md');
        const sourceDir = path.dirname(sourcePath);
        const sourceRoot = path.resolve(pkg.sourceDir);
        if (!isInside(sourceRoot, sourcePath) || !fs.existsSync(sourcePath)) continue;

        const dirName = uniqueSkillDirName(pkg, skill, synced);
        const targetDir = path.join(skillsDir, dirName);
        fs.rmSync(targetDir, { recursive: true, force: true });
        copySkillDir(sourceDir, targetDir);
        synced.push(dirName);
      }
    }

    fs.mkdirSync(skillsDir, { recursive: true });
    safeWriteJSON(metaPath, { updatedAt: new Date().toISOString(), dirs: synced });
  }

  function uniqueSkillDirName(pkg, skill, synced) {
    const base = safeSkillSegment(pkg.skills.length === 1 ? (skill.id || pkg.id) : `${pkg.id}-${skill.id}`);
    let name = base;
    let counter = 2;
    while (synced.includes(name)) {
      name = `${base}-${counter}`;
      counter += 1;
    }
    return name;
  }

  function copySkillDir(sourceDir, targetDir) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      force: true,
      filter: shouldCopySkillPath,
    });
  }

  function shouldCopySkillPath(src) {
    const parts = path.resolve(src).split(path.sep);
    return !parts.some((part) => part === '.git' || part === 'node_modules');
  }

  function safeSkillSegment(value) {
    return String(value || 'skill').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  }

  function isInside(root, target) {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function getClaudeCodeActivationPrompt() {
    if (!hasEnabledClaudeCodeSkill('using-superpowers')) return '';
    return [
      'This 1Shell internal Claude Code session has the Superpowers skills installed.',
      'Before starting any non-trivial goal, use the using-superpowers skill and follow its guidance for choosing relevant skills.',
      'Do not execute repository hook scripts unless the user explicitly asks for that specific action.',
    ].join('\n');
  }

  function hasEnabledClaudeCodeSkill(skillId) {
    if (!claudeCodeSkillRegistry?.listSkills) return false;
    const target = safeSkillSegment(skillId);
    return claudeCodeSkillRegistry.listSkills().some((pkg) => {
      if (pkg.enabled === false || !Array.isArray(pkg.skills)) return false;
      return pkg.skills.some((skill) => safeSkillSegment(skill.id || skill.name) === target);
    });
  }

  function resolveOverrideEnv(configFile) {
    const env = {};
    for (const [key, value] of Object.entries(configFile?.overrideEnvKeys || {})) {
      env[key] = typeof value === 'string' ? value.replace('{serverUrl}', serverOrigin) : value;
    }
    return env;
  }

  function cleanNativeConfigEnv(config, configFile) {
    if (!configFile.overrideEnvKeys) return config;
    const cleaned = { ...config };
    if (cleaned.env && typeof cleaned.env === 'object') {
      cleaned.env = {
        ...cleaned.env,
        ...resolveOverrideEnv(configFile),
      };
    }
    return cleaned;
  }

  function quoteShellArg(value) {
    const str = String(value ?? '');
    if (!str) return '""';
    return `"${str.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  function quotePowerShellArg(value) {
    const str = String(value ?? '');
    return `'${str.replace(/'/g, "''")}'`;
  }

  function appendShellArgs(command, args, shell) {
    if (!args?.length) return command;
    const quoted = args.map((arg) => shell === 'powershell' ? quotePowerShellArg(arg) : quoteShellArg(arg));
    return `${command} ${quoted.join(' ')}`;
  }

  function getClaudeMcpConfigPath() {
    return path.join(getNativeConfigDir('claude-code'), 'mcp-config.json');
  }

  // launchArgsBuilder 注册表 — 接 (cliId, manifest, ctx),返回追加的 arg 数组
  // ctx 含:cwd、nativeConfigDir、helpers(getClaudeMcpConfigPath / getClaudeCodeActivationPrompt)
  const LAUNCH_ARGS_BUILDERS = {
    'claude-mcp-args': (cliId, manifest, ctx) => {
      const extra = ['--strict-mcp-config', '--mcp-config', getClaudeMcpConfigPath()];
      const activationPrompt = getClaudeCodeActivationPrompt();
      if (activationPrompt) extra.push('--append-system-prompt', activationPrompt);
      return extra;
    },
  };

  function buildLaunchArgs(cliId, { useLocalEnv = false, cwd, prepareNative = false } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return [];

    const args = [...(manifest.launchArgs || [])];
    if (useLocalEnv) return args;

    if (prepareNative) ensureNativeConfig(cliId, { cwd });

    const builderId = manifest.launchArgsBuilder;
    if (builderId) {
      const builder = LAUNCH_ARGS_BUILDERS[builderId];
      if (builder) {
        args.push(...builder(cliId, manifest, {
          cwd,
          active: getActiveProviderConfig(cliId),
        }));
      } else {
        logger?.warn?.(`[native-cli-config] 未知 launchArgsBuilder: ${builderId} (cliId=${cliId})`);
      }
    }

    return args;
  }

  function hasRequiredConfigFiles(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;

    return (manifest.nativeConfig.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .every((configFile) => fs.existsSync(path.join(getNativeConfigDir(cliId), configFile.name)));
  }

  function getNativeConfigReady(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;
    if (!hasRequiredConfigFiles(cliId)) return false;
    if ((manifest.nativeConfig.configFiles || []).some(file => file.scope === 'workspace')) {
      return hasWorkspaceConfig(cliId, { cwd: process.cwd() });
    }
    return true;
  }

  function buildShellCommandString(binary, args, shell) {
    const base = quoteExecutable(binary, shell);
    return appendShellArgs(base, args, shell);
  }

  function quoteExecutable(binary, shell) {
    const value = String(binary || '').trim();
    if (!value) return '';
    if (!/[\s"']/.test(value)) return value;
    return shell === 'powershell' ? `& ${quotePowerShellArg(value)}` : quoteShellArg(value);
  }

  // postEnsureHooks 注册表 — 接 (cliId),在 ensureNativeConfig 写完所有 config 后跑
  const POST_ENSURE_HOOKS = {
    'sync-claude-skills': () => syncClaudeCodeSkills(),
  };

  // overwriteBuilder 注册表 — 每个 builder 接 (cliId, configFile),返回 JSON 对象
  const OVERWRITE_BUILDERS = {
    'env-overrides': (cliId, configFile) => ({
      env: resolveOverrideEnv(configFile),
    }),
    'claude-native-settings': (cliId, configFile, ctx = {}) => buildClaudeNativeSettings(ctx.active ?? getActiveProviderConfig(cliId)),
    'claude-native-config': (cliId, configFile, ctx = {}) => buildClaudeNativeConfig(ctx.active ?? getActiveProviderConfig(cliId)),
    'codex-native-auth': (cliId, configFile, ctx = {}) => buildCodexNativeAuth(ctx.active ?? getActiveProviderConfig(cliId)),
    'opencode-native-config': (cliId, configFile, ctx = {}) => buildOpenCodeNativeConfig(ctx.active ?? getActiveProviderConfig(cliId), buildAllMcpEntries(cliId)),
    'static': (cliId, configFile) => (
      configFile.content && typeof configFile.content === 'object' ? configFile.content : {}
    ),
    'mcp-config': (cliId, configFile) => {
      // 完整覆写 mcp-config.json:1shell 基础 entry + 所有 applied preset
      // 当用户没 apply 任何 preset 时,等价于 `{ [key]: { [entryName]: buildMcpEntry } }`,字节级一致
      const key = configFile.mcpServersKey || 'mcpServers';
      return { [key]: buildAllMcpEntries(cliId) };
    },
  };

  function generateOverwriteContent(cliId, fileName, configFile, { activeProvider = undefined } = {}) {
    const builderId = configFile.overwriteBuilder;
    if (!builderId) return {};
    const builder = OVERWRITE_BUILDERS[builderId];
    if (!builder) {
      logger?.warn?.(`[native-cli-config] 未知 overwriteBuilder: ${builderId} (cliId=${cliId} file=${fileName})`);
      return {};
    }
    return builder(cliId, configFile, { active: activeProvider, serverOrigin });
  }

  // template 注册表 — 每个 template 接 (cliId, configFile, ctx),返回字符串
  // ctx 含:cwd、active(active provider)、serverOrigin、helpers(escape/quote)
  const TEMPLATE_BUILDERS = {
    'codex-config-toml': (cliId, configFile, ctx) => {
      const model = String(ctx.active?.model || '').trim();
      const projectsCwd = ctx.cwd || process.cwd();
      const reasoningLine = codexConfigTomlReasoningLine(ctx.active?.reasoningEffort);
      const providerId = sanitizeCodexProviderId(ctx.active?.codexProviderId || ctx.active?.name || 'custom');
      const apiBase = normalizeOpenAIBaseUrl(ctx.active?.apiBase || 'https://api.openai.com/v1');
      const head = [
        `model_provider = "${escapeTomlBasicString(providerId)}"`,
      ];
      if (model) head.push(`model = "${escapeTomlBasicString(model)}"`);
      if (reasoningLine) head.push(reasoningLine);
      return [
        ...head,
        ``,
        `[model_providers.${tomlBareOrQuotedKey(providerId)}]`,
        `name = "${escapeTomlBasicString(ctx.active?.name || providerId)}"`,
        `wire_api = "responses"`,
        `base_url = "${escapeTomlBasicString(apiBase)}"`,
        `env_key = "OPENAI_API_KEY"`,
        `requires_openai_auth = true`,
        ``,
        `[projects.${tomlSingleQuotedKey(projectsCwd)}]`,
        `trust_level = "trusted"`,
        ``,
        `[windows]`,
        `sandbox = "elevated"`,
      ].join('\n');
    },
  };

  function renderTemplate(cliId, fileName, { cwd, activeProvider = undefined } = {}) {
    const manifest = getManifest(cliId);
    const configFile = manifest?.nativeConfig?.configFiles?.find(cf => cf.name === fileName);
    const templateId = configFile?.template;
    if (!templateId) return '';
    const builder = TEMPLATE_BUILDERS[templateId];
    if (!builder) {
      logger?.warn?.(`[native-cli-config] 未知 template: ${templateId} (cliId=${cliId} file=${fileName})`);
      return '';
    }
    const ctx = {
      cwd,
      active: activeProvider ?? getActiveProviderConfig(cliId),
      serverOrigin,
    };
    return builder(cliId, configFile, ctx);
  }

  function readManifestMeta(cliId) {
    const all = safeReadJSON(enabledMetaPath) || {};
    const current = all[cliId] && typeof all[cliId] === 'object' ? all[cliId] : null;
    if (current) return current;
    const legacyPath = path.join(getNativeConfigDir(cliId), '.1shell-meta.json');
    return safeReadJSON(legacyPath);
  }

  function writeManifestMeta(cliId, meta) {
    const all = safeReadJSON(enabledMetaPath) || {};
    all[cliId] = { cliId, configDir: getNativeConfigDir(cliId), ...meta };
    safeWriteJSON(enabledMetaPath, all);
  }

  function removeManifestMeta(cliId) {
    const all = safeReadJSON(enabledMetaPath) || {};
    if (Object.prototype.hasOwnProperty.call(all, cliId)) {
      delete all[cliId];
      safeWriteJSON(enabledMetaPath, all);
    }
    try {
      fs.rmSync(path.join(getNativeConfigDir(cliId), '.1shell-meta.json'), { force: true });
    } catch { /* ignore */ }
  }

  function buildLaunchEnv(cliId, { useLocalEnv = false, cwd, prepareNative = false } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return {};

    const env = {};

    if (!useLocalEnv) {
      for (const [key, tpl] of Object.entries(manifest.proxyEnv || {})) {
        env[key] = tpl.replace('{serverUrl}', serverOrigin);
      }

      if (prepareNative) ensureNativeConfig(cliId, { cwd });
      env.ONESHELL_MCP_TOKEN = bridgeToken;
    }

    Object.assign(env, manifest.extraEnv);
    return env;
  }

  function buildShellCommand(cliId, { shell = 'bash', prepareNative = false, useLocalEnv = false } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return '';

    const env = buildLaunchEnv(cliId, { cwd: process.cwd(), prepareNative, useLocalEnv });
    const args = buildLaunchArgs(cliId, { cwd: process.cwd(), prepareNative, useLocalEnv });

    if (shell === 'powershell') {
      const psExports = Object.entries(env)
        .map(([k, v]) => `$env:${k}=${quotePowerShellArg(v)}`)
        .join('; ');
      const command = buildShellCommandString(getLaunchBinary(manifest), args, 'powershell');
      return psExports ? `${psExports}; ${command}` : command;
    }

    const exports = Object.entries(env)
      .filter(([k]) => isValidShellEnvKey(k))
      .map(([k, v]) => `${k}=${quoteShellArg(v)}`)
      .join(' ');
    const command = buildShellCommandString(getLaunchBinary(manifest), args, 'bash');
    return exports ? `${exports} ${command}` : command;
  }

  function getLaunchBinary(manifest) {
    const isWindows = os.platform() === 'win32';
    const detected = detectBinary(manifest, isWindows, getBinaryOverride(manifest.id));
    return detected.path || manifest.binary;
  }

  function getLaunchCommand(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return '';
    return getLaunchBinary(manifest);
  }

  function resetNativeConfig(cliId) {
    const dir = getNativeConfigDir(cliId);
    if (!dir) return false;
    removeConfigFileOverridesForCli(cliId);
    removeManifestMeta(cliId);
    return true;
  }

  function clearConfigFileOverridesForCli(cliId) {
    return removeConfigFileOverridesForCli(cliId);
  }

  function getNativeConfigStatus(cliId) {
    const dir = getNativeConfigDir(cliId);
    if (!dir) return { configured: false, configDir: null, mode: 'host', meta: null, files: [] };
    const files = getConfigFilesStatus(cliId);
    const ready = getNativeConfigReady(cliId);
    return {
      configured: ready,
      configDir: dir,
      mode: 'host',
      files,
      meta: readManifestMeta(cliId),
    };
  }

  function getConfigFilesStatus(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return [];
    const dir = getNativeConfigDir(cliId);
    return (manifest.nativeConfig.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .map((configFile) => {
        const targetPath = path.join(dir, configFile.name);
        return { name: configFile.name, path: targetPath, exists: fs.existsSync(targetPath) };
      });
  }

  function getEditableConfigFile(cliId, fileName) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);
    const safeName = String(fileName || '').trim();
    const configFile = (manifest.nativeConfig.configFiles || [])
      .find(file => file.name === safeName && file.scope !== 'workspace');
    if (!configFile) throw new Error(`未知或不可编辑配置文件: ${safeName}`);
    return { manifest, configFile };
  }

  function validateConfigFileContent(fileName, content) {
    const text = String(content ?? '');
    if (/\.json$/i.test(fileName)) {
      try {
        JSON.parse(text || '{}');
      } catch (err) {
        throw new Error(`${fileName} 不是合法 JSON: ${err.message}`);
      }
    }
    if (/\.toml$/i.test(fileName)) {
      try {
        if (text.trim()) toml.parse(text);
      } catch (err) {
        throw new Error(`${fileName} 不是合法 TOML: ${err.message}`);
      }
    }
    return text;
  }

  function getConfigFileTargetPath(cliId, configFile) {
    return path.join(getNativeConfigDir(cliId), configFile.name);
  }

  function generateConfigFileContent(cliId, configFile, { cwd, activeProvider = undefined, forceGenerate = false } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);
    const targetPath = getConfigFileTargetPath(cliId, configFile);

    if (!forceGenerate && shouldSkipProviderConfigWrite(configFile, activeProvider ?? getActiveProviderConfig(cliId))) {
      return fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    }

    if (configFile.mergeStrategy === 'deep-merge') {
      let userConfig = safeReadJSON(targetPath) || {};
      userConfig = cleanNativeConfigEnv(userConfig, configFile);
      writeMcpEntries(userConfig, configFile, cliId);
      return JSON.stringify(userConfig, null, 2);
    }

    if (configFile.mergeStrategy === 'template') {
      return renderTemplate(cliId, configFile.name, { cwd, activeProvider });
    }

    if (configFile.mergeStrategy === 'overwrite') {
      return JSON.stringify(generateOverwriteContent(cliId, configFile.name, configFile, { activeProvider }), null, 2);
    }

    return '';
  }

  function previewConfigFiles(cliId, { cwd, activeProvider = undefined } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);
    return (manifest.nativeConfig.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .map((configFile) => {
        const targetPath = getConfigFileTargetPath(cliId, configFile);
        const override = getConfigFileOverride(cliId, configFile.name);
        const content = generateConfigFileContent(cliId, configFile, { cwd, activeProvider, forceGenerate: true });
        return {
          name: configFile.name,
          path: targetPath,
          exists: fs.existsSync(targetPath),
          editable: true,
          overridden: override != null,
          enabled: isConfigTargetTextEqual(targetPath, content),
          mergeStrategy: configFile.mergeStrategy || '',
          content,
          preview: true,
        };
      });
  }

  function listConfigFiles(cliId, { cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);
    return (manifest.nativeConfig.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .map((configFile) => {
        const targetPath = getConfigFileTargetPath(cliId, configFile);
        const override = getConfigFileOverride(cliId, configFile.name);
        const exists = fs.existsSync(targetPath);
        const content = override != null
          ? override
          : generateConfigFileContent(cliId, configFile, { cwd, forceGenerate: true });
        return {
          name: configFile.name,
          path: targetPath,
          exists,
          editable: true,
          overridden: override != null,
          enabled: isConfigTargetTextEqual(targetPath, content),
          mergeStrategy: configFile.mergeStrategy || '',
          content,
        };
      });
  }

  function isConfigTargetTextEqual(targetPath, content) {
    try {
      return fs.existsSync(targetPath) && fs.readFileSync(targetPath, 'utf8') === String(content ?? '');
    } catch {
      return false;
    }
  }

  function uniqueConfigPaths(items) {
    const out = [];
    const seen = new Set();
    for (const item of items) {
      const resolved = path.resolve(item.path);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({ ...item, path: resolved });
    }
    return out;
  }

  function getClaudeSettingsCandidates(dir) {
    return uniqueConfigPaths([
      { name: 'settings.json', path: path.join(dir, 'settings.json') },
      { name: 'claude.json', path: path.join(dir, 'claude.json') },
    ]);
  }

  function getClaudeSettingsPathInfo(dir) {
    const candidates = getClaudeSettingsCandidates(dir);
    return candidates.find(file => fs.existsSync(file.path)) || candidates[0];
  }

  function getOpenCodeConfigCandidates() {
    const dir = getNativeConfigDir('opencode');
    return uniqueConfigPaths([
      { name: 'opencode.json', path: path.join(dir, 'opencode.json') },
    ]);
  }

  function mergeOpenCodeConfig(base, next) {
    const merged = { ...(base || {}), ...(next || {}) };
    if (base?.provider || next?.provider) {
      merged.provider = { ...(base?.provider || {}) };
      for (const [providerId, provider] of Object.entries(next?.provider || {})) {
        merged.provider[providerId] = {
          ...(merged.provider[providerId] || {}),
          ...(provider || {}),
          options: {
            ...((merged.provider[providerId]?.options && typeof merged.provider[providerId].options === 'object') ? merged.provider[providerId].options : {}),
            ...((provider?.options && typeof provider.options === 'object') ? provider.options : {}),
          },
          models: {
            ...((merged.provider[providerId]?.models && typeof merged.provider[providerId].models === 'object') ? merged.provider[providerId].models : {}),
            ...((provider?.models && typeof provider.models === 'object') ? provider.models : {}),
          },
        };
      }
    }
    if (base?.mcp || next?.mcp) merged.mcp = { ...(base?.mcp || {}), ...(next?.mcp || {}) };
    return merged;
  }

  function scanNativeProviderConfig(cliId, { cwd = process.cwd() } = {}) {
    if (cliId === 'codex') return scanCodexNativeProviderConfig();
    if (cliId === 'claude-code') return scanClaudeNativeProviderConfig({ cwd });
    if (cliId === 'opencode') return scanOpenCodeNativeProviderConfig({ cwd });
    return { found: false, cliId, provider: null, files: [] };
  }

  function scanCodexNativeProviderConfig() {
    const dir = getNativeConfigDir('codex');
    const configPath = path.join(dir, 'config.toml');
    const authPath = path.join(dir, 'auth.json');
    const files = [
      { name: 'config.toml', path: configPath, exists: fs.existsSync(configPath) },
      { name: 'auth.json', path: authPath, exists: fs.existsSync(authPath) },
    ];
    if (!files[0].exists) return { found: false, cliId: 'codex', provider: null, files };

    let config;
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      config = text.trim() ? toml.parse(text) : {};
    } catch (err) {
      return { found: false, cliId: 'codex', provider: null, files, error: `config.toml 解析失败: ${err.message}` };
    }

    const providerMap = config.model_providers && typeof config.model_providers === 'object'
      ? config.model_providers
      : {};
    const providerIds = Object.keys(providerMap);
    const configuredProviderId = String(config.model_provider || '').trim();
    const providerId = configuredProviderId || providerIds[0] || 'openai';
    const nativeProvider = providerMap[providerId] || {};
    const model = String(config.model || '').trim();
    const apiBase = String(nativeProvider.base_url || (providerId === 'openai' ? 'https://api.openai.com/v1' : '')).trim();
    if (!apiBase && !model) return { found: false, cliId: 'codex', provider: null, files };

    const envKey = String(nativeProvider.env_key || 'OPENAI_API_KEY').trim() || 'OPENAI_API_KEY';
    const apiKey = readSecretFromJson(authPath, [envKey, 'OPENAI_API_KEY'])
      || String(nativeProvider.experimental_bearer_token || config.experimental_bearer_token || '').trim();
    const reasoningEffort = normalizeImportedReasoning(config.model_reasoning_effort, 'codex');
    const activeModelId = makeImportedModelId(model || 'default');
    const provider = {
      name: String(nativeProvider.name || providerId || 'Codex').trim() || 'Codex',
      apiBase,
      apiKey,
      upstreamProtocol: 'openai',
      model,
      reasoningEffort,
      models: [makeImportedModelProfile(activeModelId, model, model, reasoningEffort)],
      activeModelId,
      codexProviderId: providerId,
      nativeProviderId: providerId,
      nativeSource: 'host-config',
      nativeFiles: files,
    };
    return { found: true, cliId: 'codex', provider, files };
  }

  function scanClaudeNativeProviderConfig() {
    const dir = getNativeConfigDir('claude-code');
    const settingsCandidates = getClaudeSettingsCandidates(dir);
    const settingsFile = getClaudeSettingsPathInfo(dir);
    const files = [
      ...settingsCandidates.map(file => ({ name: file.name, path: file.path, exists: fs.existsSync(file.path) })),
      { name: 'config.json', path: path.join(dir, 'config.json'), exists: fs.existsSync(path.join(dir, 'config.json')) },
      { name: 'mcp-config.json', path: path.join(dir, 'mcp-config.json'), exists: fs.existsSync(path.join(dir, 'mcp-config.json')) },
    ];
    if (!fs.existsSync(settingsFile.path)) return { found: false, cliId: 'claude-code', provider: null, files };

    const settings = safeReadJSON(settingsFile.path);
    if (!settings || typeof settings !== 'object') {
      return { found: false, cliId: 'claude-code', provider: null, files, error: `${settingsFile.name} 解析失败` };
    }

    const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
    const apiKey = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim();
    const primaryModel = String(
      env.ANTHROPIC_MODEL
      || env.ANTHROPIC_DEFAULT_SONNET_MODEL
      || env.ANTHROPIC_DEFAULT_OPUS_MODEL
      || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      || '',
    ).trim();
    const apiBase = String(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL || (apiKey || primaryModel ? 'https://api.anthropic.com' : '')).trim();
    if (!apiBase && !apiKey && !primaryModel) {
      return {
        found: false,
        cliId: 'claude-code',
        provider: null,
        files,
        reason: `${settingsFile.name} 存在，但 env 中没有 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL`,
      };
    }

    const reasoningEffort = normalizeImportedReasoning(
      env.CLAUDE_CODE_EFFORT_LEVEL || settings.effortLevel,
      'claude-code',
    );
    const activeModelId = makeImportedModelId(primaryModel || 'default');
    const provider = {
      name: 'Claude Code Native',
      apiBase,
      apiKey,
      upstreamProtocol: 'anthropic',
      model: primaryModel,
      reasoningEffort,
      models: [makeImportedModelProfile(activeModelId, primaryModel, stripClaudeOneMMarker(primaryModel), reasoningEffort)],
      activeModelId,
      claudeModels: {
        sonnet: readClaudeRoleFromEnv(env, 'SONNET', primaryModel),
        opus: readClaudeRoleFromEnv(env, 'OPUS', primaryModel),
        fable: readClaudeRoleFromEnv(env, 'FABLE', primaryModel),
        haiku: readClaudeRoleFromEnv(env, 'HAIKU', primaryModel),
      },
      includeCoAuthoredBy: typeof settings.includeCoAuthoredBy === 'boolean' ? settings.includeCoAuthoredBy : false,
      enableToolSearch: String(env.ENABLE_TOOL_SEARCH || '').toLowerCase() === 'true',
      nativeProviderId: 'claude-code',
      nativeSource: 'host-config',
      nativeFiles: files,
    };
    return { found: true, cliId: 'claude-code', provider, files };
  }

  function scanOpenCodeNativeProviderConfig({ cwd = process.cwd() } = {}) {
    const configCandidates = getOpenCodeConfigCandidates({ cwd });
    const files = [
      ...configCandidates.map(file => ({ name: file.name, path: file.path, exists: fs.existsSync(file.path) })),
    ];
    const existingConfigFiles = configCandidates.filter(file => fs.existsSync(file.path));
    if (!existingConfigFiles.length) return { found: false, cliId: 'opencode', provider: null, files };

    let config = {};
    for (const file of existingConfigFiles) {
      const parsed = safeReadJsonLike(file.path);
      if (!parsed || typeof parsed !== 'object') {
        return { found: false, cliId: 'opencode', provider: null, files, error: `${file.name} 解析失败` };
      }
      config = mergeOpenCodeConfig(config, parsed);
    }

    const providers = config?.provider && typeof config.provider === 'object' ? config.provider : {};
    const providerId = resolveOpenCodeProviderId(config, providers);
    const nativeProvider = providerId ? providers[providerId] || {} : {};
    const options = nativeProvider.options && typeof nativeProvider.options === 'object' ? nativeProvider.options : {};
    const modelsObject = nativeProvider.models && typeof nativeProvider.models === 'object' ? nativeProvider.models : {};
    const modelProfiles = Object.entries(modelsObject)
      .map(([modelId, item]) => makeImportedModelProfile(
        makeImportedModelId(modelId),
        modelId,
        item?.name || modelId,
        'auto',
        {
          contextTokenLimit: item?.limit?.context,
          maxOutputTokens: item?.limit?.output,
        },
      ))
      .filter(model => model.apiModel);
    const configuredModel = resolveOpenCodeConfiguredModel(config, providerId);
    const activeModel = modelProfiles.find(model => model.apiModel === configuredModel)
      || modelProfiles[0]
      || makeImportedModelProfile(makeImportedModelId(configuredModel || 'default'), configuredModel || '', configuredModel || '', 'auto');
    const apiBase = String(
      options.baseURL
      || options.baseUrl
      || options.base_url
      || getDefaultOpenCodeBaseUrl(providerId)
      || '',
    ).trim();
    const apiKey = String(options.apiKey || options.api_key || '').trim();
    if (!apiBase && !apiKey && !providerId) return { found: false, cliId: 'opencode', provider: null, files };

    const provider = {
      name: String(nativeProvider.name || providerId || 'OpenCode').trim() || 'OpenCode',
      apiBase,
      apiKey,
      upstreamProtocol: 'openai',
      model: activeModel.apiModel,
      reasoningEffort: activeModel.reasoningEffort || 'auto',
      models: modelProfiles.length ? modelProfiles : [activeModel],
      activeModelId: activeModel.id,
      opencodeProviderId: providerId,
      nativeProviderId: providerId || 'opencode',
      nativeSource: 'host-config',
      nativeFiles: files,
    };
    return { found: true, cliId: 'opencode', provider, files };
  }

  function writeConfigFile(cliId, fileName, content) {
    getEditableConfigFile(cliId, fileName);
    const text = validateConfigFileContent(fileName, content);
    setConfigFileOverride(cliId, fileName, text);
    return listConfigFiles(cliId);
  }

  function clearConfigFileOverride(cliId, fileName, { cwd } = {}) {
    getEditableConfigFile(cliId, fileName);
    removeConfigFileOverride(cliId, fileName);
    return listConfigFiles(cliId, { cwd });
  }

  function getProviderSummary(cliId) {
    let providers = [];
    let active = getActiveProviderConfig(cliId);
    try {
      const result = proxyConfigStore?.listProviders?.(cliId) || {};
      providers = Array.isArray(result.providers) ? result.providers : [];
      if (!active && result.activeProviderId) active = providers.find((item) => item.id === result.activeProviderId) || null;
      if (!active && providers.length === 1) active = providers[0];
    } catch { /* ignore */ }
    return {
      providerCount: providers.length,
      providerReady: Boolean(active?.apiKey || active?.apiKeySet),
      activeProvider: active ? {
        id: active.id,
        name: active.name,
        model: active.model,
        models: Array.isArray(active.models) ? active.models.filter((model) => model?.enabled !== false) : [],
        activeModelId: active.activeModelId || null,
        activeRoute: active.activeRoute || null,
        upstreamProtocol: active.upstreamProtocol,
        apiKeySet: Boolean(active.apiKey || active.apiKeySet),
        contextTokenLimit: active.contextTokenLimit || null,
        maxOutputTokens: active.maxOutputTokens || null,
      } : null,
    };
  }

  function getReadiness(manifest, binary, nativeConfig, providerSummary) {
    const bridgeTokenReady = Boolean(bridgeToken);
    const providerReady = Boolean(providerSummary.providerReady);
    const configReady = Boolean(nativeConfig.configured);
    const configLabel = '主机原生配置';
    const configPending = '待启用配置文件';
    const installed = Boolean(binary.installed);
    const mcpReady = configReady && bridgeTokenReady;
    const launchReady = installed && providerReady && mcpReady;
    const steps = [
      { id: 'install', label: '安装 CLI', ok: installed, detail: installed ? (binary.version || binary.path || '已检测') : '未检测到可执行文件' },
      { id: 'provider', label: '模型接入', ok: providerReady, detail: providerReady ? '已配置当前方案' : '未配置模型接入' },
      { id: 'native_config', label: configLabel, ok: configReady, detail: configReady ? '配置文件已存在' : configPending },
      { id: 'mcp', label: 'MCP Token', ok: bridgeTokenReady, detail: bridgeTokenReady ? 'Bridge Token 可用' : 'BRIDGE_TOKEN 未配置' },
      { id: 'launch', label: '启动准备', ok: launchReady, detail: launchReady ? '可复制启动命令' : '仍需完成前置步骤' },
    ];
    const issues = [];
    const warnings = [];
    let nextAction = { id: 'copy_launch', label: '复制启动命令' };
    if (!installed) {
      issues.push(`未检测到 ${manifest.name} 可执行文件`);
      nextAction = { id: 'install', label: '一键安装' };
    } else if (!providerReady) {
      issues.push('尚未配置可用模型接入');
      nextAction = { id: 'config_provider', label: '配置原生文件' };
    } else if (!configReady) {
      issues.push(`${configLabel}尚未就绪`);
      nextAction = { id: 'enable_native_config', label: '启用配置' };
    } else if (!bridgeTokenReady) {
      issues.push('BRIDGE_TOKEN 未配置，MCP 无法鉴权');
      nextAction = { id: 'check_token', label: '配置 Bridge Token' };
    }
    if (binary.override) warnings.push('正在使用手动指定的 CLI 路径。');
    if (configReady && !providerReady) warnings.push(`${configLabel}已存在，但缺少模型接入配置，启动后仍无法正常调用模型。`);
    return { installed, providerReady, configReady, bridgeTokenReady, mcpReady, launchReady, steps, issues, warnings, nextAction };
  }

  function getScanInfo() {
    const isWindows = os.platform() === 'win32';
    return getAllManifests().map(manifest => {
      const binary = detectBinary(manifest, isWindows, getBinaryOverride(manifest.id));
      const nativeConfig = getNativeConfigStatus(manifest.id);
      const providerSummary = getProviderSummary(manifest.id);
      const readiness = getReadiness(manifest, binary, nativeConfig, providerSummary);

      let status;
      if (readiness.launchReady) status = 'configured';
      else if (binary.installed) status = 'detected';
      else status = 'missing';

      return {
        id: manifest.id,
        name: manifest.name,
        icon: manifest.icon,
        gradient: manifest.gradient,
        repo: manifest.repo,
        description: manifest.description,
        protocol: 'mcp',
        clientProtocol: manifest.clientProtocol,
        supportedUpstream: manifest.supportedUpstream,
        supportedOS: manifest.supportedOS,
        install: getInstallInfo(manifest),
        proxyPath: manifest.proxyPath,
        status,
        binary: { name: manifest.binary, candidates: manifest.binaries || [manifest.binary], ...binary },
        nativeConfig,
        proxy: {
          providerCount: providerSummary.providerCount,
          activeProvider: providerSummary.activeProvider,
        },
        readiness,
      };
    });
  }

  function getToolDiagnostics(cliId) {
    const tool = getScanInfo().find((item) => item.id === cliId);
    if (!tool) throw new Error(`未知 CLI: ${cliId}`);
    const configLabel = '主机原生配置文件';
    const checks = [
      { name: 'CLI 可执行文件', ok: Boolean(tool.readiness.installed), detail: tool.binary?.path || tool.binary?.name, error: tool.readiness.installed ? null : tool.binary?.error || '未检测到可执行文件' },
      { name: '模型接入配置', ok: Boolean(tool.readiness.providerReady), detail: tool.proxy?.activeProvider?.name || '', error: tool.readiness.providerReady ? null : '未配置当前方案' },
      { name: configLabel, ok: Boolean(tool.readiness.configReady), detail: tool.nativeConfig?.configDir || '', error: tool.readiness.configReady ? null : `${configLabel}缺失或不完整` },
      { name: 'Bridge Token', ok: Boolean(tool.readiness.bridgeTokenReady), detail: tool.readiness.bridgeTokenReady ? '已配置' : '', error: tool.readiness.bridgeTokenReady ? null : 'BRIDGE_TOKEN 未配置' },
      { name: '启动命令', ok: Boolean(tool.readiness.launchReady), detail: tool.readiness.nextAction?.label || '', error: tool.readiness.launchReady ? null : '仍需完成前置步骤' },
    ];
    return { tool, checks };
  }

  return {
    buildLaunchArgs,
    buildLaunchEnv,
    buildShellCommand,
    getLaunchCommand,
    enableNativeConfig,
    ensureNativeConfig,
    getNativeConfigDir,
    getNativeConfigStatus,
    listConfigFiles,
    scanNativeProviderConfig,
    previewConfigFiles,
    writeConfigFile,
    clearConfigFileOverride,
    clearConfigFileOverridesForCli,
    getProviderSummary,
    getScanInfo,
    getToolDiagnostics,
    installCli,
    resetNativeConfig,
    setBinaryOverride,
    clearBinaryOverride,
    UPSTREAM_LABELS,
  };
}

function detectBinary(manifest, isWindows, overridePath = '') {
  const manifestCandidates = (manifest.binaries || [manifest.binary]).filter(Boolean);
  const candidates = overridePath
    ? [overridePath]
    : [...new Set(manifestCandidates)].filter(Boolean);
  const attempted = [];
  const skipped = [];
  for (const candidate of candidates) {
    attempted.push(candidate);
    const detectedCandidates = resolveBinaryCandidates(candidate, isWindows);
    if (!detectedCandidates.length) continue;
    for (const detected of detectedCandidates) {
      const skipReason = getBinaryProbeSkipReason(manifest, detected, isWindows);
      if (skipReason) {
        skipped.push({ candidate, path: detected.path || candidate, reason: skipReason });
        continue;
      }
      const version = readBinaryVersion(detected.path || candidate, manifest.versionArgs || ['--version']);
      return { ...detected, version, override: Boolean(overridePath), attempted, skipped };
    }
  }
  const skippedOpenCodeDesktop = skipped.find((item) => item.reason);
  return {
    installed: false,
    attempted,
    skipped,
    override: Boolean(overridePath),
    error: skippedOpenCodeDesktop?.reason || (overridePath ? '手动路径不可用或不存在' : 'PATH 中未找到可执行文件'),
  };
}

function resolveBinaryCandidate(candidate, isWindows) {
  return resolveBinaryCandidates(candidate, isWindows)[0] || { installed: false };
}

function resolveBinaryCandidates(candidate, isWindows) {
  if (!candidate) return [];
  const clean = normalizeManualBinaryPath(candidate);
  if (path.isAbsolute(clean) || clean.includes('/') || clean.includes('\\')) {
    const resolved = resolveExecutablePath(clean, isWindows);
    return resolved ? [{ installed: true, path: resolved, source: 'path' }] : [];
  }
  try {
    const command = isWindows ? 'where.exe' : 'which';
    const result = execFileSync(command, [clean], { timeout: 3000, encoding: 'utf8', windowsHide: true }).trim();
    return result.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => ({ installed: true, path: line, source: 'path' }));
  } catch { /* not found */ }
  return [];
}

function getBinaryProbeSkipReason(manifest, detected, isWindows) {
  if (!isWindows || manifest?.id !== 'opencode') return '';
  const binaryPath = String(detected?.path || '');
  if (!binaryPath) return '';
  const basename = path.basename(binaryPath).toLowerCase();
  const parent = path.basename(path.dirname(binaryPath)).toLowerCase();
  const ext = path.extname(binaryPath).toLowerCase();
  if (ext === '.exe' && basename === 'opencode.exe' && parent === 'opencode') {
    return '检测到 OpenCode 桌面版启动器，已跳过；请安装 npm CLI(opencode-ai)或手动选择 opencode.cmd/opencode.ps1';
  }
  return '';
}

function resolveExecutablePath(filePath, isWindows) {
  if (fs.existsSync(filePath)) return filePath;
  if (!isWindows || path.extname(filePath)) return '';
  for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
    const withExt = `${filePath}${ext}`;
    if (fs.existsSync(withExt)) return withExt;
  }
  return '';
}

function readBinaryVersion(binaryPath, args) {
  if (!binaryPath) return '';
  try {
    const output = execFileSync(binaryPath, args, { timeout: 3000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return String(output || '').trim().split(/\r?\n/)[0]?.slice(0, 120) || '';
  } catch {
    return '';
  }
}

  function normalizeManualBinaryPath(value) {
    return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function isProviderReady(provider) {
  return Boolean(provider?.apiKey || provider?.apiKeySet);
}

function shouldSkipProviderConfigWrite(configFile, activeProvider) {
  if (isProviderReady(activeProvider)) return false;
  const builder = String(configFile?.overwriteBuilder || '');
  const template = String(configFile?.template || '');
  return [
    'claude-native-settings',
    'claude-native-config',
    'codex-native-auth',
    'opencode-native-config',
  ].includes(builder) || template === 'codex-config-toml';
}

function isValidShellEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ''));
}

function escapeTomlBasicString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlSingleQuotedKey(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function tomlBareOrQuotedKey(value) {
  const key = String(value || '').trim() || 'custom';
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlSingleQuotedKey(key);
}

function normalizeOpenAIBaseUrl(apiBase) {
  const raw = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://api.openai.com/v1';
  return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
}

function sanitizeCodexProviderId(value) {
  const id = String(value || 'custom')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'custom';
}

function stripClaudeOneMMarker(model) {
  const value = String(model || '').trimEnd();
  return value.toLowerCase().endsWith('[1m]') ? value.slice(0, -4).trimEnd() : value;
}

function normalizeClaudeEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (effort === 'xhigh') return 'max';
  return ['low', 'medium', 'high', 'max'].includes(effort) ? effort : '';
}

function normalizeImportedReasoning(value, cliId) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return 'auto';
  if (cliId === 'claude-code') {
    if (effort === 'xhigh') return 'max';
    return ['low', 'medium', 'high', 'max'].includes(effort) ? effort : 'auto';
  }
  if (cliId === 'codex') {
    if (effort === 'max') return 'xhigh';
    return ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'auto';
  }
  return ['auto', 'low', 'medium', 'high', 'max', 'xhigh'].includes(effort) ? effort : 'auto';
}

function makeImportedModelId(value) {
  const clean = String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `native-${clean || 'default'}`;
}

function maybePositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function makeImportedModelProfile(id, apiModel, displayName, reasoningEffort, extra = {}) {
  const profile = {
    id: id || makeImportedModelId(apiModel),
    apiModel: String(apiModel || '').trim(),
    displayName: String(displayName || apiModel || '').trim(),
    enabled: true,
    reasoningEffort: reasoningEffort || 'auto',
  };
  const contextTokenLimit = maybePositiveInteger(extra.contextTokenLimit);
  const maxOutputTokens = maybePositiveInteger(extra.maxOutputTokens);
  if (contextTokenLimit) profile.contextTokenLimit = contextTokenLimit;
  if (maxOutputTokens) profile.maxOutputTokens = maxOutputTokens;
  return profile;
}

function readSecretFromJson(filePath, keyNames) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of keyNames || []) {
      const value = data?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch { /* ignore */ }
  return '';
}

function safeReadJsonLike(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const text = /\.jsonc$/i.test(filePath)
      ? stripJsonCommentsAndTrailingCommas(raw)
      : raw;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripJsonCommentsAndTrailingCommas(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function resolveOpenCodeProviderId(config, providers) {
  const model = String(config?.model || config?.small_model || '').trim();
  if (model.includes('/')) {
    const providerId = model.slice(0, model.indexOf('/')).trim();
    if (providerId && providers?.[providerId]) return providerId;
  }
  const providerIds = Object.keys(providers || {});
  if (providerIds.includes('openai')) return 'openai';
  if (providerIds.includes('openrouter')) return 'openrouter';
  return providerIds[0] || '';
}

function resolveOpenCodeConfiguredModel(config, providerId) {
  const model = String(config?.model || '').trim();
  if (!model) return '';
  if (model.includes('/')) {
    const prefix = `${providerId}/`;
    return model.startsWith(prefix) ? model.slice(prefix.length) : model.slice(model.indexOf('/') + 1);
  }
  return model;
}

function getDefaultOpenCodeBaseUrl(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (id === 'openai') return 'https://api.openai.com/v1';
  if (id === 'openrouter') return 'https://openrouter.ai/api/v1';
  return '';
}

function readClaudeRoleFromEnv(env, role, fallbackModel) {
  const model = String(env[`ANTHROPIC_DEFAULT_${role}_MODEL`] || (role === 'SONNET' ? fallbackModel : '') || '').trim();
  const displayName = String(env[`ANTHROPIC_DEFAULT_${role}_MODEL_NAME`] || stripClaudeOneMMarker(model)).trim();
  return { model, displayName: displayName || stripClaudeOneMMarker(model) };
}

function getClaudeRoleSource(provider, role) {
  const maps = provider?.claudeModels || provider?.claudeModelMapping || provider?.modelMapping || {};
  const value = maps?.[role];
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') return { model: value };
  return {};
}

function resolveClaudeRole(provider, role, fallbackModel) {
  const source = getClaudeRoleSource(provider, role);
  const model = String(source.model || source.apiModel || fallbackModel || '').trim();
  return {
    model,
    displayName: String(source.displayName || source.name || stripClaudeOneMMarker(model)).trim(),
  };
}

function buildClaudeNativeSettings(provider) {
  const apiBase = String(provider?.apiBase || '').trim().replace(/\/+$/, '');
  const apiKey = String(provider?.apiKey || '').trim();
  const fallbackModel = String(provider?.model || provider?.models?.find(model => model?.enabled !== false)?.apiModel || '').trim();
  const sonnet = resolveClaudeRole(provider, 'sonnet', fallbackModel);
  const opus = resolveClaudeRole(provider, 'opus', fallbackModel || sonnet.model);
  const fable = resolveClaudeRole(provider, 'fable', opus.model || sonnet.model);
  const haiku = resolveClaudeRole(provider, 'haiku', fallbackModel || sonnet.model);
  const primaryModel = fallbackModel || sonnet.model || opus.model || fable.model || haiku.model;
  const env = {};

  if (apiBase) env.ANTHROPIC_BASE_URL = apiBase;
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  if (primaryModel) env.ANTHROPIC_MODEL = primaryModel;
  if (haiku.model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku.model;
  if (haiku.displayName) env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = haiku.displayName;
  if (sonnet.model) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet.model;
  if (sonnet.displayName) env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = sonnet.displayName;
  if (opus.model) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus.model;
  if (opus.displayName) env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = opus.displayName;
  if (fable.model) env.ANTHROPIC_DEFAULT_FABLE_MODEL = fable.model;
  if (fable.displayName) env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = fable.displayName;

  const effort = normalizeClaudeEffort(provider?.claudeEffort || provider?.reasoningEffort);
  if (effort === 'max') env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  if (provider?.enableToolSearch === true || provider?.claudeEnableToolSearch === true) env.ENABLE_TOOL_SEARCH = 'true';

  const settings = { env };
  if (effort && effort !== 'max') settings.effortLevel = effort;
  if (provider?.includeCoAuthoredBy !== true) settings.includeCoAuthoredBy = false;
  return settings;
}

function buildClaudeNativeConfig() {
  return { primaryApiKey: 'any' };
}

function buildCodexNativeAuth(provider) {
  const apiKey = String(provider?.apiKey || '').trim();
  return apiKey ? { OPENAI_API_KEY: apiKey } : {};
}

function buildOpenCodeNativeConfig(provider, mcpEntries = {}) {
  const providerId = sanitizeCodexProviderId(provider?.opencodeProviderId || provider?.name || '1shell');
  const apiKey = String(provider?.apiKey || '').trim();
  const baseURL = normalizeOpenAIBaseUrl(provider?.apiBase || 'https://api.openai.com/v1');
  const models = {};
  const sourceModels = Array.isArray(provider?.models) && provider.models.length
    ? provider.models
    : (provider?.model ? [{ apiModel: provider.model, displayName: provider.model }] : []);

  for (const model of sourceModels) {
    if (model?.enabled === false) continue;
    const id = String(model?.apiModel || model?.model || '').trim();
    if (!id) continue;
    const item = { name: String(model?.displayName || model?.name || id).trim() || id };
    const limit = {};
    if (Number.isInteger(model?.contextTokenLimit) && model.contextTokenLimit > 0) limit.context = model.contextTokenLimit;
    if (Number.isInteger(model?.maxOutputTokens) && model.maxOutputTokens > 0) limit.output = model.maxOutputTokens;
    if (Object.keys(limit).length > 0) item.limit = limit;
    models[id] = item;
  }

  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: String(provider?.name || providerId).trim() || providerId,
        options: {
          baseURL,
          apiKey,
          setCacheKey: true,
        },
        models,
      },
    },
  };

  if (mcpEntries && Object.keys(mcpEntries).length > 0) {
    config.mcp = mcpEntries;
  }

  return config;
}

function tailInstallOutput(output) {
  return String(output || '').trim().split(/\r?\n/).slice(-80).join('\n');
}

function buildInstallErrorMessage(err, stdout, stderr) {
  const detail = tailInstallOutput(stderr || stdout);
  return detail || err.message || '安装失败';
}

module.exports = {
  createNativeCliConfig,
  __test: {
    detectBinary,
    getBinaryProbeSkipReason,
    resolveBinaryCandidates,
  },
};
