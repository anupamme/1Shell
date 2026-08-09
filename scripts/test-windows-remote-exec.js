'use strict';

/**
 * M-W1：Windows 远端执行链路
 *
 * 覆盖三层：
 *   1. lib/win-shell 纯函数（载荷组成、编码、CLIXML 还原、OS 探测解析）
 *   2. bridge.service 的路由决策（Windows → exec 模式 + PowerShell 包装；POSIX 主机不受影响）
 *   3. host.service 的两段式 OS 探测（POSIX 失败 → 裸 ver → PowerShell 细节）
 */

const assert = require('assert');

const {
  MAX_PAYLOAD_CHARS,
  STDIN_BOOTSTRAP_COMMAND,
  WINDOWS_DETAIL_PROBE_COMMAND,
  WINDOWS_VER_PROBE_COMMAND,
  buildWindowsPayload,
  buildLocalWindowsPayload,
  buildWindowsRemoteCommand,
  decodeClixml,
  decodeRemoteOutput,
  encodePowerShellCommand,
  isWindowsOsName,
  parseWindowsDetailOutput,
  parseWindowsVerOutput,
  psQuote,
} = require('../lib/win-shell');
const { createBridgeService } = require('../src/services/bridge.service');
const { createHostService } = require('../src/services/host.service');

function decodePayload(commandLine) {
  const b64 = commandLine.trim().split(/\s+/).pop();
  return Buffer.from(b64, 'base64').toString('utf16le');
}

// ─── 1. win-shell 纯函数 ─────────────────────────────────────────────────────

{
  const built = buildWindowsRemoteCommand('Get-Service sshd', {});
  assert.strictEqual(built.stdin, null, '短命令不应动用 stdin 通道');
  const line = built.command;
  assert.ok(line.startsWith('powershell '), 'Windows 命令必须以 powershell 起头');
  assert.ok(line.includes('-EncodedCommand'), '必须走 EncodedCommand（免引号地狱）');
  assert.ok(!line.includes('"') && !line.includes("'"), 'EncodedCommand 命令行不得含任何引号');
  assert.ok(!/bash|sh -lc/.test(line), 'Windows 路径不得出现 POSIX 包装');

  const payload = decodePayload(line);
  assert.ok(payload.includes("$ProgressPreference = 'SilentlyContinue'"), '必须关进度流，否则 stderr 混入 CLIXML 噪音');
  assert.ok(payload.includes('chcp.com 65001'), '必须切 UTF-8 代码页');
  assert.ok(payload.includes('[Console]::OutputEncoding'), '必须显式设置 .NET 控制台编码');
  assert.ok(payload.includes('Get-Service sshd'), '用户命令必须原样进入载荷');
  assert.ok(payload.includes('$global:LASTEXITCODE = $null'), '用户命令前必须清空 LASTEXITCODE');
  assert.ok(payload.includes('exit $LASTEXITCODE'), '必须透传 native 命令退出码');

  // 顺序很重要：清空 LASTEXITCODE 必须在用户命令之前，退出码归一必须在之后。
  assert.ok(
    payload.indexOf('$global:LASTEXITCODE = $null') < payload.indexOf('Get-Service sshd'),
    'LASTEXITCODE 清空必须在用户命令之前',
  );
  assert.ok(
    payload.indexOf('Get-Service sshd') < payload.indexOf('$__1shellOk = $?'),
    '退出码归一必须在用户命令之后',
  );
}

{
  // 环境变量折进载荷（外层是 cmd.exe，POSIX 的 `VAR=x` 前缀完全不适用）
  const payload = buildWindowsPayload('echo hi', { TOKEN: "it's", PATH_EXTRA: 'C:\\tmp' });
  assert.ok(payload.includes("$env:TOKEN = 'it''s'"), 'PowerShell 单引号转义应为翻倍');
  assert.ok(payload.includes("$env:PATH_EXTRA = 'C:\\tmp'"), '反斜杠在单引号串内无需转义');
  assert.ok(!payload.includes('export '), 'Windows 载荷不得出现 POSIX export');
  assert.ok(
    payload.indexOf("$env:TOKEN") < payload.indexOf('echo hi'),
    '环境变量必须在用户命令之前设置',
  );
}

