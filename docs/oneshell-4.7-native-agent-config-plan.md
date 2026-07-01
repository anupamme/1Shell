# 1Shell 4.7 计划 — Agent 原生配置接入

> 状态:4.7 方向调整版。当前结论:只写本机原生配置，删除 1Shell 管理配置路径。
> 制定日期:2026-06-30
> 进入 4.7 前备份:`<workspace-backup-path>/1Shell-4.6.7-before-4.7-native-config-20260630-184409.tar.gz`
> 参考对象:cc-switch。借鉴核心是"直接管理各 Agent CLI 的原生配置文件",不是复制它的全部产品形态。

---

## 0. 结论

4.7 不继续把主要精力放在补 Panel 能力上。Panel 继续重要,但继续堆模块会让 1Shell 越来越重;而 Agent API 接入方式是底层能力,会影响 Claude Code、Codex、OpenCode 以及后续更多 Agent 的可接入性。

4.7 的核心方向:

> 1Shell 从"通过本地 proxy 接管 Agent 请求"转向"编排各 Agent CLI 的原生配置文件"。Claude Code / Codex / OpenCode 的 Agent 主链路不再走本地 proxy；proxy 仅保留给 Skills / 1Shell AI 等内部能力。

这不是简单把 base URL 改掉。真正要做的是:

- Provider 数据成为统一来源。
- 每个 Agent 有自己的 native adapter。
- adapter 把 Provider 投影成该 Agent 真实会读取的配置文件。
- 用户能看到、编辑、保存、回滚这些配置文件。
- 1Shell 启动 Agent 时使用原生配置；后续如果要重新做网关适配，必须建立在 native 版本稳定之后，作为单独兼容层设计。

---

## 1. 为什么必须从 proxy 主链路转向原生配置

当前 1Shell 的三家 CLI 接入方式基本是:

- Claude Code 指向 `ANTHROPIC_BASE_URL={serverUrl}/api/proxy/claude`。
- Codex 写 `model_provider = "1shell-proxy"` 和 `/api/proxy/codex`。
- OpenCode 写 `OPENAI_BASE_URL={serverUrl}/api/proxy/opencode/v1`。

这套架构在 4.6 以前成立,因为它让 1Shell 很快接入多家 Agent。但它的长期问题也很明确:

| 问题 | 影响 |
|---|---|
| 协议转换会丢能力 | reasoning、tool schema、cache、web search、model catalog、vendor 扩展字段都可能被压扁。 |
| proxy 成为兼容性瓶颈 | 每家 CLI 或上游 API 一变,1Shell 都要跟着修转换层。 |
| Agent 原生能力绕不开 | Codex 的 `config.toml`、Claude 的 `settings.json`、OpenCode 的 `opencode.json` 都有越来越多 Agent 专属配置。 |
| 后续接更多 Agent 成本高 | 如果每家都走 proxy,最终会变成协议和配置双重适配。 |
| 用户难以自查 | 出问题时用户看到的是 1Shell proxy,不是 Agent 真实配置,不利于排障和迁移。 |

4.7 要承认一个事实:cc-switch 能被用户理解,是因为它做的是最直接的事——修改配置文件。1Shell 要把这个核心吃进去:默认管理本机真实的 Claude Code / Codex / OpenCode 配置文件，让 CLI 按自己的原生方式启动和读配置。

---

## 2. 4.7 的产品原则

### 2.1 配置文件必须可视、可改、可带走

这是 4.7 的硬约束。

用户不能只看到一个表单,也不能只能点"保存"让 1Shell 在背后生成黑盒配置。每个 Agent 的最终配置必须具备这些能力:

- 能看到要写入哪个文件。
- 能看到完整生成结果。
- 能直接编辑 JSON/TOML 原文。
- 保存前能校验格式。
- 保存前能看到 diff。
- 保存时自动备份旧文件。
- 保存后 1Shell 后续同步不得无提示覆盖用户手工改动。
- 能从 UI 打开"结构化表单"和"原始配置文件"两种视图。

也就是说,第二张参考图里的"配置 JSON"不是高级调试功能,而是核心功能。1Shell 4.7 的 Provider 编辑页必须有类似能力:

