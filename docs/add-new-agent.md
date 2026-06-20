# 给 1Shell 加一家新的 OpenAI 兼容 Agent

> 适用范围:任何 openai 协议兼容(chat completions 或 responses)且认证用 env var 或 config 文件的 CLI agent(如 opencode/openclaw/hermes 等)。**自成协议的家(claude/gemini)不走这条路**:claude 走 Agent SDK 引擎 adapter(见 4.3.1+),gemini 当前不支持。

## 它为什么是"零代码"

4.3 Sprint B 把 `src/agents/cli-sandbox.js` 里所有 per-cli `if/else` 上提为 manifest 字段。结果:**加一家新 agent 不用改 sandbox 代码,只在 `src/agents/cli-manifest.js` 里追加一份对象**。

校验靠 `scripts/test-cli-sandbox-zero-code-manifest.js`(`npm test` 一部分)。

## 加一家 agent 的步骤

### 1. 确认 agent 的可接入性(必须先做)

回答这三个问题:
- **协议**:它的 API 请求是 openai chat completions(`/v1/chat/completions`)、openai responses(`/v1/responses`)、还是别的?**只有前两种当前支持**。
- **base URL 重定向**:它认不认 `OPENAI_BASE_URL` 或同类 env var?(嫁接架构的命门 —— 它必须能被指向 1Shell proxy)
- **MCP 注册形式**:它的 config 文件里 MCP servers 配在哪个 JSON 路径?是 `mcp_servers.<name>` 还是 `mcp.<name>` 还是其它?

任何一条对不上,这条接入路径走不通。

### 2. 在 `cli-manifest.js` 里追加一份 manifest

参考已有的 `codex` / `opencode` 两份,字段含义如下:

```js
{
  // ── 元信息 ───────────────────────────────────────
  id: 'newagent',                            // 唯一 id,小写无空格
  name: 'New Agent',                         // 显示名
  icon: '◆',                                  // 单字符图标
  gradient: 'from-blue-500 to-purple-500',   // tailwind 渐变 class
  repo: 'org/newagent',
  description: '一句话介绍',
  binary: 'newagent',                        // 主可执行文件名
  binaries: ['newagent'],                    // 候选可执行文件名(扫描时按序找)
  versionArgs: ['--version'],
  install: {
    npmPackage: '@org/newagent',             // 走 npm 安装时填
    command: 'npm install -g @org/newagent', // 全局安装命令(信息展示用)
    docsUrl: 'https://...',
    hint: '安装提示',
  },
  supportedOS: ['windows', 'macos', 'linux'],
  clientProtocol: 'openai',                  // 'openai' | 'anthropic',决定 proxy 走哪条 handler
  supportedUpstream: ['openai', 'anthropic'],
  proxyPath: '/api/proxy/newagent',          // 1Shell proxy 给这家分配的路径前缀

  // ── 沙箱配置 ─────────────────────────────────────
  sandbox: {
    dirName: 'newagent',                     // 沙箱目录名(在 dataDir/cli-sandbox/<dirName>)
    configDirEnv: 'NEWAGENT_CONFIG_DIR',     // 该 CLI 用哪个 env 读 config 目录
    defaultConfigDir: '.newagent',           // 全局 config 目录名(也用于 deep-merge 读用户 config)
    // 可选:configSubDir — 若 CLI 用 XDG_CONFIG_HOME 这种通用 env,实际 config 在 <env>/<configSubDir>

    // ── MCP 传输 ──
    mcp: {
      transport: 'stdio-bridge',              // 'stdio-bridge' | 'sse'
      // transport='stdio-bridge' 时:
      stdioCommand: 'node',                   // 启动 MCP bridge 用的命令
      stdioBridgeScript: '../bin/1shell-mcp-stdio.js',  // 相对 dataDir 的 bridge 脚本路径
      // transport='sse' 不需要额外字段(用 SSE 连 1Shell 自己的 /mcp/sse)
    },

    // ── 沙箱里要生成的 config 文件 ──
    configFiles: [
      {
        name: 'auth.json',                    // 文件名
        mergeStrategy: 'overwrite',           // 'overwrite' | 'deep-merge' | 'template'
        overwriteBuilder: 'static',           // overwrite 时必填,见下方 builder 列表
        content: { NEWAGENT_API_KEY: 'sk-1shell-proxy' },  // static builder 用
      },
      {
        name: 'mcp.json',
        mergeStrategy: 'deep-merge',          // 把 1Shell 的 MCP entry 深度合进用户 config
        mergePointer: 'mcp_servers.1shell',   // MCP entry 在 JSON 里的路径
      },
      {
        name: 'config.toml',
        mergeStrategy: 'template',
        template: 'newagent-config',          // 要在 cli-sandbox.js 的 TEMPLATE_BUILDERS 里注册
      },
    ],

    // 可选 — ensure 完所有 config 后跑的钩子(如 sync skills)
    // postEnsureHooks: ['sync-claude-skills'],
  },

  // ── 启动时注入的 proxy env ──
  proxyEnv: {
    OPENAI_BASE_URL: '{serverUrl}/api/proxy/newagent/v1',  // {serverUrl} 自动替换
    OPENAI_API_KEY: 'sk-1shell-proxy',
  },

  launchArgs: [],                            // 启动命令的固定额外参数
  // 可选 — 动态 launch args builder(如 claude 的 --strict-mcp-config)
  // launchArgsBuilder: 'claude-mcp-args',
  extraEnv: {},
}
```

