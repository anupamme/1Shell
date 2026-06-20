# 1Shell 4.3 计划(v3)— Agent 宿主化

> 状态:v3 主题已对齐,工程范围已选「完整」。本文是 4.3 开发的总体文档,**取代 v1/v2**——v2 的主题(Provider cc-switch 化)在 v3 里降为「地基」一节,真正的 4.3 主题是「让 1Shell 成为 cc/codex 的 IDE 宿主」。
> 制定日期:2026-06-21
> 关联文档(必读):
> - [oneshell-agent-core-rfc.md](./oneshell-agent-core-rfc.md) — agent 化主线 RFC,长期方向
> - [oneshell-ai-agentization-failure-retrospective.md](./oneshell-ai-agentization-failure-retrospective.md) — 失败复盘,守住的边界
> - [oneshell-4.3-plan.md](./oneshell-4.3-plan.md) — v2(2026-06-20),已被本文取代,作背景资料
> 本文是 v3。

---

## 1. 为什么要写 v3:v2 的几个核心假设被推翻

v1/v2 主题是「Agent Provider 管理 cc-switch 化」,把 4.3 定位成"做最好的第三方 agent 配置入口"。但 2026-06-21 与用户深谈、并把 1Shell 代码、claude Agent SDK / codex App Server 官方文档全部对照过后,以下假设需要修正:

### 1.1 v2 的错误假设

