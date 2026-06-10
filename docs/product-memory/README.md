# 1Shell 产品记忆库

> 这份文档不是给普通用户看的 README，而是给开发者和 AI 协作者看的产品记忆。
> 新窗口接手 1Shell 的规划、文案、功能设计或重构前，应先读这份文档。

## 一句话总览

1Shell 是围绕 Shell 长出来的多主机运维平台。

它的当前定位是：

```text
WebSSH + VPS 管理中枢 + MCP Server。
给人和 AI Agent 共用的多主机运维平台。
理论适配 Claude Code、Codex、OpenClaw、Hermes 以及所有支持 MCP 的 Agent 项目。
```

更抽象地说：

```text
1Shell 把 Shell 变成一个同时给人、AI Agent、工作流程序使用的多主机运维能力层。
```

## 名字与根理念

1Shell 这个名字和 `One Shell to rule them all` 最初来自 AI 取名建议。起初它只是一个顺眼、好记、有气势的名字，但项目一路演化后，这句话反而变成了真实的产品理念。

它最终指向的是：

- 一个入口管理多台主机。
- 一个 Shell 同时服务人和 AI。
- 一个中枢统一承载终端、文件、脚本、探针、MCP、AI、Program 和审计。
- 一个能力层让外部 Agent 不需要逐台感知 VPS，只需要接入 1Shell。

所以 1Shell 的名字不是装饰，它已经变成产品判断标准：

```text
这个功能是否仍然围绕 Shell / VPS / Agent 运维？
它是否加强一个中枢管理多主机的能力？
它是否让人或 AI 更好地掌控终端与主机？
```

如果答案是否定的，就要谨慎。

## 项目陪伴与学习轨迹

1Shell 不只是一个一次性设计出来的项目，它也是开发者一路学习 AI、MCP、Skill、VPS 运维和产品设计的过程记录。

早期开发时，开发者对 MCP 和 Skill 并不算熟，也没有深度使用过，只是隐约知道这些能力应该被引入。1Shell 的很多关键方向不是一开始就完全想清楚，而是在边做边失败、边试边发现中逐渐浮现出来。

### MCP 的幸运巧合

MCP 是 1Shell 发展中最幸运的一次巧合。

最初引入 MCP 时，本意只是让 1Shell 接入 MCP 能力。但因为实现得足够标准，代码完成后再去 `cc-switch` 里看，意外发现里面已经出现了一个 `1shell`。随后 Claude Code 也开始能够使用 1Shell MCP。

这件事的意义很大：

```text
1Shell 不是后来强行贴上 MCP 概念。
它是在一次标准化实现中，意外发现自己已经可以成为 MCP Server。
```

从这个节点开始，1Shell 的定位发生了根本变化：

- 它不只是自己内部用 AI。
- 它可以作为标准 MCP Server 给外部 Agent 调用。
- 它可以把多台 VPS 的运维能力变成 Agent 可调用的工具层。
- 它可以理论适配所有支持 MCP 的 Agent 项目。

后来“WebSSH + VPS 管理中枢 + MCP Server”这条定位线，正是从这次意外成功中长出来的。

### Skill 的艰难区分

Skill 的引入没有 MCP 那么顺利。

早期对 Skill 的理解比较混杂，曾经想用一套 Skill 或一堆提示词直接指导 1Shell AI 完成特定操作。后来在 Program、前端生成、运行约束和安全边界的反复失败中，才逐渐区分出两类 Skill：

1. **第三方 Agent Skill**
   
   这类 Skill 面向 Claude Code、Codex、OpenCode 等第三方 Agent，用来帮助它们理解如何调用 1Shell、如何通过 1Shell MCP 操作 VPS。

2. **1Shell Skill**
   
   这类 Skill 面向 1Shell AI 本身。它不绑定具体模型，不管 1Shell AI 接入的是 Claude、OpenAI 兼容模型、Qwen、DeepSeek 还是其他模型，只要运行在 1Shell AI 体系内，就应该能按 1Shell Skill 的指导完成任务。

最终形成的核心观点是：

```text
第三方 Agent Skill 是给外部 Agent 用的。
1Shell Skill 是给 1Shell AI 用的。
1Shell Skill 不绑定具体模型，而绑定 1Shell AI 这个运行环境。
```

