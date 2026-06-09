# 1Shell 安全机制论述

> 本文从「外部安全」和「AI 操控安全」两个层面论述 1Shell 的安全措施，并说明遇到问题如何查记录、做回溯。
> 所有论述基于实际代码（已逐处核实）。文末标注了有意未覆盖的边界。

---

## 0. 一句话定位

1Shell 的安全设计分两层关注点：

- **外部安全**：谁能进来、连接是否被加密、凭据怎么存——这是"人与系统之间"的边界。
- **AI 操控安全**：进来之后，AI 能对真实世界做什么、做不了什么——这是"AI 与外部世界之间"的边界，由 **harness 边界层**统一管控。

两层威胁模型不同。外部安全防的是"未授权访问与传输窃听"；AI 操控安全防的是"AI 善意失误"（它想清理却手滑跑了危险命令）。

---

## 一、外部安全

### 1.1 访问鉴权（auth.service.js）

**会话式登录 + 暴力破解防护**：

- 登录校验用户名/密码，成功后签发 `crypto.randomUUID()` 会话 ID + `crypto.randomBytes(24)` CSRF token（`auth.service.js:69-70`）。
- 密码比对用 `crypto.timingSafeEqual`（`:179`），**等长比较防时序攻击**——不会因为"前几位对了"返回得更慢而泄漏密码长度信息。
- **暴力破解锁定**：同一 IP 连续 5 次失败锁定 60 秒（`:24-25, 55-62, 167-170`）。这一条直接驳斥了"无登录限流"的说法。
- 全 `/api` 业务路由（exec / files / program / ai / host / audit）都挂在 `requireAuth` 之后（`server.js:258`），登录、健康检查在之前——顺序正确，受保护资源不可绕过鉴权。

**会话 Cookie 安全属性**（`:128-139`）：

- Session cookie 带 `HttpOnly`——JavaScript 读不到，防 XSS 窃取会话。
- `SameSite=Lax`——防跨站请求伪造的基础防线。
- HTTPS 环境自动加 `Secure` 标志（`shouldUseSecureCookie` 探测 `x-forwarded-proto`）。
- CSRF token 用独立 cookie（不带 HttpOnly，供前端读取后放进请求头），所有非 GET/HEAD/OPTIONS 请求强制校验（`verifyCsrfToken:107-126`），同样 `timingSafeEqual` 比对。

**代理 IP 反伪造**（`:27-35`）：

- 只有来自 `TRUSTED_PROXY_IPS` 白名单的请求才信任 `X-Forwarded-For` 头，否则用 socket 真实地址——攻击者无法通过伪造 XFF 头绕过 IP 锁定。

**Socket.IO 同源鉴权**（`:205-223`）：

- WebSocket 握手时校验同一套会话 cookie，未登录的 socket 连接被拒——AI 对话、终端这些走 socket 的能力同样受鉴权保护。

### 1.2 IP 访问控制（白名单 / 黑名单，ip-filter.service.js）

在鉴权之外，提供网络层的 IP 准入控制——这是"谁的网络能连进来"的边界，比账号鉴权更靠前一层。

**双模式，可叠加**：

- **白名单模式**：开启后只有名单内的 IP/CIDR 能访问，其余一律 403。
- **黑名单模式**：开启后名单内的 IP/CIDR 被拒绝访问。
- 两者可同时开启（先过白名单，再过黑名单）；均关闭时不做限制（默认全关，开箱即用）。

**实现要点**：

- 支持精确 IP 和 CIDR 段（如 `192.168.1.0/24`）匹配，含 IPv4-mapped IPv6（`::ffff:x.x.x.x`）处理（`matchesCidr` / `ipToInt`）。
- 规则存 SQLite，内存缓存 + 变更即失效（`invalidateCache`）——**热更新无需重启**。
- 同样的 XFF 反伪造：只信任受信代理 IP 转发的 `X-Forwarded-For`（`getClientIp:93-100`）。

**挂载位置是关键**（`server.js:244`）：IP 过滤中间件挂在**所有业务路由之前**——包括 bridge token 路由、MCP 路由、proxy 路由。只有登录端点（`/api/auth`）和健康检查在它之前（否则被封 IP 的人看不到 403 原因、负载均衡探活会失败）。这意味着**一旦配置白/黑名单，覆盖全部端点，无法通过 token 路由绕过**。

### 1.3 传输与连接

