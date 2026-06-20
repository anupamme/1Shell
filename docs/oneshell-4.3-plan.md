# 1Shell 4.3 → 5.0 路线规划

> 状态:方向已对齐,4.3 范围进入细化阶段。本文是 4.3 开发的总体文档,同时纲要式记录 5.0 远景,作为后续窗口接手的依据。
> 制定日期:2026-06-20
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
  └─ panel 功能按需补
```

**节奏建议**:

| 版本 | 主题 | 周期感 |
|---|---|---|
| 4.3 | Agent Provider 管理 cc-switch 化 + 二家适配 | 短(2-4 周) |
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
| Provider preset 预置库 | ❌ 缺 | — |
| reasoning_effort 字段与注入 | ❌ 缺 | — |
| 快速切换 UI(dropdown / quick switch) | ❌ 缺(只有 settings 列表) | — |
| OpenClaw / Hermes manifest | ❌ 缺 | — |

**结论**:后端"多 provider + 协议转换"已经吃透,4.3 的工作量在 **前端 UX + 注入策略 + 预置数据**,后端只需在 reasoning_effort 那条加注入逻辑。

### 3.3 cc-switch 真实定位

cc-switch(`farion1231/cc-switch`,ccswitch.io)是 Tauri 桌面 GUI 工具:

- 描述:*"cross-platform desktop All-in-One assistant for Claude Code, Codex, OpenCode, **OpenClaw**, Gemini CLI & **Hermes Agent**"*
- 卖点:System Tray 快速切换 / Cloud Sync(Dropbox/OneDrive/iCloud/WebDAV) / 50+ provider preset
- **核心价值是"配置管理 UX",不是"协议转换"——这块 1Shell 反而更强**

### 3.4 1Shell vs cc-switch 定位差

cc-switch 只管"我用哪家 API"。1Shell 管"哪些 VPS + 哪个 agent + 哪家 API + 用什么 MCP 工具"。

**4.3 借鉴方向**:把"agent 配置体验"做到不输 cc-switch,**而不是复制它**。1Shell 不需要:
- ❌ Cloud Sync(自己就是 self-hosted 服务端,本身就是统一存储)
- ❌ Tray app(是 Web/桌面 SPA,不是托盘工具)
- ❌ 重写协议转换(自己的更完整)

---

## 4. 4.3 范围

### 4.1 A. Provider Preset 预置库

**目标**:用户选 "DeepSeek" → apiBase 自动填好 → 只剩 key 要填。

**落地**:

在 [src/agents/cli-manifest.js](../src/agents/cli-manifest.js) 同级或新建 `provider-presets.js`,导出 `PROVIDER_PRESETS` 数组:

```js
{
  id: 'deepseek',
  name: 'DeepSeek',
  apiBase: 'https://api.deepseek.com',
  protocol: 'openai',                    // 上游协议
  models: ['deepseek-chat', 'deepseek-reasoner'],
  reasoningModels: ['deepseek-reasoner'], // 该 preset 下哪些是 reasoning model
  docsUrl: 'https://platform.deepseek.com/api-docs',
  requiresKey: true,
  supportedCliIds: ['claude-code', 'codex', 'opencode', '1shell-ai'], // 哪些 CLI 适用
}
```

**Preset 范围**(初版,待对齐第 8 节):

| 国内 | 海外 | 中转模板 |
|---|---|---|
| DeepSeek | OpenAI 官方 | One-API 模板(自填 base) |
| Kimi (Moonshot) | Anthropic 官方 | New-API 模板(自填 base) |
| 智谱 GLM | OpenRouter | — |
| 通义 Qwen (DashScope) | Groq | — |
| 字节豆包 (火山引擎) | xAI Grok | — |
| MiniMax | — | — |

**前端 UX**:Provider 添加表单 = 「选 preset」→ 自动填 apiBase/protocol/models → 填 key → 保存。也保留"自定义"路径,完全手填。

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

### 4.3 C. 快速切换 UX

**目标**:agent 工作台 header 一键切 active provider,切换即生效。

**落地**:

- `/agent` 页面 header 加 Provider 下拉(右侧,model 下拉旁):列出当前 CLI 的所有 provider + 高亮 active + 一键设 activate
- 切换即调 `PUT /api/agent/providers/:cliId/:pid/activate`(后端已有)
- 下次请求自动用新 active(由于 proxy 路由读 `getActiveProvider`,无需重启)
- 显示当前 active provider 的 name + 当前 model

**全局可选**:顶栏右侧也加个 mini 浮窗("当前每个 CLI 的 active provider 一览"),按需展开。第一版不做也行。

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

**优先级**:4.3.0 必做 A/B/C;OpenClaw/Hermes 放 **4.3.1 patch**,因为这两家信息未完全摸清,慢一步更稳。如果探查发现 adapter 工程量很轻、且 README 给的接入方式标准,可以塞 4.3.0。

### 4.5 E. /model slash 改造

**目标**:`/model` 不仅切 model,也露出"切 provider"路径。

**落地**:
- `/model` 子菜单分两段:**当前 provider 的可用 models** + **切其他 provider**
- 复用 4.3-C 的切换接口
- 主控 1Shell AI 浮窗、独立 `/agent`、Panel 三处都更新(4.2.4 已统一基础设施,这里追加 provider 段)

**优先级**:4.3.0 可做,工程量不大;若紧张可后置到 4.3.x。

---

## 5. 明确不做的事

| 不做 | 理由 |
|---|---|
| Cloud Sync(Dropbox/iCloud/WebDAV) | 1Shell 是 self-hosted 服务端,本身就是统一存储 |
| Tray 桌面应用 | 1Shell 是 Web/桌面 SPA,不是配置切换工具 |
| 重写协议转换层 | 现有 [proxy.routes.js](../src/routes/proxy.routes.js) 1184 行已完整 |
| 在 `/agent` 之外的页面铺 Provider 管理入口 | 设置页 + agent header 两处足够;铺多了变面板配置负担 |
| 给"每条对话/每个 run"做独立 provider override | 暂时复杂,需要时再加;4.3 只做 active provider 全局生效 |
| OpenClaw/Hermes 的细节适配(MCP 注入等深度) | 信息未齐;4.3.x 视探查结果决定深度 |

---

## 6. Sprint 拆解

### 4.3.0(必做)

| 任务 | 估算 | 依赖 |
|---|---|---|
| Preset 数据 + `provider-presets.js` 模块 | S | 无 |
| Provider 添加 UI 接 preset 选择 | M | 上一项 |
| reasoning_effort 字段 schema + 持久化 | S | 无 |
| proxy 注入 thinking/reasoning_effort | M | 上一项 + 白名单数据 |
| Reasoning model 白名单常量 | S | 无 |
| `/agent` header Provider 切换 dropdown | M | 后端 activate API 已有 |
| 设置页 Provider 列表卡片加 reasoning select | S | reasoning 字段就绪 |
| 回归测试(各 CLI 的代理链路通) | M | 全部 |
| 文档(CHANGELOG + README "AI 配置"节) | S | 全部 |

### 4.3.x(增量发版,Patch)

| 任务 | 说明 |
|---|---|
| OpenClaw manifest + 沙箱 + 代理 | 需先完成探查 |
| Hermes manifest + 沙箱 + 代理 | 需先完成探查 |
| `/model` slash 含 provider 段(若 4.3.0 未做) | UX 增强 |
| 全局顶栏 Provider 浮窗 | 可选 |
| 更多 preset(社区反馈驱动) | 按需 |

---

## 7. 关键文件参考(给接手窗口的快速定位)

```
后端:
  src/agents/cli-manifest.js              三家 CLI 的 manifest,新增 preset 模块的同级位置
  src/agents/cli-sandbox.js               沙箱扫描/安装/启动
  src/agents/agent-pty.service.js         CLI PTY 接入(终端化运行)
  src/agents/claude-config-sync.js        config 文件覆写策略
  src/routes/agent-setup.routes.js        Provider CRUD + activate(L21-25 列表已就绪)
  src/routes/proxy.routes.js              1184 行,reasoning_effort 注入在这里加
  src/services/ai.service.js              1Shell AI 自己用 active provider 的入口

