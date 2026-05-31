# Program 创作约束

## 核心模型

Program 是可复用执行入口，不是 React 前端、iframe、沙箱预览或复杂应用。

Program 分两类：
1. AI 型 Program：运行期需要 AI 探索、判断、部署、诊断、审计、生成报告或处理未知环境，使用 `type: ai`。
2. 脚本型 Program：目标、命令和结果格式都确定，例如开启/关闭固定项目、重启固定服务、执行固定备份脚本、清理固定缓存目录、查看固定状态命令，使用 `type: exec` / `type: render`，不要强行引入运行期 AI。

一个 Program 只需要回答三件事：
1. 用户运行前要填什么信息。
2. 运行时拿到这些信息后要自动完成什么目标。
3. 完成后要告诉用户什么结果。

创建 AI 型 Program 时必须先做需求扩写、风险设计和验收设计。不能只照抄用户说过的字段；要判断为了安全完成目标，哪些信息必须由用户提供，哪些信息应由运行期 AI 探测。

创建脚本型 Program 时不要触发 `program-frontend` 做卡片化前端设计，也不要把固定命令包装成 AI prompt；由 1Shell AI 直接写出 `exec` / `render` steps 和必要输入。

创建 AI 不能替运行期 AI 锁死实现。AI 型 Program goal 应描述目标和验收，不应规定固定工具链、固定路径、固定命令或过早阻塞条件。脚本型 Program 反而应明确固定脚本行为和输出格式。

## 输入字段规则

只创建运行时必须由用户提供的信息字段；AI 型 Program 按运行期 AI 需求判断，脚本型 Program 按固定脚本参数判断。

必填字段必须极少。只有“没有它就无法开始执行、也无法由运行期探测或默认”的核心对象才能 `required: true`。

“需要在界面上提供”不等于“必须填写”。用户没有主动说、但可能影响执行的业务决策、账号权限、证书联系信息、DNS 策略、冲突处理策略和验收路径，默认应设为 `required: false`，给出 default 或让运行期按条件校验。

敏感且可复用的凭据字段必须设为 `type: password`，由固定 Program 前端自动提供“保存/选择已保存凭据”能力。创建期只判断字段是否是凭据，不要在 YAML 里额外设计保存按钮、凭据管理 UI 或明文默认值。

应使用 `type: password` 的字段包括：API Token、Access Token、Secret Key、私钥、Webhook Secret、Cloudflare Token、GitHub Token、数据库密码、云厂商密钥、需要重复使用的账号密码。普通业务值如域名、端口、路径、邮箱、策略选择、健康检查路径不得设为 password。

不得询问或固化 AI 可以在运行时自己探索的信息，例如：
- VPS 操作系统、发行版、CPU、内存、目录结构。
- GitHub 项目的技术栈、框架、包管理器、启动命令。
- Docker / systemd / npm / pnpm / Python / Go 等部署方式。
- 默认健康检查细节。

对“一键部署 GitHub 项目”这类 Program，默认界面结构就是：
- 目标 VPS：由 Program 页面从 1Shell 已加入 hosts 列表选择，绝对不能手填，也不额外做 input。
- GitHub 项目链接：`github_url`。
- 对外端口：`port`。
- 最终结果：由 AI 排版后进入右侧 40% 结果界面，不生成单独结果卡片文件。

## Goal 设计规则

AI step 的 goal 应该写：
- 用户输入。
- AI 要达成的目标。
- 必要阶段。
- 成功验收条件。
- 失败或阻塞时要输出什么证据。
- 安全边界，例如不泄露密钥、不无备份覆盖未知配置、不擅自停止未知业务。

AI step 的 goal 不应该写：
- 必须使用 Nginx、Caddy、Certbot、Docker、systemd、npm、pnpm 等固定工具。
- 必须执行某条固定命令或依赖某个固定路径。
- 因为端口被占用、已有代理存在、某个命令不在 PATH、某个目录不存在，就直接判定失败。
- 运行期 AI 可以通过探测自己决定的细节。

正确表述是：让运行期 AI 探测当前环境，优先复用现有可管理服务；如需安装新工具，由运行期根据环境选择；只有无法安全备份、配置、reload 或验证时才阻塞。

## 运行规则

Program 创建完成后，用户填信息并点击运行，必须自动执行到成功、失败或阻塞：AI 型 Program 由运行期 AI 执行，脚本型 Program 由 `exec` / `render` steps 执行。