### 3. 内置 builder 列表

#### overwriteBuilder(给 `mergeStrategy: 'overwrite'` 的 config 文件用)

| builder | 行为 | 需要 configFile 上的额外字段 |
|---|---|---|
| `static` | 直接写 `configFile.content` 的对象 | `content: { ... }` |
| `env-overrides` | 写 `{ env: <渲染后的 overrideEnvKeys> }`,`{serverUrl}` 自动替换 | `overrideEnvKeys: { KEY: VALUE }` |
| `mcp-config` | 写 `{ <mcpServersKey>: { <mcpEntryName>: <buildMcpEntry(cliId)> } }` | `mcpServersKey`(默认 `mcpServers`)+ `mcpEntryName`(默认 `1shell`) |

#### template(给 `mergeStrategy: 'template'` 的 config 文件用)

每个 template 都是 `cli-sandbox.js` 里 `TEMPLATE_BUILDERS` 注册表中的一项,接 `(cliId, configFile, ctx)`,返回字符串内容。`ctx` 含 `cwd / active(active provider)/ serverOrigin`。

加新模板必须在 `TEMPLATE_BUILDERS` 里注册——**这是唯一需要碰 sandbox 代码的场景**,因为模板本质上是代码生成。但如果你的 CLI config 是 JSON,优先用 `overwrite + static`,纯数据。

#### launchArgsBuilder(可选)

`LAUNCH_ARGS_BUILDERS` 注册表,接 `(cliId, manifest, ctx)`,返回额外 args 数组。同 template 规则——能用 `manifest.launchArgs` 静态数组就别用 builder。

#### postEnsureHooks(可选)

`POST_ENSURE_HOOKS` 注册表,接 `(cliId)`,在 ensureSandbox 写完所有 config 文件后跑。用于副作用(如同步 skill 文件)。

### 4. 跑测试

```bash
npm test
```

`test-cli-sandbox-zero-code-manifest.js` 会断言"纯数据 manifest 走通 ensureSandbox";`test-cli-sandbox-snapshot.js` 会断言"三家现有 CLI 的沙箱 config 字节级不变"——你只是加新家、不动现有家,这条应该自动过。

### 5. 前端是否需要改

**不需要**。`getScanInfo()` 自动遍历 `getAllManifests()`,前端 `/cli-setup` 页扫描结果会自动多出你这家。Provider 配置(ProviderModal)按 `cliId` 复用,也无需改。

如果你的 agent 需要特殊 UI(如自定义图标动画、特殊 readiness 步骤),才需要前端配套——但这是 contrib 的可选增强,不是必需。

## 不适用这条路的情况

| 不适用 | 走哪条路 |
|---|---|
| 协议自成一套(anthropic / google generateContent / 自定义) | claude → Agent SDK adapter(4.3.1+);其它 → 当前不支持 |
| 认证用 OAuth(GitHub Copilot / ChatGPT 内置账户) | 4.3.x patch 看反馈 |
| 不认 `*_BASE_URL` 类 env var 重定向 | 接入路径走不通,放弃 |
| 需要 CLI 进程跑在远程 VPS 上 | 1Shell 的核心定位是 agentless(不在目标 VPS 装 agent),这条不会做 |

## 看看真实例子

- 最简单的:`opencode` —— 一个 deep-merge config 文件 + stdio-bridge MCP
- 含 template:`codex` —— 三个 config 文件、含 `codex-config-toml` 模板
- 含特殊 launchArgs:`claude-code` —— `claude-mcp-args` builder + `sync-claude-skills` 钩子(注:claude 在 4.3.1+ 会迁到 Agent SDK 引擎 adapter,这条接入路径作 fallback 保留)

## 维护承诺

只要你的 manifest 字段符合本文规范、`npm test` 全过,1Shell 主仓接受 PR。`cli-sandbox.js` 后续重构(4.3.1 引擎 adapter / 5.0 工作台骨架)会保证 manifest 接入路径的语义稳定。
