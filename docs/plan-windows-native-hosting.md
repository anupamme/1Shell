# 1Shell Windows 原生托管

> 2026-08-09 定稿并完成实现（M-W1 + M-W2 真机验收通过）。
>
> **本文档取代 `docs/plan-windows-cluster-roadmap.md` 的第一步部分。**
> 该文档原本规划「Windows → Agent 跨实例 → 集群/穿透」三步，
> **后两步已于 2026-08-09 决定不做**，理由见文末「集群与穿透：已放弃」。

---

## 目标形态

1Shell 通过 SSH 直连一台 Windows 主机（装 OpenSSH Server，DefaultShell 保持 cmd.exe，
PowerShell 5.1 在位）。**不要求目标机安装任何 1Shell 组件**，
也不要求把 DefaultShell 改成 Git-bash。

## 靶机

`yun-computer`（8.134.159.135:3022），Win10 Enterprise LTSC 2021 19044（21H2），
已托管进本机 1Shell。

- `scripts/test-windows-ssh-probe.js` —— 裸 ssh2 特征化探测（调研用）
- `scripts/test-windows-rig-live.js` —— **走产品真实链路的验收脚本**，随时可重跑：
  ```
  RIG_HOST=... RIG_PORT=... RIG_USER=... RIG_PASS=... node scripts/test-windows-rig-live.js
  ```

## 改造前的基线

在靶机上跑 `host_exec` 执行一句 `echo`：134ms 速败，exitCode=-1，
stdout 原样吐回整段 POSIX 包装脚本与 shell 池协议片段。
**wrapRemoteCommand 与 shell 池协议两层同时翻车。**

---

## 已完成

### 第 0 步：Windows 风险规则（护栏先于能力）

- `src/ai/command-safety.js`：6 条红线（删盘根/系统目录、格式化卷、抹盘、
  删注册表根配置单元、毁引导配置、删卷影副本），任何安全档（含 trusted）都拦。
- `src/harness/risk-rules.js`：10 条分级规则。high/审批档含递归删系统路径、
  `iwr|iex`、netsh 关防火墙、关 Defender、清事件日志、写 HKLM；
  medium 档含服务、用户管理、重启、递归删。
- 测试 `scripts/test-windows-risk-rules.js`，含 18 条不误伤用例、POSIX 回归、
  2026-07-04 事故命令专项复现。

**边界设计**：`C:\Windows` 及其下任意路径 = 红线；`C:\ProgramData`、`C:\Users`
仅根本身 = 红线（子目录交给分级规则）；`format` 必须在命令位，避免误伤 `--format=`。

> 归一化**不会**吃掉反斜杠（`.replace(/\\(\/)/g)` 只处理"反斜杠+正斜杠"），
> `c:\windows` 原样保留。规则按真实路径形态书写即可。

### M-W1：能执行

新增 **`lib/win-shell.js`** —— Windows 远端执行的共享原语：

| 能力 | 实现 |
|---|---|
| 命令包装 | `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(UTF-16LE)>` |
| 编码确定性 | 载荷前导 `$ProgressPreference='SilentlyContinue'` + `chcp.com 65001` + `[Console]::OutputEncoding=UTF8` |
| 退出码归一 | 用户命令前清空 `$LASTEXITCODE`；尾部 native 非零优先透传，其次 `$?` 失败→1，否则 0 |
| 环境变量 | 折进载荷为 `$env:NAME='value'`（外层是 cmd.exe，POSIX 的 `VAR=x` 前缀不适用） |
| 长脚本 | 超过 2600 字符自动改走 **stdin 通道**（见下） |
| 输出解码 | stdout UTF-8 优先、出现替换字符回退 cp936；stderr 还原 CLIXML |
| OS 探测解析 | 裸 `ver` + PowerShell 细节（产品名/版本/构建/架构/PS 版本） |

**执行链路改动**：

1. **真 OS 探测**（`host.service.js`）—— 删掉写死的 `os:'linux'`，改两段式：
   POSIX 探测无果 → 顶层裸 `ver` → 命中 `Microsoft Windows` 则再跑 PowerShell 取细节。
   新增 `ensureHostOsInfo(hostId)`：执行前确保 OS 已知（已有记录直接用，
   未知才现场探一次并落库，带 in-flight 去重）。探测失败返回 null，调用方按 POSIX 走。
2. **路由**（`bridge.service.js`）—— Windows 主机绕开 shell 池（池协议是 POSIX 的），
   强制走 `execViaExec`；独立 exec 通道本就原生传退出码，池协议无需移植。
3. **解码兜底** —— Windows 路径的 stdout/stderr 走 win-shell 的解码器。

### M-W2：能用好

1. **脚本库转义风格接 host.os**（`script.service.js`）——
   原来是 `hostId === 'local' ? LOCAL_SHELL_STYLE : 'bash'`（远端恒 bash），
   现在按主机 `osInfo.os` 判定，OS 未知时保守回落 bash。
