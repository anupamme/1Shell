# Changelog

## 4.2.4 - 2026-06-19

4.2.4 focuses on frontend correctness and release polish for the 4.2 patch line. It keeps the fixes in UI, rendering, and runtime plumbing rather than adding more prompt rules.

- Wire real `/model` slash-command behavior into the main console 1Shell AI panel, standalone IDE/Panel page, and global floating 1Shell AI entry.
- Add a shared model-provider loader and model slash menu so provider activation uses the same backend API across 1Shell AI surfaces.
- Limit the floating 1Shell AI slash menu to commands it can actually execute: `/model`, `/mode`, `/compact`, `/remind`, and `/clear`.
- Add safe Markdown table rendering for 1Shell AI timeline text: malformed pipe tables now fall back to literal code blocks instead of being rendered as misleading broken tables.
- Preserve natural assistant text while continuing to filter duplicate tool-boundary fragments and repeated work-note noise.
- Improve Agent sidebar/mobile behavior, terminal resize refresh, and About/version display consistency.
- Broaden the Node engine metadata for the 4.2 package line and keep the SQLite fallback path for newer local Node runtimes.

## 4.2.3 - 2026-06-19

4.2.3 focuses on making 1Shell AI less blind during long-running command failures. It does not add more prompt rules; instead it passes execution facts from the tool layer back to the model so the agent can reason from complete context.

- Add structured `outputDiagnostics` to command results, including runtime, output size, truncation state, terminal progress markers, download-phase hints, interactive prompt hints, clear error/completion hints, and last meaningful output lines.
- Preserve partial stdout/stderr, exit code, duration, timeout, and interactive prompt state through SSH shell, bridge, harness, core tools, IDE tools, frontend tool cards, and provider observations.
- Detect long-running terminal-progress downloads such as BenchOS/curl output and surface `suspectedStalledDownload` as a factual signal for the model.
- Remove duplicate pseudo progress text generated while tool arguments are still streaming, avoiding repeated “preparing parameters”/work-note noise in the agent timeline.
- Keep natural assistant text visible while avoiding repeated `workNote` rendering in tool summaries and tool bodies.
- Keep the core prompt minimal: no task-specific deployment heuristics and no fixed architecture-generated answer templates.
- Add project guardrails in `AGENTS.md` so future maintenance keeps prompt changes rare, avoids architecture impersonating the AI, and preserves full model context.
- Verify the release with syntax checks, targeted stalled-download diagnostics, `npm test`, frontend typecheck, and frontend production build.

## 4.2.2 - 2026-06-18

4.2.2 is a patch release for update-flow testing after 4.2.1. It hardens updater restart behavior and long-running MCP operations so users can continue testing in-place upgrades from the 4.2 line.

- Bump the release line from 4.2.1 to 4.2.2 so updater tests can validate a real version transition.
- Make updater restarts exit with a supervisor-friendly non-zero code by default, while still allowing `ONESHELL_RESTART_EXIT_CODE` / `ONE_SHELL_RESTART_EXIT_CODE` overrides.
- Change the Linux systemd install unit to `Restart=always`, reducing the chance that a successful update exit leaves the service down.
- Extend the stdio MCP client request timeout to 10 minutes by default and make it configurable with `ONESHELL_MCP_REQUEST_TIMEOUT_MS`.
- Preserve Linux executable permissions during release repackaging so `start.sh`, `install.sh`, and MCP stdio entrypoints remain runnable after update.
- Keep MCP large-file/background transfer fixes from 4.2.1 and continue publishing updater assets for Windows x64 and Linux x64 with SHA256 checksum files.

## 4.2.1 - 2026-06-18

4.2.1 is a test patch release for validating the 4.2 feature set. It synchronizes the latest agent, MCP, transfer, terminal, mobile layout, and slash-command fixes into the 4.2 source tree.