- 所有远端操作走 SSH（ssh2），命令、文件传输都在加密信道内。
- 级联跳板（ProxyJump）由 hostService 统一处理，多跳连接全程加密。

### 1.4 凭据存储加密（crypto.js）

- 主机 SSH 密码、私钥、passphrase 用 **AES-256-GCM** 加密后落库（`encryptText:17-34`）——GCM 是认证加密，既保密又防篡改（解密时校验 authTag，密文被改动会失败）。
- 每条密钥独立随机盐（`randomBytes(16)`）+ 随机 IV（`randomBytes(12)`），密钥经 `scryptSync` 派生——同一明文每次加密结果不同，防彩虹表。
- 密钥明文**从不写日志**；输出层有统一打码（见 2.4）。

### 1.5 文件访问路径处理（file.service.js）

- 文件管理器按真实目录内容列出、读取、写入、上传和下载文件，不再按 `.env` / key 文件等名称做隐藏或阻断。
- 拦路径穿越 `..` 片段。

---

## 二、AI 操控安全（harness 边界层）

这是 1Shell 的核心安全创新。它解决的问题是：**AI 拥有高度自主权，无人值守地操作真实 VPS，如何保证它不会好心办坏事。**

### 2.1 设计原理：唯一边界 + 确定性兜底

AI 触达外部世界的所有路径（IDE 自由对话、Program 自动化、MCP 远程调用）都收敛到**同一个关口** `harness.dispatch`。AI 想执行命令、读写文件，只能经过这个关口——绕不过去。

关键在于：安全护栏从"prompt 层"下沉到"执行层"。

- prompt 里写"禁止 rm -rf /" 是**请求**——AI 可以不听，可以被绕过。
- harness 在执行层拦截是**物理隔断**——AI 想听也绕不过，因为命令在发出前就被确定性代码判定。

护栏全部用确定性手段（正则、白名单、命令归一化），**绝不调 LLM 判断命令安不安全**——既快（微秒级）又不可被 prompt 注入绕过。

### 2.2 dispatch 的六步管道

每一次 AI 工具调用，都经过这六步（`harness/dispatch.js`）：

1. **开轨迹**（startTrace）——记录这次调用的上下文。
2. **确定性护栏**（guard.check）——capability 准入 + 灾难命令拦截，不通过直接拒绝（fail-closed）。
3. **人审 gate**——仅当"人在场"的上下文（IDE 对话）才触发；无人值守路径（Program）跳过，零等待。
4. **执行**——派发到底层执行器（SSH bridge / 本机）。
5. **出口打码**——结果里的 secret 自动脱敏。
6. **收轨迹**（endTrace）——落库决策、结果、耗时。

### 2.3 三道确定性护栏

**第一道 · 灾难命令拦截（红线兜底，command-safety.js）**

不可逆的灾难命令在执行前被拦截，命令根本不发出：

- `rm -rf /`、`rm -r --no-preserve-root /`（无 `-f` 也拦）、`rm -rf /*`、全盘通配
- fork bomb、`mkfs` 格式化块设备、`dd` 写裸设备
- **带引号绕过也能识别**：`rm -rf "/"`、`rm -rf '/'` 经命令归一化（剥引号）后同样被拦（`normalizeForRiskMatch`）。

这一道正中威胁模型——AI 手滑跑了 `rm -r /`，guard 直接挡下，不需要问任何人。

**第二道 · 能力声明式最小授权（capabilities.js）**

回答"这次任务被授权能做什么"，与红线兜底正交：

- 每个 Program 的 AI step 可在 yaml 里声明 `capabilities: [read_only]`。
- 声明 `read_only` 的 step，AI 即便想执行写命令（`rm`、`systemctl restart`、包管理器）也被边界挡掉，并把"未授权"作为结果喂回，AI 自己换方案。
- **fail-closed 授权语义**：显式空能力集 `[]` / `null` 拒绝一切；未声明（`undefined`）回退默认能力保向后兼容。

这是"最小授权"原则的落地——巡检任务只给只读，根本没机会执行破坏性操作，比黑名单稳。

**第三道 · 风险分级人审降级**

按调用上下文挂不同护栏，解决"自动化 vs 安全"的张力：

| 上下文 | 灾难拦截 | capability | 人审 |
|---|---|---|---|
| IDE 对话（人在场） | ✅ | ✅ | ✅ 可审批 |
| Program 自动化（无人值守） | ✅ | ✅ | 关闭，零等待 |

