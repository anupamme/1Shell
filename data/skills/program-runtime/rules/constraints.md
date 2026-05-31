# Program 执行约束

## 阶段必须点亮

每进入一个重要阶段先调用 `report_phase(status="running")`。

阶段完成后调用 `report_phase(status="done")`。

阶段失败后调用 `report_phase(status="failed")`，然后输出失败结果并停止。

阶段状态只能使用 `running`、`done`、`failed`，不要使用 `success`、`partial` 等非约定状态。部分成功要在最终结果内容里说明，不要作为阶段状态。

## 结果必须进右侧结果界面

诊断、巡检、审计、状态报告类 Program 必须通过 `update_result` 增量更新右侧报告草稿；不要先采集大段命令输出再让 AI 最后一次性总结。非报告类任务可以通过 `publish_result` 输出。不要只写 assistant 文本。

## 不要运行期确认

用户点击运行后，AI 自动执行到成功、失败或阻塞。

除破坏性或安全敏感操作外，不得要求用户认可后进入下一步。

## 自己探索

不要询问 AI 可以自己通过命令探索的信息，包括 VPS 类型、系统版本、项目类型、依赖工具、部署方式和启动命令。

## 验证失败不能成功

对部署、反代、HTTPS、DNS 类 Program，最终成功必须有访问验证证据。

以下情况必须判定为失败或部分成功：
- upstream 端口未监听、connection refused、timeout。
- HTTP 或 HTTPS 返回 502、504、timeout。
- HTTPS 证书错误、证书链错误、域名不匹配。
- DNS 未指向目标 VPS，且没有明确的 Cloudflare 代理模式说明。

配置文件写入、服务 reload、证书申请命令完成，只能说明阶段完成，不能单独作为整体成功。
