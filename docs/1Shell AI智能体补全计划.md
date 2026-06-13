# 1Shell AI 智能体补全计划

> 本文是 1Shell 4.3 之后的 AI 架构方向文档。它不是某一个功能页面的需求说明，而是用于约束 1Shell AI、自动化任务、Program、主控台 AI、创作界面 AI、MCP Gateway 与未来 CLI 的长期底座设计。

## 1. 为什么需要这份计划

当前 1Shell 已经拥有多个 AI 相关能力：

- 主控界面 AI。
- AI 工作流 Program。
- Skill / Program 创作能力。
- MCP Server 与 `ask_1shell_ai`。
- Claude Code / Codex / OpenCode 接入向导。
- Harness 安全边界雏形。

但这些能力还没有被统一成一个真正的智能体。

当前更接近：

```text
多个 AI 入口 + 一些工具能力 + 一些安全边界 + 若干运行时逻辑。
```

目标形态应该是：

```text
统一 Agent Runtime Kernel + 多个场景适配器 + 统一工具/策略/Harness 边界。
```

也就是说，1Shell AI 不应该只是“会聊天的 AI”，也不应该只是“能运行 Program 的 AI”。它应该成为一个面向多 VPS 运维、部署、诊断、创作和外部 Agent 协作的受控智能体。

新的关键判断是：用户侧主语应升级为“自动化任务”。Program 是自动化任务经过验证后沉淀出的可复用封装，而不是一开始从目标里猜出来的起点。复杂运维任务需要的输入、secret、第三方平台权限、审批点和验证条件，只有在 1Shell AI 真正完成任务并得到 verifier / outcome 确认后才可靠。因此可靠 Program 更应该是成功 AgentRun 的沉淀结果，而不是创建阶段的空想起点。

自动化任务与 Program 打包的详细设计见：`docs/1Shell自动化任务-AgentRun到Program打包设计.md`。

## 2. 对真正智能体的定义

在 1Shell 语境中，一个真正的智能体不是简单的 LLM 对话，而是具备以下循环：

```text
理解目标
  -> 形成计划
  -> 调用工具
  -> 观察结果
  -> 更新状态
  -> 判断下一步
  -> 必要时请求确认
  -> 验证成功条件
  -> 产出可审计结果
```

对应能力包括：

- 能理解用户目标、Program goal 或外部 MCP 请求。
- 能选择合适工具，而不是只能生成文本。
- 能记录状态，而不是每一轮都像第一次执行。
- 能控制预算，避免无限探测和上下文膨胀。
- 能在风险点暂停并等待用户确认。
- 能通过 verifier 判断任务是否真的成功。
- 能生成报告、diff、Program spec、部署计划等 artifact。
- 所有副作用操作必须经过 Harness / Policy / Audit。

## 3. 概念边界

### 3.1 LLM

LLM 是大脑，负责理解、推理、生成计划、解释工具结果和形成报告。

但 LLM 不应该直接等于执行者。

它可以生成工具调用意图：

```text
我要在 host A 上执行 nginx -t。
我要读取某个配置文件。
我要写入一个 Program YAML。
```

真正执行前必须经过工具层与 Harness。

### 3.2 LangChain

LangChain 更适合作为 Model / Tool / Parser / Retriever / Memory 的 adapter 层。

它可以帮助 1Shell：

- 统一模型调用。
- 绑定工具 schema。
- 做结构化输出解析。
- 管理上下文、记忆和 RAG。
- 对接不同 provider。

但 1Shell 不应该把自己的核心智能体概念直接绑定到 LangChain。更合理的是：

```text
1Shell 定义 Agent Runtime 接口。
LangChain 作为未来可插拔 adapter。
```

### 3.3 LangGraph

LangGraph 更适合作为 Graph Executor / Checkpoint / Interrupt / Resume 的 adapter 层。

它启发 1Shell 的地方是：

- State 是一等公民。
- 节点、边和条件分支显式存在。
- 可 checkpoint。
- 可 interrupt / resume。
- 可以把 Agent 从普通 tool loop 升级为可控状态机。