assert.strictEqual(psQuote("a'b"), "'a''b'");
assert.strictEqual(psQuote(null), "''");
assert.strictEqual(psQuote(''), "''");

{
  // base64 必须是 UTF-16LE —— PowerShell 只认这一种
  const line = encodePowerShellCommand('Write-Output "中文"');
  assert.strictEqual(decodePayload(line), 'Write-Output "中文"');
}

{
  // 载荷超长必须显式报错，而不是让远端截断成语法错误
  assert.throws(
    () => encodePowerShellCommand('x'.repeat(MAX_PAYLOAD_CHARS + 1)),
    (err) => err.code === 'WIN_PAYLOAD_TOO_LARGE',
    '超长载荷应抛 WIN_PAYLOAD_TOO_LARGE',
  );
  assert.doesNotThrow(() => encodePowerShellCommand('x'.repeat(MAX_PAYLOAD_CHARS)));
}

{
  // 长脚本自动改走 stdin —— cmd.exe 命令行只有 8191 字符，
  // 工作负载探测脚本（4.4k）直传必然被"命令行太长。"打回。
  const long = 'Write-Output ok\n' + 'x'.repeat(MAX_PAYLOAD_CHARS * 2);
  const built = buildWindowsRemoteCommand(long, { TOKEN: 'v' });
  assert.strictEqual(built.command, STDIN_BOOTSTRAP_COMMAND, '长脚本应改用恒定的引导命令行');
  assert.ok(built.command.length < 8191, '引导命令行必须远低于 cmd.exe 的 8191 上限');
  assert.ok(built.stdin.includes(long), '脚本正文必须经 stdin 送达');
  assert.ok(built.stdin.includes("$env:TOKEN = 'v'"), 'stdin 路径同样要带上环境变量');

  // 引导程序自身负责编码与退出码归一，语义与直传路径一致
  const bootstrap = decodePayload(STDIN_BOOTSTRAP_COMMAND);
  assert.ok(bootstrap.includes('[Console]::In.ReadToEnd()'), '引导程序必须从 stdin 读脚本');
  assert.ok(bootstrap.includes('Invoke-Expression'), '引导程序必须执行读到的脚本');
  assert.ok(bootstrap.includes('chcp.com 65001'), '引导程序必须设置 UTF-8');
  assert.ok(bootstrap.includes('exit $LASTEXITCODE'), '引导程序必须透传退出码');
}

{
  // CLIXML 还原（PowerShell 5.1 在 stderr 被重定向时的真实形状）
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<S S="Error">Get-Item : 找不到路径。_x000D__x000A_</S>'
    + '<S S="Error">+ CategoryInfo : ObjectNotFound_x000D__x000A_</S></Objs>';
  const decoded = decodeClixml(clixml);
  assert.ok(decoded.includes('Get-Item : 找不到路径。'), 'CLIXML 里的错误文本必须还原');
  assert.ok(decoded.includes('CategoryInfo'), '多个 <S> 段都要还原');
  assert.ok(!decoded.includes('CLIXML') && !decoded.includes('<Objs'), '不得残留 XML 骨架');
  assert.ok(decoded.includes('\r\n'), '_x000D__x000A_ 应还原成回车换行');

  // 普通 stderr 原样透传
  assert.strictEqual(decodeClixml('plain error\n'), 'plain error\n');
  assert.strictEqual(decodeClixml(''), '');

  // XML 实体：&amp; 必须最后解，否则 &amp;lt; 会被二次解成 <
  const entities = '#< CLIXML\n<Objs><S S="Error">a &amp;lt; b &gt; c &quot;d&quot;</S></Objs>';
  assert.ok(decodeClixml(entities).includes('a &lt; b > c "d"'), 'XML 实体解码顺序必须正确');
}

{
  // 输出解码：UTF-8 优先，出现替换字符才回退 cp936
  assert.strictEqual(decodeRemoteOutput(Buffer.from('中文 ok', 'utf8')), '中文 ok');
  let iconv = null;
  try { iconv = require('iconv-lite'); } catch { /* optional */ }
  if (iconv) {
    const gbk = iconv.encode('版本 10.0', 'cp936');
    assert.strictEqual(decodeRemoteOutput(gbk), '版本 10.0', 'cp936 原始字节应回退解码');
  }
  assert.strictEqual(decodeRemoteOutput(null), '');
  assert.strictEqual(decodeRemoteOutput(Buffer.alloc(0)), '');
}

