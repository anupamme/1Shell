# 1Shell Agent Core RFC

> 状态：架构方向草案。本文用于定义 1Shell 下一阶段从“带 AI 的运维工具”转向“1Shell 本身就是 agent”的产品与工程边界，不代表所有内容已经实现。

## 1. 背景

1Shell 已经具备一批很强的运维工具能力：WebSSH、远程文件、脚本、探针、审计、MCP gateway、Harness、安全审批、1Shell AI AgentRun、Skill 知识包等。

当前 README 对 1Shell 的定义是：

> local-first server operations console with an embedded AI agent

这说明 1Shell 已经不是普通 WebSSH，但从产品形态上看，它仍然容易被理解为：

```text
WebSSH + 文件管理 + VPS 管理 + MCP Server + AI 辅助执行
```

这套形态有价值，但本质上仍然偏“工具集合”。下一阶段的关键不是继续把更多第三方 agent 接进来，也不是把 1Shell AI 包装成更复杂的工作流引擎，而是让 1Shell 本身成为一个可观察、可控制、可长期演进的运维 agent。

新的方向可以概括为：

```text
1Shell 不再只是人操作服务器的工具，
而是一个 local-first、受控、安全、可验证、可记忆的服务器运维 agent。
```

## 2. 核心判断

1Shell 目前已经有 agent 的“身体”：

- WebSSH / command execution：执行能力。
- File manager：文件操作能力。
- Probe：感知能力。
- Audit / trace：事实记录。
- Harness：安全神经系统。
- MCP：对外协作接口。
- AgentRun：单次目标执行循环。
- IDE timeline / approval UI：可观察交互雏形。

但 1Shell 还没有完全形成 agent 的“人格”和“世界模型”：

- 它还没有稳定维护长期目标。
- 它还没有统一理解主机、服务、端口、部署、事故和变更之间的关系。
- 它还没有把每次执行沉淀成可检索、可修正、可遗忘的长期记忆。
- 它还没有形成持续事件循环，只是在用户发起目标后执行一次 AgentRun。
- 它的前端还需要从“工具入口集合”转成“agent command surface”。

因此，下一阶段的主线不是“1Shell AI agent 化”，而是：

```text
1Shell agent 化。
```

AI 不是一个附加面板，而应逐步成为 1Shell 的运行内核之一。WebSSH、文件管理、VPS 管理、MCP、Probe 都不再是产品终点，而是 1Shell Agent 的身体、感官和外部接口。

## 3. 设计原则

### 3.1 慢慢来，形状先行

过去 1Shell AI agent 化失败的一个核心教训是：不要过早引入重型 Task / Program / Skill / planner / workflow 框架，把模型推着走。

因此下一阶段不应一开始就建设庞大的自治系统，而应先把产品“形状”补全：

1. 先重构前端体验，让 1Shell 更像一个 agent，而不是工具页面集合。
2. 先让工具调用过程可视、可信、可调试。
3. 先让同一套工具既能被 UI 使用，也能被 agent 调用。
4. 先建立测试与事件顺序，避免 UI 残影、重复渲染、假 Thinking、假成功。
5. 再逐步引入世界模型、记忆、目标、事件驱动和默认程序。

这个顺序比直接堆功能更安全，也更符合 1Shell 之前踩过的坑。

### 3.2 Harness 只管边界，不管思想

Harness 的职责是：

- 能力准入。
- 风险识别。
- 审批拦截。
- 执行派发。
- 输出脱敏。
- 审计和 trace。
- 事实记录。

Harness 不应该：

- 替模型规划。
- 替模型总结。
- 伪造 Thinking。
- 生成模型口吻的旁白。
- 隐藏重试或修复剧本。
- 静默扩大授权范围。

### 3.3 AgentRun 是唯一默认执行单元

普通对话、IDE 入口、主页浮窗、MCP 入口、未来 CLI 入口，都应该尽量收敛到同一种执行语义：

```text
goal -> AgentRun -> tool calls through Harness -> observations -> final outcome
```

默认情况下，不恢复旧式 workflow authoring，也不把 Task / Program / Skill 默认注入模型上下文。

### 3.4 工具可以可视，但不能变成用户配置负担

下一阶段仍然要补全更多工具，但这些工具不应该被前端展示成“让用户手动挑选插件”的配置面板。

正确方向是：

```text
同一个 tool schema
  -> agent 可调用
  -> Harness 可审批
  -> UI 可渲染
  -> MCP 可暴露
  -> 测试可验证
```

