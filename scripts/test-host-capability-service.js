#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHostCapabilityService } = require('../src/services/host-capability.service');
const { createHostCapabilityScanner } = require('../src/services/host-capability-scanner.service');
const { createMcpRegistry } = require('../src/services/mcp-registry.service');
const { createMcpPresetStore } = require('../src/agents/mcp-preset-store');
const { createSkillRegistry } = require('../src/skills/registry');
const { createLibraryService } = require('../src/skills/library.service');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-host-capability-'));

try {
  const mcpRegistry = createMcpRegistry({ dataDir: tmpDir });
  const mcpPresetStore = createMcpPresetStore({ dataDir: tmpDir });
  const skillState = new Map([
    ['review', { id: 'review', name: 'Review', enabled: true, tags: ['code'] }],
  ]);
  const libraryService = {
    listSkills() {
      return Array.from(skillState.values());
    },
    setSkillEnabled(id, enabled) {
      const skill = skillState.get(id);
      if (!skill) return null;
      const next = { ...skill, enabled: enabled === true };
      skillState.set(id, next);
      return next;
    },
  };

  const service = createHostCapabilityService({
    dataDir: tmpDir,
    mcpRegistry,
    libraryService,
    nativeCliConfig: { getScanInfo: () => [] },
    mcpPresetStore,
    logger: { info() {}, warn() {} },
  });

  const agents = service.listAgents();
  assert.ok(agents.some((agent) => agent.id === 'oneshell-ai'), 'oneshell-ai should be an agent column');
  assert.ok(agents.some((agent) => agent.id === 'claude-code'), 'Claude Code should be an agent column');

  const disabledSkill = service.setExposure('skill', 'review', 'oneshell-ai', false);
  assert.strictEqual(disabledSkill.exposure['oneshell-ai'], false, 'oneshell-ai skill exposure should use skill runtime state');
  assert.strictEqual(skillState.get('review').enabled, false, 'skill runtime state should be updated');

  const importedMcp = service.setExposure('mcp', 'fetch', 'oneshell-ai', true);
  assert.strictEqual(importedMcp.id, 'fetch');
  assert.strictEqual(importedMcp.exposure['oneshell-ai'], true, 'fetch preset should be exposed to oneshell-ai after import');
  assert.match(mcpRegistry.getServer('fetch').command, /^uvx mcp-server-fetch$/, 'fetch preset should become a local MCP command');

  assert.throws(
    () => service.setExposure('mcp', 'github', 'oneshell-ai', true),
    /githubToken/,
    'configured presets should not be imported without required values',
  );

  assert.throws(
    () => service.setExposure('mcp', 'github', 'codex', true),
    /githubToken/,
    'configured presets should not be marked exposed for native CLIs without values',
  );

  const nativeFetch = service.setExposure('mcp', 'fetch', 'codex', true);
  assert.strictEqual(nativeFetch.exposure.codex, true, 'native no-config presets should be marked exposed');
  assert.ok(
    mcpPresetStore.listApplied('codex').some((item) => item.presetId === 'fetch'),
    'native no-config presets should be applied to the preset store',
  );

  const homeDir = path.join(tmpDir, 'home');
  const scanDataDir = path.join(tmpDir, 'scan-data');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude', 'skills', 'refactor'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'skills', 'design'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'skills', 'ui-ux-pro-max'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'skills', '.system', 'builtin-helper'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'plugins', 'demo-plugin', 'skills', 'plugin-helper'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.npm', '_npx', 'uipro-test', 'node_modules', 'ui-ux-pro-max-cli', 'assets', 'skills', 'design'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });

  fs.writeFileSync(path.join(homeDir, '.claude', 'mcp-config.json'), JSON.stringify({
    mcpServers: {
      '1shell': { type: 'sse', url: 'http://127.0.0.1:3301/mcp/sse' },
      'browser-tools': {
        command: 'npx',
        args: ['-y', '@example/browser-mcp'],
        env: { BROWSER_TOKEN: 'secret-token' },
        cwd: '/tmp/browser-mcp',
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
    projects: {
      '/workspace/app': {
        mcpServers: {
          'project-db': {
            command: 'node',
            args: ['/workspace/app/mcp/project-db.js'],
          },
        },
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(homeDir, '.codex', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'docs-reader': {
        type: 'sse',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer doc-token' },
      },
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'existing-gh-token' },
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(homeDir, '.codex', 'config.toml'), [
    '[mcp_servers.playwright]',
    'command = "npx"',
    'args = ["-y", "@playwright/mcp@latest"]',
  ].join('\n'));

  fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(homeDir, '.claude', 'skills', 'refactor', 'SKILL.md'), [
    '---',
    'name: Refactor',
    'description: Code refactor helper',
    'category: code',
    'tags:',
    '  - code',
    '---',
    'Refactor instructions.',
  ].join('\n'));

  fs.writeFileSync(path.join(homeDir, '.codex', 'skills', 'ui-ux-pro-max', 'SKILL.md'), [
    '---',
    'name: ui-ux-pro-max',
    'description: UI/UX design intelligence',
    '---',
    'UI instructions.',
  ].join('\n'));

  const bundledDesignSkill = [
    '---',
    'name: design',
    'description: Bundled design helper',
    'metadata:',
    '  author: claudekit',
    '---',
    'Bundled design instructions.',
  ].join('\n');
  fs.writeFileSync(path.join(homeDir, '.codex', 'skills', 'design', 'SKILL.md'), bundledDesignSkill);
  fs.writeFileSync(path.join(homeDir, '.npm', '_npx', 'uipro-test', 'node_modules', 'ui-ux-pro-max-cli', 'assets', 'skills', 'design', 'SKILL.md'), bundledDesignSkill);

  fs.writeFileSync(path.join(homeDir, '.codex', 'skills', '.system', 'builtin-helper', 'SKILL.md'), [
    '---',
    'name: builtin-helper',
    'description: system helper',
    '---',
    'System instructions.',
  ].join('\n'));

  fs.writeFileSync(path.join(homeDir, '.codex', 'plugins', 'demo-plugin', 'skills', 'plugin-helper', 'SKILL.md'), [
    '---',
    'name: plugin-helper',
    'description: Plugin skill helper',
    '---',
    'Plugin instructions.',
  ].join('\n'));

  const scanner = createHostCapabilityScanner({ dataDir: scanDataDir, homeDir, logger: { warn() {} } });
  const scanRegistry = createMcpRegistry({ dataDir: scanDataDir });
  const scanSkillRegistry = createSkillRegistry(path.join(scanDataDir, 'skills'));
  const scanLibrary = createLibraryService({ skillRegistry: scanSkillRegistry });
  const scanService = createHostCapabilityService({
    dataDir: scanDataDir,
    mcpRegistry: scanRegistry,
    libraryService: scanLibrary,
    nativeCliConfig: { getScanInfo: () => [] },
    mcpPresetStore: createMcpPresetStore({ dataDir: scanDataDir }),
    hostCapabilityScanner: scanner,
    logger: { info() {}, warn() {} },
  });

  const scanSummary = scanService.scanHostCapabilities();
  assert.strictEqual(scanSummary.mcpCount, 7, 'host scan should discover MCP servers including nested and generic host configs');
  assert.strictEqual(scanSummary.externalMcpCount, 6, 'host scan should count non-1shell MCP servers as external');
  assert.strictEqual(scanSummary.skillCount, 3, 'host scan should discover installed user and plugin skills while hiding bundled companion skills');
  assert.strictEqual(scanSummary.installedSkillCount, 3, 'host scan should count native app skills as installed external skills');
  assert.strictEqual(scanSummary.unmanagedSkillCount, 0, 'ordinary native app skills should not be downgraded to unmanaged import candidates');

  const externalMcpRows = scanService.listMcpCapabilities();
  const oneShellBridge = externalMcpRows.find((item) => item.id === '1shell');
  assert.ok(oneShellBridge, '1Shell MCP bridge should be listed in matrix');
  assert.strictEqual(oneShellBridge.source, 'oneshell');
  assert.strictEqual(oneShellBridge.readonly, true);
  assert.strictEqual(oneShellBridge.exposure['oneshell-ai'], true, '1Shell AI should see the built-in 1Shell MCP bridge');
  assert.strictEqual(oneShellBridge.exposure['claude-code'], true, '1Shell bridge exposure should reflect native config discovery');

  const browserTools = externalMcpRows.find((item) => item.id === 'browser-tools');
  assert.ok(browserTools, 'external MCP should be listed in matrix');
  assert.strictEqual(browserTools.source, 'external');
  assert.strictEqual(browserTools.managed, false);
  assert.strictEqual(browserTools.exposure['claude-code'], true, 'external MCP exposure should reflect discovered host config');

  const projectDb = externalMcpRows.find((item) => item.id === 'project-db');
  assert.ok(projectDb, 'Claude project MCP should be discovered from nested project config');
  assert.strictEqual(projectDb.exposure['claude-code'], true, 'nested Claude project MCP should be attributed to Claude Code');

  const context7 = externalMcpRows.find((item) => item.id === 'context7');
  assert.ok(context7, 'generic host MCP config should be discovered');
  assert.deepStrictEqual(context7.foundIn, ['host'], 'generic MCP configs should not be attributed to a native agent');

  const externalGithub = externalMcpRows.find((item) => item.id === 'github');
  assert.ok(externalGithub, 'existing GitHub MCP should be discovered from Codex config');
  assert.strictEqual(externalGithub.exposure.codex, true, 'existing GitHub MCP exposure should reflect Codex config');

  const managedSkillRows = scanService.listSkillCapabilities();
  const refactor = managedSkillRows.find((item) => item.id === 'refactor');
  assert.ok(refactor, 'native app Skill should be listed in the matrix as an installed external skill');
  assert.strictEqual(refactor.source, 'installed');
  assert.strictEqual(refactor.exposure['claude-code'], true, 'installed Skill exposure should reflect discovered skill directory');

  const uiUx = managedSkillRows.find((item) => item.id === 'ui-ux-pro-max');
  assert.ok(uiUx, 'Codex Skill should be listed in the matrix as an installed external skill');
  assert.strictEqual(uiUx.source, 'installed');
  assert.strictEqual(uiUx.exposure.codex, true, 'Codex Skill exposure should reflect ~/.codex/skills');

  const pluginHelper = managedSkillRows.find((item) => item.id === 'plugin-helper');
  assert.ok(pluginHelper, 'Codex plugin Skill should be listed in the matrix as an installed external skill');
  assert.strictEqual(pluginHelper.source, 'installed');
  assert.strictEqual(pluginHelper.exposure.codex, true, 'Codex plugin Skill exposure should reflect plugin skill directory');

  assert.ok(!managedSkillRows.some((item) => item.id === 'design'), 'bundled companion Skill should not be listed as a user-installed skill');
  assert.ok(!managedSkillRows.some((item) => item.id === 'builtin-helper'), 'hidden dot system skills should not be listed as user-manageable skills');

  const unmanagedSkillRows = scanService.listUnmanagedSkillCapabilities();
  assert.ok(!unmanagedSkillRows.some((item) => item.id === 'refactor'), 'installed native Skill should not be duplicated in unmanaged candidates');
  assert.ok(!unmanagedSkillRows.some((item) => item.id === 'ui-ux-pro-max'), 'installed Codex Skill should not be duplicated in unmanaged candidates');
  assert.ok(!unmanagedSkillRows.some((item) => item.id === 'design'), 'bundled companion Skill should not be listed as an unmanaged candidate');

  const importedExternalMcp = scanService.importCapability('mcp', 'browser-tools');
  assert.strictEqual(importedExternalMcp.source, 'managed');
  assert.strictEqual(importedExternalMcp.exposure['oneshell-ai'], false, 'import should not auto-expose MCP to 1Shell AI');
  assert.match(scanRegistry.getServer('browser-tools').command, /BROWSER_TOKEN='?secret-token'? npx -y @example\/browser-mcp/);

  const importedGithub = scanService.importCapability('mcp', 'github');
  assert.strictEqual(importedGithub.source, 'managed');
  assert.strictEqual(importedGithub.exposure.codex, true, 'imported GitHub MCP should keep existing Codex exposure from native config');
  const exposedGithub = scanService.setExposure('mcp', 'github', 'codex', true);
  assert.strictEqual(exposedGithub.exposure.codex, true, 'existing native GitHub MCP should not require preset githubToken to expose to Codex');
  assert.ok(
    !scanService.listMcpCapabilities().some((item) => item.id === 'github' && item.source === 'preset'),
    'existing native GitHub MCP should not be duplicated as a preset row',
  );
  assert.ok(
    !scanService.listMcpCapabilities().find((item) => item.id === 'github').runtimeError,
    'existing native GitHub MCP should not surface a preset-token runtime error',
  );

  const importedSkill = scanService.importCapability('skill', 'refactor');
  assert.strictEqual(importedSkill.source, 'managed');
  assert.ok(fs.existsSync(path.join(scanDataDir, 'skills', 'refactor', 'SKILL.md')), 'imported Skill should be copied into 1Shell skills');

  console.log('host capability service tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