2. **agent 提示词注入目标 OS** —— 三处：
   - `list_hosts` MCP 工具（`oneshell-core.tools.js`）：每台主机带 `os` / `osName` /
     `shell: 'powershell'`，有 Windows 主机时附 `note` 说明用 PowerShell 语法。
   - 内部 `list_hosts`（`ide.service.js`）：同上。
   - 会话上下文块（`ide.service.js`）：OS 以**服务端探测结果**为准
     （前端 context 从来不带这个字段），有 Windows 主机时追加两行说明。

   > **不做这条，M-W1 通了 agent 依然废** —— 模型拿不到任何信号，默认吐 bash。
3. **本机 cmd/PowerShell 一致性**（本来就存在的 bug，一并修）：
   - `bridge.execLocal` 原本传 `windowsShell: 'cmd'`，而脚本库的 `LOCAL_SHELL_STYLE`
     在 win32 是 `'powershell'` —— 转义风格与实际 shell 对不上，
     模型写的 PowerShell 会被 cmd.exe 拒收。现统一为 PowerShell。
   - `lib/exec-local.js` 的 Windows PowerShell 路径加退出码归一
     （`buildLocalWindowsPayload`），否则 `cmd /c "exit 7"` 返回 1 而不是 7。
     **本机载荷刻意不碰编码**：本机输出走管道，`chcp` 那套会让中文二次转换成乱码，
     而 `decodeBuffer` 的 cp936 回退本来就是对的。
   - `session.service.js` 的 `resolveLocalShell()`：`COMSPEC || 'powershell.exe'`
     里那个 PowerShell 分支永远走不到（Windows 上 COMSPEC 恒为 cmd.exe）。
     改为支持 `ONESHELL_LOCAL_SHELL=powershell|pwsh|cmd|<路径>` 显式切换，
     默认仍是 cmd.exe —— 这是人自己敲的终端，不跟着 agent 链路走。
4. **`localShell` 字段被静默丢弃** —— `panel-workloads.service.js` 一直传
   `localShell: 'powershell'`，但 `execOnHost` 的签名根本没解构它。
   现在本机与远端 Windows 都统一走 PowerShell，该字段已无意义，连同
   `buildWindowsPowerShellCommand` / `buildWindowsWorkloadDiscoveryCommand` 一并删除。
5. **终端与 SFTP** —— 实测**无需改动**：
   ssh2 的 `shell()` 对 Windows OpenSSH 是 ConPTY，回显/提示符/resize/UTF-8 中文全部正常；
   SFTP 读写、列目录、删除均正常（Windows OpenSSH 默认带 sftp 子系统）。

### M-W3：有数据

**工作负载面板已自动激活** —— 它本来就有完整的 PowerShell 实现
（`Get-CimInstance Win32_Service` / `Get-NetTCPConnection`），
只是被写死的 `os:'linux'` 挡住永远选不到。M-W1 一通即生效：
靶机上实测 **27 个工作负载，其中 15 个 Windows 服务**。

**探针（监控图表）已补齐** —— 起因是用户发现 `yun-computer` 详情页一片空白。
排查后确认这不是"功能未做"，而是**静默失败**：

- 远端探针发的是 5184 字符的 POSIX shell 脚本（`/proc`、`awk`、`df`），
  Windows 上一个都不存在；而 `probe.service.js` **直接调 `sshShellPool.exec`
  绕过了 bridge**，所以 M-W1 的 PowerShell 包装与路由都没生效。
- 更糟的是 shell 池只要拿到输出就算成功，于是字段全 null 而
  `online: true`、`error: null` —— 界面空白且不报错。
- 本机看似"有数据"其实也是残缺的：`probeLocalHost` 走 Node 的 `os` 模块
  （跨平台，所以内存/运行时长恰好有值），但 `getLocalDiskUsage` 与
  `getLocalLinuxExtras` **开头第一行都是 `if (win32) return null`**
  （函数名带 Linux 是诚实的），磁盘/进程数/平台/健康度四项一直是空的。

新增 **`src/services/probe/windows-commands.js`**：PowerShell 版探针脚本，
输出**与 POSIX 版完全相同的 `KEY=VALUE` 契约**，因此 `probe/parsers.js` 一行未改，
本机与远端共用同一份采集逻辑。

| 路径 | 改动 |
|---|---|
| 远端 Windows | `probeRemoteHost` 加分支 → 经 **bridgeService** 发脚本（不再直接捅 shell 池） |
| 本机 Windows | `getLocalLinuxExtras` 改名 `getLocalExtras`，win32 分支跑同一脚本；顺带补上 `DISK` 与 `CPU` |
| 装配 | `probeService` 构建早于 `bridgeService`，故加 `setBridgeService` 事后回注；**首次 refresh 必须排在回注之后** |