但 4.3 不直接把 Program Engine 替换成 LangGraph。更合理的是：

```text
1Shell 先定义自己的中立 AgentState / AgentEvent / AgentToolCall。
未来 LangGraph 可以作为执行器 adapter 接入。
```

### 3.4 MCP

MCP 是工具发现与调用协议。

它帮助 Agent 理解“外部有哪些工具可以用”，例如：

- `list_hosts`
- `host_exec`
- `read_remote_file`
- `write_remote_file`
- `ask_1shell_ai`

但 MCP 不是安全策略本身，也不是完整智能体运行时。

在 1Shell 中，MCP 有两个方向：

- 对外：1Shell 作为 MCP Server，给 Claude Code、Codex、OpenCode 等外部 Agent 调用。
- 对内：未来 1Shell AI 可以作为 MCP Client，调用第三方 MCP Server 扩展能力。

### 3.5 Harness

Harness 是副作用操作的安全屏障。

它不负责替 LLM 思考，但负责审核 LLM 产生的动作意图。

所有真实操作都应该经过 Harness：

- 执行命令。
- 写文件。
- 删除文件。
- 上传/下载文件。
- 重启服务。
- 调用外部 MCP Server。
- 调用本地 CLI。
- 执行 Skill 里的写操作。

Harness 的职责包括：

- 风险识别。
- 权限判断。
- host/path/workspace scope 限制。
- 必要时请求用户确认。
- 强制注入安全参数。
- secret 脱敏。
- 审计记录。

### 3.6 Skill

Skill 是指导和知识包，不是执行引擎本身。

Skill 可以告诉 1Shell AI：

- 某类任务应该如何拆阶段。
- 创建 Program 时应该遵守哪些规则。
- 前端结构应该怎样生成。
- 运行期报告应该包含哪些证据。

但 Skill 不能替代 Harness，也不能替代 Runtime State。

### 3.7 CLI

CLI 是入口和执行层工具之一，不是智能体内核。

未来可能存在：

```bash
1shell ai "检查所有 VPS 的磁盘和负载"
1shell program run deploy-github --host vps-1
1shell agent resume <runId>
```

但 CLI 应该在 Agent Runtime 稳定后接入，而不是先于 Runtime 成为主线。

## 4. 总体架构

推荐目标结构：

```text
主控台 / Program / Studio / MCP ask_1shell_ai / 未来 CLI / 外部 Agent
        |
        v
  Scenario Adapter
        |
        v
  1Shell Agent Runtime Kernel
        |
        |-- Model Adapter
        |     |-- direct OpenAI compatible
        |     |-- direct Anthropic compatible
        |     |-- future LangChain adapter
        |
        |-- Graph Executor
        |     |-- native simple executor
        |     |-- future LangGraph executor
        |
        |-- Tool Runtime
              |
              v
        Harness / Policy / Audit / Redaction
              |
              v
    SSH / MCP Server / Skill / CLI / File / Local Shell / Remote Host
```

关键原则：

1. 通用 AgentRun 是最小验证对象，Program 是成功路径沉淀后的重要消费者，不是唯一消费者。
2. Agent Runtime 不绑定 LangChain / LangGraph，但预留 adapter。
3. 所有副作用工具调用必须经过 Harness。
4. UI 订阅 AgentEvent，而不是直接解析某个模型输出。
5. 1Shell 定义运维语义、安全边界、工具权限、审计和验证闭环。
6. Prompt 只能表达稳定角色、契约和上下文，不应用“遇到问题就追加禁止项”的方式替代架构约束。凡是工具乱用、阶段错乱、验证缺失、输出位置错误等行为问题，应优先在 Runtime State、Tool Policy、Harness、事件协议、UI 状态机或 verifier 中解决；只有长期稳定、跨场景成立的行为契约才允许进入系统提示词。

## 5. 1Shell AI 的入口

### 5.1 主控台 AI

目标：从普通问答升级为运维 Agent。

示例任务：

```text
帮我看看哪台 VPS 负载异常。
帮我诊断 nginx 502。
帮我找出磁盘快满的机器，并给出清理建议。
```

需要能力：