{
  // OS 探测解析：`ver` 输出（含中文版与英文版）
  assert.deepStrictEqual(
    parseWindowsVerOutput('\r\nMicrosoft Windows [版本 10.0.19044.1889]\r\n'),
    { kernel: '10.0.19044.1889' },
  );
  assert.deepStrictEqual(
    parseWindowsVerOutput('Microsoft Windows [Version 10.0.22631.4317]'),
    { kernel: '10.0.22631.4317' },
  );
  // Linux 的输出不得被误判成 Windows
  assert.strictEqual(parseWindowsVerOutput('bash: ver: command not found'), null);
  assert.strictEqual(parseWindowsVerOutput(''), null);

  const detail = parseWindowsDetailOutput([
    '__1SHELL_WINOS__',
    'product=Windows 10 Pro',
    'release=21H2',
    'build=10.0.19044.0',
    'arch=AMD64',
    'ps=5.1.19041.5007',
  ].join('\r\n'));
  assert.strictEqual(detail.prettyName, 'Windows 10 Pro 21H2');
  assert.strictEqual(detail.versionId, '21H2');
  assert.strictEqual(detail.arch, 'x64', 'AMD64 应归一成 x64');
  assert.strictEqual(detail.powershellVersion, '5.1.19041.5007');
  assert.strictEqual(parseWindowsDetailOutput('no marker here'), null);
}

assert.strictEqual(isWindowsOsName('windows'), true);
assert.strictEqual(isWindowsOsName('Windows'), true);
assert.strictEqual(isWindowsOsName('linux'), false);
assert.strictEqual(isWindowsOsName(null), false);

// 探测命令本身的形状
assert.strictEqual(WINDOWS_VER_PROBE_COMMAND, 'ver',
  '必须是顶层裸 ver —— `cmd /c ver` 会被 Windows OpenSSH 的引号处理搅坏');
assert.ok(WINDOWS_DETAIL_PROBE_COMMAND.includes('-EncodedCommand'), '细节探测也必须走 EncodedCommand');
assert.ok(!WINDOWS_DETAIL_PROBE_COMMAND.includes('"'), '细节探测命令行不得含引号');

// ─── 2. bridge.service 路由决策 ──────────────────────────────────────────────

function makeBridgeHarness({ osInfo }) {
  const calls = { shellPool: [], exec: [], stdin: [] };
  const hostService = {
    findHost: () => ({ id: 'h1', name: 'rig', type: 'ssh', osInfo }),
    ensureHostOsInfo: async () => osInfo,
    connectToHost: async () => { throw new Error('unused'); },
  };
  const sshShellPool = {
    exec: async (hostId, command) => {
      calls.shellPool.push(command);
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    },
  };
  const sshPool = {
    acquire: async () => ({
      client: {
        exec: (command, cb) => {
          calls.exec.push(command);
          const written = [];
          const stream = {
            _handlers: {},
            on(evt, fn) { this._handlers[evt] = fn; return this; },
            stderr: { on() { return this; } },
            write(chunk) { written.push(String(chunk)); },
            end() { if (written.length) calls.stdin.push(written.join('')); },
          };
          cb(null, stream);
          setImmediate(() => stream._handlers.close?.(0));
        },
      },
      proxyClient: null,
    }),
    returnToPool: () => {},
    release: () => {},
  };
  const bridge = createBridgeService({ hostService, auditService: null, sshPool, sshShellPool });
  return { bridge, calls };
}

// ─── 3. host.service 探测替身 ────────────────────────────────────────────────

