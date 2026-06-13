# 1Shell AI Agent 后续优化与 5.0 方向

> 本文用于承接 4.3 的 Agent Runtime Kernel 工作，并约束后续 1Shell AI、AI 工作流 Program、IDE、CLI、MCP 与外部 Agent 的演进节奏。

## 1. 当前判断

1Shell AI 的 agent 化不是一个小版本内可以彻底完成的功能，而是一个长期工程。

4.3 当前已经开始补齐最小 Agent Runtime Kernel：

- AgentRunSpec / AgentState / AgentEvent。
- Runner turn loop。
- Tool envelope 与 Harness 对接。
- phase / budget / verify / outcome。
- checkpoint / interrupt / resume。
- store v0。
- control API 与最小 HTTP 控制面。
- Program 作为第一个消费者接入。

但这些只能说明：

```text
1Shell AI Agent Runtime Kernel v0 已进入可验证阶段。
```

不能宣称：

```text
1Shell AI 已经完整 agent 化。
```

真正的 1Shell AI Agent 还需要根据 1Shell 的核心功能持续调整，包括服务器运维、应用部署、问题诊断、Program 创作、Skill 创作、前端生成、MCP 协作、外部 Agent 协作和未来 CLI。

## 2. 4.3 与 5.0 的边界

### 2.1 4.3 的主线

4.3 的主线应收束为：

```text
先验证 1Shell AI 的最小 agent 化闭环，再从成功执行轨迹封装 AI 工作流 Program。
```

也就是证明：

- 1Shell AI 不只是能调用工具，而是能以 AgentRun 为单位真实解决低风险运维任务。
- AI 能通过 Runtime 进行工具调用、观察结果、更新状态、必要时中断、继续运行。
- Runtime 能记录目标、用户补信息、工具调用、审批、secret 引用、artifact、verify 和 outcome。
- Program 创作从“目标 -> 猜流程”改为“成功 AgentRun trace -> 归纳流程 -> 封装 Program”。
- 所有副作用操作经过 Harness。
- 任务成功由 verifier / success guard / outcome 判定，而不是 AI 自称成功。
- runnerStatus 与 taskStatus 能在真实 Program 中稳定表达。
- phase / budget / verify / artifact / event 能支撑前端展示和后续 CLI。

4.3 不应继续发散到完整 IDE 或完整 CLI。

### 2.2 5.0 的主线

5.0 更适合承载：

```text
1Shell AI IDE + native CLI + 更完整的智能体入口统一。
```

理由：

- CLI 通常应该早于或至少同步于 IDE 形成稳定命令语义。
- IDE 和 CLI 都应复用同一套 AgentRun / checkpoint / interrupt / resume / cancel 语义。
- 如果 4.3 在 Runtime 尚未完成真实 Program 验证前就大改 UI，容易让 UI 反过来绑架 Runtime。
- 5.0 可以在 4.3 的真实验证结果基础上设计更稳定的交互模型。

## 3. 5.0 方向：CLI 与 IDE 统一

### 3.1 CLI 的位置

CLI 不是智能体内核，而是 Agent Runtime 的入口之一。

未来 CLI 应表达：

```bash
1shell ai "检查所有 VPS 的磁盘和负载"
1shell agent list
1shell agent show <runId>
1shell agent timeline <runId>
1shell agent approve <runId> <interruptId>
1shell agent cancel <runId>
1shell program run <programId> --host <hostId>
1shell program create "一键部署 Node 项目"
```

CLI 不应绕过 Runtime，也不应绕过 Harness。

推荐映射：

```text
CLIAdapter -> AgentRunSpec -> AgentRuntime -> Harness -> AgentEvent / AgentResult
```

### 3.2 IDE 的位置

IDE 是 Agent Runtime 的可视化工作台，不是独立智能体系统。

未来 IDE 应围绕以下对象组织：

- AgentRun。
- AgentEvent timeline。
- AgentArtifact。
- AgentInterrupt。
- Tool calls。
- Checkpoint / resume。
- Program / Skill / file diff。
- CLI command preview。

推荐布局：

```text
左侧：Program / Skill / 文件 / 主机 / 任务导航。
中间：AI 会话、计划、diff、YAML、Skill 文档、artifact 工作区。
右侧：AgentRun 状态、timeline、tool calls、checkpoint、interrupt、verify 结果。
底部：终端、日志、CLI 预览。
```

IDE 和 CLI 的关系：

```text
CLI 负责明确、可脚本化、可审计的命令入口。
IDE 负责可视化、交互式、可编辑的智能体工作台。
二者共享 Runtime，不共享一堆临时 UI 私有状态。
```

## 4. 1Shell AI 后续优化方向

