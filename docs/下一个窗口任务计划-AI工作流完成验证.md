# 下一个窗口任务计划：先完成 1Shell AI agent 化

> 本文是给下一个开发窗口使用的任务计划。前一版计划把重心放在“创建黄金 Program 并验证 Program agent 化闭环”上；新的判断是，这个顺序仍然太早。AI 工作流 Program 不应从目标里猜出来，而应从一次已验证成功的 1Shell AI AgentRun 轨迹中归纳出来。因此下一个窗口的首要目标是：让 1Shell AI 先成为能真实解决问题、能留下可审计轨迹、能验证成败的受控 Agent。

## 1. 总目标

下一个窗口的主线：

```text
先完成 1Shell AI 的最小 agent 化闭环，再从成功执行轨迹封装 Program。
```

新的核心判断：

```text
Program 不是起点，而是成功 AgentRun 的沉淀结果。
```

如果 1Shell AI 还只是“会调用工具的 AI”，而不是能像运维 Agent 一样持续观察、决策、执行、修复、验证和沉淀轨迹，那么 Program 创作只能依赖 AI 在创建阶段猜测输入、密钥、流程和成功条件。这个方向不可靠。

因此 4.3 当前应先证明：

1. 1Shell AI 能以 AgentRun 为单位真实执行一个运维任务。
2. 执行中可以补信息、请求确认、使用工具、观察结果并继续推进。
3. 所有副作用操作仍经过 Harness / Policy / Audit。
4. 成败由 verifier / outcome 判定，而不是 AI 自称成功。
5. Runtime 能记录足够完整的 trace，用于后续打包 Program。
6. Program 创作从“目标 -> 猜流程”调整为“成功执行 -> 归纳流程 -> 封装 Program”。

需要回答的问题：

1. 1Shell AI 是否能在非 Program 场景下作为 Agent 解决一个真实任务？
2. 它是否能主动发现缺失信息，并通过结构化 interrupt / question / approval 补齐？
3. 它是否能根据工具观察结果调整下一步，而不是只做单轮工具调用？
4. Runtime 是否能记录可归纳的 trace：目标、问题、回答、工具调用、结果、审批、密钥引用、验证和 outcome？
5. 成功路径是否能被抽象为 inputs / secrets / phases / budget / verify / policy？
6. Program 是否只从已验证成功或至少已人工确认的 trace 中生成，而不是从目标直接猜？

## 2. 当前已有基础

当前 4.3 已有的关键成果包括：

- `src/agent-runtime/`：Agent Runtime Kernel v0。
- Program -> AgentRunSpec adapter。
- Agent Runner turn loop。
- Tool envelope -> Harness。
- phase / budget / verify / outcome。
- checkpoint / interrupt / resume。
- store v0。
- control API。
- HTTP 控制 API。
- command verifier。
- `docs/examples/programs/agent-runtime-smoke.yaml` 作为只读 smoke 示例。

但这些还只是底座。下一步不应先要求它生成更多 Program，而应先让 1Shell AI 以通用 AgentRun 形式真正在 1Shell 场景里完成任务，并把完成过程记录成可复用的成功轨迹。

## 3. 明确非目标

下一个窗口不要做：

- 不做完整 IDE 改造。
- 不做 native CLI。
- 不引入 LangChain / LangGraph 依赖。
- 不继续堆很多默认 AI 工作流 Program。
- 不把“根据目标直接生成 Program”当作主线。
- 不把未验证的 Program 草案包装成可靠自动化。
- 不把 Program Engine 全量替换成 LangGraph。
- 不新增 Program 私有 Runtime。
- 不把安全规则重新塞回 prompt。
- 不为了 UI 展示继续扩展大量状态字段。

IDE 与 CLI 统一放到 5.0 方向规划中。4.3 只保留必要 Runtime/API 预留。

## 4. 第一阶段：审计当前 AgentRuntime 是否支撑真正 Agent

### 4.1 读取并理解关键文件

必须先阅读：

```text
docs/4.3更新计划.md
docs/1Shell AI智能体补全计划.md
docs/1Shell AI Agent后续优化与5.0方向.md
src/agent-runtime/index.js
src/agent-runtime/runtime.js
src/agent-runtime/runner.js
src/agent-runtime/outcome.js
src/agent-runtime/verifiers.js
src/programs/agent-adapter.js
src/programs/engine.js
src/programs/program-schema.js
src/harness/guard.js
src/harness/dispatch.js
docs/examples/programs/agent-runtime-smoke.yaml
```