// connectToHost 内部 `require('ssh2')` 且被闭包引用，替换导出属性无效 ——
// 往 require 缓存里塞一个假 Client，才能驱动真实的连接 + 探测路径。
function installFakeSsh2(responder, seen) {
  const ssh2Path = require.resolve('ssh2');
  const original = require.cache[ssh2Path];

  class FakeClient {
    constructor() { this._handlers = {}; }
    on(evt, fn) { this._handlers[evt] = fn; return this; }
    connect() { setImmediate(() => this._handlers.ready?.()); }
    end() {}
    exec(command, opts, cb) {
      seen.push(command);
      const payload = responder(command);
      const stream = {
        _handlers: {},
        on(evt, fn) { this._handlers[evt] = fn; return this; },
        stderr: { on() { return this; } },
      };
      cb(null, stream);
      setImmediate(() => {
        if (payload.stdout) stream._handlers.data?.(Buffer.from(payload.stdout, payload.encoding || 'utf8'));
        stream._handlers.close?.(payload.exitCode ?? 0);
      });
    }
  }

  require.cache[ssh2Path] = { id: ssh2Path, filename: ssh2Path, loaded: true, exports: { Client: FakeClient } };
  return () => {
    if (original) require.cache[ssh2Path] = original;
    else delete require.cache[ssh2Path];
  };
}

function makeProbeHarness(responder) {
  const seen = [];
  const stored = [];
  const hostRepository = {
    readStoredHosts: () => stored.map((h) => ({ ...h })),
    writeStoredHosts: (hosts) => { stored.length = 0; stored.push(...hosts); },
    readHostPreferences: () => [],
    readHostPreference: () => null,
    writeHostPreference: () => {},
    deleteHostPreference: () => {},
  };
  const hostService = createHostService({ hostRepository });
  stored.push(hostService.buildStoredHost({
    name: 'rig', host: '10.0.0.1', port: 22, username: 'u', authType: 'password', password: 'pw',
  }));
  const restore = installFakeSsh2(responder, seen);
  return { hostService, seen, stored, hostId: stored[0].id, restore };
}

