# 1Shell AI Agent IDE handoff - 2026-06-14

这份文档给下一个 Codex 窗口使用。当前阶段不是重建 agent 框架，而是在已经成立的最小 agent loop 之上做 agent IDE：让用户能看懂、信任、调试和控制 1Shell AI。

## 当前状态

1Shell AI 的基础 loop 已成立：

- 用户目标
- 模型判断
- 调用工具
- 接收观察
- 再判断
- 继续或总结

现在的重点是 IDE 化，不是继续堆 Task / Program / Skill / planner。最近一次可见提交是：

- `04798c5 feat: unify 1Shell AI agent IDE experience`

注意：当前工作区仍有未提交改动。下一个窗口开始前必须先看 `git status --short` 和相关 diff，不要假设所有内容都已经保存。

## 本窗口主要做了什么

### 1. 重建 1Shell AI IDE 的前端入口

用户明确不希望把旧版主控 AI 放大复用，也不希望恢复旧 IDE 残留。因此本窗口的方向是：

- 左侧新增/恢复一个新的 `IDE` 板块。
- IDE 第一版只做聊天窗口，不做任务、不做工具配置面板、不做复杂工作台。
- 主控界面的悬浮窗同步使用同一套新的 1Shell AI 聊天/时间线体验。
- 入口保持简单：用户输入目标，1Shell AI 自己判断是否调用探针、文件、命令等内置工具。

相关前端重点文件：

- `frontend/src/composables/useIdeChat.ts`
- `frontend/src/components/main/IdePanel.vue`
- `frontend/src/components/AppAiFab.vue`
- `frontend/src/components/ide/IdeAgentTimeline.vue`
- `frontend/src/components/ide/IdeApprovalCard.vue`
- `frontend/src/views/IdeView.vue`

### 2. 做了 Thinking / 工作笔记可见化

目标体验参考 Claude Code / Codex / opencode：工具调用前后，用户能看到模型自己的可见工作笔记。

已实现的核心点：

- system prompt 要求模型在工具调用前输出 1-3 句可见工作笔记。
- 后端捕获模型在 `tool_use` 前输出的真实文本，作为 `workNote`。
- 前端把工具调用前/工具之间的模型文本归类为 Thinking，而不是最终答案。
- Thinking 是模型真实输出，不是 harness 或前端合成。
- 工具卡和审批卡显示对应 `workNote`。
- 普通无工具回答仍作为最终回答显示，不出现空 Thinking。

重点后端文件：

- `src/ai/oneshell-ai-prompt.js`
- `src/ide/ide.service.js`

### 3. 优化审批 UI 与审批信息结构

用户喜欢 Codex 审批 UI 的结构：上方详细中文说明，中间执行内容，底部选项。

当前原则：

- 审批卡必须分清两类信息：
  - `1Shell AI 的工作笔记`：来自模型真实输出。
  - `harness 审批理由`：来自 harness 的安全边界判断。
- 不允许 harness 冒充 AI 解释任务。
- 读操作一般不审批。
- 删除、写入、停止、重启、Docker rm/rmi、系统变更等必须审批。
- 如果未来要减少连续审批，只能通过明确的用户可见范围授权，例如“允许本轮同主机 sub2api 清理”，不能静默扩大权限。

相关文件：

- `frontend/src/components/ide/IdeApprovalCard.vue`
- `src/harness/guard.js`
- `src/harness/capabilities.js`
- `src/agent-runtime/tool-policy.js`

### 4. 修复工具执行参数被脱敏/截断的问题

曾出现严重问题：trace/审批用的脱敏参数被拿去实际执行，导致命令中出现 `…`，例如 `find /o…`，最终远端命令失败。

已修复：

- 实际执行使用 raw cloned tool input。
- trace/审批继续使用 redacted input。
- 增加 `…` / `[truncated]` 之类截断标记的拒绝保护，避免截断命令被执行。

相关文件：

- `src/ide/ide.service.js`
- `src/tools/oneshell-core.tools.js`
- `src/ide/ide.tools.js`
- `src/harness/guard.js`

### 5. 修复只读检查被频繁审批的问题

用户指出：

- 只读发现脚本不该审批。
- Docker 删除镜像/容器应该审批。
- `delete_path /opt/sub2api` 单独执行时应该审批，但未来可以做明确范围授权减少重复确认。