```text
Provider 表单
  ├── 请求地址 / API 格式 / 认证字段
  ├── 模型映射
  ├── 高级能力开关
  └── 配置文件视图
        ├── Claude Code settings.json
        ├── Codex config.toml
        ├── Codex mcp.json
        ├── OpenCode opencode.json provider 片段
        ├── MCP 配置片段
        └── Raw editor + diff + validate + backup + restore
```

### 2.2 默认写本机原生配置

4.7 的主路径不是再做一套 1Shell 隔离配置目录，而是直接管理用户本机真实配置:

```text
Claude Code: ~/.claude
Codex:       ~/.codex
OpenCode:    ~/.config/opencode  或  $XDG_CONFIG_HOME/opencode
```

启动 Claude Code / Codex / OpenCode 时，不再注入 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME` 去把它们引到 1Shell 数据目录。CLI 应该像用户手动运行时一样读取自己的默认配置文件。

旧的 1Shell 数据目录配置路径从 4.7 主链路删除，不再作为兼容模式保留。

因为默认会写真实配置，下面三件事必须尽快补齐:

- 保存前展示目标路径和最终内容。
- 写入前自动备份旧文件。
- 保存失败时能够恢复到写入前状态。

### 2.3 Agent proxy 删除,内部 proxy 保留

4.7 不保留 Claude Code / Codex / OpenCode 的旧 Agent proxy 端点。旧端点会让用户误以为仍在走网关，也会继续遮蔽 Agent 原生能力。

保留的是 1Shell 内部 proxy:

- Skills / 1Shell AI 自身请求仍需要本地转发。
- Anthropic 与 OpenAI 跨协议转换仍需要 proxy。
- 某些调试、审计、限流、后续路由能力仍可能依赖 proxy。

Agent 主链路要变:

```text
4.6:
Agent CLI -> 1Shell proxy -> 上游模型

4.7:
Agent CLI -> 上游模型
          ^
          |
       1Shell 写原生配置
```

### 2.4 不把 1Shell 做成另一个 cc-switch

cc-switch 是配置切换工具。1Shell 是 Agent 宿主和 VPS 工作台。

4.7 借鉴 cc-switch 的:

- 原生配置文件写入。
- per-agent adapter。
- 原子写入。
- 备份恢复。
- common config 保留。
- additive / exclusive 两类写入模式。
- raw config 可视编辑。

4.7 不复制 cc-switch 的:

- 全套托盘应用形态。
- 账单、同步、云备份、订阅管理等旁支能力。
- 为供应商市场做的大量 UI 复杂度。
- 与 1Shell 无关的历史迁移包袱。

---

## 3. 架构目标

### 3.1 新主链路

```text
Provider Store
  |
  | normalized provider
  v
Agent Native Adapter
  |
  | project(provider, context)
  v
Projected Config Files
  |
  | validate / diff / backup / write
  v
Host Native Config
  |
  v
Agent Process
```

### 3.2 Adapter 接口

每个 Agent adapter 至少提供:

```ts
interface AgentNativeAdapter {
  id: string;
  label: string;
  mode: "exclusive" | "additive";

