# Workflow: 修改 Program

## 触发场景

用户要求调整已有 Program 的输入字段、提示词、阶段或输出。

## 修改原则

只做用户要求的最小修改，不重写无关字段。

保持核心模型不变：
- Program 仍然是一句提示词模板。
- 前端仍然只来自必要输入字段。
- 运行期仍然自动执行到结果。

## 操作规则

如果任务上下文提供了当前 `program.yaml`，直接基于它修改。

修改时优先调整：
- `inputs`
- AI step 的 `goal`
- `name` / `description` / `label`

不要新增 UI artifact、frontend contract、preview check 或 React 前端文件。

写回原路径后，用 `render_result format=keyvalue level=success` 展示修改点。
