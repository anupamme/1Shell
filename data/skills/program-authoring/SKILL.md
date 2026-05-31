---
name: Program 创作
icon: "program"
hidden: false
forceLocal: true
description: 当用户想创建需要运行期 AI 探索、判断、部署、诊断或生成报告的 1Shell Program 时使用；纯脚本型固定操作不要触发本 Skill。
category: custom
tags:
  - program
  - authoring
referencedSkills:
  - program-frontend
  - program-runtime
inputs:
  - name: task
    label: 用户需求
    type: string
    required: true
    placeholder: 例如：创建一个一键部署 GitHub 项目到 VPS 指定端口的程序
---

# Program 创作

## Always Read
- rules/constraints.md

## Common Tasks

| 用户意图 | 读取 workflow |
|---------|--------------|
| 创建新的 AI 型 Program / AI 工作流 / 需要探索判断的一键运维程序 | workflows/create.md |
| 修改已有 AI 型 Program 的输入、提示词、阶段或结果 | workflows/edit.md |

## 不适用场景

如果用户要创建的是纯脚本型 Program，例如开启/关闭某个固定项目、重启固定服务、执行固定备份脚本、清理固定缓存目录、运行固定状态命令，这类目标不需要运行期 AI 探索、诊断或生成报告，默认不要触发本 Skill，也不要强行改写成 `type: ai` 工作流。

纯脚本型 Program 应由 1Shell AI 直接生成 `exec` / `render` steps：VPS 仍使用 1Shell hosts 选择器，输入只保留脚本必要参数，运行结果由脚本输出或 render step 呈现。

## 创建前必须确认

首次收到创建 Program 的需求时，即使用户说了“创建一个 / 生成一个”，也必须先展示结构预览，不得立刻写文件。

结构预览必须包含：Program 名称、提示词模板、VPS 选择方式、业务输入字段、运行阶段、右侧结果界面输出内容。

结构预览不能只复述用户原话，必须展示 AI 主动补充的必要执行输入、风险处理策略和验收条件，并说明每个新增输入为什么必须由用户提供。

展示后停下来等待用户明确回复“开始创建 / 确认创建 / 按这个创建 / 直接落地 / 不用确认”。只有收到这些明确确认后，才能写入 `data/programs/<program-id>/program.yaml`。

## 需求扩写与验收设计

创建 Program 时必须先把自然语言需求扩写成可安全执行的运维目标，而不是只抽取用户已经说出口的字段。

但扩写出来的字段默认不等于必填。除非没有该字段就完全无法开始执行，否则扩展字段必须是可选项，给默认值或让运行期 AI 自动推断。

必须主动判断：
- 哪些信息必须由用户提供，否则运行期 AI 只能猜测或容易失败。
- 哪些信息可由运行期 AI 探测，不应放入输入。
- 哪些操作有覆盖、停服、证书、DNS、安全或回滚风险。
- 什么证据才算真正成功，不能只以“配置写入成功”作为成功。

例如反向代理并开启 HTTPS 时，除端口、域名、Cloudflare Token 外，还应考虑 Cloudflare 代理模式、ACME 邮箱、健康检查路径、已有同域名配置冲突策略；502、504、timeout、证书错误都不能算成功。

## 实现自由原则

Program goal 只写目标、输入、阶段、成功条件、失败条件和安全边界，不要替运行期 AI 写死具体实现。

禁止在创建期把这些内容写成硬限制：
- 必须使用某个代理、证书、部署、包管理工具。
- 必须安装某个软件或使用某条固定命令。
- 必须依赖某个固定路径。
- 因为某个端口、进程或环境现象就直接阻塞。
- 把“某个命令不在 PATH”写成失败条件。

正确写法是给运行 AI 自主探索空间：选择当前环境最合适的现有工具或安装新工具；遇到已有服务时先判断是否可安全复用；只有无法安全备份、配置、reload 或验证时才阻塞。

## 创建期工具边界

创建 Program 时只写模板，不探测远程 VPS。

禁止在创建期调用这些远程探测工具：
- `execute_command`
- `list_remote_dir`
- `read_remote_file`

VPS 环境检查、目录检查、Nginx / Docker / Certbot / 端口探测，都必须写进运行时 AI step 的 goal，留到用户点击运行后执行。

如果 `query_format` 失败，不要停止，也不要反复调用；按已加载的 `program-authoring`、`program-frontend`、`program-runtime` 规则继续生成最小 `program.yaml`。

## Known Gotchas

1. Program 不一定是 AI workflow：固定脚本、固定开关、固定命令类 Program 应保留为 `exec` / `render`，不要套 `type: ai`。
2. Program 不是自定义前端项目，只是可复用的执行入口；AI 型 Program 是提示词模板，脚本型 Program 是固定脚本模板。
3. 输入字段来自“安全执行这个目标所必需且运行期无法可靠推断的信息”，不是只来自用户原话。
4. 必填字段要极少：默认只把用户明确要填且无法自动推断的核心对象设为 required；扩展字段、布尔开关、select 策略、可推断字段、有默认值字段都设为 optional。
5. API Token、Secret Key、私钥、数据库密码等敏感且可复用凭据必须设为 `type: password`；保存/选择按钮由固定前端自动提供，不写成额外 input。
6. 不问 AI 可以运行时自己探索的技术细节。
7. 运行期没有“用户认可后进入下一步”，除非遇到破坏性操作或安全风险。
8. 创建期必须先确认结构，运行期才不需要逐步确认。
9. 反向代理、HTTPS、DNS、部署、迁移等运维类 Program 必须设计验证闭环；未验证访问成功不得报告成功。
10. 不要把实现细节写成限制；运行期 AI 应自己探测环境并选择可行方案。