前端:
  frontend/src/views/AgentView.vue        /agent 页面,加 header Provider 切换
  frontend/src/views/SettingsView.vue     "AI 配置" tab,Provider 表单和 reasoning select
  frontend/src/components/AgentToolsRail.vue  Tools 面板(已存在,作风格参考)

数据:
  cli-manifest 内的 PROVIDER_PRESETS 或独立 provider-presets.js
  reasoning model 白名单常量

测试:
  scripts/ 下加 reasoning 注入的单测和代理链路冒烟脚本
```

---

## 8. 待对齐项(用户拍板)

> 这一节是开发开始前必须先有答案的决策点,标记 ❓ 的待用户回复。

| # | 项 | 当前提案 | 状态 |
|---|---|---|---|
| 1 | Provider preset 范围 | 国内 6 + 海外 5 + 中转模板 2,共 ~13 家 | ❓ 是否砍到主流 5-6 家 |
| 2 | Reasoning 档位映射 | Anthropic budget_tokens 4k/16k/64k;OpenAI 直接 effort 字符串 | ❓ OK / 需调 |
| 3 | OpenClaw + Hermes 放 4.3.0 还是 4.3.1 | 4.3.1 patch(信息未齐) | ❓ |
| 4 | 快速切换 dropdown 范围 | 仅 `/agent` header(全局浮窗后置) | ❓ |
| 5 | 4.3 是否含 `/model` slash 改造 | 含(工程量不大) | ❓ |
| 6 | 4.4/4.5 是否设置 | 可选缓冲版本,优先按需 | ❓ |

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

---

## 附录 A:决策记录(WHY)

记下几个关键判断的"为什么",避免后续窗口拍脑袋推翻:

- **4.3 不做 Cloud Sync**:1Shell 自己就是服务端,配置本来就集中存,Cloud Sync 是 cc-switch 作为本地工具的补丁,我们不需要这个补丁。
- **4.3 不在 src/ 分叉开源线与比赛线**:两条线共享代码可以保证开源线持续有动作就同时滋养比赛线;分叉了维护成本指数级上升,且会让"开源线"变成开源版本号但实质性内容停滞。
- **OpenClaw/Hermes 不抢 4.3.0**:这两家信息未齐,manifest 化的好处就是后期加成本低;先把 Claude Code 体验做到天花板,再复制给其他家,比同时铺 5 家都做半成品强。
- **5.0 不分 4.x 小步铺**:5.0 是工作台骨架重构,需要整片土地;4.x 散步式补功能(panel/agent 提质)是可选缓冲,不替代 5.0 飞跃。
- **agent + panel 一体化的核心是 schema 单源,不是 UI 拼接**:如果先把 panel 当独立产品做,再"加 AI 按钮",就是宝塔模式的复制,差异化丢失。

## 附录 B:风险登记

- **R1 — 4.x 版本号通胀**:4.3、4.4、4.5 都发会让 5.0 显得遥远。**缓解**:4.4/4.5 可选,如果 4.3 之后直接奔 5.0 也合理。
- **R2 — Provider preset 维护负担**:外部 provider 改 endpoint/模型列表,preset 会过时。**缓解**:preset 只做"自动填",不做"模型清单的真理来源";模型列表运行时通过 `/v1/models` 拉取(已有 [src/services/ai.service.js:fetchModelList](../src/services/ai.service.js))。
- **R3 — reasoning_effort 跨模型兼容**:不同 reasoning model 字段名有差异(thinking vs reasoning vs reasoning_effort)。**缓解**:白名单 + 按模型分支注入,失败降级为不注入。
- **R4 — OpenClaw / Hermes 接入风险**:这两家相对新,命令名/config 协议可能不稳定。**缓解**:放 4.3.1 patch,信息齐全后再做。