- list_hosts。
- 读取主机画像与探针状态。
- 按 host 执行诊断命令。
- 汇总多主机证据。
- 高风险修复前请求确认。
- 输出可审计报告。

### 5.2 AI 工作流 Program

目标：把“人操控智能体完成某个运维任务的过程”包装成可复用程序。

4.3 的新顺序是：先让 1Shell AI 作为通用 AgentRun 真实完成任务，再从已验证成功的 trace 中归纳 Program。Program Runtime v2 仍然重要，但它不应鼓励 AI 在没有执行证据的情况下直接猜流程。

推荐链路：

```text
用户目标
  -> 1Shell AI AgentRun 真实执行
  -> Harness / verifier / outcome 确认成败
  -> Runtime trace 记录成功路径
  -> Trace-to-Program 归纳 inputs / secrets / phases / budget / verify / policy
  -> Program replay 验证
```

重点补强：

- phase contract。
- budget contract。
- verify contract。
- runnerStatus / taskStatus 分离。
- success guard。
- 结构化命令结果。
- trace provenance：Program 能说明它来自目标草案、成功 trace，还是 replay 验证后的 proven 状态。

### 5.3 Studio / Skill / Program 创作界面

目标：从提示词辅助升级为创作 Agent。

示例任务：

```text
帮我创建一个一键部署 Node 项目的 Program。
帮我修改已有 Program，让它增加 HTTPS 验证。
帮我生成一个面向 Claude Code 的 1Shell Skill。
```

需要能力：

- 生成结构预览。
- 等待用户确认。
- 写入文件。
- 检查 schema。
- 修复格式错误。
- 输出 artifact / diff。
- 创建期禁止远程探测。

后续“创造界面”应逐步从普通创建表单升级为 1Shell AI IDE：

```text
左侧资源树：Program、Skill、主机、文件、任务模板。
中间工作区：AI 会话、任务计划、Program YAML、Skill 文档、diff 和 artifact。
右侧运行面板：AgentRun 状态、timeline、tool calls、checkpoint、interrupt、verify 结果。
底部控制台：终端、日志、CLI 命令预览和未来 native CLI 入口。
```

这个 IDE 的核心不是“更多表单项”，而是让 1Shell AI 以 AgentRun 为单位创作、修改、验证和交付产物。Program 创作、Skill 创作、前端生成、运维任务和未来 CLI 都应共享同一套 Agent Runtime 语义。

初始视觉方向：深色代码工作台、运行绿色强调色、技术型等宽字体；优先保证可读性、键盘导航、清晰 focus 状态和 44px 以上交互目标。UI 展示应默认聚合摘要，把 tool calls、checkpoint、interrupt 等高级细节放入可展开面板。

### 5.4 MCP `ask_1shell_ai`

目标：外部 Agent 不直接接触所有内部细碎能力，而是可以把复杂任务委托给 1Shell AI。

示例：

```text
Claude Code -> ask_1shell_ai("帮我判断哪台 VPS 不健康")
```

未来应映射为：

```text
McpGatewayAdapter -> AgentRunSpec -> AgentRuntime -> 结构化结果
```

### 5.5 未来 native CLI

目标：让人、脚本和 Agent 都能从终端调用 1Shell。

但 CLI 不作为 4.3 主线。它应在 Agent Runtime Kernel 稳定后成为新入口。

### 5.6 外部 Agent 接入

Claude Code / Codex / OpenCode 等外部 Agent 通过 MCP 使用 1Shell。

它们不等于 1Shell AI 本体，但会通过 MCP、Skill 和 Harness 与 1Shell AI 生态协作。

## 6. Agent Runtime Kernel v0

### 6.1 AgentRunSpec

一次智能体运行的输入合同。

建议字段：

```ts
interface AgentRunSpec {
  id?: string;
  source: 'console' | 'program' | 'studio' | 'mcp' | 'cli' | 'external-agent';
  goal: string;
  context: AgentContext;
  tools: AgentToolSpec[];
  policy: AgentPolicy;
  outputContract?: AgentOutputContract;
  metadata?: Record<string, unknown>;
}
```

其中：