用户看到的是 agent 的行动轨迹、审批内容、diff、验证结果，而不是一堆需要自己配置的内部工具列表。

### 3.5 模型自由判断，观察必须足够硬

模型应该自己判断下一步是回答、调用工具、继续观察、请求审批，还是承认无法验证。

但工具观察必须结构化、可信、不可误读：

- `ok` / `is_error`。
- exit code。
- stdout / stderr 摘要。
- 风险等级。
- 审批状态。
- 真实执行输入和脱敏展示输入分离。
- 未验证结果必须明确标记。

## 4. 目标形态

目标不是把 1Shell 做成“WebSSH + AI 面板”，而是形成如下结构：

```text
1Shell Agent Core
├─ Agent Command Surface     // Web / Desktop / CLI / IDE 统一入口
├─ AgentRun Runtime          // 单次目标执行循环
├─ Harness                   // 安全执行边界
├─ Tool Surface              // 可视、可测、可被 agent 调用的工具层
├─ Action Graph              // 运维语义动作层
├─ World Model               // 主机、服务、端口、部署、事故、变更
├─ Memory                    // 长期事实、偏好、策略、复盘
├─ Objective Manager         // 长期目标、策略、待办、SLO
├─ Event Loop                // probe / schedule / audit / manual triggers
├─ Verifier / Rollback       // 结果验证与回滚
└─ MCP Gateway               // 外部 agent 协作入口
```

短期重点不是一次性完成所有层，而是先补齐 `Agent Command Surface` 与 `Tool Surface`，让 1Shell 的外形先接近 Codex / Claude Code / opencode 这类 agent 体验。

## 5. 核心概念

### 5.1 Agent Command Surface

Agent Command Surface 是用户与 1Shell Agent 交互的统一表面，可以包括：

- Web IDE 页面。
- 主控界面 AI 浮窗。
- 未来 CLI。
- 未来桌面快捷入口。
- 外部 MCP agent 接入后的可观测 run 记录。

它的核心不是工具面板，而是一个 agent shell：

```text
当前目标
当前模型
当前主机 / scope
当前安全模式
真实时间线
工具调用卡片
审批卡片
diff / preview
验证结果
最终 outcome
```

这里的“像 Codex”不是复制 UI，而是学习它的交互语义：

- 一个输入框承接目标。
- agent 自己决定是否调用工具。
- 工具调用、输出、审批、总结按真实顺序出现。
- 用户可以随时中断、批准、拒绝、继续、切换目标或模型。

### 5.2 Tool Surface

Tool Surface 是下一阶段补全工具时的统一约束。

每个工具不只是一段后端函数，而应至少具备：

```text
Tool
├─ name
├─ description
├─ input schema
├─ output schema
├─ capability
├─ risk rules
├─ approval summary renderer
├─ result renderer hint
├─ test fixtures
└─ MCP exposure policy
```

这样工具可以同时服务四件事：

1. UI 可视操作。
2. AgentRun 内部调用。
3. MCP 对外暴露。
4. 自动化测试和回归验证。

这比“继续堆接口”更重要，因为它能避免 UI、agent、MCP、Harness 各自一套语义。

### 5.3 AgentRun Runtime

AgentRun 仍是默认运行单元，负责：

- run 生命周期。
- turn loop。
- budget。
- interrupt。
- tool policy。
- trajectory。
- final gate。
- verifier。
- outcome。

AgentRun 不应该变成旧式 Program / workflow DSL。它应该是足够薄的执行循环，让模型在清晰工具和安全边界内自主工作。

### 5.4 Action Graph

Action Graph 是后续阶段从底层工具走向运维语义的桥。

底层工具是：

- 执行命令。
- 读文件。
- 写文件。
- 上传文件。
- 查看探针。

运维动作是：

- 安装 Docker。
- 部署 GitHub 项目。
- 配置 Nginx 反代。
- 申请 HTTPS 证书。
- 诊断 systemd 服务。
- 回滚部署。
- 清理日志。

Action Graph 不应该一开始成为强 DSL，而应先作为默认程序和工具组合的轻量规范：

```text
Action
├─ preconditions
├─ steps
├─ required tools
├─ risk level
├─ dry-run / preview
├─ verifier
└─ rollback hint
```

### 5.5 World Model

World Model 是 1Shell 对服务器世界的长期理解。

最小版本可以从这些事实开始：

