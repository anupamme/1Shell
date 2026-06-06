<div align="center">

# 1Shell

**One Shell to rule them all.**

**WebSSH + VPS 管理中枢 + MCP Server。**

给人和 AI Agent 共用的多主机运维平台，理论适配 Claude Code、Codex、OpenClaw、Hermes 以及所有支持 MCP 的 Agent 项目。

1Shell 将多机终端、文件管理、脚本执行、探针监控、诊断审计、1Shell AI 网关、标准 MCP Server 和自动化 Program 集成到一个本地优先的控制台中。人可以把它当作 WebSSH / VPS 控制台使用；AI Agent 可以通过 MCP 调用它，让多台 VPS 成为可观察、可操作、可自动化、可被智能体协同管理的运维对象。

[![version](https://img.shields.io/badge/version-4.1.0-4f8cff?style=flat-square)](https://github.com/weidu12123/1Shell/releases)
[![node](https://img.shields.io/badge/node-%3E%3D18-43a047?style=flat-square&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-f9a825?style=flat-square)](LICENSE)
[![docker](https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker)](https://hub.docker.com)

</div>

---

## 什么是 1Shell？

1Shell 是一个面向个人开发者、小团队和轻量运维场景的多主机运维平台。它有两个同等重要的身份：

- 对人来说，它是一个 WebSSH / VPS 管理中枢，用来管理终端、文件、脚本、探针、审计和自动化；
- 对 AI Agent 来说，它是一个标准 MCP Server，把多台 VPS 封装成可被外部智能体调用的运维能力层。

传统 WebSSH 面板解决的是“如何连上服务器”；1Shell 更关注连接之后的人机协同运维闭环：

```text
人 / AI Agent 发起任务
        ↓
1Shell MCP Server / 1Shell AI 网关
        ↓
主机发现 → 远程命令 / 文件 / 脚本 / 探针 / 诊断
        ↓
验证结果 → 审计留痕 → 沉淀为 Program / Skill
```

在 1Shell 中，终端、文件、脚本、探针、诊断、审计、Program、Skill、MCP 和 Agent 并不是分散的功能页面，而是围绕 VPS 运维场景组织起来的一套统一能力层。

这意味着：

- 你可以像传统控制台一样管理多台 VPS；
- 也可以让 1Shell AI 在授权范围内调用这些能力完成复杂运维任务；
- 外部 Agent 可以通过 MCP 调用 1Shell，理论适配 Claude Code、Codex、OpenClaw、Hermes 以及所有支持 MCP 的 Agent 项目；
- 外部 Agent 不必感知 1Shell 内部所有工具，复杂能力可以委托给 1Shell AI 网关编排；
- 最后，可以把常见运维流程沉淀成 Program / Skill，让经验变成可复用的自动化应用。

---

## 核心能力

### 1. 多 VPS 集成管理

1Shell 提供统一的 VPS 工作台，用于管理多台远程主机和本机环境。

| 能力 | 说明 |
|---|---|
| 多机 SSH 终端 | 统一管理本机 Shell 与远程 SSH 会话 |
| SFTP 文件管理 | 浏览、预览、编辑、上传、下载远程文件 |
| 主机仓库 | 管理主机、角色、标签、排序、归档与连接信息 |
| 脚本库 | 创建、编辑、执行和复用参数化运维脚本 |
| 审计日志 | 记录关键命令、脚本执行、Bridge 调用和高风险操作 |
| 页面状态保持 | 主控台、探针、仓库等页面返回时保留上下文 |

1Shell 的目标不是替代所有专业运维系统，而是给个人开发者和小团队提供一个足够完整、足够可控、足够易扩展的 VPS 运维入口。

---

### 2. 1Shell AI 网关与上下文感知

1Shell 内置多种智能交互入口，其中 1Shell AI 是平台内部的运维 Agent，也是外部 Agent 调用复杂能力时的网关。

| 入口 | 定位 |
|---|---|
| 1Shell AI | 平台内部智能运维 Agent，可感知页面上下文、调用 1Shell 工具，并作为外部 Agent 的复杂任务网关 |
| AI Chat | 独立聊天入口，用于普通问答、解释和上下文分析 |
| AI Agent 面板 | 在 Web 控制台内运行 Claude Code、OpenCode、Codex 等 AI CLI |
| 终端选区分析 | 对选中的终端输出进行错误解释和修复建议 |
| 命令建议 | 根据自然语言生成可检查、可注入终端的命令 |
| Ghost Text | 在终端输入时提供内联补全建议 |

1Shell AI 与普通聊天机器人的区别在于：它不是只“解释”服务器状态，而是可以在授权、安全审批和审计约束下调用 1Shell 的内部能力。外部 Agent 也可以把复杂运维目标委托给 1Shell AI，由它在 1Shell 内部编排工具调用，例如：

- 列出主机、执行远程命令、读写远程文件；
- 调用脚本库、查询探针指标、读取告警；
- 执行网络诊断；安装、重启或卸载 probe-agent；
- 创建或维护 Program、Skill、Script 和 MCP 接入。

所有这些调用都经过统一的 **Harness 边界层**（见“安全设计”），在执行层做准入校验、审批与审计，而不是依赖对模型的提示词约束。

---

### 3. MCP Server：给 AI Agent 的多主机运维入口

1Shell 可以作为标准 MCP Server 暴露给外部 Agent，也可以作为平台内部的工具总线服务 1Shell AI。两者都围绕同一个目标：把 1Shell 的多主机运维能力标准化为智能体可以调用、但仍受 Harness 和审计约束的工具层。

#### 内部 MCP 调用

1Shell MCP 本身是平台能力总线，把主机、文件、脚本、探针、告警、诊断、Program、审计等能力统一开放给 1Shell 运行时内部的智能体。

内部的 1Shell AI、全局悬浮 AI、主控台 AI，以及运行在 1Shell 控制台里的 Claude Code / OpenCode / Codex 等第三方 AI CLI，都可以通过同一套能力调用整个平台。

```text
1Shell AI / 全局 AI / 内嵌 Claude Code / OpenCode / Codex
        ↓
1Shell 能力总线（Harness 边界统一管控）
        ↓
主机 / 文件 / 脚本 / 探针 / 告警 / 诊断 / Program / 审计
```

同时，1Shell 也可以接入第三方 MCP Server，让内部智能体在运维过程中调用数据库、通知、知识库、自定义 API 或团队内部工具。

#### 外部 MCP 协作（远程 HTTPS 接入）

1Shell 部署在 VPS 上时，可以作为 **远程 MCP Server**，把多主机运维能力通过 HTTPS 开放给外部 Agent。Claude Code、Codex、OpenClaw、Hermes 等支持 MCP 的项目，都可以把 1Shell 当作服务器运维工具层来调用。

外部 MCP 默认更适合走“少而硬”的工具暴露方式：保留主机列表、远程命令、文件读写等基础原语；探针、诊断、脚本、Program 等复杂能力可以委托给 `ask_1shell_ai`，由 1Shell AI 在内部编排执行，避免外部 Agent 的上下文被大量细碎工具污染。

```text
Claude Code / Codex / OpenClaw / Hermes / 其他 MCP Agent
        │  HTTPS + Remote MCP Token
        ▼
公网 VPS 上的 1Shell MCP Server
        │
        ├─ 基础工具：主机列表 / 命令执行 / 文件读写
        └─ 1Shell AI 网关：探针 / 诊断 / 脚本 / Program / 复杂运维任务
```

1Shell 会根据访问来源（hostname + 客户端 IP）**自动区分本地访问与远程访问**：本地走 Bridge Token，远程走 Remote MCP Token，两条鉴权路径隔离。

远程接入默认是关闭的，需要显式开启并经过一条完整的准入校验链：

| 校验项 | 默认 | 说明 |
|---|---|---|
| 远程开关 | 关闭 | 不显式开启则不对外暴露，纯本地使用无需任何配置 |
| 强制 HTTPS | 开启 | 非 HTTPS 请求直接拒绝，防止 Token 和数据明文传输 |
| Host 白名单 | 空（不限） | 限定允许通过哪些域名访问 |
| Origin 白名单 | 空（不限） | 校验浏览器类客户端的 Origin |
| Remote Token | 必需 | 每个 Token 独立签发，可吊销、可设有效期 |
| Token 四维 ACL | — | 每个 Token 限定可调用的工具 / 可访问主机 / 可运行脚本 / 可读写路径 |

两种传输协议都支持：标准 **SSE**（`GET /mcp/sse` 订阅 + `POST /mcp/message` 收发）和 **Streamable HTTP**（`POST /mcp/sse`，Codex 等新客户端使用）。所有远程调用与被拒绝的请求（未启用 / 非 HTTPS / Host 或 Origin 不允许 / Token 越权）都会写入审计日志。

> 部署提示：生产环境建议在 1Shell 前面放一层反向代理（nginx / Caddy）做 HTTPS 终止，把 `https://your-domain/mcp/sse` 反代到 1Shell；保持远程开关的强制 HTTPS 为开启状态。

---

### 4. 探针系统与监控闭环

1Shell 内置 VPS 探针系统，用于观察服务器运行状态。

| 模式 | 说明 | 适合场景 |
|---|---|---|
| Agentless SSH 探针 | 不在目标机安装组件，通过 SSH 采集基础指标 | 快速接入、低侵入 |
| probe-agent | 在目标机安装轻量常驻 Agent（Go 二进制） | 长期监控、稳定采样、完整指标 |
| probe-relay-agent | 通过中继 Agent 汇聚不可直连网络中的探针数据 | 内网、隔离网络、中继场景 |

探针能力包括：

- CPU、内存、磁盘、负载、进程、系统信息；
- 网络速率、累计流量、月度流量统计；
- 1m / 1h / 1d 多粒度时序数据；
- 离线告警、阈值告警、流量告警；告警确认与历史记录；
- Ping / DNS / HTTP 网络诊断；
- Agent 安装、重启、卸载和真实状态校验。

探针不是独立监控页面，而是运维闭环的一部分。智能体可以读取探针状态，脚本可以基于探针结果执行，Program 可以把监控与处置流程沉淀为可复用自动化。

---

### 5. Program：可沉淀的运维自动化应用

Program 是 1Shell 的自动化应用模型，用于把一次性的运维动作、排障经验或交付流程沉淀为可复用的小型程序。

一个 Program 由若干**有序步骤**组成，步骤分三种类型：

| 步骤类型 | 作用 | 适合 |
|---|---|---|
| `exec` | 直接执行确定的 shell 命令 + 结果校验 | 固定、可预测的动作（启停服务、清缓存） |
| `ai` | 把“对智能体的一句话任务”冻结成模板，由 AI 现场决策实现 | 需要现场判断的任务（部署、配证书、诊断、清理） |
| `render` | 结构化展示步骤结果 | 把采集/执行结果呈现给用户 |

关键在于 `ai` 步骤：它不是封装一串固定命令，而是封装**“人对智能体的指令”**。创作者只写一句 `goal`（这一步要干什么），具体用什么命令、怎么纠错、怎么排版由 AI 在该步骤内自主完成。多个 AI 步骤按顺序串联，前一步的结果自然传递给下一步。

例如一个“端口反代 + 域名 + 证书 + HTTPS”的 Program，被切成 5 个独立 AI 步骤：

```yaml
steps:
  - { id: setup_proxy,  type: ai, goal: 把本机端口反代成 HTTP }
  - { id: bind_domain,  type: ai, goal: 把域名 DNS 指过来 }
  - { id: issue_cert,   type: ai, goal: 给该域名申请证书 }
  - { id: enable_https, type: ai, goal: 启用 443，按需开 HTTP→HTTPS 跳转 }
  - { id: verify,       type: ai, goal: 端到端验证 }
```

每个 AI 步骤还可以声明 `capabilities`（如 `[read_only]`），由 Harness 在执行层强制最小授权——巡检类步骤即使 AI 想执行写操作也会被边界挡下。

典型场景：VPS 健康检查、安全清理、证书申请续签、反向代理配置、GitHub 项目部署、服务启停、日志检查、项目版本探查与更新。

Program 的执行由 Program Engine 编排：按步骤顺序执行，AI 步骤经 Harness 调用真实世界，每一步的命令、决策、结果落库，无论成功失败都进入可读的结果界面。

---

### 6. Skill、脚本库与创作台

1Shell 支持多种可复用资产：

| 类型 | 说明 |
|---|---|
| Script | 参数化脚本，适合直接执行的命令封装 |
| Program | 多步骤运维程序，支持 exec / ai / render 步骤混合 |
| 1Shell Skill | 指导 1Shell AI 完成某类任务的能力包（markdown 工作手册） |
| Claude Code Skill | 标准 Claude Code Skill 的托管与管理 |
| MCP Server | 标准 MCP Server，对外提供基础运维工具与 1Shell AI 网关 |

创作台（Skill Studio）用于创建和维护这些资产。1Shell AI 可以根据用户需求匹配并加载对应的 Skill，按 Skill 中写明的步骤、约束和风格完成创作，再把生成的 Program / Skill 文件写入并重新加载 registry。

---

## 快速开始

### 环境要求

- Node.js >= 18
- npm
- Linux / Windows / macOS 均可运行服务端
- 远程 VPS 需支持 SSH
- AI 能力需要配置 OpenAI 兼容 API 或对应 Provider

### Linux 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/weidu12123/1Shell/main/install.sh | bash
```

可选参数：

```bash
bash install.sh --port 3301 --password change-me --dir /opt/1shell
bash install.sh --docker
```

### Docker 部署

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
cp .env.example .env
docker compose up -d
```

### 源码运行

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell

# Linux / macOS
bash start.sh

# Windows
start.bat
```

启动脚本会自动安装后端依赖、在缺少 `frontend/dist` 时安装并构建前端、从 `.env.example` 创建 `.env`。

手动启动：

```bash
npm install
npm --prefix frontend install
npm --prefix frontend run build
cp .env.example .env
npm start
```

前端开发：

```bash
cd frontend
npm install
npm run dev      # 开发模式
npm run build    # 构建产物（server.js 服务的是构建产物，源码改动需重新 build）
```

默认访问地址：`http://localhost:3301`

---

## 首次配置

启动后建议完成以下配置：

1. 修改默认登录账号和密码；
2. 配置 `APP_SECRET`（用于加密存储 SSH 凭据，生产环境务必设置）；
3. 配置 `BRIDGE_TOKEN`；
4. 配置 AI Provider；
5. 添加第一台 SSH 主机；
6. 启用 Agentless 探针，如需长期监控再部署 probe-agent；
7. 如需外部 Agent 远程接入，开启远程 MCP、创建 Remote MCP Token 并配置 ACL，通过 HTTPS 暴露；仅使用内部 AI 时无需开启。

示例 `.env`：

```env
APP_LOGIN_USERNAME=admin
APP_LOGIN_PASSWORD=change-me

APP_SECRET=replace-with-random-secret

OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-key
OPENAI_MODEL=gpt-4o

BRIDGE_TOKEN=replace-with-random-token
PORT=3301
```

生产环境请务必修改默认密码、设置 `APP_SECRET` 和 `BRIDGE_TOKEN`，并通过 HTTPS 访问。

---

## 外部 MCP 协作接入示例

如果你希望让外部 Agent 调用 1Shell，可以把它配置为 MCP Server。外部 Agent 可以直接使用主机列表、命令执行、文件读写等基础工具；遇到复杂运维目标时，推荐委托给 `ask_1shell_ai`，由 1Shell AI 在内部调用探针、脚本、诊断、Program 等能力完成编排。根据部署位置分两种接入方式。

**本地 / 同机访问**（用 Bridge Token，无需开启远程开关）：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "http://localhost:3301/mcp/sse",
      "headers": {
        "X-Bridge-Token": "replace-with-your-bridge-token"
      }
    }
  }
}
```

**远程访问**（1Shell 部署在 VPS，外部 Agent 通过 HTTPS 接入）：先在控制台开启远程 MCP、创建一个 Remote MCP Token 并设置其 ACL，然后：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "https://your-domain/mcp/sse",
      "headers": {
        "X-Remote-Mcp-Token": "replace-with-your-remote-mcp-token"
      }
    }
  }
}
```

远程方式要求 HTTPS（默认强制），Token 在控制台可随时吊销，并受其工具 / 主机 / 脚本 / 路径四维 ACL 限制。服务器部署场景下，如果只使用内部 AI，则不需要开启远程 MCP、也不需要把它暴露给公网。

---

## 架构概览

```text
Browser
  └─ Vue 3 SPA / xterm.js / Tailwind / Pinia
        │
        │ HTTP + WebSocket
        ▼
1Shell Server
  ├─ Express / Socket.IO
  ├─ Auth / CSRF / IP Filter / Audit
  ├─ SSH Terminal / SFTP File Service
  ├─ Script Service / Script Runner
  ├─ Probe Service
  │   ├─ Agentless SSH Probe
  │   ├─ probe-agent
  │   └─ probe-relay-agent
  ├─ AI Service（1Shell AI / 工具调用循环）
  ├─ Harness 边界层  ← AI 触达外部世界的唯一关口
  │   ├─ 确定性护栏（灾难命令拦截 / 能力最小授权）
  │   ├─ 人审降级（安全模式审批）
  │   ├─ Secret 出口打码
  │   └─ 执行轨迹落库（harness_traces）
  ├─ MCP Server（内部能力总线 + 外部协作，Token ACL）
  ├─ Program Engine
  │   ├─ exec   直接命令执行 + 校验
  │   ├─ ai     AI 工作流步骤（经 Harness 调用真实世界）
  │   └─ render 结果展示
  ├─ Skill Registry / Skill Studio
  ├─ AI Agent PTY（Claude Code / OpenCode / Codex）
  └─ SQLite / Repositories / Migrations
```

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Vue 3、Vite、TypeScript、Tailwind CSS、Pinia、Vue Router、xterm.js |
| 后端 | Node.js、Express、Socket.IO |
| 数据库 | SQLite、better-sqlite3 |
| SSH / SFTP | ssh2、node-pty |
| AI | OpenAI 兼容 API、流式输出、工具调用 |
| AI 边界 | Harness（统一关口 / 确定性护栏 / 能力授权 / 执行轨迹） |
| MCP | MCP SSE / Streamable HTTP，Remote Token ACL |
| 探针 | Agentless SSH、probe-agent（Go）、probe-relay-agent |
| 自动化 | Program Engine（exec / ai / render）、Skill Registry |
| 部署 | Docker、docker-compose、systemd、便携包 |

---

## 项目结构

```text
1Shell/
├── server.js                    # 服务入口与依赖装配
├── frontend/                    # Vue 3 前端
│   ├── src/
│   └── dist/                    # 构建产物（server.js 实际服务的内容）
├── src/
│   ├── ai/                      # AI 提示词 / 命令安全规则
│   ├── agents/                  # AI CLI Agent 面板（Claude Code / OpenCode / Codex）
│   ├── app/                     # Express / Server 初始化
│   ├── database/                # SQLite 与 migrations
│   ├── harness/                 # AI 边界层：dispatch / guard / capabilities / trace
│   ├── ide/                     # 1Shell AI 对话引擎与工具调用
│   ├── mcp/                     # MCP Server
│   ├── middleware/              # 安全中间件
│   ├── programs/                # Program Engine 与 schema
│   ├── routes/                  # API 路由
│   ├── services/                # 主机、文件、探针、脚本、审计、IP 过滤等服务
│   ├── skills/                  # Skill registry
│   └── tools/                   # 统一工具层（oneshell-core tools）
├── data/
│   ├── programs/                # Program 定义（program.yaml）
│   ├── skills/                  # 1Shell Skill
│   ├── claude-code-skills/      # Claude Code Skill 托管
│   └── 1shell.db                # SQLite 数据库
├── agent/                       # probe-agent / relay-agent（Go）
├── Dockerfile
├── docker-compose.yml
└── install.sh
```

---

## 安全设计

1Shell 面向真实服务器操作场景，安全边界是核心设计之一。安全措施分两层：**外部安全**（谁能进来）和 **AI 操控安全**（进来之后 AI 能做什么）。

### 外部安全

| 机制 | 说明 |
|---|---|
| IP 访问控制 | 白名单 / 黑名单双模式，支持 CIDR，挂在所有业务路由之前，热更新无需重启 |
| 登录认证 | 用户名密码 + Session 管理，失败锁定防暴力破解，时序安全比对 |
| CSRF 防护 | Session Cookie（HttpOnly）+ CSRF Token |
| 凭据加密 | SSH 密码、私钥、Passphrase 用 AES-256-GCM 加密存储 |
| Bridge / MCP 鉴权 | Bridge Token 与 Web Session 隔离；远程 MCP 默认强制 HTTPS，Remote Token 支持工具 / 主机 / 脚本 / 路径四维 ACL，可吊销 |

### AI 操控安全（Harness 边界层）

1Shell AI 拥有较高自主权，可无人值守地操作真实 VPS。为此，AI 触达外部世界的所有路径（内部对话、Program、MCP）统一收敛到一个 **Harness 边界关口**，安全护栏在执行层施加，而不是依赖对模型的提示词约束。

| 机制 | 说明 |
|---|---|
| 唯一边界 | AI 执行命令、读写文件都必须经过 Harness dispatch，绕不过 |
| 灾难命令拦截 | `rm -rf /`、fork bomb、`mkfs`、`dd` 写裸设备等不可逆命令在执行前确定性拦截 |
| 能力最小授权 | Program 步骤可声明 `capabilities`（如 `read_only`），越权调用被边界挡下 |
| 安全模式 | 人在场（自由对话）时，写 / 执行类工具调用前需人工审批，超时默认拒绝 |
| Secret 打码 | 命令输出中的 token / 密码 / 私钥自动脱敏，不泄漏到日志、前端或 AI 上下文 |
| 执行轨迹 | 每次工具调用落库 `harness_traces`，记录决策、拦截原因、授权能力，可在审计界面回溯 |

1Shell 的设计目标不是让智能体绕过运维安全边界，而是在明确授权、可审计、可验证的前提下参与运维流程。

---

## 适用场景

- 个人开发者管理多台 VPS；
- 小团队统一管理测试机、部署机和服务节点；
- 需要在浏览器中同时处理终端、文件、脚本和监控的场景；
- 希望让智能体在授权范围内协助排障、巡检、部署和维护；
- 希望通过 MCP 把 1Shell 开放给 Claude Code、Codex、OpenClaw、Hermes 等外部 Agent 协作；
- 希望把常用运维流程沉淀为可复用 Program；
- 希望在本地优先、可控、可审计的前提下构建个人运维中枢。

---

## License

[MIT](LICENSE) © 2025 weidu12123