| v2 假设 | 真实情况 |
|---|---|
| postChangeSync(切 provider 后要重写 CLI config + 重启 PTY)是必做 P0 | **伪需求**。1Shell 的 CLI 沙箱永远连本地 proxy(`{serverUrl}/api/proxy/...`),proxy 每请求现取 active provider 并覆盖 `body.model`([proxy.routes.js:621](../src/routes/proxy.routes.js#L621) / [:668](../src/routes/proxy.routes.js#L668)),**切换对 CLI 物理无感**。cc-switch 必须 sync 是因为它直写 CLI config;1Shell 多了 proxy 中间层,这是架构红利不是要补的差距。 |
| 4.3 把第三方 agent 接入做到极致就是 1Shell 的护城河 | **不是护城河,是获客入口**。第三方 agent(claude/codex/opencode)有自己的大脑,1Shell 在三个面(下/旁/外)永远是"被调用方"。把宿主做得再舒服,agent 对 1Shell 仍是黑盒。真正的差异化只能来自"自有大脑(AgentRun)" 或者 "用宿主层接管 agent 的 IO 表面"。 |
| 接入更多 agent = 协议适配成本 N×N 爆炸 | **基本不成立**。绝大多数开源 agent 都是 openai 兼容协议(opencode/openclaw/hermes 等),自成协议的只有 anthropic(claude)和 google(gemini)。Gemini 失败是因为协议+认证范式不兼容,是例外不是常态。 |
| cc-switch 提供了完整产品参考(reasoning 档位/preset 字段/postChangeSync 都得做齐) | **cc-switch 解决的是 "改 CLI 配置文件" 这个本质问题**,reasoning/上下文/preset 都是这个本质的延伸。但 1Shell 是嫁接架构 + 受控运维平台,该借鉴的是「数据驱动的接入框架」而非「Tray 应用形态」。 |

### 1.2 v3 真正想清楚的事

**1Shell 在「接第三方 agent」这件事上,优势的本质是什么?**

不是"配置切换更方便"(cc-switch 比我们专精)、不是"多 VPS 运维"(MCP server 接给任何 agent 都有),而是:

> **1Shell 是 agent 的可嵌入宿主(IDE shell):用 cc/codex 官方提供的可嵌入接口(Claude Agent SDK / Codex App Server JSON-RPC),把 agent 当作可被 1Shell 完全套壳的执行引擎。**

类比:不是 VSCode 终端里跑 claude TUI,**是 VSCode 装 Claude Code 扩展那种"原生 UI + 全交互桥接"**——agent 还是原来的 agent,但用户看到的所有东西都由 1Shell 渲染、所有交互都经 1Shell 中转。

**这是 cc-switch / 配置切换器永远做不到的位置**,也是 1Shell 自有 AgentRun 之外、对第三方 agent 唯一能做出本质增量的位置。

---

## 2. 4.3 主题与三件事

**4.3 主题:Agent 宿主化(IDE 壳)**

三件事,按"地基 → 框架 → 上层"组织:

```
[上层] 第三件事:cc/codex 的 IDE 宿主壳
         用 Claude Agent SDK / Codex App Server JSON-RPC,
         自己渲染 timeline / diff / 审批 / 模式切换 UI
              ▲
              │ 依赖
              │
[框架] 第二件事:接入框架数据驱动化(manifest 化)
         cli-sandbox 里散落的 per-cli if/else 上提为 manifest 字段,
         openai 兼容 agent 加一家 = 填一份 manifest,零代码
              ▲
              │ 依赖
              │
[地基] 第一件事:Provider 网关做扎实(reasoning + preset + MCP preset)
         把 cc-switch 验证过的"配置友好"做齐,作为入口体验
         显式排除:postChangeSync / 全套 cc-switch 字段抄抄
```

**两类 agent 不同处置(关键定位)**:

| Agent | 接入路径 | 4.3 处置 |
|---|---|---|
| claude code | Claude Agent SDK(headless / ClaudeSDKClient,官方 TS+Py) | 走 IDE 宿主路径(第三件事) |
| codex | Codex App Server JSON-RPC(官方 stdio/WS,VSCode 扩展就用这个) | 走 IDE 宿主路径(第三件事),**4.3 重点优先做这家** |
| opencode / openclaw / hermes / 其他 openai 兼容开源 agent | 现状 PTY 沙箱 + 网关代管,加 manifest 即接入 | 走第二件事的轻接入路径 |

---

## 3. 5.0 远景(纲要,不变)

v3 这版本规划不动 5.0 愿景,只更新一处:**第三件事是 5.0 "agent+panel 一体化"的天然前置投资**——做出 IDE 宿主壳,意味着 1Shell 已经拥有 agent 的"渲染权 + 交互权 + 审批权",离 5.0 的 "panel 和 agent 共享 tool schema 单源" 只差 panel 那一条线。

```
4.3:把 cc/codex 装进 1Shell IDE 壳,渲染/审批/模式全接管
        ↓ 5.0 演进
5.0:同一 tool schema 同时驱动 UI panel / agent tool call / Harness / MCP / 测试
     => 自有 AgentRun + 第三方 agent 都跑在这个统一表面上
```

---

## 4. 第一件事:Provider 网关地基(2-3 周)

### 4.1 范围与不做

| 做 | 不做(对比 v2) |
|---|---|
| Provider preset 数据(国内 6 + 海外 4 + 中转 2,共 ~12 家)+ 添加表单接 preset 选择 | ❌ Per-CLI Binding(`cliBindings` map)—— 1Shell 不是 cc-switch,真实 env 注入在 cli-manifest 的 `proxyEnv`,preset 不需要嵌 cliBindings |
| Preset schema 关键字段:`id / name / apiBase / protocol / apiKeyField / models / reasoningModels / docsUrl` | ❌ `endpointCandidates / modelsUrl / requiresOAuth / templateValues`(过度设计,Sponsor 推广绑 preset 等) |
| reasoning_effort 字段:provider 配置可设 `auto / low / medium / high` | — |
| reasoning 注入策略 **双轨**:① CLI 自身配置可写的(codex `model_reasoning_effort` 写 config.toml,claude `permissionMode` 经 SDK 设)走 manifest;② 必须 API 注入的(provider→上游 thinking/reasoning_effort)走 proxy | ❌ v2 说"只在 proxy 注入"——claude 的 thinking 可以,但 codex 的 reasoning 通过 config.toml 设更对路 |
| MCP Server Preset 集合(8 个核心:fetch/time/memory/sequential-thinking/context7/filesystem/github/playwright) | ❌ 10 个全收(puppeteer 和 playwright 重叠、postgres 太具体先不收) |
| 快速切换 UI:`/agent` header 下拉 + provider 切换提示 | ❌ postChangeSync / 重启 PTY / cli-sandbox.resyncAfterProviderChange —— **架构上不需要** |
| `/model` slash 含 provider 段 | — |

### 4.2 reasoning 注入:双轨策略(v3 修正 v2)

**v2 错误**:把 reasoning 全塞 proxy 注入。

**v3 正确分轨**:

| 路径 | 适用场景 | 实现位置 |
|---|---|---|
| **轨 1 — manifest 配置写入** | codex 的 reasoning(写 `config.toml`)、claude 的 permissionMode(SDK options) | manifest 字段 + cli-sandbox 的 `renderTemplate` |
| **轨 2 — proxy 请求体注入** | 1Shell AI 自己的 reasoning(没 CLI 配置文件)、claude 的 thinking(API 请求体字段) | [proxy.routes.js:641 handleAnthropicClient](../src/routes/proxy.routes.js#L641) / `handleSkillsClient` 转发前 patch body |

**注入映射**:
- Anthropic 协议:`thinking: { type: 'enabled', budget_tokens: N }`,low=4000 / medium=16000 / high=64000
- OpenAI 协议:`reasoning_effort: 'low'|'medium'|'high'`(只对 o-series 等 reasoning model 注入)
- 非 reasoning model:跳过,按 preset 的 `reasoningModels` 字段判定

**注意**:proxy 当前已部分处理 thinking 块(粗暴合入文本,[proxy.routes.js:292](../src/routes/proxy.routes.js#L292)),v3 要顺手修正——thinking 块单独识别,不并入正文文本(否则前端 timeline 无法分开渲染)。

### 4.3 数据落点

```
新增:
  src/agents/provider-presets.js   provider preset 数据
  src/agents/mcp-presets.js        MCP preset 数据
  src/agents/reasoning.js          reasoning model 白名单 + 映射工具

修改:
  src/routes/proxy.routes.js       reasoning 注入(轨 2);thinking 块修正
  src/routes/agent-setup.routes.js Provider POST/PUT 接收 reasoning_effort 字段
  src/routes/mcp-registry.routes.js MCP preset "一键添加到 X CLI 沙箱" 接口
  src/agents/cli-sandbox.js        renderTemplate 含 reasoning(轨 1,codex config.toml)
                                    buildMcpEntry 支持 preset 数据源

前端:
  frontend/src/components/ProviderModal.vue  preset 选择器 + reasoning select
  frontend/src/views/AgentView.vue           header provider 切换下拉
  frontend/src/components/AgentToolsRail.vue MCP "Preset 库" 子 tab
  frontend/src/utils/agentSlashCommands.ts   /model 含 provider 段
```

### 4.4 Sprint(第一件事)

| 任务 | 估算 | 备注 |
|---|---|---|
| provider-presets.js + reasoning.js 数据 + 白名单 | S | 数据驱动 |
| mcp-presets.js 数据(8 个) | S | 数据驱动 |
| Provider POST/PUT 加 reasoning_effort | S | |
| proxy reasoning 注入(轨 2)+ thinking 块修正 | M | proxy.routes.js |
| cli-sandbox.renderTemplate 含 reasoning(轨 1, codex) | S | 顺手做 |
| MCP preset 一键添加到沙箱 | M | 后端 + 前端 |
| ProviderModal preset 选择器 + reasoning select | M | 前端通用组件,改一处全盘受益 |
| AgentView header provider 切换下拉 | S | |
| AgentToolsRail "Preset 库" 子 tab | M | |
| `/model` slash 含 provider 段 | S | |
| 单测 + 各 CLI 代理链路回归 | M | |
| CHANGELOG + README "AI 配置"节 | S | |

---

## 5. 第二件事:接入框架数据驱动化(manifest 化)(1-2 周)

### 5.1 为什么必须做

当前 [cli-sandbox.js](../src/agents/cli-sandbox.js) 里有一堆 per-cli 硬编码 if/else,加一家 agent 要回这些函数里塞分支:

- **`buildMcpEntry(cliId)`**([:151](../src/agents/cli-sandbox.js#L151)) — codex/opencode 走 stdio 桥接、claude 走 SSE,硬编码
- **`generateOverwriteContent`**([:486](../src/agents/cli-sandbox.js#L486)) — claude/codex 的 config 生成逻辑硬编码
- **`renderTemplate`**([:496](../src/agents/cli-sandbox.js#L496)) — codex `config.toml` 整段写死
- **`buildLaunchArgs`**([:410](../src/agents/cli-sandbox.js#L410)) — claude 专属 `--strict-mcp-config` / `--mcp-config` / `--append-system-prompt` 等

这些硬编码意味着:第三件事(IDE 宿主)以后要加新 engine adapter、第一件事(reasoning 双轨)要按 CLI 注入,**全要在这堆 if/else 里见缝插针**。先把它**提为 manifest 字段**,后面的事才能数据驱动地添加。

### 5.2 改造目标

| 当前(硬编码) | v3 目标(manifest 字段) |
|---|---|
| `if (cliId === 'codex' \|\| cliId === 'opencode')` 决定 MCP 传输类型 | manifest 的 `sandbox.mcp.transport: 'stdio-bridge' \| 'sse'` |
| `if (cliId === 'claude-code') buildClaudeConfigContent(...)` | manifest 的 `sandbox.configFiles[].overwriteBuilder: 'claude-settings' \| 'claude-mcp' \| 'codex-auth' \| ...` |
| `if (cliId === 'codex' && fileName === 'config.toml')` 整段模板写死 | manifest 的 `sandbox.configFiles[].template: <template-id>` + 在 manifest 里注册 template 模块 |
| `if (cliId === 'claude-code') args.push('--strict-mcp-config', ...)` | manifest 的 `launchArgsBuilder: <builder-id>` |

**关键约束**:**只迁移,不改语义**——manifest 字段值要保证生成出来的 config 文件**字节级别和现状一致**(否则现有沙箱破坏)。这是一次纯重构,不增能力。

### 5.3 验收标准

- ✅ 三家现有 CLI(claude/codex/opencode)的沙箱 config 文件字节级别不变
- ✅ `cli-sandbox.js` 中 `if (cliId === 'xxx')` 的分支数下降到 0(允许保留 helper 函数,但消费在 manifest 字段驱动)
- ✅ 新加一家 openai 兼容 agent 只需在 `cli-manifest.js` 填一份对象,**0 行 sandbox 代码改动**
- ✅ 跑通"加 openclaw"作为验证:在 cli-manifest 加一份 manifest,看是否能成功接入(不上传 release,作为内部验证)

### 5.4 Sprint(第二件事)

| 任务 | 估算 |
|---|---|
| 设计 manifest 扩展字段(mcp.transport / configFiles.template / launchArgsBuilder / overwriteBuilder) | S |
| 迁移 buildMcpEntry → manifest mcp.transport | S |
| 迁移 generateOverwriteContent → manifest overwriteBuilder + builder 注册表 | M |
| 迁移 renderTemplate → manifest template + template 注册表 | M |
| 迁移 buildLaunchArgs → manifest launchArgsBuilder | S |
| 字节级别一致性测试(三家 CLI sandbox dir diff) | M |
| 内部加 openclaw manifest 验证零代码改动 | S |
| 文档:contrib 如何加新 openai 兼容 agent | S |

---

## 6. 第三件事:cc/codex 的 IDE 宿主壳(4-6 周,4.3 核心)

### 6.1 是什么 / 不是什么

**是**:1Shell 用 cc/codex 的官方可嵌入接口驱动它们,自己渲染 timeline / diff / 审批 UI / 模式切换。agent 的全部交互能力(/compact /rewind /model /模式)保留,只是渲染层换成 1Shell 原生(类似 VSCode + Claude Code 扩展)。

**不是**:把 cc/codex 的 TUI 塞进右侧终端面板(那是现状 PTY 投影,已存在)、headless 跑掉 TUI(那牺牲交互、且 1Shell 要补一堆 SDK 没有的细节)。

### 6.2 官方协议背书(v3 已核实)

| 能力 | Claude Agent SDK | Codex App Server | 来源 |
|---|---|---|---|
| 多轮持续会话 | ✅ `ClaudeSDKClient` / `query + resume/continue` | ✅ `thread/start` / `thread/resume` / `turn/start` | [sdk](https://code.claude.com/docs/en/agent-sdk/sessions) / [app-server](https://developers.openai.com/codex/app-server) |
| 结构化事件流 | ✅ assistant/tool_use/tool_result/result | ✅ `item/agentMessage/delta` / `item/commandExecution/outputDelta` / `turn/diff/updated` / `item/reasoning/textDelta` | 同上 |
| 宿主接管审批 | ✅ `canUseTool` callback | ✅ `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`(server→client RPC) | 同上 |
| 运行时切模式 | ✅ `setPermissionMode()`(default/acceptEdits/plan/bypassPermissions/dontAsk/auto) | ✅ 每 turn 可设 `approvalPolicy`(never/unlessTrusted/onRequest) | [permissions](https://code.claude.com/docs/en/agent-sdk/permissions) |
| /rewind 等价 | ⚠️ 用 `fork_session` 或 sessions 文件做替代 | ✅ **`thread/rollback { threadId, numTurns }`** 官方原生 | |
| /compact 等价 | ⚠️ SDK 自动 compact,主动触发要靠 hooks 或 fork | ✅ **`thread/compact/start`** 官方原生 | |
| Hooks | ✅ PreToolUse / PostToolUse / Stop / SessionStart 等 | ✅ 通过 approval + `turn/*` 事件 | |

**关键事实(必须记住)**:
> OpenAI 自己评估并放弃了"codex 作 MCP server"路径,改用 App Server JSON-RPC。VSCode Codex 扩展就是用 App Server 实现的。
> —— [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)

这意味着 1Shell 现状用 codex MCP merge pointer 那套(cli-manifest 的 `mcpServers.1shell` / `mcp.1shell`)**是被官方淘汰的路径**,迁到 App Server 是正解。Claude SDK 同理是官方力推方向。

### 6.3 架构设计:Engine Adapter 抽象

```
┌──────────────────────────────────────────────────┐
│ 1Shell IDE Shell(前端原生 UI)                    │
│   timeline / diff / 审批卡 / 模式切换 / /slash 桥  │
└──────────────────────────────────────────────────┘
          ▲ 统一的 IDE 事件协议(1Shell 内部 socket)
          │ events:turn/started, item/*, requestApproval, ...
          │ commands:start, send, interrupt, rollback, compact, setMode, approve, ...
          ▼
┌──────────────────────────────────────────────────┐
│ Engine Adapter Registry(src/agents/engines/)     │
│  ┌─────────────────┐ ┌──────────────────────┐    │
│  │ ClaudeSDKAdapter│ │ CodexAppServerAdapter│    │
│  │ (Agent SDK)     │ │ (JSON-RPC stdio)     │    │
│  └─────────────────┘ └──────────────────────┘    │
│        ▲                        ▲                 │
│        │ 共享:provider 网关 / Harness / 1Shell MCP │
└──────────────────────────────────────────────────┘
```

**关键设计原则**:

1. **统一 IDE 事件协议**:前端不需要知道引擎是 claude 还是 codex,只对接 1Shell 内部协议(参考 RFC §6.5 TimelineEvent 模型)。两个 adapter 各自负责把官方协议翻译成统一协议。
2. **adapter 是薄翻译层**:不替模型规划、不重排事件顺序、不合成模型口吻(守住失败复盘的边界,RFC §3.2)。
3. **/rewind /compact 不对齐**:claude 原生不支持,1Shell 提供"fork + 提示用户"的备选实现,**前端 UI 上明确告知差异**——不要为了对齐而伪造能力(失败复盘第 3 条)。
4. **共享地基**:adapter 仍走第一件事的 Provider 网关 + 1Shell MCP server + Harness。agent 配置/key/工具能力自动复用。

### 6.4 4.3 落地范围(MVP)

**先做 codex,后做 claude**(理由):
- codex App Server 是为"宿主嵌入"专门设计的官方协议,边界清晰、参考实现明确(VSCode 扩展)
- /compact 和 /rewind 官方原生,UX 完整度高
- 做透 codex 后,claude SDK 适配是同形态,工程量减半

| MVP 必须支持 | 备注 |
|---|---|
| 启动 / 中断 / 续接 codex 会话 | `thread/start` `turn/interrupt` `thread/resume` |
| Timeline 渲染:user / assistant / tool_call(命令/文件)/ reasoning / diff | 对接 `turn/*` `item/*` 全套事件 |
| 审批卡:命令执行审批 + 文件变更审批 | `requestApproval` server→client RPC |
| 模式切换:`approvalPolicy` 在 UI 上有 dropdown | never / unlessTrusted / onRequest |
| `/compact` 按钮(触发 `thread/compact/start`) | UI 进度反馈用 `contextCompaction` item |
| `/rewind N` 按钮(触发 `thread/rollback`) | UI 上明确显示"已回退 N 轮"。**仅 codex 端**;claude 端按拍板 #6 不上 /rewind |
| Diff 视图 | `turn/diff/updated` 聚合 |
| 会话列表 + 继续(复用 4.2.4 已建的 ide_sessions v12) | `thread/list` + 1Shell 自己的会话表索引 codex thread |

**MVP 不做**(留到 4.3.1+):
- claude SDK adapter(放 4.3.1 patch,做透 codex 形态后照抄)
- 高阶能力:`thread/fork` 多分支可视化、`mcpServer/oauth/login` 桥接、`process/spawn`(实验性)、`config/*`(以后再做)
- /goal /host /mode 等 1Shell 自有 slash 在引擎 adapter 层的回路(那是 RFC Phase 1 的事)

### 6.5 数据落点

```
新增:
  src/agents/engines/index.js              engine adapter 注册表
  src/agents/engines/codex-app-server.js   Codex App Server JSON-RPC 客户端 + 翻译层
  src/agents/engines/types.js              统一 IDE 事件协议类型定义
  src/agents/engines/session-bridge.js     与 ide_sessions v12 表的桥接
  src/routes/engine.routes.js              前端 ↔ engine adapter 的 socket 路由

修改:
  src/agents/agent-pty.service.js          新增"engine 模式"分支(原 PTY 模式保留作为 fallback)
  src/agents/cli-sandbox.js                codex 走 app-server 时不再生成 config.toml 模板
  frontend/src/views/AgentView.vue         engine 模式下渲染 1Shell 原生 timeline,不再投影 PTY
  frontend/src/components/*                新增:CommandExecutionCard / FileChangeCard / 
                                            DiffViewer / ApprovalCard / ModeSwitch
```

### 6.6 Sprint(第三件事 — MVP 仅 codex)

| 任务 | 估算 |
|---|---|
| 调研:codex 二进制版本 + `--listen` 启动参数实测 | S |
| 设计统一 IDE 事件协议(types.js) | M |
| 实现 CodexAppServerAdapter:JSON-RPC 客户端 + 启动/关闭 | M |
| 翻译层:codex 事件 → 统一事件 | L |
| 翻译层:统一命令 → codex JSON-RPC | M |
| session-bridge:codex thread ↔ ide_sessions v12 | M |
| socket 路由 engine.routes.js | M |
| 前端 AgentView 引入 engine 模式(条件渲染) | M |
| 前端组件:CommandExecutionCard | M |
| 前端组件:FileChangeCard + DiffViewer | L |
| 前端组件:ApprovalCard(两类) | M |
| 前端组件:ModeSwitch + /compact + /rewind 按钮 | M |
| 单测:adapter 翻译层、事件流回归 | L |
| 端到端:开一个 codex 会话跑通一个真实任务 | M |
| 文档:engine adapter contributor guide | S |

---

## 7. 4.3 不做的事(对比 v2 扩充)

| 不做 | 理由 |
|---|---|
| postChangeSync(切 provider 后重写 config + 重启 PTY) | **架构上不需要**(见 §1.1) |
| Per-CLI Binding(cliBindings map) | 1Shell 不是 cc-switch,真实 env 在 cli-manifest 的 proxyEnv |
| endpointCandidates / 测速 | YAGNI,等用户反馈再加 |
| OAuth provider(github_copilot / codex_oauth)的认证流程 | codex app-server 有 ChatGPT auth 接口,但 4.3 不动 |
| Cloud Sync / Tray / Sponsor / i18n / 历史迁移 | 见 v2 §5,理由不变 |
| claude SDK adapter | 4.3.1 patch,先做透 codex |
| **OpenClaw / Hermes 单独接入** | manifest 数据驱动化(第二件事)做完后是"填数据"动作,内部验证后 4.3.x 看反馈再正式加 |
| **`thread/fork` 多分支可视化** | YAGNI,先看用户怎么用 rollback |
| **1Shell 自有 slash(/goal /host /mode)在 engine adapter 层的回路** | RFC Phase 1 的事,不在 4.3 |
| **gemini-cli** | google generateContent 协议自成一套,且认证范式不兼容嫁接(env 重定向不干净),保持失败状态不重启 |

---

## 8. 拍板记录(2026-06-21)

| # | 项 | 拍板 |
|---|---|---|
| 1 | 4.3 主题 | ✅ Agent 宿主化(IDE 壳) |
| 2 | 工程范围 | ✅ 完整(三件事都做) |
| 3 | 发版节奏 | ✅ **4.3.0** 出第一+第二件事(2-4 周);**4.3.1** 出第三件事 codex MVP(4-6 周);**4.3.2** 看反馈出 claude adapter |
| 4 | 第三件事 MVP 优先级 | ✅ 先 codex(app-server 协议明确)后 claude |
| 5 | engine 模式与现状 PTY 模式关系 | ✅ **共存,engine 默认 + PTY 作逃生开关**——adapter 出问题/版本不兼容/用户偏好可一键回退 |
| 6 | /rewind on claude | ✅ **claude 先不上 /rewind**——不伪装能力,UI 上 codex 有按钮、claude 无,保持各自语义诚实(契合失败复盘第 3 条 + RFC §3.2) |
| 7 | reasoning 双轨策略 | ✅ codex 走 config.toml(轨 1)+ claude/1Shell-AI 走 proxy 注入(轨 2) |
| 8 | manifest 贡献文档 | ✅ 作为第二件事验收的一部分,4.3.0 一起出 |

**剩余待对齐(可在开发中再敲定,不阻塞 4.3.0 开干)**:
- Provider preset 具体 12 家:DeepSeek/Kimi/智谱GLM/通义Qwen/豆包/MiniMax + OpenAI/Anthropic/OpenRouter/Groq + OneAPI/NewAPI 模板,待写 provider-presets.js 时确认
- MCP preset 具体 8 个:fetch/time/memory/sequential-thinking/context7/filesystem/github/playwright,待写 mcp-presets.js 时确认

---

## 8.1 Sprint 编排(基于拍板)

按 §8 #3 节奏拆,每个版本独立可发:

### 4.3.0 — Provider 网关地基 + manifest 数据驱动化(2-4 周)

**目标**:把"配置友好"做齐 + 把接入框架的债还掉。发版后 GitHub 有节奏交付,且为 4.3.1 IDE 宿主铺好地基(不在硬编码上叠新东西)。

**Sprint A(并行) — Provider 网关**:
1. `provider-presets.js` + `mcp-presets.js` + `reasoning.js` 数据文件
2. proxy reasoning 注入(轨 2)+ thinking 块修正
3. Provider POST/PUT 加 `reasoning_effort` 字段
4. MCP preset "一键添加到 X CLI 沙箱" 后端接口
5. ProviderModal 加 preset 选择器 + reasoning select(改一处全盘受益)
6. AgentView header provider 切换下拉
7. AgentToolsRail "Preset 库" 子 tab
8. `/model` slash 含 provider 段
9. 单测 + 各 CLI 代理链路回归

**Sprint B(并行) — manifest 数据驱动化**:
1. 设计 manifest 扩展字段(`mcp.transport` / `configFiles.template` / `launchArgsBuilder` / `overwriteBuilder`)
2. 迁移 `buildMcpEntry` / `generateOverwriteContent` / `renderTemplate` / `buildLaunchArgs` 为 manifest 字段驱动
3. 字节级别一致性测试(三家 CLI sandbox dir diff)
4. cli-sandbox.renderTemplate 含 reasoning(轨 1,codex `model_reasoning_effort`)— 在新框架上加,不在旧硬编码上叠
5. 内部加 openclaw manifest 验证零代码改动
6. **第三方 agent 贡献文档**(contrib 怎么加新 openai 兼容 agent,作为验收的一部分,§8 拍板 #8)

**两 Sprint 互依赖关系**:Sprint B 是 Sprint A 第 4 步(MCP 一键添加)和后续 4.3.1 的前置——动 manifest 字段的代码路径要先稳。所以 Sprint B 优先级排第一(开 4.3.0 时先 1 周冲 Sprint B,然后并行)。

### 4.3.1 — Codex IDE 宿主 MVP(4-6 周)

**目标**:codex 走 App Server JSON-RPC,1Shell 自己渲染 timeline / diff / 审批,/compact /rewind 等命令通过 UI 按钮触发。codex MCP merge pointer 路径作为 fallback 保留。

**前置依赖**:4.3.0 必须先发(manifest 框架就绪 + Provider 网关地基稳定)

**Sprint(线性)**:
1. **调研周** — codex 二进制 `--listen` 实测、版本兼容性验证、schema 拉取与版本绑定方案
2. **协议层** — `engines/types.js` 统一 IDE 事件协议、`engines/codex-app-server.js` JSON-RPC 客户端、翻译层(codex 事件↔统一事件、统一命令↔JSON-RPC)
3. **会话桥** — `session-bridge.js`(codex thread ↔ ide_sessions v12)
4. **路由层** — `engine.routes.js` socket 路由 + agent-pty.service 新增 engine 模式分支(共存 PTY,按拍板 #5)
5. **前端组件** — CommandExecutionCard / FileChangeCard / DiffViewer / ApprovalCard / ModeSwitch / CompactButton / RewindButton
6. **AgentView 双路渲染** — engine 模式渲染原生 timeline,PTY 模式保留作逃生通道(设置项里有开关)
7. **端到端验证** — 跑通真实运维任务(VPS 部署/排查)+ 回归测试

### 4.3.2 — Claude SDK adapter(4-6 周,看 4.3.1 反馈再开)

**前置**:4.3.1 上线后跑两周,收用户反馈、定 codex 形态稳。

**主要工作**:
1. `engines/claude-sdk.js` adapter(基于 Claude Agent SDK TS 包,`ClaudeSDKClient` + `setPermissionMode` + canUseTool callback + Hooks)
2. 翻译层:claude 事件 ↔ 统一事件
3. 复用 4.3.1 全部前端组件(因为类型走统一协议,理论上前端零改动)
4. /compact 端口:Hooks + 自动 compact 触发
5. **不上 /rewind**(按拍板 #6),前端按钮按 engine 类型条件渲染

### 之后看反馈(4.3.x patch / 4.4)

- openclaw / hermes 正式接入(manifest 填数据)
- claude /compact 的体验改进
- thread/fork 多分支可视化
- engine adapter 给 1Shell 自有 slash 提回路(/goal /host /mode)

---

## 9. 关键文件参考

```
后端:
  src/routes/proxy.routes.js                       reasoning 注入(轨 2)+ thinking 块修正
  src/routes/agent-setup.routes.js                  Provider 加 reasoning_effort 字段
  src/routes/mcp-registry.routes.js                 MCP preset 一键添加
  src/routes/engine.routes.js                       ★ 新:前端 ↔ engine adapter
  src/agents/cli-manifest.js                        manifest 扩展字段
  src/agents/cli-sandbox.js                         消除 per-cli if,reasoning 轨 1 注入
  src/agents/provider-presets.js                    ★ 新:provider preset 数据
  src/agents/mcp-presets.js                         ★ 新:MCP preset 数据
  src/agents/reasoning.js                           ★ 新:reasoning 白名单/映射
  src/agents/engines/index.js                       ★ 新:engine adapter 注册表
  src/agents/engines/codex-app-server.js            ★ 新:Codex App Server adapter
  src/agents/engines/types.js                       ★ 新:统一 IDE 事件协议
  src/agents/engines/session-bridge.js              ★ 新:thread ↔ ide_sessions
  src/agents/agent-pty.service.js                   engine 模式分支
  
前端:
  frontend/src/views/AgentView.vue                  header provider 切换 + engine 模式渲染
  frontend/src/components/ProviderModal.vue         preset 选择器 + reasoning select(改一处全盘受益)
  frontend/src/components/AgentToolsRail.vue        MCP "Preset 库" 子 tab
  frontend/src/utils/agentSlashCommands.ts          /model 含 provider 段
  frontend/src/components/engine/*                  ★ 新:统一 timeline / diff / 审批组件
```

---

## 10. 风险登记

- **R1 — codex app-server 协议版本对齐风险**:codex 迭代很快,JSON-RPC schema 会变。**缓解**:用 `--schema-typescript` / `--schema-json` 生成版本绑定的 schema;adapter 启动时做 `initialize` 握手版本检查;codex 版本不兼容时降级到 PTY 模式 + 提示用户。
- **R2 — claude SDK API 变动风险**:Agent SDK 还在迭代(v3 写作时 ClaudeSDKClient 的 V2 session API 已被弃用)。**缓解**:adapter 锁版本,文档明示支持版本范围,新版升级走专门验证流程。
- **R3 — /compact /rewind 在 claude 端的能力缺口**:用 fork_session 模拟会引入"分支"心智,和 codex 的"线性回退"语义不一致。**缓解**:UI 明确告知差异,不假装一致;给两边各自定义文案。
- **R4 — engine 模式 + PTY 模式共存复杂度**:两套渲染路径前端要分支处理。**缓解**:abstract 层提早做(types.js 统一);PTY 模式作为"逃生通道"不演进 UI,只保持可用。
- **R5 — Provider preset 维护负担**:外部 provider 改 endpoint/模型列表。**缓解**:preset 只做"自动填",模型列表运行时拉 `/v1/models`(已有)。
- **R6 — MCP preset 安全风险**:一键安装外部 npm 包有供应链风险。**缓解**:只收官方 `@modelcontextprotocol/*` 和明确背书的;描述里标"会运行 X 包,首次启用前请审阅";默认 disabled。
- **R7 — manifest 数据驱动化破坏现有 CLI 沙箱**:迁移中字节级一致性出错,用户现有沙箱失效。**缓解**:迁移前/后跑 sandbox dir diff 测试;不一致时 abort 部署;dev/test 环境先验证至少一周。
- **R8 — 4.3 周期过长开源线停滞**:第三件事 4-6 周,加上前两件可能 6-10 周。**缓解**:按 §8 项 8 拆 4.3.0 / 4.3.1 / 4.3.2 滚动发版,每个里程碑独立可发,GitHub 持续有动作。

---

## 11. 决策记录(WHY,新增)

- **为什么 v3 推翻 v2 的"Provider cc-switch 化"主题**:这几轮深谈把 1Shell 的真实定位想清楚了——它是嫁接架构的 agent 宿主,优势在"中间层接管"而非"配置切换"。继续做 v2 主题等于把别人的强项当自己的差异化,做得再好也是 "cc-switch++"。
- **为什么不做 postChangeSync**:架构上不需要(§1.1)。
- **为什么 reasoning 走双轨而非纯 proxy 注入**:codex 在 config.toml 里设 reasoning 更符合它自身的设计(也省 proxy 加工);1Shell AI 没 CLI config,只能走 proxy。
- **为什么先 codex 后 claude**:codex App Server 是为宿主嵌入设计的官方协议、参考实现(VSCode)清晰,且 /compact /rewind 原生支持,体验完整度高。做透 codex 后 claude adapter 是同形态。
- **为什么 manifest 数据驱动化要在 4.3 做**:它是第三件事和后续扩展(opencode 长尾)的共同地基,推迟会让第三件事的 adapter 注册/路由设计被现状 if/else 污染。
- **为什么不在 4.3 做 claude SDK adapter**:见 §6.4;codex 做透后再开 claude 收益更高、风险更低。
- **为什么不做 gemini 的接入**:协议+认证范式不兼容嫁接架构,且接入成本和潜在用户盘子不匹配。
- **为什么发版节奏选「完整」而非「克制」**:用户拍板。理解是这次 4.3 要把 1Shell 在"第三方 agent 宿主"这件事上的差异化做出来,小步发版会让差异化迟到。

---

## 12. 与 v2 的差异对照(供历史检索)

| 维度 | v2 | v3 |
|---|---|---|
| 主题 | Agent Provider 管理 cc-switch 化 | **Agent 宿主化(IDE 壳)** |
| Provider 网关 | 主菜 | 地基(第一件事) |
| postChangeSync | P0 必做 | 不做(架构不需要) |
| Per-CLI cliBindings | 必做 | 不做 |
| reasoning 注入 | proxy 单轨 | proxy + manifest 双轨 |
| MCP Preset | P0(10 个全收) | P0(8 个核心) |
| opencode/openclaw/hermes | 和 cc/codex 同等处置 | 走轻接入(第二件事) |
| **IDE 宿主壳** | 未提 | **核心(第三件事)** |
| **manifest 数据驱动化** | 未提 | **第二件事,必做** |
| Sprint 总量 | 2-4 周(估算) | 6-10 周(完整范围) |

---

## 附录 A:技术参考链接

- [Codex App Server — OpenAI Developers](https://developers.openai.com/codex/app-server)
- [Unlocking the Codex harness — OpenAI](https://openai.com/index/unlocking-the-codex-harness/)
- [Claude Agent SDK · Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK · Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK · Headless](https://code.claude.com/docs/en/agent-sdk/headless)
- [Codex App-Server JSON-RPC Protocol Reference](https://codex.danielvaughan.com/2026/03/28/codex-app-server-json-rpc-protocol/)