不得设计“用户认可后进入下一步”的运行流程。只有遇到会覆盖、删除、停止现有服务、改防火墙策略、暴露密钥等破坏性或安全敏感操作时，才允许在运行期请求确认。

## 创建期工具边界

创建 Program 时只写模板，不探测远程 VPS。

创建期禁止调用：
- `execute_command`
- `list_remote_dir`
- `read_remote_file`

VPS 环境检查、目录检查、Nginx / Docker / Certbot / 端口探测，都必须写进运行时 AI step 的 goal，留到用户点击运行后执行。

如果 `query_format` 失败，不要停止，也不要反复调用；按已加载的 skill 规则继续生成最小 `program.yaml`。

## Program YAML 规则

默认生成 `data/programs/<program-id>/program.yaml`。

默认结构：
- `hosts: all`，让用户运行时在 Program 页面选择 VPS。
- `inputs` 只放业务变量，例如 GitHub 链接、端口、服务名、项目名、动作选择。
- `required: true` 只给真正无法启动的核心字段；boolean、select、有 default 的字段、可由 AI 推断的字段必须 `required: false`。
- `triggers` 使用 manual。
- 固定脚本、固定开关、固定命令类 Program 优先使用 `type: exec` / `type: render`，不要使用 `type: ai`。
- 部署、配置、变更类 Program 如果需要运行期探索未知环境，优先使用一个 `type: ai` step，把完整目标写成自然语言 goal；如果执行逻辑完全固定，仍应使用 `exec` / `render`。
- 诊断、巡检、审计、状态报告类 Program 可以使用 `type: ai`，但必须要求运行期 AI 在每个关键阶段后调用 `update_result` 增量更新右侧报告草稿；不要把大段采集结果留到最后一次 Provider 调用总结。
- YAML 必须写完整机械字段：每个 trigger 都要有 `id`、`type`、`action`；每个 `ai` step 都要有 snake_case `id`、`type`、`label`、`goal`；每个 `exec` step 都要有 snake_case `id`、`type`、`label`、`run`。
- 多行文本输入使用 `type: text`，不要使用 `textarea`。
- action 显示名使用 `label`，不要只写 `name`。
- 不生成 `ui/manifest.json`、`App.jsx`、`style.css`、`DESIGN.md`。
- 不生成 frontend contract、preview check、render-only 占位前端。

## 输出规则

部署、配置、变更类 AI step 的 goal 必须要求运行时 AI 最后调用 `publish_result`。诊断、巡检、审计、状态报告类 Program 必须要求运行时 AI 在每个关键阶段后调用 `update_result`，让报告在执行过程中逐步形成。

最终结果必须输出：
- 成功还是失败。
- 操作的是哪台 VPS。
- 使用了哪些用户输入。
- 如果成功，访问地址、访问方法和验证证据。
- 如果失败，失败位置、已完成内容、下一步建议。

配置类 Program 不能只因为文件写入、命令执行或服务 reload 成功就报告成功。必须在 goal 中写清楚验收条件；例如 HTTP/HTTPS 场景必须验证访问不是 502、504、timeout 或证书错误。

验收条件要严格，但实现路径要开放：要求“配置测试通过并 reload”，不要要求“必须运行 nginx -t”；要求“证书有效且域名匹配”，不要要求“必须使用 Certbot”。

## 创建前确认

首次收到创建 Program 的需求时，即使用户说了“创建一个 / 生成一个”，也必须先展示将要创建的结构，不得立刻写文件。

确认内容必须包含：
- Program 名称和类型：AI 型或脚本型。
- AI 型写一句提示词模板；脚本型写固定执行动作和脚本参数。
- VPS 如何选择：必须来自 1Shell 已加入 hosts 列表。
- 业务输入字段，以及这些字段为什么必须由用户提供。
- 运行步骤：AI 型写阶段，脚本型写 exec / render 步骤。
- 成功验收条件和失败判定条件。
- 右侧结果界面会输出什么。

展示后必须停下来等待用户明确回复“开始创建 / 确认创建 / 按这个创建 / 直接落地 / 不用确认”。只有收到这些明确确认后，才能调用写入工具创建 `program.yaml`。

如果用户只是想调整需求，继续修改结构预览，不写文件。