**失败语义修正**：解析不出任何指标时明确 `online: false` + `errorCode`，
不再返回"在线但全 null"。无 bridge 时报 `WINDOWS_PROBE_UNAVAILABLE`，
也不退回 POSIX 路径去拿假数据。

**两个实现要点**：

1. **本机必须走 EncodedCommand，不能走 stdin** —— 脚本里有多行 `try/catch`，
   经 `powershell -Command -` 的 stdin 喂进去时空行会截断语句块
   （实测 try 与 catch **双双执行**，输出里出现重复键）；EncodedCommand 解析正常。
2. **按实测换掉三个慢 cmdlet**（探针 60 秒一轮，这个差价必须省）：

   | 采集项 | 原方案 | 换成 | 提升 |
   |---|---|---|---|
   | 端口/连接数 | `Get-NetTCPConnection` 2110ms | `[Net.NetworkInformation.IPGlobalProperties]` 256ms | 8× |
   | 失败服务 | `Get-CimInstance Win32_Service` 976ms | `Get-Service` 253ms | 4× |
   | 防火墙 | `Get-NetFirewallProfile` 863ms | **保持不变** | — |

   > 防火墙那项试过改读注册表（205ms），但实测值是**错的** ——
   > `EnableFirewall` 键在默认启用时根本不存在，读出来是 0 而真值是三个 profile 全开。
   > 准确性优先，保留 cmdlet。

   全脚本本机 8.1s → **5.6s**，靶机远端一轮 **4.2s**（在 12s 超时内）。

**实测效果**：

```
本机（改前 3 个字段有值 → 改后全部有值）
  cpuUsage=5.68  memoryUsage=86.83  diskUsage=81.61  processCount=471
  platform=Microsoft Windows 11 Home China / x86_64 / 10.0.26100
  network={listening:72, tcp:179}  service={failed:10}  firewall=running

靶机 yun-computer（改前全 null → 改后全部有值）
  cpuUsage=11  memoryUsage=27.12  diskUsage=31.31  uptimeSec=35333  processCount=173
  platform=Microsoft Windows 10 企业版 LTSC / x86_64 / 10.0.19044（中文完整）
  keyProcesses=[sshd:5]  failedServices=[DoSvc, edgeupdate, frpc, ...]
```

> 顺带一提，`failedServices` 抓到 **frpc**：它被设为自动启动但服务没在跑
> （进程是手动起的）—— 正是这个字段该发现的东西。

---

## 实现时踩到的坑（都已解决，勿重走）

1. **`cmd /c ver` 会被 Windows OpenSSH 的引号处理搅坏**（报 `'ver"' 不是内部命令`）。
   → OS 探测用**顶层裸 `ver`**；所有 PowerShell 一律走 EncodedCommand，绝不拼引号。
2. **EncodedCommand 的 stderr 是 CLIXML**（`#< CLIXML ... <S S="Error">…</S>`）。
   → 载荷前导关进度流，并在解码侧还原 CLIXML（`decodeClixml`）。
   XML 实体解码顺序有讲究：`&amp;` 必须最后解，否则 `&amp;lt;` 会被二次解成 `<`。
3. **命令行上限是 8191 不是 32767** —— 32767 是 CreateProcess 的，
   Windows OpenSSH 走 cmd.exe，超了得到「命令行太长。」。
   工作负载探测脚本 4.4k 字符，base64 后 11.8k，直传必然被打回。
   → **长脚本自动改走 stdin**：命令行只放一段长度恒定（1318 字符）的引导程序，
   `[Console]::In.ReadToEnd()` + `Invoke-Expression` 执行真正的脚本。
   编码与退出码归一由引导程序负责，语义与直传路径完全一致。
4. **别二次包装** —— `panel-workloads` 原本自己做了一次 EncodedCommand，
   叠加执行层的包装就是两层 base64，长度翻倍直接撞上限。
   现在所有上层一律给**裸 PowerShell 脚本**，包装是执行层的唯一职责。
5. **ssh-pool 的存活检测有真 bug**（不是本次引入，但被 Windows 暴露）：
   `acquire()` 里 exec 一个 `:` 做 liveness，**不排空 stdout/stderr**——
   ssh2 的 stream 默认暂停，不读就有背压，`close` 永远不触发；
   而超时又在 exec 回调里就被 `clearTimeout` 了，于是 promise 永不落定。
   POSIX 上 `:` 恰好无输出所以侥幸没暴露；Windows 一走 exec 路径就每隔一次挂死 30 秒。
   → `checkLiveness()` 排空两条流，且超时一直 armed 到 promise 落定。
6. **绕过 bridge 的调用点要单独处理** —— `probe.service.js` 直接调 `sshShellPool.exec`，
   所以 M-W1 加在 bridge 里的 Windows 分支对它无效。
   动 Windows 兼容时，凡是**不经 bridge 的执行路径都要单独过一遍**。
