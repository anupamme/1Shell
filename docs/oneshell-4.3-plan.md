# 1Shell 4.3 → 5.0 路线规划

> 状态:方向已对齐,4.3 范围已细化,**已并入 cc-switch 对照后的修订(2026-06-20 二版)**。本文是 4.3 开发的总体文档,同时纲要式记录 5.0 远景,作为后续窗口接手的依据。
> 制定日期:2026-06-20 初版 / 2026-06-20 修订(并入 cc-switch 源码对照结论)
> 关联文档:
> - [oneshell-agent-core-rfc.md](./oneshell-agent-core-rfc.md) — agent 化主线 RFC,长期方向不变
> - [oneshell-ai-agentization-failure-retrospective.md](./oneshell-ai-agentization-failure-retrospective.md) — 历史失败复盘,守住的边界
> - 本文 — 4.3 落地方案 + 5.0 远景纲要

---

## 1. 背景

### 1.1 4.2 发布回顾

4.2 是 1Shell 从"WebSSH + 程序化工作流面板"收敛为"人和 Agent 共用的本地优先运维 runtime"的底盘版本:重构 1Shell AI 默认产品路径、引入 AgentRun/IDE Agent、删 Program/Studio 重型工作流、agent-runtime 砍掉 ~3600 行死代码、补齐文件管理写操作、登录 2FA、Harness 安全边界、Skill 渐进式披露、桌面版自动更新、服务端在线更新面板。

**发布反馈定位题**:4.2 价值是底盘性的,开源用户感知偏弱。市场更关心"接入 Claude Code 之类第三方 agent"这种立刻能上手的能力。这不是质量问题,是叙事问题——4.2 的故事讲给了"未来 1Shell 自己是 agent",但当下用户要的是"现在我手里的 Claude Code 怎么用得更顺"。

### 1.2 两条产品线

- **开源社区线**(GitHub `weidu12123/1Shell`):主版本号、CHANGELOG、Release 走这条。面向个人开发者/小团队/Homelab。本文 4.3 计划主要服务这条线。
- **软件杯 + 麒麟 OS 线**(安全运维智能 agent):4.2 agent 化的真实驱动力。这条线推进中,与开源线**共享同一份代码**,通过配置/打包/默认值/UI 主题在外层分化,**不在 `src/` 内分叉**。

**两条线的关系**:开源线节奏要快、要持续有动作;比赛线节奏走里程碑。两边复用底层 agent 内核、Harness、MCP、AgentRun——任何一条线的工程投资都同时滋养另一条。

### 1.3 5.0 愿景:agent + panel 一体化

5.0 是一个"工作台一体化"的飞跃版本号,核心命题:

> **agent 的工具就是可视化面板;面板的功能就是 agent 的能力。**
> 同一份 tool schema → UI 渲染 / agent 调用 / Harness 审批 / MCP 暴露 / 测试验证。
> 人和多个 agent 共用同一张工作台,操作不分人/AI 来源,状态视图一致。

这个命题已经在 RFC 5.2 节("Tool Surface")写过技术骨架,5.0 是把它推到产品语言层面。

**对照同期类目**:

| 类目 | 代表 | 短板 |
|---|---|---|
| panel 类 | 1Panel / 宝塔 / aapanel | UI 强,AI 后塞、零散 |
| agent 类 | Claude Code / Codex / OpenCode | agent 强,运维场景没原生面板 |
| WebSSH 类 | Tabby / NextTerminal | 终端强,既没面板也没 agent |
| **1Shell 5.0 目标** | — | **三件事一起做,且共享单源 tool schema** |

### 1.4 关于"轻量"——产品原则(新增,不松)

5.0 后 1Shell 在 LOC 和能力丰富度上**已经不再轻量**,这是结构性事实(agent-runtime 4900+ 行、proxy.routes 1184 行、ide.service ~3000 行、多服务模块、SQLite v12+、CLI 沙箱多家、桌面端 + 服务端两套打包)。

但 README 第 24 行写的"面向个人开发者、小团队和**轻量运维场景**"不松——1Shell 的轻量从来是**用户认知轻量**,不是后端代码轻量。

**守则**(任何阶段做产品决策时必须对照):

1. 用户进来一眼看到的应该是"**一张 agent 工作台 + 几个高频操作面板**",不是 1Panel/宝塔那种 50 个菜单的"运维超市"
2. RFC 3.4 节"工具可以可视,但不能变成用户配置负担"——同一份 tool schema 可以可视化,但用户不应该被要求"先配 50 个工具开关再用 1Shell"
3. 新功能加进来之前问:"用户日常会用到这件事吗?如果不是高频,是不是应该藏在 agent 工具层而非作为面板入口?"
4. cc-switch 模式(把所有 provider/MCP 配置作为头等公民铺在 UI)对它本身合理,对 1Shell **不全部适合**——1Shell 是工作台,配置是工作台的后台

---

## 2. 5.0 远景路线图

5.0 不在 4.3 内交付,但 4.3 要为它"形状先行",避免做与远景冲突的局部决策。

