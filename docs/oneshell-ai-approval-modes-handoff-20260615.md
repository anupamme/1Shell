# 1Shell AI IDE Approval Modes Handoff - 2026-06-15

## 给下一个窗口的结论

这次不要先改任务创作逻辑。当前真正卡住的是 **1Shell AI 执行任务时仍然沿用标准 IDE agent 的人工审批流**。

用户已经明确认可了一个方向：

- 任务继续作为 1Shell AI 的下级工具/数据层。
- 任务不能重新变成 1Shell AI 的一部分。
- 任务执行仍然交给纯 1Shell AI agent。
- 但是任务执行必须是自动化的，不能每创建目录、写文件、执行部署命令都弹一次确认。

所以下一个窗口的任务是：

1. 给 IDE agent 增加两个权限模式：
   - 替我审批模式
   - 完全权限模式
2. 把 AI 任务执行里的 1Shell AI 固定设置成 **替我审批模式**。

## 当前状态

任务系统已经做到了关键一步：任务运行时，步骤已经交给 1Shell AI 执行，而不是旧版本那种固定脚本/伪 agent 执行。

目前已有的新任务体系大致是：

- `/task` 是任务创作入口。
- `/task` 可以调用任务创作工具：
  - `preview_ai_task`
  - `create_ai_task`
  - `update_ai_task`
  - `get_ai_task`
- 任务创作有 evidence gate：
  - 不能只凭猜测保存任务。
  - 必须先实践、验证、留证据，再包装成任务。
- 任务 UI 已经向旧版本 Program 风格靠近：
  - 左侧任务列表。
  - 中间任务输入表单和运行按钮。
  - 右侧进度、结果、历史运行。
- 任务执行目前使用 1Shell AI，而不是旧 Program runtime。

这个方向是对的。

## 当前错误

用户最新截图里，任务运行时出现了 `IdeApprovalCard`：

> 需要确认 / 允许 1Shell AI 操作需要确认吗?

例如创建目录 `create_directory` 也要确认。

这对任务板块来说是错误体验。任务是自动化入口，用户点击一次“运行任务”，就已经是在授权这个任务按既定流程执行。任务运行中不应该出现 IDE 聊天里的逐步审批卡。

根因在代码层面大概率是：

- `frontend/src/views/FeaturesView.vue`
  - 任务运行使用了通用 `useIdeChat(...)`。
  - 页面还渲染了 `IdeApprovalCard`。
- `src/ide/ide.agent-kernel.js`
  - `createIdeAgentPolicy(...)` 目前统一返回 `approvalPolicy: 'agent_side_effects'`。
  - `entry === 'task'` 只代表任务创作，不代表任务执行。
- `src/ide/ide.service.js`
  - 目前工具执行路径里有 `allowApproval: true`。
  - 这会把 harness 推荐审批的写操作转成前端确认卡。
- `src/harness/dispatch.js`
  - 如果 `verdict.needApproval && context.allowApproval`，就走人工审批。
  - 如果 `allowApproval=false`，普通 needApproval 操作不会弹确认。
  - 如果 `approvalRequired=true` 且没有预授权，则会拒绝自动执行。

也就是说，目前缺的不是“任务 agent”，而是 **task_run 专用权限策略**。

## 产品判断

这里有两个 Codex 值得学习的模式：

1. 替我审批
2. 完全访问/完全权限

默认任务执行应该学习 **替我审批**，不要默认学习完全权限。

原因：

- 任务必须自动化，所以不能每一步都问。
- 任务会操作 VPS、端口、目录、Docker、服务，默认完全权限太危险。
- 用户之前的 example-hk 事故已经说明，自动化必须有边界。

建议权限模型：

```text
manual
  普通 IDE/普通 1Shell AI 默认模式。
  保留现有审批卡。

delegated
  替我审批模式。
  用户对本次 agent run 做一次委托授权。
  常规副作用操作自动执行。
  确定性高危操作仍然 fail-closed。

full_access
  完全权限模式。
  用户显式开启后，对本次 agent run 做更高等级预授权。
  可以通过原本需要人工确认的高风险操作。
  但 deterministic guard 的 allow=false 仍然必须阻断。
```

## 三种入口要分开

不要把任务执行和任务创作混在一起。

建议后端 entry 语义：

```text
core
  普通 IDE 1Shell AI。

task
  /task 任务创作模式。
  允许 task_authoring capability。
  必须保留先实践、再验证、再包装的规则。

task_run
  AI 任务执行模式。
  不允许 task_authoring capability。
  默认 approvalMode = delegated。
  不显示任务创作工具。
  不显示逐步审批卡。
```

重点：

- `entry: 'task'` 只能代表任务创作。
- `entry: 'task_run'` 才代表任务执行。
- `task_run` 不能拿到 `task_authoring` capability，否则任务执行时可能又开始创建/修改任务。

## 替我审批模式应该怎么落地

`delegated` 不建议简单粗暴设置 `preApproved=true`。

更合理的行为：

- `allowApproval=false`
- `preApproved=false`
- `approvalPolicy` 不再是 `agent_side_effects`
- harness 里的普通 `needApproval` 操作自动执行
- harness 里的 `approvalRequired` 操作自动拒绝，并报告越界/需要更高权限

这样可以得到用户想要的自动化：

- 创建目录：自动执行
- 写配置：自动执行
- clone repo：自动执行
- docker compose up：自动执行
- curl/ss/systemctl 检查：自动执行

同时保留底线：

- 清空根目录：拒绝
- 大范围删除：拒绝
- 无限杀进程：拒绝
- 明显越界目录/主机/端口：拒绝
- harness deterministic allow=false：永远拒绝