  getTargets(context): ConfigTarget[];
  readCurrent(context): Promise<ConfigSnapshot>;
  project(provider, context): Promise<ProjectedConfig>;
  validate(projected): ValidationResult;
  diff(current, projected): ConfigDiff;
  backup(targets): Promise<BackupRecord>;
  write(projected, options): Promise<WriteResult>;
  redact(snapshot): RedactedConfigSnapshot;
}
```

解释:

| 字段 | 含义 |
|---|---|
| `exclusive` | 当前 Provider 会成为该 Agent 的主配置,例如 Claude Code、Codex。 |
| `additive` | 只往配置里追加一个 provider/mcp entry,不删除其他用户配置,例如 OpenCode。 |
| `getTargets` | 返回真实文件路径和配置格式。 |
| `project` | 把统一 Provider 转成该 Agent 的原生文件。 |
| `validate` | JSON/TOML 格式校验和 Agent 特定规则校验。 |
| `diff` | 保存前展示差异。 |
| `backup` | 写入前生成备份。 |
| `redact` | UI 展示时脱敏 key/token。 |

### 3.3 配置所有权

1Shell 不能假设整个配置文件都归自己。必须区分:

| 类型 | 处理方式 |
|---|---|
| 用户本机真实配置文件 | 默认只 patch 1Shell 管理的片段。写前必须 diff + backup。 |
| OpenCode 这类 additive config | 只写 `provider.<id>` 和 `mcp.<id>` 片段,不碰其他 provider。 |
| Codex `auth.json` | 只做旧配置导入兼容读取；1Shell 不生成、不展示、不覆盖。Codex API Key 通过启动环境变量注入。 |
| 用户手工指定 catalog/config | 不抢占,不删除,只在明确由 1Shell 生成时管理。 |

建议新增 ledger:

```text
data/agent-native-config/ledger.json
```

记录:

- 1Shell 写过哪些文件。
- 每次写入的 hash。
- 备份位置。
- 哪些片段属于 1Shell。
- 用户是否手工编辑过 raw config。
- 当前 Agent 使用 native 还是 proxy。

不要依赖在 JSON/TOML 文件里塞注释来判断所有权,因为很多配置格式不支持注释或会被 CLI 重写。

---

## 4. Provider 数据模型升级

当前 `upstreamProtocol` 过粗。4.7 需要把"上游协议"拆成更准确的数据:

```js
{
  id,
  name,
  apiBase,
  apiFormat: "anthropic_messages" | "openai_responses" | "openai_chat" | "proxy",
  auth: {
    type: "api_key" | "bearer" | "oauth" | "none",
    field: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "experimental_bearer_token",
    valueRef: "encrypted-secret-id"
  },
  models: {
    active,
    claudeRoles: {
      haiku,
      sonnet,
      opus,
      fable
    },
    codex: {
      model,
      reasoningEffort,
      contextWindow,
      catalogModels
    },
    opencode: {
      defaultModel,
      models
    }
  },
  capabilities: {
    reasoning,
    toolSearch,
    webSearch,
    promptCache,
    responsesApi,
    customTools,
    oneMillionContext
  },
  agentConfigs: {
    "claude-code": {},
    "codex": {},
    "opencode": {}
  }
}
```

关键点:

- `apiFormat` 决定是否能 native direct。
- `auth.field` 决定写入哪个 env/config 字段。
- `models` 不只是一个字符串,要支持 Claude 角色模型、Codex catalog、OpenCode model map。
- `agentConfigs` 用来保存某个 Agent 的特殊配置和 raw override。

---

## 5. 配置编辑器是 4.7 的核心界面

### 5.1 页面入口

Provider 编辑页新增 "配置文件" 区域。

结构:

```text
编辑供应商
  ├── 基础信息
  ├── API 设置
  ├── 模型映射
  ├── 能力开关
  └── 配置文件
        ├── Agent tabs: Claude Code / Codex / OpenCode
        ├── 文件 tabs: settings.json / config.toml / mcp.json
        ├── 表单视图
        ├── 原文视图
        ├── 预览生成
        ├── 与当前文件 diff
        ├── 校验
        ├── 保存到本机原生配置
        └── 从备份恢复
```

### 5.2 Raw editor 的规则

Raw editor 不是只读预览。

必须支持:

- JSON 格式化。
- TOML 格式化或至少语法校验。
- token 脱敏显示,点击后可临时显示。
- 保存前校验。
- 保存前 diff。
- 保存后成为该 Provider 的 `agentConfigs.<agent>.rawOverride`。
- 之后表单字段变化时,要提示 raw override 可能被影响,不能静默覆盖。

### 5.3 表单和原文的关系

表单用于快速配置,原文用于精细控制。

推荐模型:

```text
structured provider fields
  + adapter default template
  + user raw override
  = final projected config