### 4.2 确认当前能力清单

需要确认：

- AgentRun 是否能创建。
- Program AI step 是否能映射 AgentRunSpec。
- Runner 是否能执行单轮和多轮。
- Tool calls 是否经过 `runtime.dispatchTool()`。
- `execute_command` 是否最终进入 Harness。
- phase 是否能更新。
- budget 是否能阻止超限。
- verify 是否能写入 `verification_result` artifact。
- outcome 是否能区分 success / failed / partial / blocked / unverified。
- checkpoint / interrupt / resume 是否不破坏 Program 执行。
- HTTP 控制 API 是否只是预留，不应成为本窗口主线。

还要额外确认通用 1Shell AI Agent 化所需能力：

- 是否存在不依赖 Program 的 AgentRun 创建入口，或当前需要新增最小入口。
- Runner 是否支持多轮 observe / act / observe，而不是只跑一个模型回合。
- 是否能结构化记录 `ask_user` / `request_secret` / `request_approval` 这类人参与事件；没有则需要先设计最小 interrupt 语义。
- Tool call 是否保留足够语义，能区分探测、修改、验证、报告和风险操作。
- Secret 是否只以引用进入 trace，不能把明文写进 prompt、artifact 或日志。
- Verifier / outcome 是否能服务通用 AgentRun，而不只是 Program step。

### 4.3 参考 Codex / OpenCode 的最小借鉴点

本窗口可以参考 `openai/codex` 与 `anomalyco/opencode`，但不要照搬为“代码编辑 Agent”。1Shell 的核心场景仍是 VPS 运维、部署、诊断、Program 沉淀和 MCP 协作。可借鉴的是 Agent 运行结构，而不是产品形态。

从 Codex 借鉴：

- `codex-rs/core/src/session/turn.rs`：模型采样 -> 工具调用 -> 工具结果回灌 -> 继续采样的 turn loop。对应 1Shell 的多轮 observe / act / observe。
- `codex-rs/core/src/tools/orchestrator.rs`：审批 -> sandbox / policy 选择 -> 执行 -> 失败后按策略重试的统一工具编排。对应 1Shell 的 Harness / Policy / Audit 中心化。
- `codex-rs/protocol/src/request_user_input.rs`：结构化向用户提问。对应 1Shell 的 `ask_user` / `request_secret` interrupt。
- `codex-rs/protocol/src/request_permissions.rs`：结构化权限请求与授权范围。对应 1Shell 的 `request_approval` / capability grant。

从 OpenCode 借鉴：

- `packages/opencode/src/session/processor.ts`：流式处理 LLM 输出、tool call part、完成/失败状态、事件发布和 blocked 状态。
- `packages/opencode/src/session/run-state.ts`：每个 session 的 busy / idle / cancel 管理，避免同一会话并发乱跑。
- `packages/opencode/src/tool/tool.ts`：统一工具定义、参数 schema、上下文、metadata、输出截断。
- `packages/opencode/src/tool/question.ts`：把“问用户问题”建模为工具调用并把答案回灌给模型。
- `packages/opencode/src/permission/index.ts`：permission ask/reply、once / always / reject、pending request 管理。

映射到 1Shell 的优先级：

1. 先补通用 AgentRun 入口与 run-state，避免只依赖 Program step。
2. 把 `ask_user`、`request_secret`、`request_approval` 做成结构化 interrupt / tool，而不是普通文本提问。
3. 把所有工具调用统一进 Harness，并记录 tool call start/end、risk、scope、auditId、output excerpt。
4. 增加输出截断和证据摘要，防止远程命令长日志污染上下文。
5. 确保 trace 可归纳为 Program：用户输入、secret 引用、审批点、探测命令、验证命令和最终 artifact 都要结构化。

## 5. 第二阶段：先做最小通用 AgentRun，而不是先写 Program

本阶段目标：证明 1Shell AI 可以作为受控 Agent 真实完成一个低风险任务。

建议第一个真实任务仍然选择：

```text
VPS 基础健康巡检
```

但它一开始不应被当作 Program 创作任务，而应先作为普通 AgentRun 执行：

```text
用户目标 -> 1Shell AI AgentRun -> Harness 工具 -> verifier -> outcome -> trace
```

