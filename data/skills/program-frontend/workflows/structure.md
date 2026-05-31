# Workflow: Program 前端结构

## 触发场景

用户要求为 AI 型 Program 创建或检查前端结构，例如输入卡片、阶段卡片、结果界面。

纯脚本型 Program 不应触发本 workflow，例如开启/关闭固定项目、重启固定服务、执行固定备份脚本、清理固定缓存目录、查看固定状态命令。如果已经进入本 workflow，先返回“不需要额外前端结构”，不要继续生成阶段卡片或结果卡片设计。

## 核心判断

先把 Program 需求还原成一句提示词模板，然后把模板拆成三类界面结构：

1. 系统选择：由 1Shell 固定界面提供。
2. 业务输入：用户必须填写的变量，包括用户没说但运行期必须由用户决策的信息。
3. 运行展示：阶段进度和最终结果。

## 系统选择

如果需求里出现“哪台 VPS / 哪台主机 / 哪个服务器”，不要创建 input。

处理方式：
- Program YAML 默认 `hosts: all`。
- Program 页面使用已加入 1Shell 的 hosts 列表给用户选择。
- AI 运行时拿到目标 host，不需要用户手填连接信息。

## 业务输入

只为用户必须提供、AI 不能自己推导的业务变量创建 input。

对运维类 Program，要主动扩写必要输入。比如“把端口反代到域名并开启 HTTPS”不能只有端口、域名、Cloudflare Token，还应包含 Cloudflare 代理模式、ACME 邮箱、健康检查路径和已有同域名配置冲突策略。

字段要求：
- name 用 snake_case。
- label 用中文短标签。
- type 只用必要类型：string、number、boolean、select、text、password。
- 敏感且可复用的凭据字段用 password，例如 Cloudflare Token、GitHub Token、API Key、Secret Key、数据库密码；固定前端会自动显示保存和选择已保存凭据。
- 普通业务字段不要用 password，例如域名、端口、路径、邮箱、boolean、select、健康检查路径和冲突策略。
- description 说明用户要填什么，不解释技术实现。

一键部署 GitHub 项目的业务输入：

```yaml
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
```

## 阶段展示

阶段不需要写成单独前端文件，写进 AI step 的 goal，让运行时 AI 调用 `report_phase`。

一键部署 GitHub 项目的默认阶段：

```text
env_check      读取 VPS 环境
repo_analysis  读取 GitHub 仓库
deploy         安装依赖并部署
verify         验证端口和访问
result         生成结果
```

每个阶段只展示短状态，不展示长命令日志。

反向代理与 HTTPS 默认阶段：`input_validate`、`env_check`、`upstream_check`、`cloudflare_dns`、`proxy_config`、`proxy_reload`、`https_issue`、`http_verify`、`https_verify`、`result`。

## 右侧结果界面

最终结果进入右侧 40% 结果界面。部署、配置、变更类 Program 通常由 AI 调用 `publish_result`；诊断、巡检、审计、状态报告类 Program 必须在关键阶段后调用 `update_result` 增量更新报告，最后用 `update_result(final=true)` 或 `publish_result` 完成。

结果排版要求写进 AI step 的 goal：

```text
部署/配置类最后调用 publish_result；报告类每阶段调用 update_result，并输出：
- 状态：成功 / 失败 / 阻塞。
- 目标 VPS。
- GitHub 项目链接。
- 对外端口。
- 访问地址和访问方法。
- 验证证据。
- 如果失败，说明失败阶段、已完成内容和下一步建议。
```

HTTP/HTTPS 类 Program 的结果必须明确 HTTP、HTTPS、证书、DNS、upstream 验证结果；502、504、timeout、证书错误不得显示为成功。

## 输出给创作流程的结构

当本 skill 被用于辅助 Program 创作时，用以下结构返回判断：

```text
系统选择：
- target_host: 使用 1Shell hosts 选择器，不进入 inputs。

业务输入：
- github_url: string
- port: number

阶段：
- env_check: 读取 VPS 环境
- repo_analysis: 读取 GitHub 仓库
- deploy: 安装依赖并部署
- verify: 验证端口和访问
- result: 生成结果

右侧结果：
- 部署/配置类用 publish_result 输出排版后的最终结果。
- 诊断/巡检/审计/状态报告类用 update_result 增量更新报告，避免最后一次性总结。
```

## 禁止输出

不要输出：
- Vue / React / JSX / HTML / CSS。
- `ui/manifest.json`。
- iframe bridge。
- preview check。
- 需要用户逐步认可的流程。
- 给纯脚本型 Program 生成只有展示意义、没有执行功能的阶段卡片或结果卡片。
