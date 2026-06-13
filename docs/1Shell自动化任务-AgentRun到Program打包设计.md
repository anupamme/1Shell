# 1Shell 自动化任务：AgentRun 到 Program 打包设计

> 本文用于定义 1Shell 4.3 之后的“自动化任务”产品语义，以及从已验证 AgentRun 沉淀为可复用 Program 的内部打包能力。它替代过去容易混淆的“AI 工作流程序”说法，但不要求立即重命名代码中的 Program 域。

## 1. 背景

过去的 Program 创作路径容易落入：

```text
目标 -> AI 猜输入 -> AI 猜流程 -> AI 猜 secret -> AI 猜验证方式 -> 写 Program
```

这个路径的问题是，复杂运维任务真正需要哪些输入、权限、secret、审批点和验证条件，通常只有在 AI 真实执行并验证后才会暴露。用户一开始并不能保证把所有信息给全，AI 也不应该凭空猜。

新的主线是：

```text
先解决，再捕获，再封装。
```

即：

```text
用户目标
  -> 1Shell AI 以 AgentRun 真实执行
  -> ask_user / request_secret / approval 补齐运行中发现的信息
  -> verifier / outcome 验证成功
  -> 从 verified AgentRun 提取可复用流程
  -> 生成 Program draft
  -> replay 验证
  -> proven Program
```

## 2. 核心术语

### 自动化任务

用户视角的主词，表示一个可以由 1Shell AI 执行、验证并沉淀的运维目标。例如：

- 一键部署 GitHub 项目到 VPS。
- 为某个服务配置反向代理与 HTTPS。
- 巡检一组 VPS 并生成报告。
- 诊断某个线上服务不可访问的原因。

用户界面优先使用“自动化任务”或“任务”，避免继续使用“AI 工作流程序”。

### AgentRun

一次自动化任务的智能体执行实例。它记录：

- goal / source / context。
- phase / toolCalls / events / artifacts。
- ask_user / request_secret / approval。
- side-effect ledger。
- verification_result。
- final outcome。

AgentRun 是打包的事实来源，聊天上下文只能作为辅助说明，不能作为唯一依据。

### Program

代码层已有的可复用自动化载体，保留 `data/programs/<id>/program.yaml`、manual/cron trigger、exec/render/ai steps、verify/workflow contract 等能力。

产品侧可以把 Program 解释为：

```text
自动化任务经过验证后沉淀出的可复用封装。
```

### Skill

Skill 是知识与流程指导包，可以辅助打包策略，但不拥有系统级打包权限。真正读 AgentRun、脱敏、写 Program、校验 replay 的能力属于 1Shell 内部服务。

### Script

Script 是确定性命令模板。固定开关服务、执行备份脚本、清理目录等可以走 Script 或 exec Program；需要运行期 AI 探索、判断、修复、验证的场景才适合自动化任务 / AI Program。

## 3. 可信等级

自动化任务和 Program 必须显式区分可信等级，防止把未验证草稿包装成可靠自动化。

| 状态 | 含义 | 是否可视为可靠 |
|---|---|---|
| `draft_from_goal` | 只根据用户目标生成，尚未真实执行 | 否 |
| `executed` | 已真实执行过，但未确认成功 | 否 |
| `verified_agent_run` | AgentRun 执行成功，并由 verifier/outcome 验证 | 可作为打包来源 |
| `draft_from_trace` | 从 AgentRun trace 提取出的 Program 草稿 | 否，需要 replay |
| `replay_verified` | 用原始参数 replay 通过 | 是，接近 proven |
| `proven` | 可复用 Program 通过 replay 和安全校验 | 是 |
| `blocked` | 缺少必要输入、权限、secret 或审批 | 否 |
| `unverified` | 无足够证据证明成功 | 否 |

硬规则：

```text
没有 verified AgentRun，不能生成 proven Program。
没有 replay verified，Program 不能最终 proven。
```

## 4. 两条打包路径

### 4.1 创建新自动化任务

用户一开始就说：“我要做一个可复用任务”。

流程：