推荐原因：

- 以只读为主，风险低。
- 能验证命令工具调用。
- 能验证多轮观察与判断。
- 能验证报告证据质量。
- 不需要复杂审批。
- 容易判断 AI 是否重复探测、是否能自主推进。

最小 AgentRun 应验证：

- Agent 能读取目标和 host 上下文。
- Agent 能提出一个简短执行计划。
- Agent 能在只读能力下执行少量命令。
- Agent 能根据命令结果判断是否需要继续探测。
- Agent 能生成包含证据的报告 artifact。
- Agent 能触发 verifier。
- outcome 能给出 success / failed / partial / blocked / unverified。
- trace 能完整记录用于后续封装 Program 的信息。

## 6. 第三阶段：从成功 trace 归纳 Program 草案

只有当某次 AgentRun 已经成功或至少得到人工确认后，才进入 Program 打包阶段。

推荐生成位置：

```text
docs/examples/programs/vps-health-check.yaml
```

这个文件应该标记来源：

```yaml
metadata:
  generated_from: agent_run_trace
  generated_from_run_id: "..."
  program_status: draft_from_verified_trace
```

打包时要从 trace 中抽取：

- 哪些字段是用户每次必须提供的 inputs。
- 哪些信息是运行时可探测项，不应变成输入。
- 是否使用过 secret；只声明 secret 引用，不保存明文。
- 哪些工具调用是探测，哪些是验证，哪些是报告。
- 哪些风险点需要 approval gate。
- 哪些 phase 在成功路径中真实存在。
- 哪些 verify 条件真正证明了成功。

这一步的关键不是“AI 能否写 YAML”，而是：

```text
Program YAML 是否来自已验证流程，而不是来自创建阶段的猜测。
```

### 6.1 Program 目标

Program 目标应简洁：

```text
检查指定 VPS 的基础健康状态，并输出包含证据的巡检报告。
```

不要把大量命令、步骤、路径和输出格式全部塞进 goal。

### 6.2 建议 phases

```yaml
workflow:
  phases:
    - id: collect
      label: 采集基础状态
      required: true
    - id: analyze
      label: 分析异常信号
      required: true
    - id: verify
      label: 验证关键指标
      required: true
    - id: report
      label: 输出巡检报告
      required: true
```

### 6.3 建议 budget

```yaml
workflow:
  budget:
    max_tool_calls: 12
    max_commands: 8
    max_runtime_ms: 180000
    max_output_chars_per_command: 4000
```

### 6.4 建议 capabilities

只读为主：

```yaml
capabilities:
  - read_only
```

### 6.5 建议 verify

最小先用 command verifier 验证命令链路，例如：

```yaml
verify:
  - type: command
    run: "uname -a >/dev/null && uptime >/dev/null"
    expect_exit_code: 0
    timeout: 30000
```

后续再扩展 service / process / disk / tcp 等 verifier。

## 7. 第四阶段：验证 Program replay，而不是验证猜测创作

目标：让从成功 trace 打包出来的黄金 Program 真正走现有 Program Engine 和 Agent Runtime。

### 7.1 最小执行路径

应确认路径为：

```text
Program YAML
  -> Program schema
  -> ProgramAdapter
  -> AgentRunSpec
  -> runAgentTask / Agent Runner
  -> Runtime.dispatchTool
  -> Harness
  -> verifier
  -> outcome
  -> Program run result
```

### 7.2 必须记录的数据

执行时要记录：

- runnerStatus。
- taskStatus。
- phases 状态。
- tool call 数量。
- command 数量。
- 是否触发 budget。
- verification_result artifact。
- outcome reasons。
- 最终 report 是否含证据。
- 是否出现 AI 自称成功但 verify 不通过。
- 是否有重复探测或低效命令。
- replay 与原始成功 trace 的差异。

### 7.3 验收标准

至少应达到：

- Program 可以正常加载。
- AI step 可以创建 AgentRun。
- 执行命令经过 Harness。
- required phase 能完成或明确失败。
- verify 能执行。
- verify 失败时不能 taskStatus=success。
- 成功报告包含关键证据。
- 预算限制有效。
- 生成的 Program 能解释其来源 trace。
- 没有破坏旧 Program v1 基本行为。

## 8. 第五阶段：更新 Program 创作原则

Program 创作链路需要从“目标生成器”改成“成功流程打包器”。

新的原则：

