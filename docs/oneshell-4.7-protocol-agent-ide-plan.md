# 1Shell 4.7 — Agent 板块协议化接入与 IDE 壳计划

> 目标一句话：让第三方 agent（Claude Code / Codex / Gemini CLI / 其它 ACP agent）以**结构化协议**方式住进 Agent 板块，与 1Shell AI 共用同一套时间线 UI；在此之上给 Agent 板块套上三栏 IDE 壳（工作区文件树 · 会话时间线 · 文件预览/编辑）。

参考对象：[mindfs](https://github.com/a9gent/mindfs)（本机源码 `/opt/mindfs-src`）。
**注意 mindfs 是 AGPL-3.0，只参考架构与数据模型设计，不搬运代码。**

---

## 1. 背景与现状

### 1.1 两个板块的现状

| 板块 | 路由 / 视图 | 第三方 agent 形态 |
|------|-------------|-------------------|
| 终端板块 | `/terminal` `MainConsoleView.vue` | `src/agents/agent-pty.service.js`：node-pty 起原生 CLI，xterm.js 透传 TUI，1Shell 对 agent 行为不可见 |
| Agent 板块 | `/agent` `AgentView.vue` | 仅 1Shell AI（`src/ide/ide.service.js` 自研 harness），结构化时间线；第三方 agent 进不来 |

### 1.2 已有的关键资产（本计划的复用基础）

- **统一事件流**：后端 `src/ide/ide.events.js` 把所有会话事件规范为
  `ide:event { v:1, type, sessionId, runId, payload, ts }`；
  前端 `frontend/src/utils/ideStreamEvents.ts` 的 `bindIdeStreamHandlers` 统一消费。
  事件类型：`thinking / text / text_delta / tool_start / tool_end / approval_request / ask_user / done / error / cancelled / compact …`
- **时间线 UI**：`useIdeChat.ts` + `IdeAgentTimeline.vue` + `IdeApprovalCard.vue`，与具体 agent 无关，只认事件形状。
- **会话持久化**：`src/repositories/ide-session.repository.js`（SQLite，`entry / host_id / messages_json` 等字段），REST 面 `src/routes/ide-session.routes.js`（`/api/agent/sessions`）。
- **CLI 清单**：`src/agents/cli-manifest.js` 已描述 claude-code / codex / opencode 的二进制、安装、原生配置生成。
- **Socket 面**：`registerIdeSocketHandlers.js`（`ide:message / ide:stop / ide:approve-response …`）。

### 1.3 从 mindfs 学到的核心结论

mindfs 的多 agent 能力**不靠 PTY**，靠协议层（`server/internal/agent/`）：

- 17 个 agent 中绝大多数走 **ACP**（Agent Client Protocol，JSON-RPC 2.0 over ndjson stdio），如 `gemini --experimental-acp`；
- Claude Code 走 `stream-json`（claude-sdk），Codex 走 app-server 协议（codex-sdk）；
- agent 注册表 `agents.json`：`{ name, command, protocol, args, installCommands, configBackup }`；
- 会话绑定持久化：内部会话 ↔ agent 原生会话 ID 的映射，重启后可 `--resume`；
- "IDE 感"来自 文件树 + 渲染器 + 会话↔文件双向关联（`.mindfs/file-meta.json`），它甚至没有代码编辑器。

---

## 2. 总体设计

```
                      ┌────────────────────────────────────────┐
                      │        AgentView（Agent 板块）          │
                      │  左：会话/工作区 rail  中：时间线  右：IDE│
                      └───────────────▲────────────────────────┘
                                      │ ide:event（形状不变）
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
     ┌────────┴───────┐    ┌──────────┴─────────┐   ┌─────────┴────────┐
     │ ide.service.js │    │ protocol-agent      │   │ (未来) 更多来源   │
     │  1Shell AI     │    │ .service.js（新增） │   │ 会话导入/定时任务 │
     └────────────────┘    └──────────▲─────────┘   └──────────────────┘
                                      │ 归一化内部事件
                        ┌─────────────┼──────────────┐
                 ┌──────┴─────┐ ┌─────┴──────┐ ┌─────┴─────┐
                 │ acp-client │ │ claude-    │ │ codex-    │
                 │ (JSON-RPC) │ │ stream     │ │ adapter   │
                 └──────┬─────┘ └─────┬──────┘ │ (M4)      │
                        │             │        └───────────┘
                  gemini/cursor…   claude CLI
```

核心原则：

1. **第三方 agent 后端翻译成与 1Shell AI 完全相同的 `ide:event` 形状**，前端时间线零改动复用；
2. 协议进程管理复用 `agent-pty.service.js` 的会话生命周期模式（socket 归属、detach/reattach），但 stdio 走管道不走 PTY；
3. 会话数据进同一个 SQLite 仓库，新增 `agent_id / cwd / native_session_id` 三个字段——`(agent, 工作目录, 原生会话)` 三元组是绑定恢复的关键；
4. 工作区（文件夹）成为一等概念：会话按 cwd 组织，为 M3 的 IDE 壳打地基。

---

## 3. 分阶段计划

### M1 — 协议接入层后端（本次先做）

新增 `src/agents/protocol/`：

| 文件 | 职责 |
|------|------|
| `ndjson.js` | 子进程 stdio 的行分隔 JSON 读写（背压安全、半行缓冲） |
| `acp-client.js` | ACP 客户端：`initialize → session/new → session/prompt`；处理 `session/update` 通知（`agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / plan`）、`session/request_permission`、`fs/read_text_file`、`fs/write_text_file` |
| `claude-stream-adapter.js` | 起 `claude -p --input-format stream-json --output-format stream-json --verbose`，长驻多轮；解析 `system:init`（拿 native session_id）、`assistant / user(tool_result) / stream_event / result`；权限走 control_request/response 通道 |
| `agent-catalog.js` | 协议 agent 注册表：`{ id, name, command, protocol: 'acp'|'claude-stream', args, detect }`，与 `cli-manifest.js` 打通检测 |
| `protocol-agent.service.js` | 会话管理器：创建/继续/停止/重连；归一化事件 → `emitIdeEvent`；权限请求挂起/应答；会话持久化与 `--resume` / `session/load` 恢复 |

配套：

- `src/database/migrations.js`：`ide_sessions` 表加 `agent_id`、`cwd`、`native_session_id` 列（幂等 ALTER）；
- Socket：`ide:message` 载荷增加 `agentId`、`cwd`；`registerIdeSocketHandlers.js` 按会话归属路由到 `ideService` 或 `protocolAgentService`；`ide:approve-response` 同理；
- REST：`GET /api/agent/protocol/agents`（可用协议 agent + 检测状态）；
- 测试脚本：`scripts/test-protocol-agent-claude.js`（真实 claude CLI 冒烟）、`scripts/test-acp-client.js`（mock ACP agent 单测）。

事件映射表（两个方向的翻译标准）：

| ide:event type | claude stream-json 来源 | ACP 来源 |
|---|---|---|
| `thinking` | `stream_event: content_block_delta(thinking_delta)` | `session/update: agent_thought_chunk` |
| `text_delta` | `stream_event: content_block_delta(text_delta)` | `session/update: agent_message_chunk` |
| `text` | `assistant` 消息 text block 定稿 | 一轮 chunk 聚合定稿 |
| `tool_start` | `assistant` 消息 `tool_use` block | `session/update: tool_call (status=pending/in_progress)` |
| `tool_end` | `user` 消息 `tool_result` | `session/update: tool_call_update (status=completed/failed)` |
| `approval_request` | control 通道 `can_use_tool` 请求 | `session/request_permission` |
| `done` | `result` | `session/prompt` 返回 `stopReason` |
| `error` | `result subtype≠success` / 进程异常退出 | JSON-RPC error / 进程异常退出 |

### M2 — Agent 板块多 agent 化（前端）

- `AgentView.vue` 顶部加 agent 切换器（1Shell AI / Claude Code / Gemini / …，来源 `/api/agent/protocol/agents`）；
- 新建会话时选定 agent + 工作目录（`AgentSessionRail.vue` 的文件浏览器加"以此目录新建会话"入口）；
- `useIdeChat.ts`：`ide:message` 带上 `agentId / cwd`；会话列表展示 agent 图标与工作目录；
- 审批卡片：ACP `request_permission` 的多选项（allow once / always / reject）映射进 `IdeApprovalCard` 的动作组。

### M3 — IDE 壳（三栏布局）

- AgentView 扩成三栏：左 = 现有 rail 升级为「工作区 + 会话」双 tab；中 = 时间线；右 = 文件面板；
- 右栏文件面板：预览渲染器（Markdown / 代码高亮 / 图片 / diff），编辑器用 **CodeMirror 6**（轻、移动端友好；mindfs 没做到这步，是超越点）；
- 文件 ↔ 会话关联：`tool_end` 事件里出现的文件路径（ACP `tool_call.locations` 直接给）记录到会话，点击工具卡片文件路径 → 右栏打开；文件页可反查产生它的会话；
- ~~底部可选 xterm 面板（复用终端板块组件）~~ **已决策移除（2026-07-04）**：后续方向是把 Agent 板块与终端板块整体合一，壳内再嵌一个独立终端面板会与合并方案冲突，不做一次性过渡实现。

### M4 — 深化（后续版本）

- Codex app-server 协议适配；
- 外部会话导入（读 `~/.claude/projects/*.jsonl` 等，mindfs 的双向同步模式）；
- 多主机：远程主机上的协议 agent（经 bridge 起进程），`(host, agent, cwd)` 三元组——1Shell 相对 mindfs 的差异化优势；
- 会话 fork / 定时任务对第三方 agent 开放。

---

## 4. 风险与对策

| 风险 | 对策 |
|------|------|
| claude stream-json 权限通道版本差异 | 适配器探测失败时降级 `--permission-mode acceptEdits/plan`，并在 UI 标注"该 agent 由自身权限策略控制" |
| ACP agent 各家实现参差 | 客户端对未知 `sessionUpdate` 类型宽容跳过；每个 agent 在 catalog 里可声明能力开关 |
| 协议进程泄漏 | 会话空闲超时回收 + socket 断开 detach（进程保留、可 reattach）+ 服务关闭统一 kill |
| 事件形状回归 | 冒烟脚本断言事件序列；沿用仓库现有 `scripts/test-*.js` 模式进 `npm test` |

## 5. 验收标准（M1）

1. `scripts/test-acp-client.js`：mock ACP agent 全事件类型往返通过；
2. `scripts/test-protocol-agent-claude.js`：真实 claude CLI 完成一轮对话 + 一次工具调用，事件序列符合映射表；
3. 服务重启后，带 `native_session_id` 的会话可继续对话（claude `--resume`）；
4. `npm test` 全绿。