- 中危命令（`systemctl restart`、递归删除、改防火墙）在人在场时标记 needApproval，弹审批。
- 无人值守路径 `allowApproval: false`，人审分支永不进入——**AI 在红线内完全自主、零等待，碰红线确定性挡掉、不打断流程也不问人**。

### 2.4 安全模式（IDE 自由对话的人审 gate，ide.service.js）

第 2.3 节第三道护栏在"人在场"上下文的具体落地，就是 **1Shell AI 的安全模式**——用户与 AI 自由对话时默认开启（`session.safeMode` 默认 `true`，`ide.service.js:516`）。

**它怎么工作**（`ide.service.js:723-736`）：

- AI 每次想调用工具，先按工具类型分流：
  - **只读工具**（`list_hosts` / `read_remote_file` / `query_probe` / `query_audit` 等，见 `READONLY_TOOLS` 白名单）——自动放行，不打扰用户。
  - **写/执行类工具**（`execute_command` / `write_file` / `deploy_local_mcp` 等）——**弹出审批请求**，等用户在前端点"批准 / 拒绝 / 自定义回复"，AI 暂停等待。
- **超时默认拒绝**（`waitForApproval:438`）：5 分钟无响应自动按"拒绝"处理——fail-safe，不会因为用户离开就默默执行。
- 用户可关闭安全模式（`setSafeMode`），关闭后 AI 自主执行不再逐条弹审批——适合信任场景下的高效操作。

**关键设计**：安全模式**不靠 prompt 文字约束**（`SAFE_MODE_ADDENDUM` 实际是空字符串）——它纯粹是执行层的拦截 gate。这与整个安全理念一致：约束 AI 行为靠的是代码关卡，不是"对 AI 好言相劝"。AI 能不能执行，由 safeMode + 工具类型决定，AI 自己说什么都改变不了这个判断。

**与 harness 的人审 gate 的关系**：安全模式是"人在场"路径（IDE 对话）的审批；harness dispatch 的人审 gate（2.3 第三道）是同一理念在统一边界层的实现。两者都遵循"无人值守关、人在场开"的上下文授权原则。Program 自动化（无人值守）不走安全模式审批，靠的是确定性 guard + 最小授权兜底。

### 2.5 Secret 出口打码

命令输出里的 token / 密码 / 私钥片段，在返回给 AI 和前端、写入轨迹前自动脱敏成 `[REDACTED]`：

- 成功路径、错误路径、轨迹的 input_summary 全部覆盖（`redactKnownSecrets` + `redactCredentialPatterns`）。
- 防止 secret 通过命令输出泄漏到日志、前端展示或 AI 上下文。

### 2.6 这个边界的价值（before/after）

改造前，灾难拦截只挂在底层 SSH 服务上，任何不走该服务的路径（本机命令执行）自动逃逸所有护栏——本机 `rm -rf /` 直接执行，连审计都没有。

改造后，IDE / Program / MCP 三条路径统一穿过 harness，本机命令同样被拦、被审计。这不是"加了个功能"，是**修复了一个真实存在的安全真空**。

---

## 三、遇到问题：怎么查记录、怎么回溯

1Shell 有**两套记录**，互补使用。

### 3.1 审计日志 audit_logs（法务级流水）

**记什么**：每一次命令执行、MCP 工具调用、Program 运行、文件操作、配置变更，都落一条（`audit.service.js`）。字段含 action、source（来源：bridge_api / mcp / ide / program）、host、command、exit_code、duration、client_ip、error、timestamp。

**只追加，不删除**——满足合规留痕。SQLite 不可用时降级为文件日志（`audit.log`），保证不丢。

**怎么查**：
- 前端/API：`GET /api/audit/logs?limit=50&action=...&source=...&hostId=...&keyword=...`（`audit.routes.js`，受 requireAuth 保护，分页、可按动作/来源/主机/关键词过滤）。
- AI 自己也能查：`query_audit` 工具（AI 排障时可调阅历史）。

**典型场景**：
- "某台机器昨天被执行了什么" → 按 hostId 过滤。
- "哪条命令导致了故障" → 按 keyword 搜命令文本，看 exit_code 非 0 的条目。
- "某次 Program 跑了哪些命令" → 按 source=program-ai-workflow 过滤。

### 3.2 执行轨迹 harness_traces（带决策上下文的结构化轨迹）

