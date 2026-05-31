# Workflow: 创建 Program

## 触发场景

用户要求把一句自然语言需求做成可复用 Program，例如“一键部署 GitHub 项目”“一键巡检 VPS”“一键安装某服务”。

## 判断方式

先判断 Program 类型：

- 脚本型 Program：目标、命令和结果格式都确定，不需要运行期 AI 探索或判断，例如开启/关闭固定项目、重启固定服务、执行固定备份脚本、清理固定缓存目录、查看固定状态命令。脚本型 Program 不要继续套本 AI 工作流模板，也不要触发 `program-frontend` 做卡片化结构；由 1Shell AI 直接创建 `exec` / `render` steps。
- AI 型 Program：需要运行期 AI 探索环境、分析项目、诊断问题、生成报告或处理未知状态，才继续使用本 workflow。

AI 型 Program 再把用户需求压缩成一句提示词模板：

`帮我把 / 帮我做 {用户填写的信息} 到 {用户选择的 VPS}，并在完成后告诉我结果。`

然后围绕这个目标做需求扩写：补齐安全执行所需的用户决策、风险策略、验证路径和最终验收条件。最后只把“必须由用户提供、运行期无法可靠探索”的变量做成输入。

## 前端结构判断

只有 AI 型 Program 才参考 `program-frontend` 的规则：VPS 使用 1Shell hosts 选择器，业务输入放中间 40%，阶段和最终结果放右侧 40%。脚本型 Program 使用固定 Program 页面本身，不生成前端卡片结构；只在 YAML 里定义必要 inputs、exec 输出和 render 结果。

## 输入字段抽取

只问一个问题：AI 执行时有哪些业务信息必须由用户在前端填写？

规则：
- VPS 选择不做自定义 input，使用 Program 页面的目标主机选择；Program YAML 默认 `hosts: all`。
- 用户必须粘贴或填写的业务对象才做 input，例如 GitHub URL、域名、端口、路径、名称。
- 用户没主动说、但安全执行可能需要的决策信息可以做 input，例如证书邮箱、DNS 代理模式、冲突处理策略、验证路径。
- 但补充字段默认必须是可选项：有安全默认值的字段必须提供 default，并设为 `required: false`；布尔开关、select 策略、可由 AI 推断的字段、条件性字段都必须 `required: false`。
- 只有没有默认值、无法推断、且不填写就无法开始执行的核心字段才 `required: true`。
- 条件性字段不要在前端强制必填，例如 `acme_email` 只在开启 HTTPS 时由运行期校验；不开启 HTTPS 时不能阻止运行。
- 敏感且可复用的凭据做成 `type: password`，例如 Cloudflare Token、GitHub Token、API Key、Access Token、Secret Key、私钥、Webhook Secret、数据库密码、云厂商密钥；固定 Program 前端会自动给 password 字段提供保存和选择已保存凭据的按钮。
- 不要给普通业务输入添加保存凭据能力，例如域名、端口、路径、邮箱、boolean、select、健康检查路径和冲突策略。
- 不要在 Program YAML 里保存 token 明文、设置 token default、输出 token 示例值，或额外设计“保存按钮”字段。
- AI 可以通过命令探索出来的信息，不做 input。
- 不为技术栈、部署方式、包管理器、启动命令创建 input，除非用户明确要求固定。

## 创建前结构预览

首次接到创建需求时，先输出结构预览并等待用户确认，不要写文件。

结构预览应包含：

AI 型 Program 示例：

```text
Program：一键部署 GitHub 项目
类型：AI 型 Program
提示词模板：帮我把 {github_url} 部署到用户选择的 VPS 的 {port} 端口。
VPS 选择：使用 1Shell 已加入 hosts 列表，不手填。
业务输入：github_url、port
AI 主动补充：无；项目类型、包管理器、启动方式由运行期探测。
运行阶段：env_check、repo_analysis、deploy、verify、result
成功验收：端口监听、HTTP 访问成功、返回非 502/504/timeout。
右侧结果：成功/失败、目标 VPS、访问地址、验证证据、失败建议

请回复“开始创建”后我再写入 program.yaml。
```

脚本型 Program 示例：

```text
Program：一键重启项目服务
类型：脚本型 Program
固定动作：在用户选择的 VPS 上执行固定重启脚本或服务重启命令。
VPS 选择：使用 1Shell 已加入 hosts 列表，不手填。
业务输入：service_name
AI 主动补充：无；运行时不调用 AI，不做环境探索。
运行步骤：exec_restart、render_result
成功验收：命令退出码为 0，状态检查显示服务运行中。
右侧结果：成功/失败、目标 VPS、服务名、执行摘要、失败建议

请回复“开始创建”后我再写入 program.yaml。
```

只有用户明确回复“开始创建 / 确认创建 / 按这个创建 / 直接落地 / 不用确认”后，才进入写入文件步骤。

## 运维类 Program 的扩写规则

对 DNS、HTTPS、反向代理、部署、迁移、备份、数据库等运维类 Program，创建 AI 必须主动补齐执行所需输入和验收条件。

反向代理并开启 HTTPS 的默认输入：
- `proxy_port`：要反代的本机端口，`required: true`。
- `domain`：绑定域名，`required: true`。
- `cloudflare_token`：Cloudflare API Token，password，`required: true`。
- `cloudflare_zone`：Cloudflare Zone ID 或根域名，通常可从 domain 推断，若保留输入也必须 `required: false`。
- `enable_https`：是否开启 HTTPS，boolean，默认 true，`required: false`。
- `cloudflare_proxy_mode`：`dns_only` / `proxied`，默认 `dns_only`，`required: false`。
- `acme_email`：证书申请邮箱，开启 HTTPS 时运行期需要，`required: false`。
- `health_check_path`：验证路径，默认 `/`，`required: false`。
- `conflict_policy`：已有同域名配置策略，`abort` / `backup_replace`，默认 `abort`，`required: false`。