### 4.1 服务器运维 Agent

目标：让主控台 AI 从问答升级为受控运维 Agent。

需要能力：

- 主机列表与画像读取。
- 探针状态分析。
- 跨主机只读诊断。
- 高风险修复前中断确认。
- 统一报告 artifact。
- 命令证据与审计链接。

典型任务：

```text
检查所有 VPS 的磁盘、负载、内存和关键服务状态。
诊断某台机器 nginx 502。
找出近期流量异常的节点。
```

### 4.2 开发与部署 Agent

目标：让 1Shell AI 能辅助部署、调试和维护应用。

需要能力：

- 项目结构识别。
- 依赖与运行方式判断。
- 部署计划 artifact。
- 文件 diff。
- 回滚计划。
- verify contract。

典型任务：

```text
把 GitHub 项目部署到指定 VPS。
修复服务启动失败。
生成 nginx reverse proxy 配置并验证。
```

### 4.3 Program 创作 Agent

目标：把“人操控 Agent 完成一类任务”的过程打包为 Program。

重点不是让 AI 根据目标猜一个完整 Program，而是依赖真实成功轨迹做 Trace-to-Program：

```text
先解决任务 -> 捕获 AgentRun trace -> verifier/outcome 确认成功 -> 参数化 -> 生成 Program draft -> replay 验证 -> proven Program
```

因此 Program 创作 Agent 需要依赖：

- Program authoring skill。
- Program schema。
- workflow contract。
- Runtime trace / artifact。
- secret 引用与审批记录。
- schema validation。
- replay / verify。

没有已验证轨迹时，只能生成 `draft_from_goal` 或探索计划，不能宣称得到可靠自动化；从成功轨迹生成的 Program 至少应标记为 `draft_from_trace`，只有 replay 成功后才应进入 `proven` 状态。

### 4.4 Skill 创作 Agent

目标：让 Skill 成为指导包，而不是执行引擎。

后续需要：

- Skill 结构校验。
- Skill 与 Program 的边界校验。
- Skill 使用效果反馈。
- Skill 版本与适用场景说明。

### 4.5 MCP 与外部 Agent 协作

目标：外部 Claude Code / Codex / OpenCode 能把复杂任务委托给 1Shell AI，但不能绕过 Harness。

推荐方式：

```text
ExternalAgent -> MCP ask_1shell_ai -> AgentRunSpec -> AgentRuntime -> Harness
```

## 5. LangChain / LangGraph 的接入节奏

LangChain / LangGraph 仍然重要，但不应提前接管 1Shell 的产品语义。

推荐节奏：

1. 4.3 先完成 1Shell AI 最小 AgentRun 闭环与真实任务验证。
2. 再验证成功 AgentRun trace 能否封装为 Program，并通过 Program replay。
3. 补齐真实场景下缺失的 state / tool / verify / memory 能力。
4. 再评估 LangChain adapter 是否能提升 model/tool/parser/memory 层。
5. 再评估 LangGraph adapter 是否适合作为 graph executor / checkpoint / interrupt / resume 后端。

边界：

```text
1Shell 定义运维语义、安全边界、审计、验证和 UI 事件。
LangChain / LangGraph 作为 adapter 或 executor，不作为 1Shell 的唯一主语义。
```

## 6. 后续验收标准

在进入 5.0 前，至少应确认：

- 1Shell AI 能以 AgentRun 为单位真实完成低风险运维任务。
- AgentRun trace 能记录用户补信息、工具调用、secret 引用、审批、artifact、verify 和 outcome。
- AI 工作流 Program 能从成功 trace 归纳草案，并通过 replay 验证核心路径。
- AI 工作流 Program 能通过 Agent Runtime 稳定执行。
- Harness 能拦住副作用风险。
- verify / outcome 能阻止假成功。
- AgentRun / timeline / artifact 能支撑 UI 与 CLI。
- Runtime 缺口来自真实任务验证，而不是想象中的架构补全。

5.0 的验收应包括：

- CLI 能完整观察和控制 AgentRun。
- IDE 能复用 CLI / Runtime 语义。
- 主控台 AI、Program、Studio、MCP 至少两个入口复用同一 Runtime。
- 真实服务器运维和开发任务能形成可审计闭环。

## 7. 当前结论

4.3 不应继续扩大到 IDE / CLI 大改。

4.3 下一步应回到最关键的产品验证：

```text
1Shell AI 能不能先作为受控 Agent 真实完成任务，并留下足以封装 Program 的成功执行轨迹。
```

Agent 化要慢慢做，后续根据 1Shell 的服务器运维与开发功能持续调整。Program 是 Agent 成功路径的沉淀，不应继续主要依赖创建阶段的猜测。