```

如果用户只用表单,1Shell 生成标准配置。

如果用户编辑原文,1Shell 标记为 "customized",后续同步时:

- 能安全 merge 的字段继续 merge。
- 有冲突时展示 diff,让用户选择保留原文或重新生成。
- 不允许静默覆盖。

### 5.4 文件级可见性

每个文件卡片必须显示:

| 字段 | 示例 |
|---|---|
| Agent | Claude Code |
| 文件名 | `settings.json` |
| 原生路径 | `~/.claude/settings.json` |
| 当前模式 | host |
| 上次写入 | 时间、Provider、hash |
| 备份 | 最近 N 个备份 |
| 状态 | 未写入 / 已同步 / 用户修改 / 冲突 / 校验失败 |

---

## 6. 首批 Adapter 设计

### 6.1 Claude Code adapter

目标文件:

```text
host(default):
~/.claude/settings.json
~/.claude/config.json
~/.claude/mcp-config.json
```

主要写入:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://provider.example.com",
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "...",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "...",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "model": "opus",
  "effortLevel": "high",
  "includeCoAuthoredBy": false
}
```

注意:

- `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_API_KEY` 要按 provider 的 `auth.field` 选择。
- `ANTHROPIC_BASE_URL` 不要强制补 `/v1`,以供应商文档为准。
- 模型角色要支持 Haiku / Sonnet / Opus / Fable。
- tool search、co-author、自动升级等开关要保留 raw config 通道。
- MCP 继续写 `mcp-config.json`,但同样可视可改。

第一阶段验收:

- Claude Code 可以不经过 1Shell proxy 直连 Anthropic-compatible API。
- 用户能在 UI 看到最终 `settings.json`。
- 用户改 raw JSON 后再次启动 Claude Code 生效。
- 旧 `/api/proxy/claude` 链路不再作为 Agent 入口。

### 6.2 Codex adapter

目标文件:

```text
host(default):
~/.codex/config.toml
~/.codex/mcp.json
~/.codex/1shell-model-catalog.json

```

主要写入:

```toml
model_provider = "custom"
model = "gpt-5.5"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "Provider Name"
base_url = "https://provider.example.com"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "..."

[projects.'/path/to/1Shell']
trust_level = "trusted"

[windows]
sandbox = "elevated"
```

关键原则:

- 不默认覆盖用户官方 ChatGPT/Codex 登录态。
- 第三方 token 不写入 `auth.json`；启动 Codex 时由 1Shell 注入 `OPENAI_API_KEY`。
- `auth.json` 只兼容读取旧配置,不得由 1Shell 生成或覆盖。
- `model_catalog_json` 只管理 1Shell 自己生成的 catalog 文件。
- 如果用户已有外部 catalog,不得删除。
- native Responses 网关可能拒绝 Codex 的 custom tool schema,model catalog 要能按 provider 能力调整。
- `web_search` 不能一刀切禁用,只对已知不支持的 native 网关处理。

第一阶段验收:

- Codex direct Responses 能跑通。
- `config.toml` 不再写 `1shell-proxy` 或 `/api/proxy/codex`。
- 用户可以编辑 `config.toml` 原文。
- TOML 校验失败时不能写入。
- 保存本机配置前有 diff 和备份。

### 6.3 OpenCode adapter

目标文件:

```text
host(default):
~/.config/opencode/opencode.json

```

写入方式:additive。

只写:

```json
{
  "provider": {
    "1shell-provider-id": {
      "name": "Provider Name",
      "api": {
        "baseURL": "https://provider.example.com/v1",
        "key": "..."
      },
      "models": {}
    }
  },
  "mcp": {
    "1shell": {}
  }
}
```

关键原则:

- 不删除用户已有 provider。
- 不重写整个 `opencode.json`。
- 只 patch `provider.<id>` 和 `mcp.1shell`。
- UI 必须能显示最终合并后的完整 JSON,也能只看 1Shell 管理的片段。

第一阶段验收:

- OpenCode 可以选择 1Shell Provider 直连。
- 用户已有 OpenCode 配置不被覆盖。
- raw editor 改 provider 片段后能保留。

---

## 7. 实施阶段

### Phase 0:备份与方向文档

已完成:

- 生成 4.6.7 进入 4.7 前源码备份。
- 新增本计划文档。

### Phase 1:Native Config Core

目标:先把三家 CLI 的主链路切到本机原生配置，删除 1Shell 管理配置路径。

任务:

- 目标目录固定为 `~/.claude`、`~/.codex`、`~/.config/opencode`。
- 启动时不注入 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME`。
- 新增 `/api/agent/native-config/...` 接口，删除旧配置管理 URL。
- 实现 JSON/TOML 校验。
- 实现单文件 atomic write。
- 保留 raw editor 覆盖逻辑。
- 记录当前模式与目标路径。
- 后续补齐 backup ledger、diff、rollback。

验收:

- 能读取当前本机原生配置。
- 能生成 projected config。
- 能写入本机原生配置目录。
- 启动命令不会把 CLI 引向 1Shell 数据目录。
- 单测覆盖 host mode、JSON/TOML 校验、启动使用本机 CLI 路径。

### Phase 2:配置文件可视化编辑器

目标:先把"可视、可改"做出来。

任务:

- Provider 编辑页新增 "配置文件" 区域。
- 支持 Agent tabs。
- 支持文件 tabs。
- 支持 raw editor。
- 支持格式化、校验、diff、保存、恢复。
- 支持显示 host 路径。
- 支持标记 customized / conflict / synced。

验收:

- 用户能看到 Claude/Codex/OpenCode 的最终配置文件。
- 用户能手动改 JSON/TOML。
- 校验失败不能保存。
- 保存后 Agent 启动使用用户修改后的内容。
- 1Shell 不会静默覆盖用户 raw editor 改动。

### Phase 3:Claude Code native mode

目标:最先让 Claude Code 脱离 proxy 主链路。

任务:

- 实现 `claude-code.adapter.js`。
- Provider 增加 `apiFormat = anthropic_messages`。
- 写真实 `ANTHROPIC_BASE_URL` 和 token。
- 写模型角色映射。
- 继续保留 MCP/skills 同步。
- Agent 启动固定走 native config。

验收:

- native 模式下 Claude Code 不请求 `/api/proxy/claude`。
- raw `settings.json` 编辑生效。
- 不破坏现有 MCP。

### Phase 4:Codex native mode

目标:Codex 支持 direct Responses。

任务:

- 实现 `codex.adapter.js`。
- 使用 TOML parser/edit 工具,避免字符串拼接。
- 不再生成 `auth.json`,仅兼容读取旧文件。
- 支持 provider-scoped bearer token。
- 支持 `model_reasoning_effort`。
- 初版 model catalog 只做必要最小集。
- 不写 `1shell-proxy` provider。

验收:

- Codex native direct Responses 可用。
- TOML 注释和用户未知字段尽量保留。
- 官方登录态不被默认覆盖。
- Codex 配置不再包含 `/api/proxy/codex`。

### Phase 5:OpenCode native mode

目标:OpenCode additive provider 写入。

任务:

- 实现 `opencode.adapter.js`。
- `opencode.json` 只 patch provider/mcp 片段。
- UI 展示完整合并结果和 1Shell 管理片段。

验收:

- 用户已有 OpenCode provider 不丢。
- 1Shell provider 可添加、更新、删除。
- raw provider 片段编辑生效。

### Phase 6:备份、回滚与写入安全

目标:默认已经写本机真实配置，因此必须把写入安全补到可长期使用。

任务:

- 每个 adapter 明确 host target。
- 写入前显示路径和 diff。
- 写入前强制备份本机真实文件。
- 支持恢复。
- 支持只写 selected Agent。
- 支持 "dry run"。

验收:

- 写本机配置必须可撤销。
- 写入失败不得产生半写文件。
- 用户手工本机配置不被大面积覆盖。

### Phase 7:更多 Agent 接入

目标:新增 Agent 时主要写 adapter,不再扩 proxy 主干。

候选:

- Gemini CLI
- Qwen Code
- Aider
- OpenClaw
- Hermes
- Cursor CLI 或其他代码 Agent

验收:

- 新 Agent 接入文档更新。
- 新 Agent 至少提供 config target、project、validate、write。
- 不再要求扩展 `/api/proxy/<agent>` 主干。

---

## 8. 后端文件规划

建议新增:

```text
src/agents/native-config/
  index.js
  types.js
  registry.js
  paths.js
  redact.js
  backup-store.js
  diff.js
  json-file.js
  toml-file.js
  adapters/
    claude-code.adapter.js
    codex.adapter.js
    opencode.adapter.js

