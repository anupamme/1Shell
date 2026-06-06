# 1Shell Harness 层架构设计

Harness 是 AI 与外部世界之间的统一执行边界。它不替代底层执行器，而是在 AI 发起命令、文件写入、MCP 调用等真实操作前，集中完成风险识别、人工确认、执行派发、输出打码和审计记录。

## 目标

- **统一入口**：AI 触达外部世界的路径应经过 `harness.dispatch`。
- **确定性护栏**：灾难命令、高风险参数、最小授权和审批策略都由确定性逻辑处理，不依赖 LLM 判断安全性。
- **按上下文授权**：IDE 对话、Program AI、MCP、脚本执行等入口可以使用不同的审批与自动化策略。
- **可回溯**：每次 dispatch 记录结构化轨迹，便于排障、审计和解释拦截原因。
- **低侵入**：保留现有 bridge、local exec、file service 等底层能力，只调整调用边界。

## Dispatch 流程

```text
caller
  ↓
harness.dispatch(toolName, input, context)
  ↓
startTrace
  ↓
guard.check
  ↓
approval gate
  ↓
execute
  ↓
redact output
  ↓
endTrace + audit
```

### 1. Trace

`src/harness/trace.js` 为每次调用生成 trace，记录来源、工具、输入摘要、风险等级、决策结果、耗时和阶段事件。

### 2. Guard

`src/harness/guard.js` 聚合确定性护栏：

- capability 准入；
- 灾难命令红线；
- 高风险操作规则；
- 写入类工具的人审建议。

### 3. Approval gate

`src/harness/dispatch.js` 根据 guard 结果和调用上下文决定是否需要人工确认。

- 人在场入口可以传入 `requestApproval`。
- 无人值守入口默认不等待用户；需要审批但不能审批时拒绝执行。

### 4. Execute

`src/harness/executors.js` 将工具调用派发到底层执行器。执行逻辑本身尽量不重写，local 和 remote 都通过同一层 guard 后再执行。

### 5. Redact

输出在返回前经过 secret redaction，避免 token、密钥等敏感信息进入 UI、日志或模型上下文。

## 安全档位

风险规则由 `src/harness/risk-rules.js` 分类，并按安全档位决定行为：

| 档位 | 行为 |
|---|---|
| `strict` | critical 阻断，high/medium 需要审批 |
| `standard` | critical 阻断，high 需要审批，medium 告警放行 |
| `trusted` | 规则仅告警，灾难命令仍由红线兜底 |

GitHub 通用版默认偏向个人使用体验，生产或多人共享环境可以切到 `strict`。

## Agent 权限隔离

`agentPrivilegeIsolation` 是高级选项，默认关闭。启用后，命令可通过普通用户执行，并为只读诊断命令配置有限 sudo 白名单。

该功能适合受管主机、团队环境或更严格的生产环境；个人自托管使用可以保持关闭，继续使用当前连接用户权限。

## 审计数据

Harness 轨迹写入 `harness_traces`，常规操作流水写入 `audit_logs`。两者配合使用：

- `audit_logs` 回答“发生了什么”；
- `harness_traces` 回答“为什么允许、审批或阻断”。

## 设计边界

Harness 防的是 AI 的误操作和自动化路径的意外高风险行为，不试图对抗已经取得系统权限的恶意攻击者。对于自托管个人工具，这个边界更贴近真实使用场景，也避免引入过重的企业级复杂度。