这一区分非常重要。它让 1Shell Skill 不再只是模仿 Claude Code Skill，而是变成 1Shell 自己的能力组织方式。

## 发展历程

### v1.0：WebSSH 面板

最早的 1Shell 是一个 VPS 远程管理工具，核心是 WebSSH、多机 SSH、本机终端和基础运维。

这个阶段解决的问题是：

```text
如何连上服务器？
如何在一个地方切换多台 VPS？
如何把终端体验搬到网页里？
```

这一阶段的价值是打下 Shell 入口，但产品还更像 WebSSH 工具。

### v2.0：零侵入 AI 接入

第二阶段开始思考 Claude Code、Codex 等第三方 Agent 如何进入 VPS。

当时的关键问题是：

```text
如果每台 VPS 都要安装 Claude Code / Codex / Agent，成本太高。
低配 VPS 也未必跑得动这些工具。
```

于是 1Shell 开始走零侵入路线：

- 能力尽量集中在 1Shell 一端。
- 目标 VPS 通过 SSH 被统一纳管。
- Agent 不必逐台安装到每台 VPS。
- 探针也提供 Agentless SSH 探测模式。

这一阶段逐渐形成了“一端御万机”的底层意识。

### v3.0：1Shell AI 与 MCP 化

第三阶段，1Shell 开始从“人用的 WebSSH 工具”变成“AI 也能用的运维能力层”。

关键变化：

- 出现 1Shell AI。
- 出现全局 AI、终端选区分析、命令建议等智能入口。
- 1Shell 能力开始通过 MCP 暴露。
- Claude Code、Codex、OpenCode 等外部/内嵌 Agent 可以通过 1Shell 间接操作 VPS。

这个阶段的核心意识是：

```text
1Shell 不只是被人点击使用，也应该被 Agent 调用。
```

但此时外部远程 MCP、Agent 生态联动和最终定位还没有完全收束。

### v4.0：新范式重构

4.0 是项目理念真正成型的关键版本。

这一阶段围绕几个核心问题重构：

- AI 如何真正参与运维，而不是只会解释？
- AI 如何安全地执行真实主机操作？
- 自动化程序如何不被固定脚本和固定面板功能限制？
- 1Shell 如何对标 1Panel，但不正面复刻 1Panel 的大量工程代码？

最终形成几项核心能力：

- AI 工作流程序。
- 1Shell Skill。
- Harness 执行层安全边界。
- Vue 前端重构。
- 主机仓库、探针、中继等 VPS 管理中枢能力。

4.0 的核心突破是 Program 理念：

```text
Program 不是封装一串 CLI 命令。
Program 是把“人操控智能体完成任务的过程”包装成可复用模板。
```

### v4.1：真正意义上的正式版

4.1 是 1Shell 第一次真正对外形成清晰产品闭环的版本。

这一版对外定位收束为：

```text
WebSSH + VPS 管理中枢 + MCP Server。
```

相较 4.0，4.1 的重要意义不只是新增功能，而是把已有功能重新组织成了一个能被用户理解的产品：

- WebSSH：人使用 Shell。
- VPS 管理中枢：多主机被组织、观察、管理。
- MCP Server：AI Agent 使用 Shell。
- 1Shell AI / Skill / Program：把运维经验变成可复用能力。

从产品意义上看，4.1 才是 1Shell 真正意义上的第一个正式版本。

## 失败与转化

1Shell 的发展不是一路顺利设计出来的，而是很多失败被拆解、吸收、重组后的结果。

重要判断：

```text
很多旧方案失败的是形式，不是问题意识。
旧方案抓住了真问题，但给错了解法。
```

### 失败一：定位曾经太散

早期 1Shell 同时有 WebSSH、远程 Agent、MCP、探针、脚本、文件管理等功能，但对外说不清主线。

当时的问题不是功能不够，而是缺少一句话串起来。

后来定位收束成：

```text
WebSSH + VPS 管理中枢 + MCP Server。
给人和 AI Agent 共用的多主机运维平台。
```

这说明 1Shell 不是简单功能集合，而是围绕 Shell 组织起来的统一能力层。

