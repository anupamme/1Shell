# Program 前端结构约束

## 前端不是代码产物

Program 前端结构由 1Shell 固定程序界面承载，不生成 Vue、React、HTML、CSS、iframe、manifest 或 sandbox preview。

本 skill 只用于 AI 型 Program 的结构信息：
- 中间 40% 区域需要哪些业务输入字段。
- 运行时右侧 40% 结果界面显示哪些阶段。
- AI 最终结果应该如何排版到右侧结果界面。

纯脚本型 Program 不需要本 skill 参与结构设计，例如开启/关闭固定项目、重启固定服务、执行固定备份脚本、清理固定缓存目录、查看固定状态命令。它们的功能来自 Program YAML 的 `exec` / `render` steps，不要把它们改造成只有展示意义的阶段卡片或结果卡片。

## VPS 选择规则

VPS 选择必须使用 1Shell 已加入的 VPS / hosts 列表。

绝对禁止把 VPS 做成自由输入字段，例如：
- 输入 IP。
- 输入 SSH 地址。
- 输入用户名。
- 输入密码。
- 输入 VPS 类型。

Program YAML 中默认用 `hosts: all`，让 Program 页面从 1Shell 主机列表里选择目标 VPS。若用户明确限定某些 VPS，才写成固定 host id 数组。

## 输入区规则

输入区只放业务变量。

业务变量不是“用户原话里出现过的词”，而是运行期 AI 安全完成目标所必需、且无法可靠自行探索的信息。对运维类 Program，要主动补齐用户没说但必须决策的输入。

补齐输入不等于全部必填。有安全默认值的字段必须给 default，并设为 `required: false`；条件性字段在前端也设为 `required: false`，由运行期按条件校验。boolean、select、有 default 的字段、可由 AI 推断的字段都不得标为 required。

敏感且可复用的凭据字段使用 `type: password`。固定 Program 前端会自动给 password 字段显示手动输入、保存凭据、选择已保存凭据；不要把“保存按钮”建成额外 input，也不要把 token 明文写进 YAML、default、placeholder、描述、日志或结果。

适合 `type: password` 的字段：Cloudflare Token、GitHub Token、API Key、Access Token、Secret Key、私钥、Webhook Secret、数据库密码、云厂商密钥、需要重复使用的账号密码。

不适合 `type: password` 的字段：域名、端口、路径、邮箱、boolean、select、健康检查路径、冲突策略、项目名称、GitHub URL。

对“一键部署 GitHub 项目”默认只有：
- `github_url`：GitHub 项目链接。
- `port`：对外端口。

VPS 不属于 `inputs`，因为它由 Program 页面的目标主机选择提供。

不得为 AI 可自行探索的信息创建输入字段，例如项目类型、包管理器、部署方式、系统环境、启动命令。

反向代理与 HTTPS 默认需要：
- `proxy_port`：反代端口，`required: true`。
- `domain`：绑定域名，`required: true`。
- `cloudflare_token`：Cloudflare API Token，password，`required: true`。
- `cloudflare_zone`：Cloudflare Zone ID 或根域名，通常可从域名推断，若保留输入也必须 `required: false`。
- `enable_https`：是否开启 HTTPS，默认 true，`required: false`。
- `cloudflare_proxy_mode`：Cloudflare 代理模式，`dns_only` / `proxied`，默认 `dns_only`，`required: false`。
- `acme_email`：证书申请邮箱，开启 HTTPS 时运行期需要，`required: false`。
- `health_check_path`：验证路径，默认 `/`，`required: false`。
- `conflict_policy`：已有同域名配置策略，`abort` / `backup_replace`，默认 `abort`，`required: false`。

## 阶段区规则

阶段区是运行过程展示，不是用户确认流程。

阶段由运行时 AI 调用 `report_phase` 点亮。阶段名称应短、结果导向。

一键部署 GitHub 项目的默认阶段：
- `env_check`：读取 VPS 环境。
- `repo_analysis`：读取 GitHub 仓库。
- `deploy`：安装依赖并部署。
- `verify`：验证端口和访问。
- `result`：生成结果。

不得设计“用户认可后进入下一步”。只有遇到破坏性或安全敏感操作时才允许确认。

## 右侧结果界面规则

最终结果必须放在 Program 页面右侧 40% 结果界面。

部署、配置、变更类 Program 通常在运行结束时通过 `publish_result` 输出排版后的结果内容；诊断、巡检、审计、状态报告类 Program 应通过 `update_result` 在运行过程中增量更新报告，最后 `update_result(final=true)` 或 `publish_result` 完成。结果不是另一个独立输入卡片，也不是额外前端文件。

最终结果至少包含：
- 成功 / 失败 / 阻塞状态。
- 目标 VPS。
- 用户输入的关键业务变量。
- 访问地址或使用方法。
- 验证证据。
- 如果失败，失败位置、已完成内容和下一步建议。

对 HTTP/HTTPS 类结果，右侧结果必须明确 HTTP/HTTPS 验证是否通过；502、504、timeout、证书错误都要显示为失败或部分成功，不能排版成成功。