```text
用户提出目标
  -> AI 提出验证/模拟方案
  -> 用户选择沙箱、staging、dry-run 或真实目标
  -> AI 收集必要输入与 secret ref
  -> AI 真实执行受控测试
  -> verify_outcome
  -> Packager 从 verified AgentRun 生成 draft_from_trace
  -> replay
  -> proven
```

模拟不等于假装执行，而是在安全边界内真实执行。可选方式包括：

- 临时目录 + 临时端口。
- staging VPS / staging zone。
- 容器沙箱。
- 平台 dry-run。
- 用户明确批准的真实执行。

如果只能 dry-run，结果不能标记为 proven，只能是 `validated_dry_run` 或 `draft_from_goal`。

### 4.2 从已有执行记录打包

用户已经让 1Shell AI 做完一堆操作，之后说：“把刚才这些打包成任务”。

流程：

```text
用户请求打包
  -> 选择 AgentRun 或时间范围
  -> Packager 读取结构化 trace
  -> 提取最终成功路径，排除探索和失败路线
  -> 提取 inputs / secrets / approval points / verify
  -> 生成 draft_from_trace
  -> 用户审核
  -> replay
  -> proven
```

这类打包不能依赖压缩后的聊天记录，必须依赖 AgentRun 的结构化事件、工具调用、artifact、side-effect ledger 和 verification_result。

## 5. Secret 规则

敏感信息不能通过普通聊天交给 AI，也不能写入 Program。

正确路径：

```text
AI 发现需要 token/API key/password
  -> request_secret
  -> 用户在 Secret Manager 选择或保存 secret
  -> AI 只看到 secret ref / metadata
  -> 工具执行时由后端解析 secret
  -> AgentRun trace 只保存 secret ref/slot
  -> Program 保存 secret requirement，不保存明文
```

需要区分：

- `secret ref`：当前 Secret Manager 中的具体凭据引用，用于某次执行。
- `secret slot`：Program/自动化任务声明“运行时需要一个什么凭据”。

如果测试必须使用 Cloudflare token、GitHub token 等 secret，但用户不提供 secret ref，则任务只能是 `blocked` 或 `unverified`，不能 proven。

## 6. 打包器职责

打包器是内部架构能力，而不是外部 MCP、CLI 或普通 Skill。

建议模块：

```text
ProgramPackagerService / TaskPackagerService
```

职责：

1. 读取 AgentRun state。
2. 调用 outcome evaluator 确认来源是否 verified。
3. 摘要化 trace，排除明显失败路线和噪音。
4. 提取 inputs、secret slots、approval points、workflow phases、verify contract。
5. 生成 Program draft。
6. 执行 secret 明文扫描和结构校验。
7. 可选写入 `data/programs/<id>/program.yaml`。
8. 后续触发 replay，并根据结果升级可信等级。

## 7. v0 实现边界

v0 先做最小闭环，不追求完美自动抽取所有 tool calls：

```text
verified AgentRun
  -> single ai step Program draft
  -> 带 provenance / workflow / verify / summary
  -> schema 校验
  -> 可选写入 data/programs
```

v0 不做：

- 不把所有工具调用机械转换成 exec steps。
- 不新增独立 data/tasks 域。
- 不让普通 Skill 直接读取全部 trace 并写 Program。
- 不把未 verified 的 AgentRun 直接标记为 proven。
- 不保存 secret 明文。

v0 推荐 API：

```http
POST /api/program-drafts/from-agent-run
```

请求：

```json
{
  "runId": "ide-...",
  "programId": "optional-kebab-id",
  "write": false
}
```

响应包含：

- `programId`
- `trustLevel`
- `yaml`
- `programDraft`
- `validation`
- `provenance`
- `warnings`

## 8. 验收标准

1. 未 verified 的 AgentRun 默认不能写入 Program draft，除非显式 `allowUnverifiedDraft=true`，且可信等级只能是 `draft_from_goal` 或 `unverified`。
2. Program draft 必须包含 provenance，说明来源 AgentRun、outcome reasons 和 verification evidence。
3. Program draft 不能包含 secret 明文。
4. 有副作用的来源必须有 verification_result，否则只能 `unverified`。
5. 写入前必须经过 Program schema 校验。
6. replay 之前只能叫 draft；replay 通过后才能升级 proven。