### 失败二：想正面追 1Panel

1Panel 是代码时代很成熟的服务器面板，它的优势是大量工程代码固化了网站、反向代理、证书、应用商店等流程。

1Shell 如果正面复刻，很难在代码完成度上赢过它。

后来形成的新路线是：

```text
1Panel 用代码固化流程。
1Shell 用 AI 工作流复现流程。
```

这就是“弯道超车”的真实含义。

1Shell 不追求在每一个固定面板功能上写出比 1Panel 更完整的代码，而是通过 AI 工作流程序，让用户可以把常见运维流程包装成可复用程序，例如：

- 一键部署 GitHub 项目。
- 反向代理 + 域名 + 证书 + HTTPS。
- VPS 基础巡检。
- 服务日志诊断。
- 环境安装和服务管理。

### 失败三：三层架构失败，但没有白死

曾经构想过一个逻辑上很完美的三层架构，用 1Shell Skill 和大量提示词让 1Shell AI 完成特定操作。

这个显式架构后来被放弃了，项目里也不再保留“三层架构”这个词。

但它的影子仍然留在现在的架构里：

- 原来“让 AI 完成特定操作的技能”，被拆成新的 1Shell Skill。
- 原来“用提示词约束 AI”，被拆成 Harness 执行层安全边界。
- 原来“让复杂操作结构化”，被拆成 AI 工作流程序。
- 原来“AI 能力入口”，落到 MCP 工具体系和 1Shell AI 网关上。

所以三层架构不是完全错了，而是过于集中、过于依赖提示词。

它最后被拆成三块更合理的东西：

```text
Skill 负责指导。
Program 负责沉淀流程。
Harness 负责安全兜底。
```

### 失败四：Program 曾经被写成复杂 Prompt

旧 Program 里常见问题：

- 一个 AI step 里塞很多 phase。
- prompt 巨长，写满通用素养。
- 要求 AI 严格输出 JSON。
- 前端再 parse AI 输出。
- AI 不按格式输出时界面就空白。
- 首次 LLM 调用容易超时。

后来明确：

```text
Program 创作者不应该重写智能体内功。
Program 只应该表达 goal 和少量领域陷阱。
```

不该写进每个 Program 的内容：

- 调用哪个内部工具上报阶段。
- 执行哪些固定系统命令。
- 禁止哪些危险命令。
- 最终报告必须包含哪些死板字段。
- 工具存在方式。

正确拆分：

- 任务目标写在 Program 的 `goal`。
- 通用运行素养放进 runtime Skill。
- 安全红线放进 Harness。
- 展示规范放进前端 Skill / 输出 Skill。

### 失败五：过度统一 Program 前端

曾经尝试把 Program 前端做成通用固定槽位，但后来发现这会杀死 Program 的表达能力。

因为不同 Program 需要不同界面：

- VLESS 程序可能需要复制链接和二维码。
- HTTPS 反代程序可能需要打开域名按钮。
- VPS 巡检程序可能需要健康评分和资源表格。
- 部署程序可能需要日志、端口、启动命令和访问入口。

所以正确方向不是固定所有前端，而是：

```text
硬约束统一，具体界面由 AI 按场景生成。
```

硬约束包括：

- 必须能选择目标 VPS。
- 必须有步骤推进。
- 必须符合 1Shell 设计 token。
- 必须避免把无用 stdout、堆栈、密钥直接暴露给用户。
- 必须遵守 runAction、事件订阅、secret 处理等平台契约。

## 核心理念

### 1. Shell 是根

1Shell 的所有能力最终都应该围绕 Shell 展开。

```text
WebSSH 是人用 Shell。
MCP 是 Agent 用 Shell。
Program 是把 Shell / Agent 运维流程沉淀下来。
主机仓库和探针是让多台 Shell 背后的主机可观察、可管理。
```

这也是 1Shell 不优先做 RDP 的原因。

RDP 更偏图形远程桌面，会把产品带向“全协议连接工具”。1Shell 的核心是通过终端掌控主机，而不是成为所有远程连接协议的集合。

### 2. 一端御万机

1Shell 不希望每台 VPS 都安装一个重型面板，也不希望每台 VPS 都安装一套 Claude Code / Codex / Agent。