- `source` 决定默认权限和 UI 映射。
- `goal` 是当前任务目标。
- `context` 放 host、inputs、workspace、conversation、programId 等。
- `tools` 是本次允许使用的工具。
- `policy` 是预算、安全、审批和能力约束。
- `outputContract` 是成功条件、结果格式和验证要求。

### 6.2 AgentState

一次运行的状态。

建议字段：

```ts
interface AgentState {
  runId: string;
  source: string;
  runnerStatus: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval' | 'interrupted';
  taskStatus: 'unknown' | 'success' | 'failed' | 'partial' | 'blocked' | 'unverified';
  currentPhase?: string;
  phases: Record<string, AgentPhaseState>;
  budget: AgentBudgetState;
  toolCalls: AgentToolCallRecord[];
  artifacts: AgentArtifact[];
  checkpoints: AgentCheckpoint[];
  interrupts: AgentInterrupt[];
  result?: AgentResult;
}
```

核心点：

- `runnerStatus` 表示运行器是否跑完。
- `taskStatus` 表示用户目标是否真正达成。
- 这两个状态必须分离。

### 6.3 AgentEvent

统一事件模型，用于 UI、日志、MCP、CLI 订阅。

候选事件：

```text
agent:run-started
agent:run-ended
agent:phase-started
agent:phase-ended
agent:tool-call-started
agent:tool-call-ended
agent:artifact-updated
agent:checkpoint-created
agent:interrupt-created
agent:approval-resolved
agent:result-published
```

Program 页面可以把这些事件映射成 workflow UI，主控台可以映射成聊天过程，CLI 可以映射成终端输出。

### 6.4 AgentPolicy

策略对象。

建议字段：

```ts
interface AgentPolicy {
  riskLevel?: 'low' | 'medium' | 'high';
  allowedTools?: string[];
  deniedTools?: string[];
  capabilities?: string[];
  hostScope?: string[] | 'all' | 'current';
  pathScope?: string[];
  workspaceScope?: string[];
  maxToolCalls?: number;
  maxCommands?: number;
  maxRuntimeMs?: number;
  maxOutputCharsPerCommand?: number;
  requireApproval?: string[];
  readOnly?: boolean;
}
```

它要能表达：

- Program AI 只能操作当前 host。
- Studio AI 可以写 `data/programs`，但不能远程探测。
- MCP 外部 Agent 只能用 standard profile。
- 主控台 AI 可以跨 host 读，但高风险写操作要确认。

### 6.5 AgentToolCall / AgentToolResult

统一工具调用 envelope。

```ts
interface AgentToolCall {
  runId: string;
  source: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: string;
  capability?: string;
  scope?: {
    hostId?: string;
    path?: string;
    workspace?: string;
  };
}
```

```ts
interface AgentToolResult {
  ok: boolean;
  exitCode?: number;
  durationMs?: number;
  content?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  evidence?: string[];
  data?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
  auditId?: string;
}
```

所有工具调用进入执行层前都必须经过 Harness。

### 6.6 AgentArtifact

智能体产物。

候选类型：

```text
report
program_spec
program_draft
file_diff
deploy_plan
diagnostic_result
verification_result
mcp_config
rollback_plan
```

Artifact 应该是 UI 一等公民，避免所有结果都塞在纯文本里。

## 7. Program Runtime v2 映射

Program 不应拥有私有 Agent 内核，而应通过 adapter 接入通用 Agent Runtime。可靠 Program 优先来自已验证 AgentRun trace，而不是创建阶段凭目标猜测。

映射关系：

```text
Program YAML
  -> ProgramAdapter
  -> AgentRunSpec
  -> AgentRuntime
  -> AgentEvent
  -> ProgramsView
```

Program YAML 可逐步增加：

```yaml
workflow:
  task_type: deploy
  phases:
    - id: env_check
      label: 环境检查
      required: true
    - id: deploy
      label: 部署
      required: true
    - id: verify
      label: 验证
      required: true
    - id: result
      label: 结果
      required: true
  budget:
    max_tool_calls: 16
    max_commands: 8
    max_runtime_ms: 600000
    max_output_chars_per_command: 8000
  success:
    requires_verify: true
    requires_phases:
      - env_check
      - deploy
      - verify
verify:
  - type: http
    url: "{{ inputs.url }}"
    expect_status: [200, 301, 302]
metadata:
  generated_from: agent_run_trace
  generated_from_run_id: "..."
  program_status: draft_from_trace
```