**记什么**：每一次经过 harness 的工具调用，落一条带**决策上下文**的轨迹（`harness/trace.js`）。这是 audit_logs 没有的维度：

- `decision`：allowed / blocked / denied / error——这次调用被放行还是被挡。
- `block_reason`：命中了哪条策略（"已拦截灾难性命令：递归强制删除根目录"、"当前授权能力 [read_only] 下该命令不被允许"）。
- `capabilities`：本次授权的能力集。
- `source`：来自 IDE / Program / MCP 哪条路径。
- `needed_approval`、`input_summary`（已打码）、`exit_code`、`duration_ms`、`result_summary`。

**可解释性**：每次拦截都能回答"**为什么挡 / 命中哪条策略**"——这是 audit_logs 的扁平流水做不到的。排查"AI 当时为什么没执行某操作"时，看 decision + block_reason 一目了然。

**怎么查**：
- 前端：审计界面顶部「Harness 轨迹」tab——拦截/拒绝的记录红色高亮，拦截原因单独红框展示，可按决策（放行/拦截/拒绝/错误）和关键词筛选。
- API：`GET /api/audit/harness-traces?decision=blocked&keyword=...`（`audit.routes.js`，受 requireAuth 保护，与审计日志接口对称）。

**典型场景**：
- "AI 说要清理却没清理" → 查 harness_traces，看是 blocked（被护栏挡）还是 allowed（AI 自己没发命令）。这次真实排障就是靠它定位到"AI 跳过了执行步骤"而非"被 harness 拦"。
- "read_only step 真的限制住了吗" → 看该 run 的 traces，写命令应是 blocked + block_reason 写明能力不足。

### 3.3 两套记录怎么配合

- **audit_logs** 回答"**发生了什么**"——完整的操作流水，含成功执行的真实命令。
- **harness_traces** 回答"**为什么这么决策**"——每次调用的准入判断、拦截原因、授权能力。

排障路径：先用 audit_logs 定位"哪台机、什么时间、哪条命令、退出码多少"；再用 harness_traces 看"那次调用 harness 的决策是什么、有没有被挡、命中哪条策略"。两者通过 host_id / run_id / 时间关联。

### 3.4 Program 运行级回溯

- `program_runs` 表记每次 Program 运行的 status、steps_total/completed、error、started/finished、完整 renders。
- 排查 Program 失败时，先看这张表的 status 和 steps_completed 定位卡在哪一步，再下钻到 audit_logs / harness_traces 看那一步的具体命令和决策。

---

## 四、诚实的边界（有意未覆盖）

为避免误导，明确标注当前安全边界——这些是基于"自托管个人工具"威胁模型的**有意取舍**，不是疏漏：

**威胁模型**：1Shell 是自托管工具，用户自己掌控访问、自己加主机、自己信任。安全设计防的是"AI 善意失误"和"未授权外部访问"，**不防"恶意攻击者已经能打到机器后的提权/绕过"**。

基于此，以下有意不做：

- **首启默认凭据**：无凭据时开放访问，让用户首次启动后自行设置——与自建面板的常规做法一致。`isUsingFallbackSecret()` 会在启动时告警提示设置 `APP_SECRET`。
- **AI 命令绕过的极端构造**：`env` 前缀、`$(...)` 命令替换、`find -exec`、base64 解码执行等 shell-out 技巧能绕过 capability 限制。要完全堵住需 AST 级命令解析——但这些是"攻击者刻意绕过"才会用的，AI 助手不会主动构造。当前 guard 对"善意失误"够用。
- **SSH 主机密钥校验（TOFU）**：未做首连指纹固定。自托管、自己掌控网络的场景风险可控。
清楚标注安全边界，可以避免把自托管个人工具包装成不切实际的企业级隔离系统。

---

## 五、安全能力摘要

1. **外部访问保护**：IP 白/黑名单、会话鉴权、暴力破解锁定、CSRF、HttpOnly cookie、时序安全比对和 AES-256-GCM 凭据加密，覆盖常见 Web 暴露面。
2. **AI 操作保护**：把护栏从 prompt 下沉到执行层，确立 harness 作为 AI 触达外部世界的统一边界，提供灾难拦截、最小授权、人审降级、安全模式和 secret 打码。
3. **可回溯审计**：audit_logs 记录发生了什么，harness_traces 记录为什么这么决策，排障时可以先定位再下钻。
