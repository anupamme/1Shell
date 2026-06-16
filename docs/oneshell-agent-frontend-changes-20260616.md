# Agent 前端改动记录 — 2026-06-16

> 本文件记录 2026-06-16 窗口对 1Shell Agent 前端的所有改动，供下一个窗口接手。

## 改动概览

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/routes/proxy.routes.js` | 后端新增 | provider 加 `enabled` 字段 |
| `frontend/src/utils/cliSetup.ts` | 前端类型 | `ProviderInfo` 加 `enabled?: boolean` |
| `frontend/src/views/CliSetupView.vue` | 前端重写 | AI 配置页：左侧竖排 tab + 渠道管理面板 |
| `frontend/src/views/AgentView.vue` | 前端修改 | 斜杠命令面板、模型子视图、任务模式开关 |
| `frontend/src/components/ProviderModal.vue` | 前端修改 | 保存时带 `enabled` 字段 |

---

## 1. 后端：provider 加 `enabled` 字段

**文件**: `src/routes/proxy.routes.js` — `createProxyConfigStore`

三处改动：

```js
// maskProvider — 输出时包含 enabled
function maskProvider(p) {
  return {
    id: p.id, name: p.name || '',
    apiBase: p.apiBase || '',
    apiKey: p.apiKey ? maskKey(p.apiKey) : '',
    apiKeySet: Boolean(p.apiKey),
    model: p.model || '',
    upstreamProtocol: p.upstreamProtocol || 'openai',
    enabled: p.enabled !== false,  // NEW
  };
}

// addProvider — 新 provider 默认 enabled
const provider = {
  ...
  enabled: true,  // NEW
};

// updateProvider — 支持 enabled 布尔字段更新
if (typeof partial.enabled === 'boolean') p.enabled = partial.enabled;  // NEW
```

**数据存储**: `data/proxy-configs.json`，已有 provider 没有 `enabled` 字段的默认视为 `true`

---

## 2. AI 配置页重写（CliSetupView）

**文件**: `frontend/src/views/CliSetupView.vue`

**旧布局**: 左侧 EndpointsPanel（MCP/Bridge 端点信息）+ 右侧 CLI 卡片网格（扫描/安装/沙箱）
**新布局**: 左侧竖排 4 个 tab + 右侧选中 tab 的内容

### 左侧 nav

```
┌─────────────┐
│ AI 渠道      │
│             │
│ ● 1Shell AI │  ← skills slot
│   Claude Code│  ← claude-code slot
│   Codex     │  ← codex slot
│   OpenCode  │  ← opencode slot
└─────────────┘
```

### 1Shell AI tab
- 渠道卡片列表，每张卡片有：
  - **启用/禁用 toggle**（绿色滑块，调 `PUT /api/agent/providers/skills/:pid` 设 `enabled`）
  - 活跃标记（绿点 = 当前 active provider）
  - 模型名 + API 地址 + Key 状态
  - 悬停显示编辑/删除按钮
- "添加渠道"按钮打开 ProviderModal
- **optimistic update**: toggle 先改 UI，再调 API，失败则 revert + 重拉

### CLI tabs（Claude Code / Codex / OpenCode）
- 顶栏：状态标签 + **扫描** / **安装** / **更新** 按钮
- CLI 状态卡片：名称、状态、路径、版本、沙箱目录
- 操作按钮：创建沙箱、重置沙箱、指定路径、清除路径、诊断
- API 渠道列表（下方，复用 provider CRUD）

### 删除的旧功能
- EndpointsPanel 组件引用（MCP/Bridge 端点信息）
- CLI 卡片网格 + 筛选栏 + 搜索框
- CliCard 组件引用
- 扫描/安装/沙箱等是从旧代码迁移过来的，逻辑保留

---

## 3. AgentView 改动

**文件**: `frontend/src/views/AgentView.vue`

### 3a. 斜杠命令面板

输入 `/` 时在输入框上方弹出命令面板，显示 6 个命令：

```
┌──────────────────────────────────────────┐
│  命令                                      │
│ ┌────┬──────────────────────────────────┐ │
│ │ ✨ │ /model  选择模型  切换模型与渠道   │ │
│ │ 💾 │ /task   任务模式  进入任务创作模式 │ │
│ │ 🎯 │ /goal   设置目标                  │ │
│ │ 🖥  │ /host   选择主机                  │ │
│ │ 🛡  │ /mode   审批模式                  │ │
│ │ ✕  │ /clear  清空时间线                │ │
│ └────┴──────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