旧 Program 没有这些字段时，仍走兼容模式。

### 7.1 Trace-to-Program 原则

Program Creator 不应只是目标生成器，而应优先作为成功流程打包器。

```text
No verified trace, no proven Program.
没有已验证轨迹，就没有正式 Program。
```

允许存在三类 Program 产物：

| 状态 | 来源 | 含义 |
|---|---|---|
| draft_from_goal | 仅根据用户目标和 Skill 生成 | 只能作为探索计划或草案 |
| draft_from_trace | 从一次成功/人工确认过的 AgentRun trace 归纳 | 可进入 replay 验证 |
| proven | trace 打包后再次 replay 成功 | 才适合作为可靠 Program 分发或内置 |

Trace-to-Program 至少应抽取：

- 用户每次必须提供的 inputs。
- 运行时可以自动探测的信息。
- 使用过的 secret 引用及所需权限范围。
- 工具调用中的探测、修改、验证和报告语义。
- 风险审批点。
- 成功路径中真实存在的 phases。
- verifier 能证明成功的条件。

## 8. Harness 对接原则

Harness 不应该只服务 Program，也不应该只服务 MCP。

它应该服务所有 source：

```text
program-ai
console-ai
studio-ai
mcp-remote
mcp-local
cli-agent
external-agent
```

基本规则：

- 读操作可以低风险放行，但仍记录审计。
- 写文件、删除、重命名、上传、重启服务、修改配置等属于有副作用操作。
- 破坏性操作需要确认或更高 capability。
- source 不同，默认权限不同。
- 所有命令结果进入 AI 上下文前做 secret redaction。
- 所有工具执行返回 auditId。

## 9. Verify Contract

1Shell AI 的重要差异点是：成功不能只由 AI 自己宣布。

Verifier 应逐步支持：

- HTTP verifier。
- TCP verifier。
- DNS verifier。
- TLS verifier。
- process verifier。
- service verifier。
- command verifier。
- file verifier。

执行原则：

```text
AI 负责尝试完成任务和解释结果。
Verifier 负责判定成功条件是否真的通过。
Engine 负责阻止未验证成功被标记为 success。
```

## 10. Interrupt / Human-in-the-loop

运维任务遇到风险时需要暂停。

典型场景：

- 需要删除目录。
- 需要覆盖配置文件。
- 需要重启 nginx / docker / systemd 服务。
- 发现已有生产站点占用端口。
- 需要写入证书、密钥或防火墙规则。

状态应进入：

```text
runnerStatus = waiting_approval
taskStatus = blocked
```

并生成 `AgentInterrupt`：

```json
{
  "type": "approval_required",
  "risk": "可能影响现有 nginx 站点",
  "proposedAction": "备份配置后写入新的 server block 并 reload nginx",
  "choices": ["继续", "修改方案", "终止"]
}
```

## 11. LangChain / LangGraph 未来接入方式

### 11.1 LangChain 接入位置

未来可以新增：

```text
LangChainModelAdapter
LangChainToolAdapter
LangChainOutputParserAdapter
LangChainMemoryAdapter
```

但 1Shell 业务对象仍然是 AgentRunSpec / AgentState / AgentToolCall。

### 11.2 LangGraph 接入位置

未来可以新增：

```text
LangGraphExecutorAdapter
```

负责把 1Shell 的 AgentRunSpec 映射成 LangGraph graph，把 AgentState 映射成 graph state，把 checkpoint/interrupt/resume 映射成 LangGraph 能力。

但 1Shell 不应该把产品语义写死成 LangGraph 专属格式。

### 11.3 不被框架锁死的原则