- Fix terminal progress-output and resize behavior by stabilizing xterm sizing, delaying remote PTY resize updates until layout settles, resetting terminal state on session switches, and clamping backend PTY dimensions.
- Add MCP core transfer coverage and safer large-file transfer paths, including chunk upload and background task checks.
- Sync 1Shell AI slash-command support and structured tool-result rendering across IDE/Agent surfaces.
- Remove leftover UI noise from the frontend and improve mobile layout behavior for the 4.2 console.
- Keep 4.2's Node engine constraint and release baseline while bumping package metadata to 4.2.1.

## 4.2.0 - 2026-06-18

4.2 是在 4.1 主体闭环上的一次大版本级补强，但版本号仍保留在 4.x。它把 1Shell 从“WebSSH + 程序化工作流面板”进一步收敛为“人和 Agent 共用的本地优先运维 runtime”：模型负责判断，runtime 负责状态、工具、安全边界、审计和可恢复运行。

### 核心变化

- 重构 1Shell AI 的默认产品路径，新增 AgentRun/IDE Agent 体验，弱化旧的重型 Program/Studio 路线。
- 新增 agent runtime 基础模块，覆盖预算、工具策略、观察解释、轨迹、interrupt、replay、final gate 和验证器等运行时职责。
- IDE Agent 页面新增会话侧栏、工具侧栏、时间线、审批卡片、审批模式、结构化工具结果和更稳定的流式状态。
- 新增 `/compact` 历史压缩能力，前端会显示独立的“正在压缩”状态，避免和普通对话生成混淆。
- 主机列表、探针列表等工具结果改为结构化数据交给前端渲染，减少模型重新拼表格导致的格式漂移。
- 清理过度具体的部署提示词，把“该读网页还是拉源码”等判断交回模型和工具上下文。

### Agent Runtime 与安全边界

- 新增 `src/agent-runtime/*`，为多步骤 agent 运行提供状态、预算、工具策略、轨迹、回放和验证基础。
- 强化 Harness 作为 AI 触达外部世界的统一边界，继续承载能力授权、风险识别、审批、人审降级和 trace 记录。
- 新增/调整 MCP 工具 profile，让不同工具集可以按场景裁剪，避免一次性暴露过长工具列表。
- 增强空输出保护，避免模型或工具异常返回空内容时前端进入不明确状态。
- 删除旧的 legacy IDE tool loop，减少 runtime 和模型互相“抢方向”的情况。

### 主机、文件与 Docker

- 文件管理器补齐基础写操作：新建文件夹、新建文件、重命名、删除、排序和写后刷新。
- 后端文件服务同步支持本机与 SFTP 的 mkdir/touch/delete/rename，并拒绝路径穿越、根目录删除、盘符根目录操作和重命名覆盖。
- MCP、Harness、Remote MCP ACL 和 1Shell AI gateway 同步纳入新增文件写工具。
- Docker 场景下增强只读挂载/权限错误提示，明确容器视角、宿主机视角和可执行处理方式。
- 新增文件写入自检接口，便于判断是工具链问题还是目标路径不可写。

### 登录、安全与凭据

- 新增 TOTP 2FA，兼容 Google Authenticator 等认证器。
- 新增一次性恢复码，恢复码只展示一次，服务端仅保存哈希。
- 登录流程支持密码验证后的 2FA 待验证票据，验证码通过后才签发正式会话。
- 设置页新增安全分区，可开启/关闭 2FA、查看恢复码和管理安全选项。
- `APP_SECRET` 缺失时不再阻止首次添加主机；`start.bat` / `start.sh` 首次创建 `.env` 时会自动生成随机 `APP_SECRET`。
- `start.sh` 固定 LF 行尾，避免 Linux 上出现 `env: bash\r` 类启动错误。

### MCP、外部 Agent 与 Bridge

- 本地 MCP 与 Remote MCP 的配置、令牌、ACL 和路径限制继续收敛到统一能力层。
- Bridge Token 自动管理更稳定，避免 `.env` 与持久化 token 读取顺序冲突。
- Claude Code MCP 配置同步能力增强，便于本地 Agent 直接接入 1Shell。
- 新增 `SecretRefPicker` 等前端能力，为工具调用中的 secret 引用做准备。