它的路线是：

- 能力集中在 1Shell。
- VPS 通过 SSH、探针、Agent、Relay 被统一纳管。
- 本地电脑、VPS、公网中枢都可以成为 1Shell 所在位置。
- 无公网 IP 的本地设备可以通过中继完成探针回传。

这一理念支撑主机仓库、探针、中继、MCP Server、远程 Agent 接入。

### 3. 对人和 AI 同等开放

1Shell 的特殊之处不是“有 AI”，而是同一套运维能力同时给人和 AI 使用。

```text
人通过 Web / Desktop / WebSSH 操作。
1Shell AI 通过内部工具操作。
外部 Agent 通过 MCP 操作。
未来 CLI 可以让人、脚本、Agent 都从终端调用。
```

这使 1Shell 不是普通 WebSSH，也不是普通聊天机器人，而是一个可被人和 Agent 共用的运维能力层。

### 4. MCP 是能力总线

MCP 在 1Shell 中有两个方向：

- 对外：1Shell 作为 MCP Server，把 VPS 运维能力开放给 Claude Code、Codex、Hermes、OpenClaw 等 Agent。
- 对内：1Shell 可以作为 MCP Client，导入第三方 MCP，丰富 1Shell AI 的能力。

因此 MCP 不是附属功能，而是 1Shell 的能力总线。

重要设计：

- 主机、文件、命令、脚本、探针、诊断、审计、Program 都应该逐步 MCP 化。
- 外部 Agent 不一定需要看到所有细碎工具，复杂任务可以委托给 `ask_1shell_ai`。
- Remote MCP 要有明确鉴权、HTTPS、Token、白名单、审计和权限边界。

### 5. AI 工作流程序是原创核心

AI 工作流程序是 1Shell 区别于普通 SSH 工具、普通面板和普通 AI 聊天工具的关键。

它的定义：

```text
把“人操控智能体完成某个运维任务的过程”包装成可复用程序。
```

它不是：

- 固定命令序列。
- 简单脚本库。
- 低代码表单。
- 单纯 prompt 模板。

它应该是：

- 确定性动作交给 `exec`。
- 需要现场判断的动作交给 `ai`。
- 展示结果交给 `render` 或前端。
- 每个 AI step 只描述 goal，不重写 AI 的执行细节。

这套范式的意义：

```text
代码写不完的面板能力，可以用 AI 工作流复现。
用户自己的运维经验，可以变成可重复运行的程序。
每个 Program 都会扩展 1Shell 的能力边界。
```

### 6. 1Shell AI 保持纯净，逻辑外置到 Skill

1Shell AI 不应该靠一个越来越长的系统提示词硬撑所有能力。

正确方向：

- 核心系统提示词保持尽量纯净。
- 任务逻辑写进 Skill。
- Skill 通过列表匹配和按需加载进入上下文。
- 工具行为写进工具描述。
- 安全红线下沉到执行层。

这让能力扩展从“改 AI”变成“写 Skill”。

### 7. 安全约束下沉到执行层

AI 运维不能只靠提示词说“不要做危险操作”。

正确边界：

```text
AI 生成动作
  ↓
Harness 接管
  ↓
风险识别 / 权限判断 / 审批或阻断
  ↓
最小权限执行
  ↓
审计记录
```

安全理念：

- AI 可以提出操作意图。
- AI 不能直接等于系统执行。
- 高风险操作必须被识别、审批或阻断。
- 审计要能回溯“谁让 AI 做了什么、AI 为什么做、系统是否放行”。

### 8. 真实证据优先

1Shell AI 不应该脱离主机上下文泛泛回答。

它应该优先读取：

- 主机画像。
- 探针状态。
- OS 信息。
- 服务状态。
- 端口、日志、文件、执行结果。
- 审计和历史记录。

一句话：

```text
普通 Agent 是临时查系统，1Shell 是持续理解系统。
```

## 三类核心用户

### 玩 AI 的人

他们的痛点：

- Agent 很强，但落到 VPS 上部署、调试、排障时需要反复 SSH。
- 不想每台 VPS 都安装 Claude Code / Codex。
- 想让 Agent 接入真实服务器环境。