```text
HostFact
ServiceFact
PortFact
DeploymentFact
ImportantFileFact
ChangeRecord
IncidentRecord
```

它不应该一开始就做成复杂知识图谱。更合理的路径是：

1. 从 AgentRun summary 中抽取事实。
2. 从 probe 中沉淀健康状态。
3. 从工具结果中沉淀服务、端口、路径、部署目录。
4. 允许用户编辑、删除、否定错误记忆。
5. 下一次 AgentRun 可以读取相关事实。

### 5.6 Memory

Memory 是 agent 长期变聪明的基础，但要克制。

初期只做结构化记忆，不急着引入复杂向量库：

- 主机事实。
- 服务事实。
- 用户偏好。
- 安全策略。
- 变更记录。
- 事故复盘。
- secret 引用，不保存 secret 明文。

每次 AgentRun 结束后可以生成结构化 summary：

```text
RunSummary
├─ goal
├─ hosts touched
├─ tools used
├─ commands executed
├─ files changed
├─ services touched
├─ facts learned
├─ verification result
├─ remaining uncertainty
└─ follow-up suggestions
```

### 5.7 Objective Manager

Objective Manager 是更后面的阶段。

它让 1Shell 不只是执行一次性目标，而是维护长期目标：

```text
Objective: 保持 blog-server 健康
Scope: host-001
Policy:
  - read-only 自动检查
  - restart 需要审批
  - 删除和重装永远需要审批
SLO:
  - HTTP 200
  - disk < 85%
  - nginx active
```

短期内不必实现完整 Objective Manager，但前端形态要为 `/goal`、当前目标栏、目标切换、目标历史留下空间。

## 6. 前端方向：先把形状补全

用户已经明确过一个非常重要的方向：先重构前端，把形状补全，再慢慢加功能和测试。

这应该成为第一阶段的实际工程主线。

### 6.1 目标

把 1Shell 前端从“功能页面集合”逐步转成“agent command surface”。

第一阶段不追求完全自治，而追求：

- 入口统一。
- 时间线可信。
- 工具调用可视。
- 审批清楚。
- 输出不重复。
- 当前模型、目标、主机、模式可见。
- 命令式交互可以扩展，例如 `/model`、`/goal`。

### 6.2 Agent IDE 的基本布局

建议第一版布局：

```text
┌──────────────────────────────────────────────┐
│ Agent Header                                  │
│ goal / model / host scope / mode / run status │
├──────────────────────────────────────────────┤
│ Timeline                                     │
│ - user goal                                  │
│ - model work note                            │
│ - tool call card                             │
│ - tool result card                           │
│ - approval card                              │
│ - diff / preview                             │
│ - verifier result                            │
│ - final outcome                              │
├──────────────────────────────────────────────┤
│ Composer                                     │
│ input + slash commands + attach/context       │
└──────────────────────────────────────────────┘
```

### 6.3 Slash commands

可以逐步引入轻量命令，而不是重型配置页。

首批建议：

```text
/model     切换或查看当前模型
/goal      设置或查看当前目标
/host      设置或查看当前主机 scope
/mode      设置或查看安全/自治模式
/clear     清空当前会话显示，不删除审计
```

后续再考虑：

```text
/memory    查看或管理当前主机相关记忆
/approve   查看等待审批项
/runs      查看历史 AgentRun
/tools     只用于调试，不作为普通用户默认工具配置入口
```

这些命令不是为了把 1Shell 变成纯 CLI，而是为了让 Web / Desktop / CLI 未来共享一种 agent shell 语义。

### 6.4 工具可视化

工具卡片不应该只是打印 JSON，而应该按工具类型显示：

- command：命令、主机、风险、exit code、stdout/stderr 摘要。
- file read/write：路径、操作、diff、大小、权限。
- probe：指标、状态、时间范围。
- approval：AI 工作笔记和 Harness 审批理由分开。
- verifier：验证目标、验证方法、通过/失败、剩余不确定性。

但工具卡片也不能替模型说话。卡片只显示事实和结构化观察。

### 6.5 UI 不能重排行为

Timeline 必须按真实事件顺序渲染。不要把文本、工具、最终回答拆成多个数组后再按固定槽位拼装。

推荐事件模型：

```text
TimelineEvent
├─ id
├─ runId
├─ turnId
├─ sequence
├─ type
├─ timestamp
├─ payload
└─ status
```

所有流式 chunk、工具调用、审批、结果、最终消息都要有稳定 id 或 sequence，避免残影和重复追加。