已修复：

- shell 风险识别能理解更多只读结构，例如 `if/then/fi`、`for/do/done`、`[ -e ]`、`|| true`、`/dev/null` 重定向等。
- `/dev/null` 不再被当成文件写入。
- `xargs docker rm/rmi` 能被识别为变更操作。
- 增加风险规则测试。

相关文件：

- `src/harness/capabilities.js`
- `src/agent-runtime/tool-policy.js`
- `scripts/test-risk-rules.js`

### 6. 修复完成后多出一个单独气泡的问题

用户截图中，1Shell AI 已经完整回答后，又单独发出一个 `2api` 气泡。

原因：

- 前端收到 `ide:done` 后把 `activeRunId` 清空。
- 如果同一轮 run 的迟到 `text-delta` 后到，前端会把它当成新的 assistant 气泡。
- 另有 delta buffer 可能在结束后仍刷出最后一小段文本。

已修复：

- `useIdeChat.ts` 增加 `completedRunIds`。
- `done/error/cancelled` 后记住 runId。
- `matchesCurrentRun()` 丢弃已结束 run 的后续事件。
- `finalize()` 清理 delta buffer。
- `resetChat()` 清空这份 run 状态。

相关文件：

- `frontend/src/composables/useIdeChat.ts`

## 本窗口犯过的错误

这些错误必须写清楚，下个窗口不要重复。

### 错误 1：试图外显“工具配置面板”

用户明确指出这是错的。

1Shell AI 的内置工具是区分 agent 能力边界的内部能力，不应该像外部插件一样在聊天界面列出来。用户说得很明确：让 1Shell AI 看 VPS 状态，它自然应该调用探针；让它下载文件，它自然应该调用文件管理。界面应该保持聊天窗口，而不是让用户面对工具分类。

结论：

- 不要做工具配置 UI。
- 不要把内置工具暴露成用户需要手动选择的东西。
- 工具可以在后台增强，但前台仍以聊天和可观测过程为主。

### 错误 2：旧 IDE 残留清理不够干净

用户多次指出“没删干净”。旧版 IDE / Task / Program / Skill 残留会干扰新 agent IDE 的产品语义。

结论：

- 任何新增前端入口前，先确认它没有复用旧语义。
- 不要把旧 Task / Program / Skill 名词偷偷带回来。
- 不要把旧版 UI 残留包装成新功能。

### 错误 3：审批过频，读操作也弹审批

这会严重破坏 agent 体验。只读观察如果频繁审批，用户会觉得 agent 不能独立工作。

结论：

- read-only inspection 默认不审批。
- mutation / deletion / restart / write / privileged cleanup 才审批。
- 未来减少重复审批时，必须用清晰可见的范围授权，不允许 silent broadening。

### 错误 4：harness 信息一度像是在替 AI 说话

用户质疑“这真的是 AI 在给我服务吗？是不是 harness 代替 AI 回复我？”

这是非常严重的边界问题。

结论：

- AI 的工作笔记必须来自模型真实输出。
- harness 只能给事实、权限、审计、审批原因。
- 前端不能合成 Thinking。
- 后端不能编模板化旁白冒充模型判断。

### 错误 5：脱敏/截断内容进入真实执行

这是工程层面的严重 bug。trace/审批为了安全可以截断，但真实工具执行绝不能使用截断参数。

结论：

- execution input 和 trace input 必须分离。
- 执行前必须拒绝明显截断的命令。
- 不要为了 UI 展示方便污染真实工具参数。

### 错误 6：对文件编码伤痕处理不够谨慎

一些文件有历史 mojibake/编码损伤。使用大上下文 patch 时容易匹配失败或误伤。

结论：

- 修改这些文件时尽量锚定 ASCII 代码结构。
- 不要整文件格式化。
- 不要顺手修大量中文编码，除非用户明确要求。

## 必须继续遵守的原则

### 产品原则

- 当前阶段是 agent IDE，不是 agent 框架重建。
- 保持一个聊天窗口作为核心体验。
- Thinking / 工具 / 审批 / 最终回复按真实时间线展示。
- 工具是 agent 的内置能力，不是用户显式配置面板。
- 用户要的是“看得懂 AI 在做什么”，不是看到更多框架名词。

### Agent 原则