对他们的表达：

```text
1Shell 是一个 MCP Server，可以让 Claude Code、Codex、Hermes、OpenClaw 等 Agent 通过 MCP 操控 VPS。
```

### 玩 VPS 的人

他们的痛点：

- 手里有多台 VPS。
- SSH、文件、监控、脚本分散。
- 不想每台机器都装一个面板。

对他们的表达：

```text
1Shell 是一个 WebSSH + VPS 管理中枢，可以统一管理主机、终端、文件、探针状态和运维脚本。
```

### VPS 小白

他们的痛点：

- 会买 VPS，但不熟 Linux。
- 不会部署项目、反代域名、申请证书、看日志、排错。

对他们的表达：

```text
1Shell 用 1Shell AI 和 AI 工作流程序，把常见 VPS 操作变成可执行流程，让新手也能在 AI 辅助下使用 VPS。
```

## 与 1Panel 的关系

1Panel 是 1Shell 的启蒙对象，但不是同赛道正面对手。

1Panel 的优势：

- 单机面板功能成熟。
- 网站、反向代理、证书、应用商店等能力工程化程度高。
- 用户习惯清晰。

1Shell 的不同路线：

- 不追求每台 VPS 都安装一个面板。
- 不用固定应用商店覆盖所有场景。
- 用 AI 工作流程序复现常见运维流程。
- 用一个中枢统一管理多台 VPS。
- 用 MCP 把运维能力开放给 AI Agent。

对标关系可以这样理解：

```text
1Panel 是代码时代的单机服务器面板。
1Shell 是 AI 时代的人机共用多主机运维中枢。
```

## 与 Termark 的关系

Termark 是一个功能定位相近但路线不同的产品。

它更像：

```text
现代桌面 SSH 客户端 + AI + 资产管理 + 本地 CLI。
```

1Shell 更像：

```text
开源自部署的 MCP VPS 运维中枢。
```

Termark 在 WebSSH / 终端客户端体验上天然更强，因为它是成熟桌面软件，可以更直接地利用本地终端、剪贴板、窗口、快捷键、CLI 和系统能力。

1Shell 不应把主战场放在“做一个更强的 SSH 客户端”。

1Shell 的差异点：

- 开源。
- 自部署。
- VPS 管理中枢。
- 主机仓库。
- 探针与中继。
- MCP Server 标准适配。
- 1Shell AI。
- 1Shell Skill。
- AI 工作流程序。

尤其是 AI 工作流程序，是 1Shell 最大的原创差异点。

竞品观察原则：

- 可以学习公开产品行为、文档、演示视频、CLI 交互。
- 不应逆向、扫描或反编译闭源代码。
- 可以抽象学习产品思路，但实现要走 1Shell 自己路线。

## 产品边界

### 不优先做 RDP

RDP 更偏 Windows 图形桌面连接，会把产品带向全协议远程连接平台。

1Shell 的核心是 Shell：

```text
掌控终端，基本就等于掌控主机。
```

因此 RDP 可以作为建议记录，但不应成为近期主线。

### 不和成熟桌面终端正面比终端体验

桌面 SSH 客户端在终端体验、系统集成、快捷键、剪贴板、本地路径等方面天然占优。

1Shell 的 WebSSH 需要持续补强，但主战场不是终端客户端本身，而是：

- VPS 中枢。
- MCP。
- 1Shell AI。
- AI 工作流程序。

### 不盲目堆功能

4.1 之后主体功能已经饱和。

后续 4.x 不应该再频繁大转向，而是：

- 修 bug。
- 补安全。
- 补接入。
- 补默认程序。
- 补文档和案例。
- 让已有能力更开箱可用。

### 不声称绝对安全

1Shell 管 VPS，安全表述必须克制。

可以说：

- 1Shell 是自部署。
- 密码和主机信息存储在运行 1Shell 的本机/服务器。
- AI 不直接拿到用户密码，而是通过工具和终端能力操作。
- 支持 IP 白名单、Token、审计、Harness 等安全设计。

不应说：

```text
绝对安全。
完全不会出问题。
放心暴露公网无需配置。
```

## 版本路线

### 4.2：补强开箱体验