async function runAsyncChecks() {
  {
    // Windows 主机：绕开 shell 池，走 exec + PowerShell 包装
    const { bridge, calls } = makeBridgeHarness({ osInfo: { os: 'windows' } });
    const result = await bridge.execOnHost('h1', 'Get-Service sshd', 30000, { env: { TOKEN: 'x' } });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(calls.shellPool.length, 0, 'Windows 主机不得走 shell 池（池协议是 POSIX 的）');
    assert.strictEqual(calls.exec.length, 1, 'Windows 主机必须走独立 exec 通道');
    assert.ok(calls.exec[0].startsWith('powershell '), 'Windows 命令必须是 PowerShell 包装');
    assert.strictEqual(calls.stdin.length, 0, '短命令不应动用 stdin');
    const payload = decodePayload(calls.exec[0]);
    assert.ok(payload.includes('Get-Service sshd'));
    assert.ok(payload.includes("$env:TOKEN = 'x'"), 'env 必须折进 PowerShell 载荷');
  }

  {
    // POSIX 主机：行为完全不变（回归保护）
    const { bridge, calls } = makeBridgeHarness({ osInfo: { os: 'linux' } });
    await bridge.execOnHost('h1', 'uptime', 30000, {});
    assert.strictEqual(calls.exec.length, 0, 'Linux 主机仍应优先走 shell 池');
    assert.strictEqual(calls.shellPool.length, 1);
    assert.ok(calls.shellPool[0].includes('exec bash -lc'), 'Linux 主机必须保留 bash 包装');
  }

  {
    // OS 未知（探测失败）：按 POSIX 走，等于回到本功能之前的行为
    const { bridge, calls } = makeBridgeHarness({ osInfo: null });
    await bridge.execOnHost('h1', 'uptime', 30000, {});
    assert.strictEqual(calls.shellPool.length, 1, 'OS 未知时应保守走原有 POSIX 路径');
  }

  {
    // 载荷超长：自动改走 stdin 通道，不再失败
    const { bridge, calls } = makeBridgeHarness({ osInfo: { os: 'windows' } });
    const longCommand = `Write-Output start\n${'x'.repeat(MAX_PAYLOAD_CHARS * 2)}`;
    const result = await bridge.execOnHost('h1', longCommand, 30000, {});
    assert.strictEqual(result.exitCode, 0, '长脚本应正常执行而不是被拒');
    assert.strictEqual(calls.exec.length, 1);
    assert.strictEqual(calls.exec[0], STDIN_BOOTSTRAP_COMMAND, '长脚本应走恒定引导命令行');
    assert.strictEqual(calls.stdin.length, 1, '脚本正文必须经 stdin 送达');
    assert.ok(calls.stdin[0].includes(longCommand), 'stdin 内容必须包含完整脚本');
  }

  // ─── 3. host.service 两段式 OS 探测 ────────────────────────────────────────

  {
    // Windows 靶机：POSIX 探测空手而归 → 裸 ver → PowerShell 细节
    const { hostService, seen, stored, hostId, restore } = makeProbeHarness((command) => {
      if (command === 'ver') return { stdout: '\r\nMicrosoft Windows [版本 10.0.19044.1889]\r\n' };
      if (command.startsWith('powershell ')) {
        return {
          stdout: [
            '__1SHELL_WINOS__',
            'product=Windows 10 专业版',
            'release=21H2',
            'build=10.0.19044.0',
            'arch=AMD64',
            'ps=5.1.19041.5007',
          ].join('\r\n'),
        };
      }
      // cmd.exe 收到 POSIX 探测：原样回显一堆垃圾，退出码非零
      return { stdout: "'cat' 不是内部或外部命令", exitCode: 1 };
    });

    try {
      const osInfo = await hostService.ensureHostOsInfo(hostId);
      assert.strictEqual(osInfo.os, 'windows', '两段式探测必须认出 Windows');
      assert.strictEqual(osInfo.prettyName, 'Windows 10 专业版 21H2');
      assert.strictEqual(osInfo.arch, 'x64');
      assert.strictEqual(osInfo.kernel, '10.0.19044.0');
      assert.strictEqual(osInfo.source, 'ssh');
      assert.ok(seen.includes('ver'), '必须用顶层裸 ver 探测');
      assert.ok(!seen.some((c) => c.includes('cmd /c ver')), '不得用会被引号搅坏的 cmd /c ver');
      assert.strictEqual(stored[0].osInfo.os, 'windows', '探测结果必须落库');

      // 已落库后不再重复探测
      const before = seen.length;
      const again = await hostService.ensureHostOsInfo(hostId);
      assert.strictEqual(again.os, 'windows');
      assert.strictEqual(seen.length, before, '已知 OS 不应重复探测');
    } finally {
      restore();
    }
  }

  {
    // Linux 主机：第一段就成功，绝不触碰 Windows 探测
    const { hostService, seen, hostId, restore } = makeProbeHarness((command) => {
      if (command.includes('/etc/os-release')) {
        return {
          stdout: [
            'PRETTY_NAME="Ubuntu 22.04.3 LTS"',
            'ID=ubuntu',
            'VERSION_ID="22.04"',
            '',
            '__1SHELL_OS_SPLIT__',
            'x86_64',
            '',
            '__1SHELL_OS_SPLIT__',
            '5.15.0-88-generic',
          ].join('\n'),
        };
      }
      throw new Error(`unexpected probe command: ${command}`);
    });

    try {
      const osInfo = await hostService.ensureHostOsInfo(hostId);
      assert.strictEqual(osInfo.os, 'linux');
      assert.strictEqual(osInfo.distroId, 'ubuntu');
      assert.strictEqual(osInfo.prettyName, 'Ubuntu 22.04.3 LTS');
      assert.ok(!seen.includes('ver'), 'POSIX 探测成功后不得再跑 Windows 探测');
    } finally {
      restore();
    }
  }

  {
    // 细节探测失败：仍然认定是 Windows，走 ver 的降级信息
    const { hostService, hostId, restore } = makeProbeHarness((command) => {
      if (command === 'ver') return { stdout: 'Microsoft Windows [Version 10.0.22631.4317]' };
      return { stdout: '', exitCode: 1 };
    });
    try {
      const osInfo = await hostService.ensureHostOsInfo(hostId);
      assert.strictEqual(osInfo.os, 'windows', '细节探测失败不应推翻 Windows 判定');
      assert.strictEqual(osInfo.kernel, '10.0.22631.4317', '应回落用 ver 里的版本号');
    } finally {
      restore();
    }
  }

  {
    // 两段都空：OS 保持未知，调用方按 POSIX 走
    const { hostService, hostId, restore } = makeProbeHarness(() => ({ stdout: '', exitCode: 1 }));
    try {
      assert.strictEqual(await hostService.ensureHostOsInfo(hostId), null);
    } finally {
      restore();
    }
  }
}