- Program YAML 不出现不可替换的 LangGraph 私有字段。
- Harness 不依赖 LangGraph 才能执行安全策略。
- Tool registry 不只服务 LangChain。
- UI 订阅 1Shell AgentEvent，而不是订阅某个框架事件。
- LangChain / LangGraph 是增强，不是 1Shell AI 的全部定义。

## 12. CLI 的位置

CLI 缺失是事实，但不应先于 Agent Runtime 成为 4.3 主线。

未来 CLI 应该只是新入口：

```text
CLIAdapter -> AgentRunSpec -> AgentRuntime
```

候选命令：

```bash
1shell ai "检查所有 VPS 的健康状态"
1shell agent run <task>
1shell agent resume <runId>
1shell program list
1shell program run <id> --host <host>
1shell mcp config
```

如果没有统一 Runtime，先做 CLI 只会新增一个分散入口；有了 Runtime，CLI 会自然变薄。

## 13. 分阶段路线

### v0：文档与接口边界

- 完成本文档。
- 完成 4.3 更新计划。
- 明确 AgentRunSpec / AgentState / AgentEvent / AgentPolicy / AgentToolCall 的最小字段。

### v0.1：Program Runtime v2 最小闭环

- Program 映射 AgentRunSpec。
- runnerStatus / taskStatus 分离。
- phase contract。
- budget contract。
- success guard。
- 最小 verify contract。

### v0.2：统一工具 envelope 与 Harness 对接

- Program `execute_command` 先接入统一 envelope。
- 工具结果结构化。
- 审计与脱敏字段统一。

### v0.3：黄金 Program

- VPS 基础巡检。
- 服务日志诊断。
- GitHub 项目部署。

重点验证 Runtime 合同，而不是追求 Program 数量。

### v0.4：主控台 AI 接入

- 主控台 AI 可以列主机、诊断、调用工具、验证、报告。
- 高风险操作进入 interrupt。

### v0.5：Studio AI 接入

- Program/Skill 创作通过 Agent Runtime 执行。
- 生成结构预览、等待确认、写文件、检查 schema、修复错误。

### v0.6：CLI 接入预研

- CLI 作为 Agent Runtime 的轻量入口。
- 支持 run/resume/status。

### v1：LangChain / LangGraph adapter 评估

- 在 Runtime 边界稳定后决定是否接入。
- 优先实验复杂任务和可恢复任务。

## 14. 4.3 最小可交付范围

4.3 不要求完成完整智能体，但至少要做到：

- 文档层面明确 1Shell AI 的目标架构。
- 代码层面出现 Agent Runtime Kernel v0 的最小内部结构。
- AI 工作流 Program 不再只靠 prompt 自觉，而开始拥有 phase / budget / verify / success guard 的硬约束。
- 至少一个黄金 Program 能用新合同运行。
- 旧 Program 不被破坏。
- 所有副作用工具仍受 Harness / Audit / Redaction 保护。

## 15. 风险与控制

### 风险一：过度工程化

控制：先做最小对象和 Program 落地，不急着完整 graph engine。

### 风险二：框架锁定

控制：LangChain / LangGraph 只作为 adapter 位置，不作为 1Shell 业务对象。

### 风险三：Program 私有化

控制：Runtime 命名和接口保持通用，Program 只是 adapter。

### 风险四：安全绕过

控制：所有真实工具调用必须通过统一 Tool Envelope 和 Harness。

### 风险五：UI 过度暴露内部状态

控制：普通用户默认看阶段、证据和结果；高级状态折叠显示。

### 风险六：旧能力回归

控制：Program v1 兼容；新增字段可选；逐步迁移黄金样例。

## 16. 最终判断

1Shell 迟早需要 LangChain / LangGraph 类能力，也迟早需要 native CLI。

但当前最优先的不是立刻接入框架，也不是立刻补一批默认 AI 工作流，而是：

```text
先补 1Shell AI 的 Agent Runtime 最小底座。
再用 AI 工作流 Program 作为第一个落地场景。
然后逐步把主控台、Studio、MCP ask_1shell_ai、CLI 接入同一个 Runtime。
```

这样 1Shell AI 才能从“多个 AI 功能入口”成长为真正受控、可执行、可观测、可验证的智能体。