```text
No verified trace, no proven Program.
没有已验证轨迹，就没有正式 Program。
```

允许存在三类产物：

| 状态 | 来源 | 可信度 | 用途 |
|---|---|---|---|
| draft_from_goal | 仅根据目标和 Skill 生成 | 最低 | 只能作为探索计划或草案 |
| draft_from_trace | 从一次成功/确认过的 AgentRun trace 归纳 | 较高 | 可进入 replay 验证 |
| proven | trace 打包后再次 replay 成功 | 最高 | 可作为可靠 Program 分发或内置 |

Program authoring skill 也应据此调整：

- 优先询问是否已有成功 AgentRun。
- 有 trace 时，从 trace 抽取 inputs / secrets / phases / verify / policy。
- 没有 trace 时，只能生成探索计划或草案，不能宣称可靠。
- 不要凭空猜第三方平台 token、权限、Zone ID、API 语义。
- 复杂任务必须先由 1Shell AI Agent 真正跑通，再封装。

## 9. 第六阶段：补齐缺口，而不是继续扩架构

如果验证中发现问题，按优先级修：

### P0：真正 Agent 化闭环

- 只能单轮工具调用，不能 observe / act / observe。
- 不能结构化提问、请求 secret 或请求审批。
- Tool call 没有足够 trace，无法归纳为 Program。
- Secret 明文进入 prompt、日志或 artifact。
- Harness 被绕过。
- verifier 没执行或结果没进入 outcome。
- runnerStatus / taskStatus 错乱。
- Agent 失败但 UI/结果显示成功。

### P1：Trace-to-Program 质量

- trace 无法区分用户输入、运行时探测和 secret。
- trace 无法识别哪些步骤是风险审批点。
- trace 无法抽取 phases / verify / budget。
- Program draft 仍然大量依赖猜测。
- replay 与原始成功路径差异过大。

### P2：效率与可观察性

- AI 重复探测。
- 命令输出过长污染上下文。
- AgentRun timeline 不够清晰。
- verification artifact 不适合展示。
- Program result 与 Agent result 映射不完整。

暂时不要修：

- 完整 IDE。
- CLI。
- LangGraph adapter。
- 大量新内置 Program。

## 10. 建议输出一份验证报告

下一个窗口完成后，应新增或更新一份报告，例如：

```text
docs/1Shell-AI-Agent化验证报告.md
```

报告至少包含：

- 测试 AgentRun 名称与目标。
- 1Shell AI 是否作为非 Program Agent 真实执行任务。
- 使用的工具、命令、host、capability、risk 和 audit 数据。
- 用户补信息 / approval / secret 引用是否结构化记录。
- verifier 结果。
- outcome 判定。
- trace 是否足以归纳 Program。
- 从 trace 打包出的 Program draft。
- Program replay 结果。
- 发现的问题。
- 下一步需要补的 Runtime / Harness / Program / Skill 缺口。

## 11. 下一个窗口建议开场步骤

建议下一个窗口开始后按以下顺序执行：

1. `git status --short --branch`。
2. 读取本文档和三份架构文档。
3. 读取 Agent Runtime / Program Engine / Harness 关键文件。
4. 确认当前未提交变更，不要回滚。
5. 审计是否已有通用 AgentRun 入口；没有则设计最小入口。
6. 选择 VPS 基础健康巡检作为低风险真实 AgentRun。
7. 验证多轮工具调用、Harness、verifier、outcome 和 trace。
8. 从成功 trace 半手动或自动生成 `docs/examples/programs/vps-health-check.yaml`。
9. replay 该 Program，记录与原始 trace 的差异。
10. 只修真实验证暴露的问题。

## 12. 成功定义

下一个窗口如果能证明下面这句话成立，就算完成主线：

```text
1Shell AI 可以先作为受控 Agent 真实完成任务，并留下足以封装 Program 的成功执行轨迹。
```

如果不能证明，也要明确失败原因：

- 是通用 AgentRun 入口不够？
- 是 Runner 不够，无法持续 observe / act？
- 是 Harness 适配不够？
- 是 verifier / outcome 不够？
- 是 trace 结构不够，无法归纳 Program？
- 是 AI service / skill 创作链路还没接好？

这个结果会决定 4.3 后续继续补哪里。Program 只有在 Agent 能真正做成事、并留下可验证成功路径之后，才应该被视为可靠自动化产物。