这才像 Codex 的“替我审批”：不是没安全，而是不再把普通步骤逐个扔给用户点确认。

## 完全权限模式应该怎么落地

`full_access` 应该是 IDE 的显式高级模式，不是任务默认。

建议行为：

- 前端必须有明显模式选择。
- 最好是按 session/run 生效，不要一开就永久全局生效。
- 后端记录 `approvalMode: 'full_access'`。
- harness context 可以设置更高等级预授权，例如：
  - `allowApproval=false`
  - `preApproved=true`
  - `approvalMode='full_access'`
- 但 deterministic guard 的 `allow=false` 仍然不能被绕过。
- 所有高风险操作必须进 audit/trace。

这表示：

- `needApproval` 不弹卡，自动执行。
- `approvalRequired` 也可以在 full access 下执行。
- `allow=false` 仍然阻断。

注意：完全权限不是“关闭 Hermes/关闭 guard”。它只是用户对本次 run 选择了更高等级预授权。

## 前端改造建议

### IDE 页面

文件：

- `frontend/src/views/IdeView.vue`
- `frontend/src/composables/useIdeChat.ts`
- 相关复用入口：
  - `frontend/src/components/AppAiFab.vue`
  - `frontend/src/components/main/IdePanel.vue`

建议给 IDE 增加模式控制：

```text
普通审批
替我审批
完全权限
```

实现细节建议：

- 在 `useIdeChat` 增加可传的 `approvalMode` 或 `messagePayload` 字段。
- 发送消息时带给后端：
  - `approvalMode: 'manual' | 'delegated' | 'full_access'`
- `manual` 保持现有 `IdeApprovalCard`。
- `delegated` 和 `full_access` 不显示逐步审批卡。
- `full_access` 开启时 UI 必须有醒目提示。

### 任务页面

文件：

- `frontend/src/views/FeaturesView.vue`

任务运行固定：

```text
entry: 'task_run'
approvalMode: 'delegated'
```

任务页面不应该渲染 `IdeApprovalCard`。

如果后端返回“需要更高权限”，任务页面应该作为运行失败/越界显示在结果流里，而不是弹人工审批卡。

## 后端改造建议

### entry 归一化

文件：

- `src/ide/ide.service.js`

`normalizePromptEntry(...)` 需要支持：

```text
core
task
task_run
```

可以从 message/context/query 里识别：

- `entry: 'task_run'`
- `context.taskRun === true`
- `context.taskExecution === true`

但不要把普通 `/task` 创作识别成 `task_run`。

### agent policy

文件：

- `src/ide/ide.agent-kernel.js`

`createIdeAgentPolicy(...)` 建议：

```text
entry === 'task'
  capabilities includes task_authoring
  approvalPolicy 可继续保持人工审批策略

entry === 'task_run'
  capabilities 不包含 task_authoring
  approvalPolicy 使用 delegated/no_interactive_approval 语义

entry === 'core'
  根据前端 approvalMode 决定 policy
```

不要让 `task_run` 获得任务创作工具。

### harness context

文件：

- `src/ide/ide.service.js`
- `src/harness/dispatch.js`
- `src/agent-runtime/runtime.js`
- `src/agent-runtime/tool-policy.js`

目标不是重写 harness，而是把正确上下文传进去：

```text
manual:
  allowApproval=true
  preApproved=false

delegated:
  allowApproval=false
  preApproved=false

full_access:
  allowApproval=false
  preApproved=true
```

如果现有 tool-policy 还会在 agent 层制造审批事件，也要让它识别 `approvalMode`，避免 `delegated/full_access` 继续触发 `ide:approve-request`。

## 任务执行的目标体验

用户在任务界面选择：

- 任务
- 主机
- 端口
- repo
- 其他参数

点击运行后：

1. 1Shell AI 自动执行任务。
2. 过程实时进入右侧 timeline/result。
3. 普通写操作不问用户。
4. 普通命令不问用户。
5. 越界/高危操作直接失败并解释原因。
6. 不出现 `IdeApprovalCard`。
7. 执行结果写入 `ai_task_runs`，任务界面能看到历史。

## 验证要求

下个窗口完成后至少验证：

1. IDE 普通模式仍然会出现人工审批卡。
2. IDE 替我审批模式不会出现人工审批卡，普通写操作自动执行。
3. IDE 完全权限模式不会出现人工审批卡，并能通过原本 `approvalRequired` 但 guard allow 的操作。
4. 任务执行发送的是：
   - `entry: 'task_run'`
   - `approvalMode: 'delegated'`
5. `task_run` policy 不包含 `task_authoring` capability。
6. `task_run` 不会调用/暴露：
   - `preview_ai_task`
   - `create_ai_task`
   - `update_ai_task`
   - `get_ai_task`
7. 任务界面不渲染 `IdeApprovalCard`。
8. `npm.cmd test` 通过。
9. `npm.cmd --prefix frontend run build` 通过。

不要再跑重型 GitHub 部署到 example-hk。需要做端到端验证时，用 local 或低风险测试主机、短命令、临时目录、短超时。

## 不要做的事

- 不要恢复旧版本 Program runtime。
- 不要把任务做成第二个 agent。
- 不要让任务创作工具出现在普通 IDE 或 task_run。
- 不要用“完全权限”作为任务默认。
- 不要把 Hermes/guard 整体绕开。
- 不要把任务执行失败包装成成功。
- 不要在任务运行中弹逐步审批卡。

## 一句话交接

现在任务系统的方向是对的：任务作为下级工具，真正由 1Shell AI 执行。下一步只需要把权限模型补齐：IDE 增加“替我审批”和“完全权限”，任务运行固定使用 `task_run + delegated`，从而让任务自动执行，但仍然保留高危阻断和完整审计。