```
Phase A — 工作台骨架(最大工程,5.0 核心)
  └─ 终端重构 + IDE 界面合并(本质是同一件事)
      目标:不铺功能,定下"消息总线 + 单一状态视图"骨架
      探索题:理想终端形态尚未明确(用户自述)

Phase B — agent 接入提质(中等工程,价值立刻感知)
  ├─ cc-switch 风格 Provider 管理(★ 已立 4.3)
  ├─ Claude Code 体验做透(MCP 自动/多主机/审批/可观察)
  ├─ Codex / OpenCode 体验对齐
  └─ /model /mode /goal /host 等 slash 命令真生效

Phase C — panel 一体化(中等工程,做透 1-2 个验证形态)
  └─ SSL+反代 站点  或  端口/防火墙  选一个
      按"tool schema 单源 → UI/agent/MCP 都用"做穿
      不铺面板数量,避免变成宝塔仿品

Phase D — 生态扩展(小工程,顺手做)
  ├─ OpenClaw / Hermes manifest 加一条(★ 已立 4.3.x)
  ├─ MCP 接入总控台(4.3 §4.6 MCP Preset 集合的演进)
  └─ panel 功能按需补
```

**节奏建议**:

| 版本 | 主题 | 周期感 |
|---|---|---|
| 4.3 | Agent Provider 管理 cc-switch 化 + MCP Preset 集合 + 二家适配 | 短(2-4 周) |
| 4.4(可选) | 单个 panel 雏形(SSL/端口) — 探路 Tool Surface 单源 | 中 |
| 4.5(可选) | agent 体验天花板(Claude Code MCP 自动注册 + 多主机) | 中 |
| 5.0 | 工作台骨架 + 全家桶 + 至少 2 个 panel 做穿 | 长 |

**警告**:5.0 工程量大,如果 4.x 一直憋着不发,GitHub 那边会显得停滞。4.3 必须发,4.4/4.5 是可选缓冲。

---

## 3. 4.3 主题:Agent Provider 管理 cc-switch 化

### 3.1 为什么是这个主题

- **用户立刻感知**:加 API key、切模型、调思考深度——这是任何用第三方 agent 的人每天都做的事
- **拿水花,对开源线友好**:cc-switch 当前是中文圈热门工具,1Shell 把这套体验"内嵌进运维平台"是天然的故事
- **不影响 5.0 主线**:这件事是 Phase B 的子集,做完直接进入下一阶段;不会和 5.0 工作台骨架冲突
- **现有底盘已经吃了 70% 的活**:见 §3.2

### 3.2 1Shell 现状盘点(探索结论)

