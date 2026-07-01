'use strict';

const CLI_MANIFESTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '✦',
    gradient: 'from-orange-400 to-pink-500',
    repo: 'anthropics/claude-code',
    description: '将 Anthropic Messages 兼容 API 写入 Claude Code 原生配置，并注入 1Shell MCP。',
    binary: 'claude',
    binaries: ['claude'],
    versionArgs: ['--version'],
    install: {
      npmPackage: '@anthropic-ai/claude-code',
      command: 'npm install -g @anthropic-ai/claude-code',
      docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      hint: '未检测到时可点击一键安装；1Shell 会执行全局 npm 安装，也可手动安装后指定可执行文件路径。',
    },
    supportedOS: ['windows', 'macos', 'linux'],
    clientProtocol: 'anthropic',
    supportedUpstream: ['anthropic'],

    nativeConfig: {
      dirName: 'claude-code',
      defaultConfigDir: '.claude',
      mcp: { transport: 'sse' },
      configFiles: [
        {
          name: 'settings.json',
          mergeStrategy: 'overwrite',
          overwriteBuilder: 'claude-native-settings',
        },
        {
          name: 'config.json',
          mergeStrategy: 'overwrite',
          overwriteBuilder: 'claude-native-config',
        },
        {
          name: 'mcp-config.json',
          mergeStrategy: 'overwrite',
          overwriteBuilder: 'mcp-config',
          mcpServersKey: 'mcpServers',
          mcpEntryName: '1shell',
        },
      ],
    },

    launchArgs: [],
    launchArgsBuilder: 'claude-mcp-args',
    postEnsureHooks: ['sync-claude-skills'],
    extraEnv: { CLAUDE_CODE_ENTRYPOINT: '1shell-agent-panel' },
  },

  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    icon: '◎',
    gradient: 'from-slate-700 to-slate-900',
    repo: 'openai/codex',
    description: '将 OpenAI Responses 兼容 API 写入 Codex CLI 原生 config.toml。',
    binary: 'codex',
    binaries: ['codex'],
    versionArgs: ['--version'],
    install: {
      npmPackage: '@openai/codex',
      command: 'npm install -g @openai/codex',
      docsUrl: 'https://github.com/openai/codex',
      hint: '未检测到时可点击一键安装；1Shell 会执行全局 npm 安装，也可手动安装后指定可执行文件路径。',
    },
    supportedOS: ['windows', 'macos', 'linux'],
    clientProtocol: 'openai',
    supportedUpstream: ['openai'],

    nativeConfig: {
      dirName: 'codex',
      defaultConfigDir: '.codex',
      mcp: {
        transport: 'stdio-bridge',
        stdioCommand: 'node',
        stdioBridgeScript: '../bin/1shell-mcp-stdio.js',
      },
      configFiles: [
        {
          name: 'config.toml',
          mergeStrategy: 'template',
          template: 'codex-config-toml',
        },
        {
          name: 'mcp.json',
          mergeStrategy: 'deep-merge',
          mergePointer: 'mcpServers.1shell',
        },
      ],
    },

    launchArgs: [],
    extraEnv: {},
  },

  {
    id: 'opencode',
    name: 'OpenCode',
    icon: '▣',
    gradient: 'from-emerald-400 to-teal-500',
    repo: 'opencode-ai/opencode',
    description: 'OpenCode 原生配置接入，旧 proxy 网关已移除。',
    binary: 'opencode',
    binaries: ['opencode', 'opencode-ai', '/usr/lib/node_modules/opencode-ai/bin/opencode'],
    versionArgs: ['--version'],
    install: {
      npmPackage: 'opencode-ai',
      command: 'npm install -g opencode-ai',
      docsUrl: 'https://github.com/opencode-ai/opencode',
      hint: '未检测到时可点击一键安装；OpenCode 的命令名可能随版本变化，如扫描失败可手动选择实际可执行文件。',
    },
    supportedOS: ['windows', 'macos', 'linux'],
    clientProtocol: 'openai',
    supportedUpstream: ['openai'],

    nativeConfig: {
      dirName: 'opencode',
      configHome: 'xdg',
      configSubDir: 'opencode',
      defaultConfigDir: '.opencode',
      mcp: {
        transport: 'stdio-bridge',
        stdioCommand: 'node',
        stdioBridgeScript: '../bin/1shell-mcp-stdio.js',
      },
      configFiles: [
        {
          name: 'opencode.json',
          mergeStrategy: 'overwrite',
          overwriteBuilder: 'opencode-native-config',
        },
      ],
    },

    launchArgs: [],
    extraEnv: {},
  },
];

const UPSTREAM_LABELS = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
};

function getManifest(cliId) {
  return CLI_MANIFESTS.find(m => m.id === cliId) || null;
}

function getAllManifests() {
  return CLI_MANIFESTS;
}

module.exports = { CLI_MANIFESTS, UPSTREAM_LABELS, getManifest, getAllManifests };