## 7. CLI 与 IDE 方向

用户提到“通过制作 cli 与 ide 来裁撤大部分的空间，让其形态趋近于 codex 这种 agent”。这可以作为中期方向，但不要一开始就同时重写所有端。

推荐顺序：

1. Web IDE 先成为 canonical command surface。
2. Desktop 复用 Web IDE。
3. CLI 复用同一套 AgentRun API、slash command 语义和 timeline event。
4. MCP 外部接入也能在 Web IDE 中看到 run 轨迹。

未来 CLI 不是另起炉灶，而是 Web IDE 的终端投影：

```text
oneshell
oneshell /model
oneshell /goal "保持 blog-server 健康"
oneshell run "检查这台 VPS 的 nginx 为什么挂了"
oneshell approve
oneshell runs
```

## 8. 默认程序的重新定义

4.2 计划中提到“默认 AI 工作流程序”。这个方向可以保留，但需要避免回到旧式 workflow authoring。

推荐重新定义为：

```text
Agent Program = AgentRun template + input schema + tool policy + verifier + UI renderer
```

它不是隐藏 planner，也不是强制模型按 DSL 走，而是给高频运维目标提供更好的参数入口、上下文约束和验证方式。

首批默认程序可以是：

1. VPS 基础巡检。
2. Docker 安装/检查。
3. GitHub 项目部署。
4. Nginx/Caddy 反代 + HTTPS。
5. systemd 服务诊断和重启。

但这些不应该在第一步抢在 Agent IDE 之前实现。第一步先把 agent 形状、时间线、工具卡、审批、slash command 打稳。

## 9. 分阶段路线

### Phase 0：守住现有 AgentRun 和 Harness 边界

目标：不让旧问题回潮。

任务：

- 不恢复默认 Task / Program / Skill 语境。
- 不引入隐藏 planner。
- 不让 Harness 生成 AI 口吻旁白。
- 保证实际执行输入和脱敏展示输入分离。
- 保证工具观察结构化且失败足够硬。
- 保证 timeline 按真实顺序渲染。

### Phase 1：Agent Command Surface / 前端形状补全

目标：让 1Shell 的主体验变成 agent shell。

任务：

- 统一 Web IDE 和主控 AI 浮窗的 timeline 体验。
- 增加 Agent Header：goal / model / host scope / mode / run status。
- 引入 `/model`、`/goal`、`/host`、`/mode` 等轻量命令。
- 把工具调用渲染成稳定、可信、按顺序的事件卡片。
- 审批卡继续分离 AI 工作笔记与 Harness 安全理由。
- 为流式 chunk、tool call、tool result、approval、final outcome 增加稳定 id/sequence 去重。
- 清理旧 IDE / Task / Program / Skill 残留入口。

验收：

- 一个用户目标能在同一条 timeline 中完整呈现：输入、Thinking、工具、审批、结果、最终答复。
- 切换页面、迟到 delta、run 完成后不产生重复气泡或残影。
- 用户能看到当前目标、模型、主机 scope 和安全模式。
- 读操作不频繁审批，写入/删除/重启等高风险操作审批清楚。

### Phase 2：Tool Surface 规范化

目标：让更多工具既可视又可被 agent 调用。

任务：

- 为核心工具补齐 schema、risk、renderer hint、approval summary、test fixtures。
- 将命令、文件、探针、服务、MCP 调用统一成 tool event。
- 工具输出标准化：`ok`、`is_error`、`exitCode`、摘要、原始输出引用。
- 增加工具卡片 renderer registry。
- 增加 focused tests，避免工具实际执行被展示用截断参数污染。

验收：

- 新增工具只需要补一份工具定义，就能被 UI、AgentRun、Harness、MCP、测试复用。
- 工具失败在 UI 和模型上下文中都不可被误认为成功。

### Phase 3：轻量 Agent Program

目标：把高频运维流程变成默认可用能力，但不恢复旧式 workflow builder。

任务：

- 定义 Agent Program 最小结构。
- 实现 VPS 基础巡检程序。
- 实现 systemd 服务诊断程序。
- 参数入口复用 Agent Command Surface。
- 执行仍落到 AgentRun。

验收：

- 用户可以选择目标主机并运行默认程序。
- 程序过程仍按 timeline 展示，不进入独立黑盒工作流页面。
- 失败时能继续对话处理。

### Phase 4：World Model 和 Memory 最小版