| 能力 | 现状 | 文件位置 |
|---|---|---|
| Provider CRUD + activate API | ✅ 已就绪 | [src/routes/agent-setup.routes.js:21-25](../src/routes/agent-setup.routes.js#L21-L25) |
| 协议转换 openai↔anthropic 双向 | ✅ 已就绪(1184 行) | [src/routes/proxy.routes.js](../src/routes/proxy.routes.js) |
| 沙箱化第三方 CLI(三家) | ✅ 已就绪 | [src/agents/cli-manifest.js](../src/agents/cli-manifest.js) |
| 沙箱配置同步(config 文件覆写) | ✅ 已就绪 | [src/agents/claude-config-sync.js](../src/agents/claude-config-sync.js) |
| `getActiveProvider(cliId)` 接口 | ✅ 已用 | [src/services/ai.service.js:77](../src/services/ai.service.js#L77) |
| MCP server 注册 | ✅ 已有(待复用) | [src/routes/mcp-registry.routes.js](../src/routes/mcp-registry.routes.js) |
| Provider preset 预置库 | ❌ 缺 | — |
| Per-CLI Binding(同 provider 在不同 CLI 下的 env 不同) | ❌ 缺 | — |
| reasoning_effort 字段与注入 | ❌ 缺 | — |
| postChangeSync(切换后同步沙箱 config) | ❌ 缺 | — |
| 快速切换 UI(dropdown / quick switch) | ❌ 缺(只有 settings 列表) | — |
| MCP Server Preset 集合 | ❌ 缺 | — |
| OpenClaw / Hermes manifest | ❌ 缺 | — |

**结论**:后端"多 provider + 协议转换"已经吃透,4.3 的工作量在 **前端 UX + 注入策略 + 预置数据 + 切换同步**,后端只需在 reasoning_effort + postChangeSync 两条加注入/同步逻辑。

### 3.3 cc-switch 真实形态(2026-06-20 校准)

初版本节描述 cc-switch 是"Tauri 桌面 GUI 配置切换器"——**这低估了它**。深读源码后真实形态:

**cc-switch 是 7 家 AI 工具 config-as-code 统一管理器**:

| 维度 | 实质 |
|---|---|
| 模块划分 | 每家 CLI 独立 Rust 模块(`claude_*.rs / codex_*.rs / gemini_*.rs / hermes_*.rs`)+ 各自 MCP / Plugin / Desktop 子模块 |
| Preset 字段 | 远不止 apiBase/key:含 `apiKeyField`(AUTH_TOKEN vs API_KEY)、`apiFormat`(anthropic / openai_chat / openai_responses / gemini_native 四种 format 转换)、`endpointCandidates`(地址候选列表,可测速)、`templateValues`(模板变量)、`providerType`(github_copilot / codex_oauth)、`requiresOAuth`、`modelsUrl`(覆写) |
| MCP Preset | fetch / time / memory / sequential-thinking / context7 等一键收录,跨平台 npx 处理 |
| postChangeSync | 切完调 `settingsApi.syncCurrentProvidersLive` **把配置写回 CLI 的 live config 文件**,体验丝滑 |
| 商业层 | partner / primePartner / promotion 字段,sponsor 推广绑在 preset 数据里 |
| 其他 | i18n(4 语言)、自启动、deeplink、Codex 历史迁移、Claude Desktop GUI 接入 |

借鉴方向**没变**:把"agent 配置体验"做到不输 cc-switch,**不复制它的桌面工具形态**。

### 3.4 1Shell vs cc-switch 定位差(关键)

cc-switch 只管"我用哪家 API"。1Shell 管"哪些 VPS + 哪个 agent + 哪家 API + 用什么 MCP 工具"。

更关键的方向差异:

```
cc-switch:                       1Shell:
  MCP 客户端                       MCP server(对外暴露多机能力)
  配置管理者                      + MCP 客户端配置管理者(借鉴 cc-switch)
                                  + 内嵌 agent + 协议转换 + 多 VPS

  方向:把客户端配置管好          方向:既做客户端配置管好,
                                       又把自己变成被外部 agent 使用的能力面
```

**这就是 4.3 要做 MCP Server Preset 集合的根本原因**(见 §4.6)——任何单机配置工具都做不到"既管 MCP 客户端,又自己是 MCP server",这是 1Shell 在 agent 生态里独有的位置。

### 3.5 cc-switch 三档差距速查(新增)

| 档位 | 功能 | 处置 |
|---|---|---|
| **必加 P0** | Preset 字段扩展(apiKeyField / apiFormat / endpointCandidates / modelsUrl) | 进 4.3.0 §4.1 |
| **必加 P0** | Per-CLI Binding(同 provider 在不同 CLI 下的 env 不同) | 进 4.3.0 §4.1 |
| **必加 P0** | postChangeSync 等价物(切换后同步沙箱 config) | 进 4.3.0 §4.3 |
| **必加 P0** | MCP Server Preset 集合(8-12 个常用 MCP 一键收) | 进 4.3.0 §4.6 |
| **后期 P1** | 使用量统计与展示 | 4.3.x / 4.4 |
| **后期 P1** | endpoint 候选 + 测速 | 4.3.x / 4.4 |
| **后期 P1** | OAuth(github_copilot / codex_oauth) | 4.3.x / 4.4 |
| **后期 P1** | Claude Desktop GUI 接入 | 4.4 / 5.0 |
| **后期 P1** | Codex 配置 TOML 解析 | 5.0(若 reasoning_effort 需写进 config.toml) |
| **不做** | Cloud Sync / Tray / Sponsor 推广 UI / 分布式 Session Manager / 多语言 i18n | 见 §5 |

---

## 4. 4.3 范围

### 4.1 A. Provider Preset 预置库(扩展)

**目标**:用户选 "DeepSeek" → apiBase 自动填好 → 只剩 key 要填。

**修订(并入 cc-switch 对照)**:

Preset schema 不是只有 apiBase/protocol/models,要补 cc-switch 验证过的关键字段。**Preset 数据按 provider 维度组织,每个 provider 含 `cliBindings` map 描述在各 CLI 下的环境变量**——比 cc-switch 七套独立 preset 文件更紧凑。

在 [src/agents/cli-manifest.js](../src/agents/cli-manifest.js) 同级新建 `provider-presets.js`,导出 `PROVIDER_PRESETS` 数组:

```js
{
  id: 'deepseek',
  name: 'DeepSeek',
  apiBase: 'https://api.deepseek.com',
  protocol: 'openai',                        // 上游协议
  apiKeyField: 'OPENAI_API_KEY',             // 该 provider 的 key 字段名(cc-switch 验证过差异:Claude 用 AUTH_TOKEN 或 API_KEY)
  apiFormat: 'openai_chat',                  // openai_chat / openai_responses / anthropic / gemini_native
  models: ['deepseek-chat', 'deepseek-reasoner'],
  modelsUrl: null,                           // 覆写 /v1/models 的 URL,null 走默认
  reasoningModels: ['deepseek-reasoner'],
  endpointCandidates: ['https://api.deepseek.com'],  // 候选地址,可测速(P1)
  requiresOAuth: false,                      // 预留:github_copilot / codex_oauth
  docsUrl: 'https://platform.deepseek.com/api-docs',
  // 关键:每家 CLI 下的环境变量映射
  cliBindings: {
    'claude-code':   { env: { ANTHROPIC_BASE_URL: '{apiBase}', ANTHROPIC_API_KEY: '{key}' } },
    'codex':         { env: { OPENAI_BASE_URL: '{apiBase}/v1', OPENAI_API_KEY: '{key}' } },
    'opencode':      { env: { OPENAI_BASE_URL: '{apiBase}/v1', OPENAI_API_KEY: '{key}' } },
    '1shell-ai':     { env: { OPENAI_API_BASE: '{apiBase}', OPENAI_API_KEY: '{key}' } },
    // openclaw/hermes 待 4.3.1 信息齐全后补
  },
}
```

**Preset 范围**(初版,~12 家,待对齐 §8):

| 国内 | 海外 | 中转模板 |
|---|---|---|
| DeepSeek | OpenAI 官方 | One-API 模板(自填 base) |
| Kimi (Moonshot) | Anthropic 官方 | New-API 模板(自填 base) |
| 智谱 GLM | OpenRouter | — |
| 通义 Qwen (DashScope) | Groq | — |
| 字节豆包 (火山引擎) | xAI Grok | — |
| MiniMax | — | — |

**前端 UX**:Provider 添加表单 = 「选 preset」→ 自动填 apiBase/protocol/apiKeyField/apiFormat/models → 填 key → 保存。也保留"自定义"路径,完全手填。

### 4.2 B. Reasoning Effort 档位

**目标**:Provider 配置可设"思考程度",发请求时按上游协议自动注入,reasoning model 才生效。

**Schema**:

Provider 配置加字段:
```js
reasoning_effort: 'low' | 'medium' | 'high' | 'auto'
// auto = 不强制,模型自己决定;其他档位由 proxy 按上游协议映射
```

**注入策略**(在 [src/routes/proxy.routes.js](../src/routes/proxy.routes.js) 转换层):

| 上游协议 | 注入字段 | 映射 |
|---|---|---|
| Anthropic | `thinking: { type: 'enabled', budget_tokens: N }` | low=4000 / medium=16000 / high=64000 |
| OpenAI(reasoning model) | `reasoning_effort: 'low'\|'medium'\|'high'` 或 `reasoning: { effort }` | 直接传字符串 |
| 非 reasoning model | 跳过注入 | — |

**Reasoning model 白名单**(初版):

```
openai:    gpt-5*, o1*, o3*, o4-mini*
anthropic: claude-3.7-sonnet*, claude-opus-4*, claude-sonnet-4*, claude-fable-5*
deepseek:  deepseek-reasoner*
其他:      暂跳过(按 preset 的 reasoningModels 字段判定)
```

**前端 UX**:Provider 配置卡片加一个 select:**自动 / 低 / 中 / 高**,带提示"仅对支持思考的模型生效"。

### 4.3 C. 快速切换 UX + postChangeSync(扩展)

**目标**:agent 工作台 header 一键切 active provider,**切换后正在跑的沙箱 CLI 立即能用新 provider,不要求用户手动重启(或最少手动操作)**。

**落地分两层**:

**层 1:active 状态切换**(已有 `PUT /api/agent/providers/:cliId/:pid/activate` 后端)
- `/agent` 页面 header 加 Provider 下拉:列出当前 CLI 的所有 provider + 高亮 active + 一键设 activate
- 1Shell AI 自己用的 active provider 切换无需重启(proxy 路由读 `getActiveProvider` 每次都新鲜)

**层 2:postChangeSync 等价物(新增)**——切换后:
1. 调 `syncSandboxConfig(cliId)` 重写沙箱 config 文件(env 注入新 provider 的 apiBase/key)
2. 如果该 CLI 正在 PTY 沙箱里跑,触发"温和重启"提示——大多数 CLI(Claude Code/Codex)切 provider 要重启进程才生效,这是 CLI 限制不是 1Shell 能绕过
3. 提供"立即重启"按钮 + 设置项"自动重启 PTY"开关
4. UI 明确反馈:"已切换到 X,运行中的 CLI 实例已同步配置(或:请点击重启使生效)"

**落地点参考**:
- [src/agents/cli-sandbox.js](../src/agents/cli-sandbox.js) — 已有沙箱机制,补 `syncSandboxConfig(cliId)` 入口
- [src/agents/agent-pty.service.js](../src/agents/agent-pty.service.js) — PTY 重启 + 广播事件
- [src/agents/claude-config-sync.js](../src/agents/claude-config-sync.js) — config 覆写机制已就绪,扩到 sync API 即可

### 4.4 D. OpenClaw + Hermes Agent 适配

**信息已知**:
- **OpenClaw** (`openclaw/openclaw`,openclaw.ai) — TypeScript,"Personal AI Assistant. The lobster way 🦞",定位日常使用(非开发专精)
- **Hermes Agent** (`NousResearch/hermes-agent`,hermes-agent.nousresearch.com) — Python,"The agent that grows with you"

**还需做的探查**(在动工前先完成):

1. 这两家的 **CLI 命令名**(binary name)
2. **config 文件路径与协议**(决定沙箱配置覆写策略)
3. **API/认证机制**:用 env var 还是 config 字段,字段名是什么
4. **MCP 支持**:是否原生支持 MCP server 注册
5. **是否支持 OpenAI-compatible / Anthropic-compatible 协议**

**落地**(信息齐全后):
- [src/agents/cli-manifest.js](../src/agents/cli-manifest.js) 增加两条 manifest(参考现有三家结构)
- 必要时新增 sandbox config sync adapter
- [src/routes/proxy.routes.js](../src/routes/proxy.routes.js) 加对应路由(`/api/proxy/openclaw` / `/api/proxy/hermes`)
- 前端 sandbox 扫描/安装/启动 UI 自动覆盖
- provider preset 的 `cliBindings` 补两家的 env 映射

**优先级**:4.3.0 必做 A/B/C/F;OpenClaw/Hermes 放 **4.3.1 patch**(信息未齐时慢一步更稳)。

### 4.5 E. /model slash 改造

**目标**:`/model` 不仅切 model,也露出"切 provider"路径。

**落地**:
- `/model` 子菜单分两段:**当前 provider 的可用 models** + **切其他 provider**
- 复用 4.3-C 的切换接口(同时触发 postChangeSync)
- 主控 1Shell AI 浮窗、独立 `/agent`、Panel 三处都更新(4.2.4 已统一基础设施,这里追加 provider 段)

**优先级**:4.3.0 可做,工程量不大;若紧张可后置到 4.3.x。

### 4.6 F. MCP Server Preset 集合(新增,与 5.0 愿景对接)

**目标**:1Shell 收录常用 MCP server 作 preset,前端给"一键添加到 Claude Code / Codex / OpenCode 的沙箱 MCP 配置"按钮。

**为什么是 P0**(不能拖到 5.0):

1. **战略地位关键**:cc-switch 已经验证用户买账(常用 MCP 一键添加),但它**只做客户端 MCP 配置管理**;1Shell 既是 MCP server(给外部 agent 用)又能管 MCP 客户端,这是任何单机工具做不到的位置
2. **5.0 "MCP 接入总控台"的天然地基**:今天做 preset 集合,5.0 直接演进为"MCP 接入面板",路径自然
3. **现有基础设施已部分就绪**:[src/routes/mcp-registry.routes.js](../src/routes/mcp-registry.routes.js) 后端基础有,cli-manifest 沙箱 mcp 配置 mergePointer 也有,主要工作在数据 + 前端 UX

**Preset 收录范围(初版 8-10 个,待对齐 §8)**:

| MCP Server | 类型 | 启动 |
|---|---|---|
| Fetch(网页抓取) | stdio | uvx `mcp-server-fetch` |
| Time | stdio | npx `@modelcontextprotocol/server-time` |
| Memory(知识图) | stdio | npx `@modelcontextprotocol/server-memory` |
| Sequential Thinking | stdio | npx `@modelcontextprotocol/server-sequential-thinking` |
| Context7(文档查询) | stdio/sse | context7 官方 |
| Filesystem(本地) | stdio | npx `@modelcontextprotocol/server-filesystem` |
| GitHub | stdio | npx `@modelcontextprotocol/server-github`(需 GH token) |
| PostgreSQL | stdio | npx `@modelcontextprotocol/server-postgres` |
| Playwright | stdio | playwright 官方 |
| Puppeteer | stdio | npx `@modelcontextprotocol/server-puppeteer` |

**Schema**(参考 cc-switch [mcpPresets.ts](https://github.com/farion1231/cc-switch/blob/main/src/config/mcpPresets.ts)):

```js
{
  id: 'fetch',
  name: 'mcp-server-fetch',
  tags: ['stdio', 'http', 'web'],
  description: '网页抓取与转 markdown',
  server: {
    type: 'stdio',
    command: 'uvx',                  // Windows 下自动包成 cmd /c uvx
    args: ['mcp-server-fetch'],
  },
  homepage: 'https://github.com/modelcontextprotocol/servers',
  docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
}
```

**跨平台**:Windows 下 npx/uvx 自动包 `cmd /c <command>` 包装(cc-switch 的做法)。

**前端 UX**:
- [frontend/src/components/AgentToolsRail.vue](../frontend/src/components/AgentToolsRail.vue) MCP tab 新增 "Preset 库" 子 tab
- 每个 preset 卡片:名字 + 标签 + 描述 + "添加到 ..." 下拉(选 CLI)
- 添加 = 在该 CLI 沙箱 MCP 配置里 deep-merge 一段 preset.server,默认 disabled,用户去 MCP 面板里开启

**1Shell 自己的 MCP server 始终在所有 CLI 中默认列出**(已有 cli-manifest 的 mergePointer `mcpServers.1shell` / `mcp.1shell`)——这是 1Shell 比 cc-switch 强的位置,不变。

---

## 5. 明确不做的事(扩充)

| 不做 | 理由 |
|---|---|
| Cloud Sync(Dropbox/iCloud/WebDAV) | 1Shell 是 self-hosted 服务端,本身就是统一存储 |
| Tray 桌面应用 + 自启动 | 1Shell 是 Web/桌面 SPA,不是配置切换工具 |
| 重写协议转换层 | 现有 [proxy.routes.js](../src/routes/proxy.routes.js) 1184 行已完整 |
| 在 `/agent` 之外的页面铺 Provider 管理入口 | 设置页 + agent header 两处足够;铺多了变面板配置负担,违反 §1.4 守则 |
| 给"每条对话/每个 run"做独立 provider override | 暂时复杂,需要时再加;4.3 只做 active provider 全局生效 |
| OpenClaw/Hermes 的细节适配(MCP 注入等深度) | 信息未齐;4.3.x 视探查结果决定深度 |
| **Sponsor / 合作伙伴推广绑进 preset 数据**(新) | cc-switch 这条对它合理(商业模式),1Shell 走开源路子;商业合作可以另设地方,不污染 provider 数据 |
| **分布式 Session Manager**(扫本地 CLI 会话文件)(新) | 1Shell 已有中心化 `ide_sessions` v12,自己跑 agent 直接落库,不需要扫别人家文件 |
| **多语言 i18n**(英/日/德)(新) | 中文为主,英文化是产品节奏问题不是 cc-switch 抄的事;若做要走专门版本规划 |
| **Codex 历史迁移**(新) | 1Shell 不发布过 Codex 的旧版集成,没有迁移负担 |

---

## 6. Sprint 拆解(扩展)

### 4.3.0(必做)

| 任务 | 估算 | 依赖 |
|---|---|---|
| Preset 数据 + `provider-presets.js`(含 cliBindings) | M | 无 |
| **Preset schema 字段扩展**(apiKeyField/apiFormat/endpointCandidates/modelsUrl)(新) | S | 无 |
| Provider 添加 UI 接 preset 选择 | M | 上面两项 |
| reasoning_effort 字段 schema + 持久化 | S | 无 |
| proxy 注入 thinking/reasoning_effort | M | 上一项 + 白名单数据 |
| Reasoning model 白名单常量 | S | 无 |
| `/agent` header Provider 切换 dropdown | M | 后端 activate API 已有 |
| **postChangeSync 等价物**:syncSandboxConfig + PTY 重启提示(新) | M | sandbox/PTY 改造 |
| 设置页 Provider 列表卡片加 reasoning select | S | reasoning 字段就绪 |
| **MCP Server Preset 数据 + `mcp-presets.js`**(新) | S | 无 |
| **MCP Preset 一键添加 UI + 后端 merge 到沙箱 MCP 配置**(新) | M | mcp-registry/cli-sandbox 基础设施 |
| /model slash 含 provider 段 | S | 切换接口就绪 |
| 回归测试(各 CLI 的代理链路通) | M | 全部 |
| 文档(CHANGELOG + README "AI 配置"节) | S | 全部 |

### 4.3.x(增量发版,Patch)

| 任务 | 说明 |
|---|---|
| OpenClaw manifest + 沙箱 + 代理 | 需先完成探查 |
| Hermes manifest + 沙箱 + 代理 | 需先完成探查 |
| 使用量统计(token 计数 + UI 展示) | 后期 P1 |
| Endpoint 候选 + 测速 | 后期 P1 |
| OAuth 支持(github_copilot/codex_oauth) | 后期 P1 |
| MCP Preset 集合扩充(社区反馈驱动) | 按需 |
| 更多 provider preset(社区反馈驱动) | 按需 |

---

## 7. 关键文件参考(给接手窗口的快速定位,扩展)

```
后端:
  src/agents/cli-manifest.js              三家 CLI manifest,preset 模块同级
  src/agents/cli-sandbox.js               沙箱扫描/安装/启动 + postChangeSync 落地点(新增 syncSandboxConfig)
  src/agents/agent-pty.service.js         CLI PTY 接入 + 重启广播
  src/agents/claude-config-sync.js        config 覆写策略(扩到 sync API)
  src/agents/provider-presets.js          ★ 新增:provider preset 数据(含 cliBindings)
  src/agents/mcp-presets.js               ★ 新增:MCP server preset 数据
  src/routes/agent-setup.routes.js        Provider CRUD + activate(L21-25 已就绪)
  src/routes/proxy.routes.js              1184 行,reasoning_effort 注入在这里加
  src/routes/mcp-registry.routes.js       MCP server 注册(preset 一键添加落地点)
  src/services/ai.service.js              1Shell AI 自己用 active provider 的入口

前端:
  frontend/src/views/AgentView.vue        /agent 页面,加 header Provider 切换
  frontend/src/views/SettingsView.vue     "AI 配置" tab,Provider 表单 + reasoning select
  frontend/src/components/AgentToolsRail.vue  Tools 面板,加 "MCP Preset 库" 子 tab

数据:
  src/agents/provider-presets.js          provider preset(国内 6 + 海外 5 + 中转 2)
  src/agents/mcp-presets.js               MCP preset(8-10 个常用)
  reasoning model 白名单常量(放在 provider-presets.js 内或独立)

测试:
  scripts/ 下加:
    - reasoning 注入的单测和代理链路冒烟
    - preset cliBindings 渲染单测(deepseek → claude-code env 输出)
    - MCP preset 一键添加的沙箱 config merge 单测
    - postChangeSync 切换后沙箱 config 内容变化的断言
```

---

## 8. 待对齐项(用户拍板,更新)

| # | 项 | 当前提案 | 状态 |
|---|---|---|---|
| 1 | Provider preset 范围 | 国内 6 + 海外 5 + 中转模板 2,共 ~13 家 | ❓ 是否砍到主流 5-6 家 |
| 2 | Reasoning 档位映射 | Anthropic budget_tokens 4k/16k/64k;OpenAI 直接 effort 字符串 | ❓ OK / 需调 |
| 3 | OpenClaw + Hermes 放 4.3.0 还是 4.3.1 | 4.3.1 patch(信息未齐) | ❓ |
| 4 | 快速切换 dropdown 范围 | 仅 `/agent` header(全局浮窗后置) | ❓ |
| 5 | 4.3 是否含 `/model` slash 改造 | 含(已纳 Sprint) | ❓ |
| 6 | 4.4/4.5 是否设置 | 可选缓冲版本 | ❓ |
| 7 | **MCP Preset 收录范围**(新) | 10 个(fetch/time/memory/sequential-thinking/context7/filesystem/github/postgres/playwright/puppeteer) | ❓ 哪些必收 / 哪些先不放 |
| 8 | **postChangeSync 重启策略**(新) | 默认提示用户手动重启,提供"自动重启 PTY"开关 | ❓ 默认开 or 默认关 |
| 9 | **Per-CLI Binding 数据组织**(新) | provider 维度 + cliBindings map(单一文件比 cc-switch 七套独立文件紧凑) | ❓ OK |
| 10 | **Preset schema 字段补**(apiKeyField/apiFormat/endpointCandidates/modelsUrl)(新) | 全收(预留 endpointCandidates 测速到 P1) | ❓ OK |

---

## 9. 5.0 探索预备(本文最后一节,留预埋)

4.3 做的事不能挡 5.0 的路。两件 5.0 探索题先写下来,避免 4.3 期间做出与远景冲突的局部决策:

### 9.1 终端 + IDE 界面合并(理想形态待探索)

**用户自述**:理想终端长什么样还不清楚,需要后续探索。

**已知方向**:
- 现状是 xterm 跑 PTY、CLI 沙箱跑在终端里、agent 在另一个面板,**三者独立、无消息总线**
- 5.0 要的是"消息总线 + 单一状态视图":agent 动作 → 终端可见;终端命令 → agent 可见;文件/面板状态 → agent timeline 可见
- 这件事和 Cursor / Zed / Windsurf 把 agent 装进编辑器壳是同一个范式,运维场景需要重新设计

**4.3 期间不动 xterm**,避免给 5.0 探索铺垫错误的局部架构。

### 9.2 Tool Surface schema 单源(panel + agent 一体化的核心)

**RFC 5.2 节已写技术骨架**:
```
同一个 tool schema
  -> agent 可调用
  -> Harness 可审批
  -> UI 可渲染
  -> MCP 可暴露
  -> 测试可验证
```

5.0 Phase C 选一个 panel 功能(SSL+反代 或 端口/防火墙)做"穿透实践"——证明这条路可行后再铺。

**4.3 期间避免做的事**:不要做"前端独立按钮 + 后端独立 API"的 panel 功能,否则到 5.0 要返工。如果 4.3 之后有 panel 雏形(4.4 可选),从一开始就按 Tool Surface 单源做。

### 9.3 MCP 接入总控台(由 4.3 §4.6 演进)

4.3 §4.6 MCP Server Preset 集合是"按钮 + 数据"。5.0 进一步:
- preset 一键添加 + 收录 + 评分 + 安全标记 + 跨 CLI 同步
- 1Shell 作为"MCP 接入总控台":让用户管所有外部 agent 用哪些 MCP,集中可见
- 1Shell 自己的 MCP server 是其中一员,但对外部 agent 一视同仁
- 这是 1Shell 在 agent 生态里**独有**的位置,要稳步做大

---

## 附录 A:决策记录(WHY)

- **4.3 不做 Cloud Sync**:1Shell 自己就是服务端,配置本来就集中存,Cloud Sync 是 cc-switch 作为本地工具的补丁,我们不需要这个补丁。
- **4.3 不在 src/ 分叉开源线与比赛线**:两条线共享代码可以保证开源线持续有动作就同时滋养比赛线;分叉了维护成本指数级上升,且会让"开源线"变成开源版本号但实质性内容停滞。
- **OpenClaw/Hermes 不抢 4.3.0**:这两家信息未齐,manifest 化的好处就是后期加成本低;先把 Claude Code 体验做到天花板,再复制给其他家,比同时铺 5 家都做半成品强。
- **5.0 不分 4.x 小步铺**:5.0 是工作台骨架重构,需要整片土地;4.x 散步式补功能(panel/agent 提质)是可选缓冲,不替代 5.0 飞跃。
- **agent + panel 一体化的核心是 schema 单源,不是 UI 拼接**:如果先把 panel 当独立产品做,再"加 AI 按钮",就是宝塔模式的复制,差异化丢失。
- **4.3 不做 Sponsor / 合作伙伴推广绑 preset**(新增):cc-switch 把 sponsor 字段绑在 preset 数据里有它的商业模式合理性;1Shell 走开源路子,商业合作可以另设地方,不污染 provider 数据(也防止用户感受到"是在被推销")。
- **4.3 不做分布式 Session Manager**(新增):1Shell 已有中心化 `ide_sessions` v12,扫别人家 CLI 的 session 文件再合并是 cc-switch 的补丁,我们不需要这个补丁。
- **4.3 不做多语言 i18n**(新增):是产品节奏问题(用户群当前以中文为主),不是 cc-switch 抄的事,做要走专门规划。
- **MCP Preset 集合 P0 而非 P1**(新增):因为它是 5.0 "MCP 接入总控台"的天然地基,且 cc-switch 这件事只做客户端而 1Shell 既是 server 又是客户端管理者,这是独有位置,不能让 cc-switch 在客户端那边把这个心智先占了。
- **Per-CLI Binding 用 cliBindings map 而非每 CLI 一套独立 preset 文件**(新增):cc-switch 七套独立 preset 文件是 TypeScript 项目自然选择;1Shell 用 provider 维度 + cliBindings 紧凑得多,维护成本更低,且对 1Shell AI 自己也无缝。
- **认知轻量原则不松**(新增,见 §1.4):5.0 后代码不再轻,但用户认知必须保持"一张工作台 + 几个高频面板",不变成宝塔/cc-switch 那种"配置超市"。

## 附录 B:风险登记

- **R1 — 4.x 版本号通胀**:4.3、4.4、4.5 都发会让 5.0 显得遥远。**缓解**:4.4/4.5 可选,如果 4.3 之后直接奔 5.0 也合理。
- **R2 — Provider preset 维护负担**:外部 provider 改 endpoint/模型列表,preset 会过时。**缓解**:preset 只做"自动填",不做"模型清单的真理来源";模型列表运行时通过 `/v1/models` 拉取(已有 [src/services/ai.service.js](../src/services/ai.service.js))。
- **R3 — reasoning_effort 跨模型兼容**:不同 reasoning model 字段名有差异(thinking vs reasoning vs reasoning_effort)。**缓解**:白名单 + 按模型分支注入,失败降级为不注入。
- **R4 — OpenClaw / Hermes 接入风险**:这两家相对新,命令名/config 协议可能不稳定。**缓解**:放 4.3.1 patch,信息齐全后再做。
- **R5 — MCP Preset 维护风险**(新):MCP server 包名/启动参数会变,preset 过时。**缓解**:同 R2,preset 只做"安装与启动模板",运行时让 CLI 自己读 MCP server 的 capabilities;描述用户场景不绑死实现细节。
- **R6 — postChangeSync 重启体验断层**(新):大多数 CLI(Claude Code/Codex)切 provider 要重启进程才生效,这是 CLI 限制不是 1Shell 能绕过。**缓解**:UI 明确提示 + 自动重启选项 + 重启后续接原会话(若 PTY 协议支持);并在 release notes 解释清楚为什么这样。
- **R7 — MCP Preset 安全风险**(新):一键安装外部 MCP server 等于运行外部 npm/uvx 包,有供应链风险。**缓解**:preset 只收官方 `@modelcontextprotocol/*` 和有明确背书的;描述里标"会在沙箱内运行 X 包,首次启用前请审阅";不自动启用,默认 disabled,用户手动开启。

## 附录 C:cc-switch 关键对照速查

(快速查阅,详见 §3.3-3.5 + §5)

```
✅ 借鉴并 P0 加入 4.3.0:
   Preset 字段扩展(apiKeyField/apiFormat/endpointCandidates/modelsUrl)
   Per-CLI Binding(cliBindings map)
   postChangeSync 等价物(切换后同步沙箱 + PTY 重启)
   MCP Server Preset 集合(8-10 个常用 MCP 一键添加)

✅ 借鉴但放 P1(4.3.x / 4.4):
   使用量统计与展示
   Endpoint 候选 + 测速
   OAuth(github_copilot / codex_oauth)
   Claude Desktop GUI 接入
   Codex TOML 解析

❌ 不做(理由见 §5):
   Cloud Sync(Dropbox/iCloud/WebDAV)
   Tray app + 自启动
   Sponsor / 合作伙伴推广 UI
   分布式 Session Manager
   多语言 i18n(4 语言)
   Codex 历史迁移

🛡️ 1Shell 比 cc-switch 强的位置(要保住):
   协议转换 1184 行(双向 openai↔anthropic 完整流式)
   多 VPS 受控运维(cc-switch 完全没有)
   Harness 安全边界 + 审批 + 审计
   内嵌 1Shell AI + agent timeline + 中心化会话历史
   作为 MCP server 暴露给外部 agent
   Web/服务端架构(非单机桌面工具)
```