### 探针与远程监控

- 探针安装支持 `PUBLIC_SERVER_URL` / `ONESHELL_PUBLIC_URL`，可显式指定公网回连地址。
- 反代场景下生成 agent 端点时优先使用显式公网地址、Forwarded 头和浏览器 Origin，减少 http/https/端口推导错误。
- probe-agent、relay-agent、流量统计、告警、诊断和主机状态展示继续完善。
- 前端新增/调整探针结构化卡片和趋势展示，让 Agent 工具结果和人工界面复用同一批数据表达。

### 前端与桌面体验

- 登录页重做为深色终端品牌区 + 浅色登录卡片，移除旧 LoginGlobe。
- 设置从弹窗改为独立 `/settings` 页面，支持账号、安全、IP 访问控制、AI 配置、桌面版和关于分区。
- 默认浅色模式，保留已有用户的深色偏好。
- 主机仓库、主控台、脚本、技能、MCP Hub、Agent/IDE 相关页面都有结构和交互更新。
- 桌面版开始接入 GitHub Releases 更新能力，浏览器/开发模式下提供手动 Release 入口。

### 发布与安装

- 版本升级到 `4.2.0`，Node 支持范围为 `>=20 <23`；推荐 Node 20.18.3，不支持 Node 24 原生依赖安装。
- Windows/Linux 离线发布包内置 Node 20.18.3 与生产依赖，解压后可直接运行启动脚本。
- `start.bat` 优先使用包内 `runtime/node/node.exe`。
- `start.sh` 优先使用包内 `runtime/node/bin/node` 并加入 `PATH`，避免系统 Node 版本过高导致原生模块 ABI 不匹配。
- 发布包已验证 `better-sqlite3` 和 `node-pty` 在内置 Node 20 下可加载。

### 移除或降级的旧路径

- 移除旧 Program runtime、Program routes、Skill Studio 以及对应前端 Studio 组件。
- 移除 SettingsModal，改用独立设置页。
- 移除 LoginGlobe，避免登录页依赖重型视觉组件。
- 旧的“把一句目标拆成完整工作流卡片”的方向不再作为默认产品路径；可复用能力改为从真实 AgentRun、Skill、Script 和轻量 AI Task 中沉淀。

### 迁移说明

- 升级时请保留 `data/`、`.env`、`logs/` 和已有数据库文件，不要用新包直接覆盖这些运行数据。
- 已经配置过 `APP_SECRET` 的部署必须继续保留原值，否则旧凭据无法解密。
- 新部署通过 `start.bat` / `start.sh` 创建 `.env` 时会自动生成 `APP_SECRET`；手动部署未设置时仍可首次使用，但上线前建议设置强随机密钥。
- 如果从旧包手工替换文件，建议使用新 release 包完整替换程序文件，只保留运行数据目录和 `.env`。

### 发布包

- Windows: `release/1shell-4.2.0-windows-x64-offline-20260618-011427.zip`
  - Size: 64,914,600 bytes
  - SHA256: `6b9e9835da567b6289b012a29d7d6d2d2c5ce84e83e28d3c869f7123b9a7eba2`
- Linux x64: `release/1shell-4.2.0-linux-x64-offline-20260617-172258.tar.gz`
  - Size: 83,354,890 bytes
  - SHA256: `5a41c19f21d0f7ba2bb1bea7f2a24accf2406de1b252681b9ef683a2197fabbb`

### 验证

- `npm test`
- `npm --prefix frontend run build`
- Windows 干净解压后运行 `start.bat`，自动生成 `.env` 和 `APP_SECRET`，`/api/health` 返回 `usingFallbackSecret:false`
- Linux/vip-hk 干净解压后运行 `start.sh`，自动生成 `.env` 和 `APP_SECRET`，`/api/health` 返回 `usingFallbackSecret:false`