7. **多行 try/catch 不能走 stdin** —— `powershell -Command -` 读 stdin 时，
   空行会截断语句块，导致 try 与 catch 双双执行。长脚本走 stdin 时要么去掉空行，
   要么像探针那样改用 EncodedCommand。

---

## 验收现状（2026-08-09 真机全过）

```
# OS 探测: {"os":"windows","prettyName":"Windows 10 Enterprise LTSC 2021 21H2",
#           "versionId":"21H2","arch":"x64","kernel":"10.0.19044.0","source":"ssh"}
PASS ascii / chinese / service / exitcode(=7) / cmdlet-err(=1)
PASS env / quotes / multiline / long-script(=3, 走 stdin)
PASS script-shell-style (powershell)
PASS workload-panel (27 个工作负载，其中 windows-service 15 个)
```

单元测试 `scripts/test-windows-remote-exec.js`（已挂 npm test）覆盖四层：
win-shell 纯函数、bridge 路由决策（含 Linux 回归保护）、host.service 两段式探测、
M-W2 的下游消费者（脚本库转义/list_hosts OS 字段/本机载荷）。

`scripts/test-windows-probe.js`（已挂 npm test）覆盖 M-W3：
脚本输出契约（键齐全/Clean-Field/慢 cmdlet 不得复现/try-catch 隔离）、
解析落位、远端路由（Windows 走 bridge、失败不装在线、无 bridge 报不可用、
setBridgeService 回注、Linux 与 OS 未知的回归保护）。

`scripts/probe-windows-rig.js` 是靶机体检脚本（系统/磁盘/网络/穿透/运行时/安全/负载/自启动），
排查 Windows 主机问题时可直接跑。

同时把一直存在却从未挂进 npm test 的 `scripts/test-bridge-command-shell.js`
（POSIX 包装的守卫测试）补挂上了。

---

## 未做 / 已知遗留

- **exec 型文件助手**：`stat -Lc` / `tar` 这类 POSIX 命令与路径拼接在 Windows 上不成立。
  文件操作优先走 SFTP（已验证可用），按功能分期补。
- **`TOP_LISTEN_PORTS` 拿不到进程名**：换成 `IPGlobalProperties` 换来 8 倍提速，
  代价是没有进程归属（端口号仍准确）。要进程名得回到 `Get-NetTCPConnection`，
  不值得为此每轮多花 1.8 秒。
- **人肉终端不过 guard**：`session.service.js` 里风险检查零命中，
  人自己敲的命令不受护栏约束。这符合设计（1Shell 是终端工具），但值得记着。
- **`scripts/test-host-capability-service.js` 有预先存在的失败**（8≠7，MCP 扫描），
  与本次改动无关（stash 掉全部改动后同样失败），是本机装了额外 MCP 的环境性失败。

---

## 集群与穿透：已放弃（2026-08-09）

原三步规划的第二步（agent 操控第三方 1Shell）与第三步（集群/穿透）**决定不做**。

**用户判断**：花大力气做集群吃力不讨好，实际使用没什么用，穿透同理。

**支撑这个判断的理由**：

1. **穿透是别人的主赛道** —— Tailscale / frp / cloudflared 专门干这个且做得更好。
   自研穿透与"对标 1panel 做证书管理"是同一个陷阱（参见既定方向：做减法求稳）。
2. **集群的价值前提不成立** —— 只有"多节点 + 多人 + 有不可达机器"同时满足才浮现；
   单人管十几台有公网 IP 的 VPS，全加进一个 1Shell 就完事，跨实例是凭空多一层。
3. **代价明确落在攻击面上** —— 当前认证是一对环境变量 + 内存会话 + 一个 fail-open 分支。
   联邦意味着 parent 被攻破 = 所有 child 被攻破。
   为一个用不上的功能先重做认证模型，这个次序本身就说明它不该排进来。

**Windows 不受影响**：它是纯单机能力、零新增攻击面，与集群无依赖关系。

**如果将来真的需要「省掉云电脑上的 frp + OpenSSH」**：
`agent/` 里的 Go 探针已经是**拨出式**的（主动连 1Shell，轮询
`/api/agent/probe/commands/next` 拿指令、POST 回结果），天然穿 NAT。
它现在只实现了 `file.listDir` 一个命令类型，加一个 `exec.run` 分支即可执行命令；
服务端队列、鉴权、结果回传全是现成的。代价：`scripts/build-agent.js` 的 `TARGETS`
只有 linux amd64/arm64，需加 windows/amd64；且 1.2 秒轮询只适合 agent 的一次性命令，
**撑不起人的交互式终端**（那仍需要 socket 中继，即集群）。
这条路**没有走**，仅作为备选记录在此。