目标：让 1Shell 开始认识服务器。

任务：

- 新增 host facts / service facts / port facts / change records / memories。
- AgentRun 结束后生成结构化 summary。
- 从 summary 中沉淀事实和变更。
- 下一次 AgentRun 可读取相关事实。
- UI 展示主机事实卡片，并允许用户删除或修正错误事实。

验收：

- 1Shell 能知道某台主机上有哪些常见服务、端口、部署目录和最近变更。
- agent 下一次执行时能引用这些事实，但必须标明来源和不确定性。

### Phase 5：Objective 和事件驱动 Agent

目标：让 1Shell 从响应式工具走向持续运维 agent。

任务：

- 定义 Objective。
- 将 probe alert / schedule / audit 事件转成 diagnostic AgentRun。
- 初期只自动执行只读诊断。
- 高风险修复必须审批。
- 形成 incident summary 和 follow-up。

验收：

- 服务 down、磁盘高、证书即将过期等事件可以自动生成诊断 run。
- 用户看到清楚的计划、风险、审批和验证结果。

## 10. 第一阶段详细建议

第一步不建议直接做 World Model，也不建议直接补一批默认程序。更稳的第一步是：

```text
重构 Agent IDE / Command Surface，先把 1Shell 的 agent 形状补全。
```

具体拆成 6 个小任务：

### 10.1 统一 Agent Shell 外壳

- 以现有 IDE 聊天入口为主，不恢复旧工作台。
- 主控 AI 浮窗复用同一套 timeline 和 composer。
- 增加顶部状态栏：当前 goal、model、host scope、mode、run status。

### 10.2 建立 slash command 解析层

- 先支持 `/model` 和 `/goal`。
- `/model` 只负责查看/切换当前模型，不改变工具策略。
- `/goal` 负责设置当前会话目标，后续消息默认继承。
- slash command 结果也进入 timeline，但不伪装成模型回答。

### 10.3 稳定 TimelineEvent 模型

- 给 text delta、work note、tool call、tool result、approval、final outcome 统一 sequence。
- 前端按 sequence 渲染，不再按 lines/toolCalls 分槽拼接。
- done/error/cancelled 后丢弃迟到 chunk。
- 增加去重保护，继续修复残影问题。

### 10.4 工具卡片 renderer registry

- command card。
- file card。
- probe card。
- approval card。
- verifier card。
- generic JSON card 仅作为 fallback。

### 10.5 工具定义补齐可视元数据

- 给已有核心工具补 `displayName`、`summary`、`riskHint`、`resultKind`。
- 这些元数据只影响展示，不影响真实执行输入。
- 审批摘要仍来自 Harness 的确定性风险判断。

### 10.6 加测试护栏

- Timeline event ordering 测试。
- 重复 chunk 去重测试。
- slash command parser 测试。
- tool result `ok=false` / exit code 展示测试。
- Harness 风险规则继续保持单测。

完成这一步后，1Shell 会先在形态上从“控制台 + AI”变成“agent shell”。这时再补工具、默认程序、world model，会更稳。

## 11. 非目标

下一阶段明确不做或不默认启用：

- 不恢复旧式 workflow builder。
- 不恢复默认 Task / Program / Skill 语境注入。
- 不做用户需要手动配置的内部工具面板。
- 不做隐藏 planner。
- 不让 Harness 伪装成 AI。
- 不默认自动修复生产问题。
- 不在没有可见 scope/policy 的情况下扩大审批授权。
- 不把长期记忆做成不可编辑、不可删除的黑盒。

## 12. 成功标准

短期成功标准：

- 用户打开 1Shell，第一感觉是“这是一个能操作服务器的 agent”，而不是“这是一个面板集合”。
- 用户能在一条 timeline 中看懂 agent 做了什么、为什么要审批、结果是否验证。
- 工具调用既能被 agent 使用，也能以人类可读方式展示。
- 前端不再因状态模型问题制造假顺序、假气泡、残影和重复执行错觉。

中期成功标准：

- 1Shell 能通过默认程序完成常见 VPS 运维任务。
- 1Shell 能记住每台主机的关键事实和最近变更。
- 1Shell 能在 probe 事件触发后自动诊断，并请求用户批准高风险修复。

长期成功标准：

- 1Shell 不再只是 WebSSH、MCP server 或 VPS 管理器。
- 1Shell 成为一个本地优先、受控、安全、可验证、可记忆、可协作的服务器运维 agent。

