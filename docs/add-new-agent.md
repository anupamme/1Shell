# 给 1Shell 加一家新的 CLI Agent

> 4.7 起，新增 Claude Code / Codex / OpenCode 同类 Agent 的主链路是“写入该 CLI 的本机原生配置文件”，不是新增 `/api/proxy/<agent>` 网关，也不是把 CLI 指向 1Shell 自己的数据目录。

## 接入原则

新增 Agent 前先确认三件事：

- CLI 的真实配置文件路径，例如 `~/.codex/config.toml`、`~/.claude/settings.json`、`$XDG_CONFIG_HOME/opencode/opencode.json`。
- CLI 的模型/API 配置格式，优先照成熟工具和官方格式写，不自造字段。
- CLI 的 MCP 注册格式，能直接写配置文件就直接写配置文件。

1Shell 启动 Agent 时只做两件事：

- 解析真实 CLI 可执行文件路径，必要时允许用户手动指定。
- 写入或更新本机原生配置文件，并把 1Shell MCP entry 合进去。

不再新增这些东西：

- 不新增 Agent 专用 proxy 网关主链路。
- 不注入 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME` 把 CLI 重定向到 1Shell 数据目录。
- 不复制一套 CLI 安装目录或私有运行目录。

## manifest 字段

在 [src/agents/cli-manifest.js](/srv/mindfs-workspaces/1Shell/src/agents/cli-manifest.js) 追加 manifest。核心字段如下：

```js
{
  id: 'newagent',
  name: 'New Agent',
  binary: 'newagent',
  binaries: ['newagent'],
  versionArgs: ['--version'],
  install: {
    npmPackage: '@org/newagent',
    command: 'npm install -g @org/newagent',
    docsUrl: 'https://...',
    hint: '未检测到时可点击一键安装，也可手动指定可执行文件路径。',
  },
  clientProtocol: 'openai',
  supportedUpstream: ['openai'],
  nativeConfig: {
    defaultConfigDir: '.newagent',
    mcp: {
      transport: 'stdio-bridge',
      stdioCommand: 'node',
      stdioBridgeScript: '../bin/1shell-mcp-stdio.js',
    },
    configFiles: [
      {
        name: 'config.json',
        mergeStrategy: 'overwrite',
        overwriteBuilder: 'static',
        content: {},
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
}
```

如果 CLI 使用 XDG 配置目录，使用：

```js
nativeConfig: {
  configHome: 'xdg',
  configSubDir: 'newagent',
  defaultConfigDir: '.newagent',
  configFiles: [],
}
```

## 生成器

配置生成逻辑在 [src/agents/native-cli-config.js](/srv/mindfs-workspaces/1Shell/src/agents/native-cli-config.js)。

- `overwriteBuilder` 用于 JSON 对象生成。
- `template` 用于 TOML 或其它文本配置。
- `launchArgsBuilder` 只在 CLI 必须追加动态启动参数时使用。
- `postEnsureHooks` 只用于写完配置后的必要副作用，例如同步 Claude Code skills。

加新 Agent 时优先只改 manifest。只有当该 CLI 的配置格式需要代码生成时，才添加新的 builder。

## 验证

至少跑：

```bash
npm test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

新增 Agent 的测试要覆盖：

- 原生配置文件写入正确路径。
- 启动环境不注入 CLI 配置目录重定向变量。
- Agent provider 启动真实 CLI 可执行路径。
- 配置文件可预览、可手动编辑、可清除覆盖后重新生成。