// ─── 4. M-W2：OS 感知的下游消费者 ────────────────────────────────────────────

let listHostsCheck = async () => {};

{
  // 脚本库转义风格跟着主机 OS 走（此前远端恒为 bash）
  const { createScriptService } = require('../src/services/script.service');
  const hostsById = {
    win: { id: 'win', type: 'ssh', osInfo: { os: 'windows' } },
    lin: { id: 'lin', type: 'ssh', osInfo: { os: 'linux' } },
    unknown: { id: 'unknown', type: 'ssh', osInfo: null },
  };
  const scriptService = createScriptService({
    scriptRepository: { findScript: () => null },
    hostService: { findHost: (id) => hostsById[id] || null },
    bridgeService: null,
    auditService: null,
  });
  const render = (hostId) => scriptService.renderContent(
    { content: 'echo {{msg}}' },
    { msg: "it's" },
    { hostId },
  );

  assert.strictEqual(render('win').shellStyle, 'powershell', 'Windows 主机应使用 PowerShell 转义');
  assert.ok(render('win').rendered.includes("'it''s'"), 'PowerShell 单引号应翻倍');
  assert.strictEqual(render('lin').shellStyle, 'bash', 'Linux 主机保持 bash');
  assert.ok(render('lin').rendered.includes("'it'\\''s'"), 'POSIX 转义不应变化');
  assert.strictEqual(render('unknown').shellStyle, 'bash', 'OS 未知时保守回落 bash');
}

{
  // list_hosts 必须把 OS/shell 告诉模型 —— 不给信号，模型默认吐 bash
  const { createOneShellCoreTools } = require('../src/tools/oneshell-core.tools');
  const tools = createOneShellCoreTools({
    hostService: {
      listHosts: () => ([
        { id: 'win', name: 'rig', type: 'ssh', host: '10.0.0.1', port: 22, osInfo: { os: 'windows', prettyName: 'Windows 10 Pro 21H2' } },
        { id: 'lin', name: 'vps', type: 'ssh', host: '10.0.0.2', port: 22, osInfo: { os: 'linux', prettyName: 'Ubuntu 22.04' } },
      ]),
    },
  });
  listHostsCheck = async () => {
    const result = await tools.handle('list_hosts', {}, {});
    const parsed = JSON.parse(result.content);
    const hosts = parsed.data.hosts;
    const win = hosts.find((h) => h.id === 'win');
    const lin = hosts.find((h) => h.id === 'lin');
    assert.strictEqual(win.os, 'windows', 'Windows 主机必须带 os 字段');
    assert.strictEqual(win.shell, 'powershell', 'Windows 主机必须显式标出 shell');
    assert.strictEqual(win.osName, 'Windows 10 Pro 21H2');
    assert.strictEqual(lin.os, 'linux');
    assert.strictEqual(lin.shell, undefined, 'Linux 主机不应带 shell 字段');
    assert.ok(/PowerShell/.test(parsed.data.note || ''), '有 Windows 主机时应给出 PowerShell 提示');
  };
}

{
  // 本机 PowerShell 载荷：只做退出码归一，绝不碰编码
  // （本机输出走管道，chcp 那套会让中文二次转换成乱码；cp936 回退本来就是对的）
  const payload = buildLocalWindowsPayload('cmd /c "exit 7"');
  assert.ok(payload.includes('$global:LASTEXITCODE = $null'), '必须清空 LASTEXITCODE');
  assert.ok(payload.includes('exit $LASTEXITCODE'), '必须透传 native 退出码');
  assert.ok(!payload.includes('chcp'), '本机载荷不得改代码页（会导致中文乱码）');
  assert.ok(!payload.includes('OutputEncoding'), '本机载荷不得改控制台编码');
}

runAsyncChecks()
  .then(() => listHostsCheck())
  .then(() => { console.log('windows remote exec (M-W1 + M-W2) checks passed'); })
  .catch((err) => { console.error(err); process.exit(1); });