反向代理并开启 HTTPS 的默认阶段：`input_validate`、`env_check`、`upstream_check`、`cloudflare_dns`、`proxy_config`、`proxy_reload`、`https_issue`、`http_verify`、`https_verify`、`result`。

反向代理并开启 HTTPS 的实现原则：运行期 AI 自己探测当前 VPS 的代理服务、证书工具、配置位置和 reload 方法；优先复用现有可管理代理，必要时再安装合适工具。创建期不要写死 Nginx、Caddy、OpenResty、Certbot、固定路径或固定命令，也不要把“80/443 被占用”“某命令不在 PATH”直接设为失败。

反向代理并开启 HTTPS 的成功条件：DNS 已正确指向或明确为 Cloudflare 代理模式、upstream 可访问、代理配置测试通过并 reload、HTTP 非 502/504/timeout、开启 HTTPS 时 HTTPS 无证书错误且非 502/504/timeout。

## 一键部署 GitHub 项目的默认映射

如果用户需求是“一键部署 GitHub 项目到 VPS 的端口”，默认结构为：

- Program 名称：一键部署 GitHub 项目
- `hosts: all`
- inputs:
  - `github_url`: GitHub 项目链接，string，required
  - `port`: 对外端口，number，required
- manual trigger: `run`
- 一个 AI step: `deploy`

AI step 的 goal 必须明确：
- 第一步上报并执行 `env_check`：读取当前目标 VPS 环境。
- 读取 `inputs.github_url` 和 `inputs.port`。
- clone 或更新仓库。
- 自己判断项目类型、依赖、启动方式。
- 部署到用户指定端口。
- 验证端口和服务可访问。
- 部署/配置类最后 `publish_result`，告诉用户访问地址和成败；诊断/巡检/审计/状态报告类每个关键阶段后 `update_result` 增量更新报告。

## Program ID

用简短 kebab-case 英文 ID。

示例：
- 一键部署 GitHub 项目 → `deploy-github-project`
- 一键巡检 VPS → `vps-health-check`

## 创建期禁止远程探测

创建 Program 时只做模板设计和文件写入，不读取或操作任何远程 VPS。

不要调用：
- `execute_command`
- `list_remote_dir`
- `read_remote_file`

如果需要知道 VPS 环境、Nginx 目录、Docker 状态、Certbot 状态、端口占用、Cloudflare 配置结果，把这些写进 AI step 的 goal，让运行期自己探测。

如果 `query_format` 失败，继续使用本 workflow 的模板和规则，不要卡住。

## 写入文件

只有用户确认开始创建后才写文件。

创建时只写：

`data/programs/<program-id>/program.yaml`

必须使用 `write_local_file` 或系统提供的 Program 写入工具，不要用命令行写文件。

写完后用 `render_result format=keyvalue level=success` 展示：
- Program ID
- 文件路径
- 输入字段
- 运行方式

## 默认 YAML 模板

必须保持以下结构完整：trigger 写 `id/type/action`；AI step 写 `id/type/label/goal`；exec step 写 `id/type/label/run`；多行文本输入用 `type: text`，不要用 `textarea`；action 显示名用 `label`。诊断、巡检、审计、状态报告类 Program 的 goal 必须要求运行期 AI 使用 `update_result` 增量更新报告，不要用运行期 AI 采集大输出后最后一次性总结。

```yaml
name: 一键部署 GitHub 项目
description: 把指定 GitHub 项目部署到用户选择的 VPS 和端口。
enabled: true
hosts: all
inputs:
  - name: github_url
    label: GitHub 项目链接
    type: string
    required: true
    placeholder: https://github.com/owner/repo
    description: 要部署的 GitHub 仓库地址。
  - name: port
    label: 对外端口
    type: number
    required: true
    placeholder: "3000"
    description: 服务最终监听或对外暴露的端口。
triggers:
  - id: manual
    type: manual
    action: run
actions:
  run:
    label: 开始部署
    steps:
      - id: deploy
        type: ai
        label: 自动部署
        goal: |
          把 inputs.github_url 指向的 GitHub 项目部署到当前目标 VPS 的 inputs.port 端口。

          运行要求：
          1. 先调用 report_phase(phase="env_check", status="running")，读取当前 VPS 的系统、网络、端口、运行环境和可用工具。
          2. 再调用 report_phase(phase="repo_analysis", status="running")，获取仓库并读取项目结构，自己判断技术栈、依赖、构建命令和启动方式。
          3. 调用 report_phase(phase="deploy", status="running")，安装依赖、构建项目并部署到 inputs.port。
          4. 调用 report_phase(phase="verify", status="running")，验证进程、端口和 HTTP 访问情况。
          5. 不要询问用户项目类型、VPS 类型、包管理器或部署方式；这些都必须自己探索。
          6. 除非会覆盖、删除、停止已有服务或暴露敏感信息，否则运行中不要请求用户确认。
          7. 最后必须调用 publish_result，说明成功或失败、目标 VPS、GitHub 项目、端口、访问地址、失败原因或下一步建议。
          8. 如果创建的是诊断、巡检、审计、状态报告类 Program，不要套用部署模板；必须要求每个关键阶段后调用 update_result 增量更新右侧报告，最终 update_result(final=true) 或 publish_result 完成。
```
