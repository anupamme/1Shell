# Workflow: 执行 Program

## 触发场景

Program 的 `type: ai` step 开始执行时使用。

## 执行模型

用户已经选择目标 VPS，并填写业务输入。AI 不再收集需求，只执行。

执行循环：

1. 点亮阶段：`report_phase(status="running")`。
2. 执行探测或操作：`execute_command`。
3. 阶段完成：`report_phase(status="done")`。
4. 进入下一阶段。
5. 诊断、巡检、审计、状态报告类 Program 必须在每个关键阶段后调用 `update_result` 增量更新右侧报告草稿；非报告类任务在验证闭环通过后可调用 `publish_result`。

如果失败：

1. 当前阶段 `report_phase(status="failed")`。
2. 输出失败结果：报告类用 `update_result(status="failed", final=true)` 输出，非报告类可用 `publish_result(status="failed")`。
3. 停止。

部分配置完成但最终访问失败时，也不能发布成功结果；用失败或部分成功的结果内容说明已完成内容和未通过的验证。

## 默认阶段

若 goal 没给阶段，按任务自动拆 3-6 个阶段。

一键部署 GitHub 项目默认：

```text
env_check      读取 VPS 环境
repo_analysis  读取 GitHub 仓库
deploy         安装依赖并部署
verify         验证端口和访问
result         生成结果
```

## 验证闭环

对部署、反向代理、HTTPS、DNS 类任务，必须把最终访问验证作为成功前置条件。

不能视为成功的情况：
- upstream 不可达。
- HTTP/HTTPS 访问返回 502、504、timeout 或 connection refused。
- HTTPS 证书错误、证书链错误或域名不匹配。
- DNS 与目标 VPS 或 Cloudflare 代理模式不一致。

## 最终结果

最终必须输出到右侧结果界面。报告类 Program 的结果应在运行过程中逐步形成，最后只做完成确认，不再追加单独的大总结调用。内容至少包括：

```text
状态：成功 / 失败 / 阻塞
目标 VPS：...
输入：...
完成内容：...
访问方式：...
验证证据：...
失败原因 / 下一步建议：...
```