src/routes/agent-native-config.routes.js
```

建议修改:

```text
src/agents/cli-manifest.js
src/agents/native-cli-config.js
src/agents/providers/index.js
src/agents/agent-pty.service.js
src/routes/agent-setup.routes.js
server.js
```

接口草案:

```text
GET  /api/agent-native-config/:cliId/targets
GET  /api/agent-native-config/:cliId/snapshot
POST /api/agent-native-config/:cliId/project
POST /api/agent-native-config/:cliId/validate
POST /api/agent-native-config/:cliId/diff
POST /api/agent-native-config/:cliId/write-host
GET  /api/agent-native-config/:cliId/backups
POST /api/agent-native-config/:cliId/restore
```

---

## 9. 前端文件规划

建议新增:

```text
frontend/src/components/agent-config/
  AgentConfigFilesPanel.vue
  AgentConfigTargetTabs.vue
  AgentConfigRawEditor.vue
  AgentConfigDiffView.vue
  AgentConfigBackupList.vue
  AgentConfigStatusBadge.vue
```

建议修改:

```text
frontend/src/views/CliSetupView.vue
frontend/src/components/ProviderModal.vue
frontend/src/views/AgentView.vue
frontend/src/api/agents.js
```

UI 原则:

- 不做营销解释页,直接在 Provider 编辑/CLI 设置里给实际配置。
- raw editor 是一等功能。
- 保存按钮必须明确写到 host。
- diff 和备份入口必须在保存附近。
- token 默认脱敏。
- 错误必须指向具体文件和具体字段。

---

## 10. 测试策略

后端:

- adapter projection snapshot。
- JSON/TOML parse/format/validate。
- atomic write rollback。
- backup restore。
- raw override 不被覆盖。
- additive patch 不删除用户配置。
- Codex `auth.json` 兼容读取,不生成不覆盖。
- Agent proxy 旧端点不可回归。

前端:

- 配置文件 tab 渲染。
- raw editor 修改和保存。
- invalid JSON/TOML 阻止保存。
- diff 展示。
- host 路径展示。
- customized/conflict 状态展示。

手工回归:

- Claude Code native。
- Codex native Responses。
- OpenCode additive config。
- MCP 在三家里仍可用。

---

## 11. 风险与处理

| 风险 | 处理 |
|---|---|
| 写坏用户本机配置 | 默认写 host，因此必须尽快补齐 diff、backup、restore，并避免整文件覆盖用户未知字段。 |
| 用户 raw editor 修改被覆盖 | 引入 customized 状态和 raw override;冲突时必须让用户选择。 |
| Codex 变化太快 | 先做最小 direct Responses;model catalog 高级能力分阶段。 |
| 跨协议 provider 无法 native | 第一阶段不支持；后续如需网关适配，作为 native 稳定后的独立兼容层。 |
| key 泄露 | UI 脱敏、日志脱敏、备份权限控制、不要在错误里打印 token。 |
| TOML 字符串拼接出错 | 使用 parser/edit 工具,不要手写大段 replace。 |
| OpenCode 配置被整体覆盖 | adapter 必须 additive patch。 |
| 用户难以理解请求链路 | UI 明确显示当前 Agent 读取的配置文件和目标 base URL。 |

---

## 12. 4.7 完成标准

4.7 不以"新增多少供应商"为完成标准,而以接入方式改变为标准。

必须满足:

- Claude Code / Codex / OpenCode 至少两家可用 native mode。
- 每家都能看到最终配置文件。
- 每家都能 raw edit。
- 保存前有校验和 diff。
- 写入前有备份。
- Agent 旧 proxy 端点不再作为 Claude Code / Codex / OpenCode 主链路。
- host 默认可用。
- host 写入可撤销。
- 文档说明如何新增 adapter。

一句话验收:

> 用户可以像 cc-switch 一样看到和修改本机配置文件,但 1Shell 仍然保持自己的 MCP、Agent 宿主和 VPS 工作台优势。
