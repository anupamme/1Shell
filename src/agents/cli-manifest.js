'use strict';

const CLI_MANIFESTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '✦',
    gradient: 'from-orange-400 to-pink-500',
    repo: 'anthropics/claude-code',
    description: '将你的 OpenAI 兼容 API 或 Anthropic API 接入 Claude Code，无需修改本地配置。',
    binary: 'claude',
    binaries: ['claude'],
    versionArgs: ['--version'],
    install: {
      npmPackage: '@anthropic-ai/claude-code',
      command: 'npm install -g @anthropic-ai/claude-code',
      docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      hint: '未检测到时可点击一键安装；1Shell 会优先安装到自己的数据目录，避免 Linux/macOS sudo 权限问题。',
    },
    supportedOS: ['windows', 'macos', 'linux'],
    clientProtocol: 'anthropic',
    supportedUpstream: ['openai', 'anthropic'],
    proxyPath: '/api/proxy/claude',

    sandbox: {
      dirName: 'claude-code',
      configDirEnv: 'CLAUDE_CONFIG_DIR',
      defaultConfigDir: '.claude',
      configFiles: [
        {
          name: 'settings.json',
          mergeStrategy: 'overwrite',
          overrideEnvKeys: {
            ANTHROPIC_AUTH_TOKEN: 'sk-1shell-proxy',
            ANTHROPIC_BASE_URL: '{serverUrl}/api/proxy/claude',
            ANTHROPIC_API_KEY: 'sk-1shell-proxy',
          },
        },
        {
          name: 'config.json',
          mergeStrategy: 'overwrite',
        },
        {
          name: 'mcp-config.json',
          mergeStrategy: 'overwrite',
        },
      ],
    },

    proxyEnv: {
      ANTHROPIC_BASE_URL: '{serverUrl}/api/proxy/claude',
      ANTHROPIC_API_KEY: 'sk-1shell-proxy',
      ANTHROPIC_AUTH_TOKEN: 'sk-1shell-proxy',
    },

    launchArgs: [],
    extraEnv: { CLAUDE_CODE_ENTRYPOINT: '1shell-agent-panel' },
  },

  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    icon: '◎',
    gradient: 'from-slate-700 to-slate-900',
    repo: 'openai/codex',
    description: '将你的 OpenAI 兼容 API 或 Anthropic API 接入 Codex CLI，支持透传或协议转换。',
    binary: 'codex',
    binaries: ['codex'],
    versionArgs: ['--version'],
    install: {
      npmPackage: '@openai/codex',
      command: 'npm install -g @openai/codex',
      docsUrl: 'https://github.com/openai/codex',
      hint: '未检测到时可点击一键安装；1Shell 会优先安装到自己的数据目录，避免 Linux/macOS sudo 权限问题。',
    },
    supportedOS: ['windows', 'macos', 'linux'],
    clientProtocol: 'openai',
    supportedUpstream: ['openai', 'anthropic'],
    proxyPath: '/api/proxy/codex',

    sandbox: {
      dirName: 'codex',
      configDirEnv: 'CODEX_HOME',
      defaultConfigDir: '.codex',
      configFiles: [
        {
          name: 'config.toml',
          mergeStrategy: 'template',
        },
        {
          name: 'auth.json',
          mergeStrategy: 'overwrite',
        },
        {
          name: 'mcp.json',
          mergeStrategy: 'deep-merge',
          mergePointer: 'mcpServers.1shell',
        },
      ],
    },

    proxyEnv: {
      OPENAI_BASE_URL: '{serverUrl}/api/proxy/codex/v1',
      OPENAI_API_KEY: 'sk-1shell-proxy',
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
    description: '将你的 OpenAI 兼容 API 或 Anthropic API 接入 OpenCode，支持透传或协议转换。',
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
    supportedUpstream: ['openai', 'anthropic'],
    proxyPath: '/api/proxy/opencode',

    sandbox: {
      dirName: 'opencode',
      configDirEnv: 'XDG_CONFIG_HOME',
      configSubDir: 'opencode',
      defaultConfigDir: '.opencode',
      configFiles: [
        {
          name: 'config.json',
          mergeStrategy: 'deep-merge',
          mergePointer: 'mcp.1shell',
        },
      ],
    },

    proxyEnv: {
      OPENAI_BASE_URL: '{serverUrl}/api/proxy/opencode/v1',
      OPENAI_API_KEY: 'sk-1shell-proxy',
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