4.2 不是大方向版本，而是围绕 4.1 的闭环补强。

当前计划包括：

- 登录 2FA。
- Claude Code / Codex / OpenCode 接入扫描和一键配置。
- 默认 AI 工作流程序。
- 初次部署默认浅色模式。
- 地图返回空白问题修复。
- 沙箱输出残影和重复渲染修复。
- GitHub、文档、Release、反馈入口。
- Docker 部署主机目录写入优化。
- 自动更新能力预研。

宣传主题：

```text
安全登录、Agent 接入向导、默认 AI 运维程序。
```

### 4.3：Agent 生态接入增强

4.3 可以在 Claude Code、Codex、OpenCode 的基础上加入：

- Hermes。
- OpenClaw。
- 更多 MCP Client 配置模板。
- Agent 接入状态检测。
- Hermes + 微信 + 1Shell MCP 示例。
- OpenClaw 调用 1Shell 管理 VPS 示例。

宣传主题：

```text
Agent 生态接入增强，让更多 MCP Agent 通过 1Shell 管理 VPS。
```

### 4.x 后续：持续小步补强

适合两周一个小版本，一次一个宣传主题。

可能方向：

- 安全与权限。
- 探针告警。
- 1Shell AI 执行链路。
- Skill 编辑器和模板。
- Program 导入导出。
- 程序市场雏形。
- 告警触发 AI 工作流。
- 更多默认程序。

原则：

```text
4.x 做能力补强，不做大转向。
```

### 5.0：CLI 与命令式主控台

CLI 值得作为 5.0 的方向。

它会给 1Shell 增加第三个入口：

```text
Web / Desktop 是图形入口。
MCP 是 Agent 入口。
CLI 是人、脚本、Agent 都能用的轻量入口。
```

可能能力：

```bash
1shell status
1shell login
1shell host list
1shell host info <host>
1shell exec <host> -- <command>
1shell mcp config
1shell agent scan
1shell agent install codex
1shell agent install claude
1shell workflow list
1shell workflow run <name>
```

CLI 还会反向影响前端：

- 主控台可以从拥挤布局变得更简洁。
- 复杂能力可以通过命令面板按需唤起。
- 例如 `/claude`、`/codex`、`/vps`、`/workflow`、`/files`。

但 5.0 之前，优先打磨 1Shell AI 与 AI 工作流程序。

## 宣传口径

### 核心三句话

```text
WebSSH + VPS 管理中枢 + MCP Server。
给人和 AI Agent 共用的多主机运维平台。
理论适配 Claude Code、Codex、OpenClaw、Hermes 以及所有支持 MCP 的 Agent 项目。
```

### 面向 AI 用户

```text
1Shell 是一个 MCP Server，可以让 Claude Code、Codex、Hermes、OpenClaw 等 Agent 通过 MCP 操控 VPS。
适合想把 AI Agent 接到真实服务器上做部署、调试、运维的人。
```

### 面向 VPS 用户

```text
1Shell 是一个 WebSSH + VPS 管理中枢，适合手上有多台 VPS 的用户。
可以统一管理主机、终端、文件、探针状态，并支持多 VPS 快捷切换。
```

### 面向 VPS 新手

```text
1Shell 内置 AI 运维能力，可以辅助完成 VPS 上的部署、反代、证书、日志分析等操作。
适合想用 VPS 但不太熟 Linux 命令的新手。
```

## 给未来 AI 协作者的注意事项

接手 1Shell 时，不要只把它当成一个功能很多的 WebSSH 项目。

必须先理解：

- Shell 是根。
- 一端御万机是底层方向。
- MCP 是能力总线。
- AI 工作流程序是原创核心。
- Skill 是指导，不是提示词堆叠。
- Harness 是安全边界，不是文案。
- 4.1 是正式闭环，4.x 是补强。
- 5.0 才适合考虑 CLI 和命令式主控台。

做规划或写文案时，优先问：

```text
这件事是否让人或 AI 更好地通过 1Shell 操控 VPS？
它是否加强 WebSSH / VPS 管理中枢 / MCP Server 三条主线？
它是否让 AI 工作流程序更像真正的产品能力？
```

如果不是，就不要轻易把它放进近期主线。