- 不恢复 Task / Program / Skill 默认语境。
- 不加隐藏 planner。
- 不加隐藏 recovery script。
- 不加外部模板化旁白。
- 模型自己判断下一步，harness 不替模型规划。

### Harness 原则

harness 只负责：

- 边界
- 权限
- 审计
- 脱敏
- 工具执行
- 事实记录
- 风险识别
- 审批拦截

harness 不负责：

- 伪造 Thinking
- 替 AI 总结任务
- 替 AI 解释意图
- 隐藏规划
- 自动扩大审批范围

### Thinking 原则

- Thinking 是可见工作笔记 / reasoning summary。
- 不暴露隐藏 chain-of-thought。
- 不由前端或 harness 合成。
- 工具调用前的模型文本可以转入 Thinking。
- 最终总结不能塞进 Thinking。

### 审批原则

- 审批原因必须可解释。
- AI 的工作笔记和 harness 的安全理由必须分开显示。
- 只读命令不该审批。
- 变更命令必须审批。
- 重复审批只能通过明确用户授权范围减少。

## 当前验证结果

本窗口最后已跑过：

- `npm.cmd --prefix frontend run typecheck`
- `npm.cmd --prefix frontend run build`
- `npm.cmd test`

最近一次测试结果：

- `risk-rules: 42 checks passed`
- `file-service: dot file checks passed`

下一个窗口开始后，如果继续改功能，仍然要重新跑对应验证。

## 下一个窗口的任务

用户当前提出的下一阶段是“补回任务”，但用户也明确怀疑我们是否还记得旧任务是什么样子。

所以下一个窗口不要直接开写新任务系统。正确顺序是：

1. 先做考古。
   - 从 git 历史中查看旧 Task 相关代码。
   - 重点看旧页面、接口、数据结构、执行记录。
   - 不要直接恢复旧代码。

2. 提炼产品能力。
   - 用户真正可能需要的是：
     - 保存一个目标
     - 查看任务列表
     - 查看任务详情
     - 启动/继续执行
     - 看到执行时间线
     - 关联审批和审计记录
     - 查看最终结果与验证状态

3. 明确不回来的东西。
   - Program 不回来。
   - Skill 默认语境不回来。
   - 隐藏 planner 不回来。
   - 模板化任务旁白不回来。
   - 旧任务框架世界观不回来。

4. 设计新任务的最小版本。
   - 任务应该被视为 1Shell AI 可操作/可记录的一类对象。
   - 执行仍然走当前 agent loop。
   - 任务本身不成为另一个 agent 框架。
   - 第一版可以只是“保存目标 + 点击执行 + 使用当前 IDE 时间线展示过程 + 保存结果”。

5. 先和用户确认方案。
   - 用户现在非常不信任我们。
   - 不要拿到一句“开始吧”就铺大架构。
   - 先展示从旧代码考古得到的事实，再给一个非常小的第一阶段方案。

## 建议下个窗口先读的文件

当前实现：

- `src/ai/oneshell-ai-prompt.js`
- `src/ide/ide.service.js`
- `src/ide/ide.tools.js`
- `src/tools/oneshell-core.tools.js`
- `src/harness/guard.js`
- `src/harness/capabilities.js`
- `src/agent-runtime/tool-policy.js`
- `frontend/src/composables/useIdeChat.ts`
- `frontend/src/components/ide/IdeAgentTimeline.vue`
- `frontend/src/components/ide/IdeApprovalCard.vue`
- `frontend/src/components/main/IdePanel.vue`
- `frontend/src/components/AppAiFab.vue`

历史考古：

- 使用 `git log --oneline --all -- Task task program Program`
- 使用 `git show <old-commit>:<path>`
- 特别注意最近历史中：
  - `d613e9d refactor(ai): remove Program/Task system (tools + backend + routes + samples)`
  - `c1d0c0c refactor(ai): unwire Program/Task system from server.js + clean prompt`

## 给下个窗口的第一句话

请先读取 `docs/oneshell-ai-agent-ide-handoff-20260614.md` 和 `docs/oneshell-ai-agentization-failure-retrospective.md`，然后从 git 历史考古旧 Task 系统。不要直接恢复旧 Task / Program / Skill 框架。目标是设计“新任务作为 1Shell AI 的可保存工作对象”的最小版本，并先和用户确认方案。
