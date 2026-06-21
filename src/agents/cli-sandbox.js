'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { getManifest, getAllManifests, UPSTREAM_LABELS } = require('./cli-manifest');
const { codexConfigTomlReasoningLine } = require('./reasoning');

function createCliSandbox({ dataDir, bridgeToken, port, proxyConfigStore, claudeCodeSkillRegistry, logger }) {
  const sandboxRoot = path.join(dataDir, 'cli-sandbox');
  const binaryOverridesPath = path.join(sandboxRoot, 'binary-overrides.json');
  const serverOrigin = `http://127.0.0.1:${port}`;
  const home = os.homedir();

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

  function installCli(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);
    const installInfo = getInstallInfo(manifest);
    const command = installInfo.command;
    if (!command) throw new Error(`${manifest.name} 暂未配置自动安装命令`);
    fs.mkdirSync(getManagedInstallRoot(manifest.id), { recursive: true });

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
        const binary = detectBinary(manifest, isWindows, getBinaryOverride(manifest.id), getManagedBinaryCandidates(manifest));
        const result = {
          command,
          installRoot: getManagedInstallRoot(manifest.id),
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

  function getManagedInstallRoot(cliId) {
    return path.join(sandboxRoot, 'managed-cli', cliId);
  }

  function getManagedBinaryCandidates(manifest) {
    const binDir = path.join(getManagedInstallRoot(manifest.id), 'node_modules', '.bin');
    const names = [manifest.binary, ...(manifest.binaries || [])]
      .filter(Boolean)
      .filter((name) => !path.isAbsolute(name) && !name.includes('/') && !name.includes('\\'));
    return [...new Set(names)].map((name) => path.join(binDir, name));
  }

  function getManagedBinaryPath(manifest) {
    const isWindows = os.platform() === 'win32';
    for (const candidate of getManagedBinaryCandidates(manifest)) {
      const resolved = resolveExecutablePath(candidate, isWindows);
      if (resolved) return resolved;
    }
    return '';
  }

  function getInstallInfo(manifest) {
    const pkg = manifest.install?.npmPackage;
    if (!pkg) return manifest.install || {};
    return {
      ...manifest.install,
      executable: getNpmExecutable(),
      args: ['install', '--prefix', getManagedInstallRoot(manifest.id), pkg, '--no-audit', '--no-fund'],
      command: buildManagedNpmInstallCommand(manifest, pkg),
      globalCommand: manifest.install.command,
    };
  }

  function getNpmExecutable() {
    return os.platform() === 'win32' ? 'npm.cmd' : 'npm';
  }

  function buildManagedNpmInstallCommand(manifest, pkg) {
    const installRoot = getManagedInstallRoot(manifest.id);
    return [
      'npm',
      'install',
      '--prefix',
      quoteInstallArg(installRoot),
      quoteInstallArg(pkg),
      '--no-audit',
      '--no-fund',
    ].join(' ');
  }

  function quoteInstallArg(value) {
    return quoteShellArg(value);
  }

  function buildMcpEntry(cliId = null) {
    // 默认走 SSE(claude-code 形态);cliId=null 调用来自 buildClaudeMcpConfig
    const mcp = cliId ? (getManifest(cliId)?.sandbox?.mcp) : { transport: 'sse' };
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

  function safeReadJSON(filePath) {
    if (!filePath) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  }

  function safeWriteJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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

  function getSandboxDir(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return null;
    const baseDir = path.join(sandboxRoot, manifest.sandbox.dirName);
    if (manifest.sandbox.configSubDir) {
      return path.join(baseDir, manifest.sandbox.configSubDir);
    }
    return baseDir;
  }

  function getWorkspaceConfigPath(manifest, configFile, cwd) {
    if (!configFile?.scope || configFile.scope !== 'workspace' || !cwd) return null;
    return path.join(cwd, manifest.sandbox.workspaceConfigDir || manifest.sandbox.defaultConfigDir, configFile.name);
  }

  function hasWorkspaceConfig(cliId, { cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;
    const workspaceFiles = (manifest.sandbox.configFiles || []).filter(file => file.scope === 'workspace');
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

  function ensureSandbox(cliId, { cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) throw new Error(`未知 CLI: ${cliId}`);

    const dir = getSandboxDir(cliId);
    fs.mkdirSync(dir, { recursive: true });

    for (const configFile of manifest.sandbox.configFiles) {
      if (configFile.scope === 'workspace') {
        if (!cwd) continue;
        const workspaceDir = path.join(cwd, manifest.sandbox.workspaceConfigDir || manifest.sandbox.defaultConfigDir);
        const targetPath = path.join(workspaceDir, configFile.name);
        if (configFile.mergeStrategy === 'deep-merge') {
          let userConfig = safeReadJSON(targetPath) || {};
          userConfig = cleanSandboxEnv(userConfig, configFile);
          deepSet(userConfig, configFile.mergePointer, configFile.mergeValue || buildMcpEntry(cliId));
          safeWriteJSON(targetPath, userConfig);
        }
        continue;
      }

      const targetPath = path.join(dir, configFile.name);

      if (configFile.mergeStrategy === 'deep-merge') {
        const userConfigPath = path.join(home, manifest.sandbox.defaultConfigDir, configFile.name);
        let userConfig = safeReadJSON(userConfigPath) || {};
        userConfig = cleanSandboxEnv(userConfig, configFile);
        deepSet(userConfig, configFile.mergePointer, configFile.mergeValue || buildMcpEntry(cliId));
        safeWriteJSON(targetPath, userConfig);

      } else if (configFile.mergeStrategy === 'template') {
        const content = renderTemplate(cliId, configFile.name, { cwd });
        if (content) fs.writeFileSync(targetPath, content, 'utf8');

      } else if (configFile.mergeStrategy === 'overwrite') {
        const content = generateOverwriteContent(cliId, configFile.name, configFile);
        safeWriteJSON(targetPath, content);
      }
    }

    for (const hookId of (manifest.postEnsureHooks || [])) {
      const hook = POST_ENSURE_HOOKS[hookId];
      if (!hook) {
        logger?.warn?.(`[cli-sandbox] 未知 postEnsureHook: ${hookId} (cliId=${cliId})`);
        continue;
      }
      try {
        hook(cliId);
      } catch (err) {
        logger?.warn?.(`[cli-sandbox] postEnsureHook '${hookId}' 失败: ${err.message}`);
      }
    }

    writeManifestMeta(cliId, { updatedAt: new Date().toISOString() });
    return dir;
  }

  function syncClaudeCodeSkills() {
    if (!claudeCodeSkillRegistry?.listSkills) return;

    const dir = getSandboxDir('claude-code');
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

  function cleanSandboxEnv(config, configFile) {
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
    return path.join(getSandboxDir('claude-code'), 'mcp-config.json');
  }

  // launchArgsBuilder 注册表 — 接 (cliId, manifest, ctx),返回追加的 arg 数组
  // ctx 含:cwd、sandboxDir、helpers(getClaudeMcpConfigPath / getClaudeCodeActivationPrompt)
  const LAUNCH_ARGS_BUILDERS = {
    'claude-mcp-args': (cliId, manifest, ctx) => {
      const extra = ['--strict-mcp-config', '--mcp-config', getClaudeMcpConfigPath()];
      const activationPrompt = getClaudeCodeActivationPrompt();
      if (activationPrompt) extra.push('--append-system-prompt', activationPrompt);
      return extra;
    },
  };

  function buildLaunchArgs(cliId, { useLocalEnv = false, cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return [];

    const args = [...(manifest.launchArgs || [])];
    if (useLocalEnv) return args;

    ensureSandbox(cliId, { cwd });

    const builderId = manifest.launchArgsBuilder;
    if (builderId) {
      const builder = LAUNCH_ARGS_BUILDERS[builderId];
      if (builder) {
        args.push(...builder(cliId, manifest, { cwd }));
      } else {
        logger?.warn?.(`[cli-sandbox] 未知 launchArgsBuilder: ${builderId} (cliId=${cliId})`);
      }
    }

    return args;
  }

  function hasRequiredConfigFiles(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;

    return (manifest.sandbox.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .every((configFile) => fs.existsSync(path.join(getSandboxDir(cliId), configFile.name)));
  }

  function getSandboxReady(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return false;
    if (!hasRequiredConfigFiles(cliId)) return false;
    if ((manifest.sandbox.configFiles || []).some(file => file.scope === 'workspace')) {
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

  // postEnsureHooks 注册表 — 接 (cliId),在 ensureSandbox 写完所有 config 后跑
  const POST_ENSURE_HOOKS = {
    'sync-claude-skills': () => syncClaudeCodeSkills(),
  };

  // overwriteBuilder 注册表 — 每个 builder 接 (cliId, configFile),返回 JSON 对象
  const OVERWRITE_BUILDERS = {
    'env-overrides': (cliId, configFile) => ({
      env: resolveOverrideEnv(configFile),
    }),
    'static': (cliId, configFile) => (
      configFile.content && typeof configFile.content === 'object' ? configFile.content : {}
    ),
    'mcp-config': (cliId, configFile) => {
      const key = configFile.mcpServersKey || 'mcpServers';
      const entryName = configFile.mcpEntryName || '1shell';
      return { [key]: { [entryName]: buildMcpEntry(cliId) } };
    },
  };

  function generateOverwriteContent(cliId, fileName, configFile) {
    const builderId = configFile.overwriteBuilder;
    if (!builderId) return {};
    const builder = OVERWRITE_BUILDERS[builderId];
    if (!builder) {
      logger?.warn?.(`[cli-sandbox] 未知 overwriteBuilder: ${builderId} (cliId=${cliId} file=${fileName})`);
      return {};
    }
    return builder(cliId, configFile);
  }

  // template 注册表 — 每个 template 接 (cliId, configFile, ctx),返回字符串
  // ctx 含:cwd、active(active provider)、serverOrigin、helpers(escape/quote)
  const TEMPLATE_BUILDERS = {
    'codex-config-toml': (cliId, configFile, ctx) => {
      const model = ctx.active?.model || 'gpt-4o';
      const projectsCwd = ctx.cwd || process.cwd();
      // v3 plan §4.2 轨 1:codex 的 reasoning 写到 config.toml 的 model_reasoning_effort
      // (claude/1Shell AI 走 proxy 注入 = 轨 2,见 proxy.routes.js 的 maybeInjectReasoning)
      // effort=auto 或未设时不输出该行,让 codex 自决 ── 也保证 snapshot 字节级不变
      const reasoningLine = codexConfigTomlReasoningLine(ctx.active?.reasoningEffort);
      const head = [
        `model_provider = "1shell-proxy"`,
        `model = "${escapeTomlBasicString(model)}"`,
      ];
      if (reasoningLine) head.push(reasoningLine);
      head.push(`disable_response_storage = true`);
      return [
        ...head,
        ``,
        `[model_providers.1shell-proxy]`,
        `name = "1shell-proxy"`,
        `wire_api = "responses"`,
        `base_url = "${ctx.serverOrigin}/api/proxy/codex"`,
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

  function renderTemplate(cliId, fileName, { cwd }) {
    const manifest = getManifest(cliId);
    const configFile = manifest?.sandbox?.configFiles?.find(cf => cf.name === fileName);
    const templateId = configFile?.template;
    if (!templateId) return '';
    const builder = TEMPLATE_BUILDERS[templateId];
    if (!builder) {
      logger?.warn?.(`[cli-sandbox] 未知 template: ${templateId} (cliId=${cliId} file=${fileName})`);
      return '';
    }
    const ctx = {
      cwd,
      active: getActiveProviderConfig(cliId),
      serverOrigin,
    };
    return builder(cliId, configFile, ctx);
  }

  function writeManifestMeta(cliId, meta) {
    const dir = getSandboxDir(cliId);
    if (!dir) return;
    safeWriteJSON(path.join(dir, '.1shell-meta.json'), { cliId, ...meta });
  }

  function buildLaunchEnv(cliId, { useLocalEnv = false, cwd } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return {};

    const env = {};

    if (!useLocalEnv) {
      for (const [key, tpl] of Object.entries(manifest.proxyEnv)) {
        env[key] = tpl.replace('{serverUrl}', serverOrigin);
      }

      ensureSandbox(cliId, { cwd });
      const sandboxDir = getSandboxDir(cliId);

      if (manifest.sandbox.configDirEnv) {
        if (manifest.sandbox.configSubDir) {
          const baseDir = path.join(sandboxRoot, manifest.sandbox.dirName);
          env[manifest.sandbox.configDirEnv] = baseDir;
        } else {
          env[manifest.sandbox.configDirEnv] = sandboxDir;
        }
      }

      env.ONESHELL_MCP_TOKEN = bridgeToken;
    }

    Object.assign(env, manifest.extraEnv);
    return env;
  }

  function buildShellCommand(cliId, { shell = 'bash' } = {}) {
    const manifest = getManifest(cliId);
    if (!manifest) return '';

    const dir = getSandboxDir(cliId);
    const hasMeta = fs.existsSync(path.join(dir, '.1shell-meta.json'));
    if (!hasMeta) ensureSandbox(cliId);

    const env = buildLaunchEnv(cliId, { cwd: process.cwd() });
    const args = buildLaunchArgs(cliId, { cwd: process.cwd() });

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
    return getBinaryOverride(manifest.id) || getManagedBinaryPath(manifest) || manifest.binary;
  }

  function resetSandbox(cliId) {
    const dir = getSandboxDir(cliId);
    if (!dir) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  function getSandboxStatus(cliId) {
    const dir = getSandboxDir(cliId);
    if (!dir) return { sandboxed: false, sandboxDir: null, meta: null, files: [] };
    const metaPath = path.join(dir, '.1shell-meta.json');
    const exists = fs.existsSync(metaPath);
    const files = getConfigFilesStatus(cliId);
    return {
      sandboxed: exists && getSandboxReady(cliId),
      sandboxDir: dir,
      files,
      meta: exists ? safeReadJSON(metaPath) : null,
    };
  }

  function getConfigFilesStatus(cliId) {
    const manifest = getManifest(cliId);
    if (!manifest) return [];
    const dir = getSandboxDir(cliId);
    return (manifest.sandbox.configFiles || [])
      .filter(file => file.scope !== 'workspace')
      .map((configFile) => {
        const targetPath = path.join(dir, configFile.name);
        return { name: configFile.name, path: targetPath, exists: fs.existsSync(targetPath) };
      });
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
        upstreamProtocol: active.upstreamProtocol,
        apiKeySet: Boolean(active.apiKey || active.apiKeySet),
      } : null,
    };
  }

  function getReadiness(manifest, binary, sandbox, providerSummary) {
    const bridgeTokenReady = Boolean(bridgeToken);
    const providerReady = Boolean(providerSummary.providerReady);
    const sandboxReady = Boolean(sandbox.sandboxed);
    const installed = Boolean(binary.installed);
    const mcpReady = sandboxReady && bridgeTokenReady;
    const launchReady = installed && providerReady && mcpReady;
    const steps = [
      { id: 'install', label: '安装 CLI', ok: installed, detail: installed ? (binary.version || binary.path || '已检测') : '未检测到可执行文件' },
      { id: 'provider', label: '配置 API', ok: providerReady, detail: providerReady ? '已配置活跃 Provider' : '未配置活跃 Provider' },
      { id: 'sandbox', label: '写入沙箱配置', ok: sandboxReady, detail: sandboxReady ? '配置文件就绪' : '待创建或刷新沙箱' },
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
      issues.push('尚未配置可用 API Provider');
      nextAction = { id: 'config_provider', label: '配置 API' };
    } else if (!sandboxReady) {
      issues.push('沙箱配置尚未就绪');
      nextAction = { id: 'ensure_sandbox', label: '写入 1Shell MCP 配置' };
    } else if (!bridgeTokenReady) {
      issues.push('BRIDGE_TOKEN 未配置，MCP 无法鉴权');
      nextAction = { id: 'check_token', label: '配置 Bridge Token' };
    }
    if (binary.override) warnings.push('正在使用手动指定的 CLI 路径。');
    if (sandboxReady && !providerReady) warnings.push('沙箱已存在，但缺少 API Provider，启动后仍无法正常调用模型。');
    return { installed, providerReady, sandboxReady, bridgeTokenReady, mcpReady, launchReady, steps, issues, warnings, nextAction };
  }

  function getScanInfo() {
    const isWindows = os.platform() === 'win32';
    return getAllManifests().map(manifest => {
      const binary = detectBinary(manifest, isWindows, getBinaryOverride(manifest.id), getManagedBinaryCandidates(manifest));
      const sandbox = getSandboxStatus(manifest.id);
      const providerSummary = getProviderSummary(manifest.id);
      const readiness = getReadiness(manifest, binary, sandbox, providerSummary);

      let status;
      if (readiness.launchReady) status = 'sandboxed';
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
        sandbox,
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
    const checks = [
      { name: 'CLI 可执行文件', ok: Boolean(tool.readiness.installed), detail: tool.binary?.path || tool.binary?.name, error: tool.readiness.installed ? null : tool.binary?.error || '未检测到可执行文件' },
      { name: 'API Provider', ok: Boolean(tool.readiness.providerReady), detail: tool.proxy?.activeProvider?.name || '', error: tool.readiness.providerReady ? null : '未配置活跃 Provider' },
      { name: '沙箱配置文件', ok: Boolean(tool.readiness.sandboxReady), detail: tool.sandbox?.sandboxDir || '', error: tool.readiness.sandboxReady ? null : '沙箱配置缺失或不完整' },
      { name: 'Bridge Token', ok: Boolean(tool.readiness.bridgeTokenReady), detail: tool.readiness.bridgeTokenReady ? '已配置' : '', error: tool.readiness.bridgeTokenReady ? null : 'BRIDGE_TOKEN 未配置' },
      { name: '启动命令', ok: Boolean(tool.readiness.launchReady), detail: tool.readiness.nextAction?.label || '', error: tool.readiness.launchReady ? null : '仍需完成前置步骤' },
    ];
    return { tool, checks };
  }

  return {
    buildLaunchArgs,
    buildLaunchEnv,
    buildShellCommand,
    ensureSandbox,
    getSandboxDir,
    getSandboxStatus,
    getScanInfo,
    getToolDiagnostics,
    installCli,
    resetSandbox,
    setBinaryOverride,
    clearBinaryOverride,
    UPSTREAM_LABELS,
  };
}

function detectBinary(manifest, isWindows, overridePath = '', extraCandidates = []) {
  const manifestCandidates = (manifest.binaries || [manifest.binary]).filter(Boolean);
  const candidates = overridePath
    ? [overridePath]
    : [...new Set([...(extraCandidates || []), ...manifestCandidates])].filter(Boolean);
  const extraCandidateSet = new Set(extraCandidates || []);
  const attempted = [];
  for (const candidate of candidates) {
    const detected = resolveBinaryCandidate(candidate, isWindows);
    attempted.push(candidate);
    if (!detected.installed) continue;
    const version = readBinaryVersion(detected.path || candidate, manifest.versionArgs || ['--version']);
    return { ...detected, version, override: Boolean(overridePath), managed: !overridePath && extraCandidateSet.has(candidate), attempted };
  }
  return { installed: false, attempted, override: Boolean(overridePath), error: overridePath ? '手动路径不可用或不存在' : 'PATH 和 1Shell 托管目录中未找到可执行文件' };
}

function resolveBinaryCandidate(candidate, isWindows) {
  if (!candidate) return { installed: false };
  const clean = normalizeManualBinaryPath(candidate);
  if (path.isAbsolute(clean) || clean.includes('/') || clean.includes('\\')) {
    const resolved = resolveExecutablePath(clean, isWindows);
    return resolved ? { installed: true, path: resolved, source: 'path' } : { installed: false };
  }
  try {
    const command = isWindows ? 'where.exe' : 'which';
    const result = execFileSync(command, [clean], { timeout: 3000, encoding: 'utf8', windowsHide: true }).trim();
    const first = result.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    if (first) return { installed: true, path: first, source: 'path' };
  } catch { /* not found */ }
  return { installed: false };
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

function isValidShellEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ''));
}

function escapeTomlBasicString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlSingleQuotedKey(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function tailInstallOutput(output) {
  return String(output || '').trim().split(/\r?\n/).slice(-80).join('\n');
}

function buildInstallErrorMessage(err, stdout, stderr) {
  const detail = tailInstallOutput(stderr || stdout);
  return detail || err.message || '安装失败';
}

module.exports = { createCliSandbox };