键盘导航：`↑↓` 移动、`Enter` 选中、`Tab` 自动补全、`Escape` 关闭

### 3b. `/model` — 模型子视图

选中 `/model` 后，命令面板切换为模型列表：

```
┌──────────────────────────────────────────┐
│ ← 返回命令列表                            │
│                                          │
│ ○ 默认模型              系统默认          │
│ ● deepseek-v4-pro       深海              │  ← ● = 当前活跃
│ ○ claude-opus-4-6       bohe             │
└──────────────────────────────────────────┘
```

- 仅显示 `enabled !== false` 的渠道
- 每次打开时调用 `loadProviders()` 实时拉取
- header 模型按钮点击也触发此面板
- 选中模型 → 调 `PUT /api/agent/providers/skills/:pid/activate`

### 3c. `/task` — 任务模式开关

- **不是子视图**，是纯 toggle
- 选中 `/task` → `taskMode = true` → composer 填入 `/task `
- `/task` chip 高亮 amber 色表示 ON
- 状态栏显示 amber 色 `任务模式` 徽章
- 再点 chip 关闭
- `taskMode = true` 时，`messagePayload.entry` 从 `'core'` → `'task'`
- 后端收到 `entry: 'task'` → 激活 `TASK_AUTHORING_SYSTEM_PROMPT` + task authoring tools + evidence gate

### 3d. 其他命令行为

| 命令 | 行为 |
|---|---|
| `/goal` | 弹出 prompt 输入目标 → composer 填 `/goal xxx` 并发送 |
| `/host` | 打开 header 主机下拉 |
| `/mode` | 打开 header 审批模式下拉 |
| `/clear` | 弹出确认 → 清空时间线 |

### 3e. 删除的旧功能
- header 独立 model dropdown（`showModelDropdown`）
- 旧的 `pickModel()` 函数 → 替换为 `selectModelFromSlash()`
- 错误添加的任务列表/保存功能（`loadTasks`、`saveCurrentGoalAsTask` 等）
- `openSlashTask()`、`startTaskAuthoring()`、`packageConversationAsTask()` 子视图函数

### 3f. 新增的接口/类型
```ts
interface AgentProvider {  // AgentView 本地定义
  id: string; name: string; apiBase: string;
  apiKeySet: boolean; model: string;
  upstreamProtocol: string; enabled?: boolean;
}
```

---

## 4. ProviderModal 修改

**文件**: `frontend/src/components/ProviderModal.vue`

`onSave()` 保存 body 新增 `enabled` 字段：

```ts
const cur = editingPid.value ? providers.value.find(p => p.id === editingPid.value) : null;
const body: Record<string, string | boolean | undefined> = {
  ...
  enabled: cur?.enabled,  // NEW
};
```

防止编辑 provider 其他字段时，`enabled` 状态被静默丢失。

---

## 5. 已知问题 / 未完成

| 问题 | 状态 |
|---|---|
| `/task` 只是开关，没有任何引导/提示 | 用户不满意，要求一比一复刻旧版 |
| 旧版 `/task` 在 `IdeView.vue`（已删除），通过 `?taskAuthoring=1` query param 进入 | 新 AgentView 无此逻辑 |
| 后端 `entry: 'task'` 的 system prompt + tools 已在 `ide.service.js` 中完整实现 | 待前端正确对接 |
| FeaturesView（面板→功能）有完整的任务列表+执行系统 | 未与 AgentView 联动 |
| `/ide` 路由已 redirect 到 `/terminal` | FeaturesView 的 "创建任务" 按钮指向 `/ide?taskAuthoring=1` 已失效 |
| Model 切换的 `activeProviderId` 变化后，后端 agent 实际使用的 model 仍来自 `getActiveProvider` | 需要后端支持运行时 `providerId` 透传 |
