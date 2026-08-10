'use strict';

/**
 * Windows 探针（M-W3）
 *
 * 背景：本机与远端走两条完全不同的采集路径 ——
 *   - 本机原本靠 Node 的 os 模块（跨平台，所以 Windows 上内存/运行时长恰好有值），
 *     但磁盘/进程数/平台/健康度四项在 win32 直接 return null（函数名带 Linux 是诚实的）。
 *   - 远端原本发一段 5184 字符的 POSIX shell 脚本（/proc、awk、df），
 *     Windows 上一个都不存在，且 shell 池协议本身也是 POSIX 的。
 *     结果是"在线但每个字段都是 null"的**静默失败** —— 界面一片空白还不报错。
 *
 * 本测试锁住三件事：脚本输出契约、本机补齐、远端走 bridge 且失败时不装在线。
 */

const assert = require('assert');

const { WINDOWS_PROBE_SCRIPT } = require('../src/services/probe/windows-commands');
const { KEY_PROCESS_NAMES } = require('../src/services/probe/commands');
const {
  parseKeyProcesses,
  parsePlatformInfo,
  parseProbeOutput,
  parseSystemHealth,
} = require('../src/services/probe/parsers');
const { createProbeService } = require('../src/services/probe.service');

// ─── 1. 脚本形状：必须与 POSIX 版输出同一套键 ────────────────────────────────

{
  // parseProbeOutput 按首个 `=` 切分、按行读，所以脚本必须逐行 KEY=VALUE
  const REQUIRED_KEYS = [
    'HOSTNAME', 'UPTIME', 'MEM', 'CPU', 'DISK', 'LOAD',
    'NET_RX', 'NET_TX', 'DISK_READ_BYTES', 'DISK_WRITE_BYTES',
    'PROC_COUNT', 'KEY_PROC', 'ZOMBIE_COUNT',
    'PLATFORM_OS', 'PLATFORM_DISTRO_ID', 'PLATFORM_VERSION_ID',
    'PLATFORM_ARCH', 'CPU_MODEL', 'CPU_VENDOR', 'PACKAGE_MANAGER',
    'LISTEN_PORT_COUNT', 'TCP_CONN_COUNT', 'TOP_LISTEN_PORTS',
    'FAILED_SERVICE_COUNT', 'FAILED_SERVICES',
    'RECENT_ERROR_COUNT', 'RECENT_ERRORS',
    'FIREWALL_STATE', 'SELINUX_STATE',
  ];
  for (const key of REQUIRED_KEYS) {
    assert.ok(
      WINDOWS_PROBE_SCRIPT.includes(`'${key}=`) || WINDOWS_PROBE_SCRIPT.includes(`('${key}=' +`),
      `Windows 探针脚本必须输出 ${key} 键（与 POSIX 版契约一致）`,
    );
  }

  // 值里不能混入 = 或换行，否则 parseProbeOutput 切错；所有自由文本都要过 Clean-Field
  assert.ok(WINDOWS_PROBE_SCRIPT.includes('function Clean-Field'), '必须有 Clean-Field 清洗自由文本');
  assert.ok(/\$t -replace '\[=\|\]', ' '/.test(WINDOWS_PROBE_SCRIPT), 'Clean-Field 必须剥掉 = 与 |');

  // 性能：这几个 cmdlet 实测比替代方案慢 4~8 倍，探针 60s 一轮不能用
  // （只看真实调用，注释里提到名字不算）
  assert.ok(
    !/^[^#\n]*\bGet-NetTCPConnection\b/m.test(WINDOWS_PROBE_SCRIPT),
    'Get-NetTCPConnection 实测 2110ms，应改用 IPGlobalProperties（256ms）',
  );
  assert.ok(
    WINDOWS_PROBE_SCRIPT.includes('IPGlobalProperties'),
    '端口/连接数应走 .NET 的 IPGlobalProperties',
  );
  assert.ok(
    !/^[^#\n]*Get-CimInstance Win32_Service\b/m.test(WINDOWS_PROBE_SCRIPT),
    'Win32_Service CIM 实测 976ms，应改用 Get-Service（253ms）',
  );

  // 每段都要 try/catch：单项失败不能让整个脚本没有输出
  const tryCount = (WINDOWS_PROBE_SCRIPT.match(/\btry\s*\{/g) || []).length;
  assert.ok(tryCount >= 8, `采集段应各自 try/catch 隔离，当前只有 ${tryCount} 个 try`);
}

// ─── 2. 输出解析：喂真实形状的输出，确认落进正确字段 ─────────────────────────

{
  const sample = [
    'HOSTNAME=Z10181412366807',
    'UPTIME=35333',
    'MEM=27.12',
    'CPU=11.00',
    'DISK=31.31',
    'LOAD=',
    'NET_RX=1435551244',
    'NET_TX=376898268',
    'PROC_COUNT=173',
    `KEY_PROC=${KEY_PROCESS_NAMES.map((n) => `${n}:${n === 'sshd' ? 5 : 0}`).join(',')}`,
    'ZOMBIE_COUNT=0',
    'PLATFORM_OS=windows',
    'PLATFORM_DISTRO_ID=windows',
    'PLATFORM_VERSION_ID=21H2',
    'PLATFORM_ARCH=x86_64',
    'PLATFORM_PRETTY_NAME=Microsoft Windows 10 企业版 LTSC',
    'PLATFORM_KERNEL=10.0.19044',
    'CPU_MODEL=AMD EPYC Processor (with IBPB)',
    'CPU_VENDOR=AuthenticAMD',
    'PACKAGE_MANAGER=unknown',
    'LISTEN_PORT_COUNT=48',
    'TCP_CONN_COUNT=71',
    'TOP_LISTEN_PORTS=tcp:22:,tcp:135:,tcp:139:',
    'FAILED_SERVICE_COUNT=6',
    'FAILED_SERVICES=DoSvc,edgeupdate,frpc',
    'RECENT_ERROR_COUNT=0',
    'RECENT_ERRORS=',
    'FIREWALL_STATE=running',
    'SELINUX_STATE=unknown',
  ].join('\r\n');

  const parsed = parseProbeOutput(sample);
  assert.strictEqual(parsed.HOSTNAME, 'Z10181412366807');
  assert.strictEqual(parsed.MEM, '27.12');
  assert.strictEqual(parsed.LOAD, '', 'Windows 无 load average，应为空串而不是缺键');

  const platform = parsePlatformInfo(parsed);
  assert.strictEqual(platform.os, 'windows');
  assert.strictEqual(platform.versionId, '21H2');
  assert.strictEqual(platform.arch, 'x86_64');
  assert.strictEqual(platform.prettyName, 'Microsoft Windows 10 企业版 LTSC', '中文系统名必须完整保留');
  assert.strictEqual(platform.packageManager, null, 'unknown 应归一成 null');

  const keyProcs = parseKeyProcesses(parsed.KEY_PROC);
  assert.strictEqual(keyProcs.length, KEY_PROCESS_NAMES.length);
  assert.deepStrictEqual(
    keyProcs.filter((p) => p.running).map((p) => p.name),
    ['sshd'],
  );

  const health = parseSystemHealth(parsed);
  assert.strictEqual(health.network.listeningPortCount, 48);
  assert.strictEqual(health.network.tcpConnectionCount, 71);
  assert.strictEqual(health.network.topListeningPorts[0].port, '22');
  assert.strictEqual(health.service.failedServiceCount, 6);
  assert.deepStrictEqual(health.service.failedServices, ['DoSvc', 'edgeupdate', 'frpc']);
  assert.strictEqual(health.security.firewallState, 'running');
  assert.strictEqual(health.process.zombieCount, 0);
}

// ─── 3. 远端路由：Windows 走 bridge，且失败时绝不装作在线 ─────────────────────

function makeProbeHarness({ osInfo, bridgeResult, bridgeError, withBridge = true }) {
  const calls = { bridge: [], shellPool: [] };
  const host = {
    id: 'h1', name: 'rig', type: 'ssh', host: '10.0.0.1', port: 22, username: 'u', osInfo,
  };
  const hostRepository = {
    readStoredHosts: () => [{ ...host }],
    writeStoredHosts: () => {},
    readHostPreferences: () => [],
    readHostPreference: () => null,
    writeHostPreference: () => {},
    deleteHostPreference: () => {},
  };
  const hostService = {
    findHost: () => ({ ...host }),
    findStoredHost: () => ({ ...host }),
    listHosts: () => [{ ...host }],
    getLocalHost: () => ({ id: 'local', type: 'local', name: '本机' }),
    ensureDefaultPreference: () => {},
  };
  const sshShellPool = {
    exec: async (hostId, command) => {
      calls.shellPool.push(command);
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    },
  };
  const bridgeService = withBridge ? {
    execOnHost: async (hostId, command) => {
      calls.bridge.push(command);
      if (bridgeError) throw bridgeError;
      return bridgeResult;
    },
  } : null;

  const probeService = createProbeService({
    hostRepository, hostService, sshShellPool, bridgeService,
    probeAgentService: null, probeRelayService: null, probeTrafficService: null,
  });
  return { probeService, calls };
}

async function runAsyncChecks() {
  {
    // Windows 主机：必须经 bridge 发 PowerShell 脚本，绝不碰 POSIX shell 池
    const { probeService, calls } = makeProbeHarness({
      osInfo: { os: 'windows' },
      bridgeResult: {
        stdout: ['HOSTNAME=WINBOX', 'UPTIME=1000', 'MEM=30.5', 'CPU=12.0', 'DISK=45.0',
          'PLATFORM_OS=windows', 'PROC_COUNT=88'].join('\n'),
        stderr: '', exitCode: 0, durationMs: 100,
      },
    });
    const snap = await probeService.refreshSnapshot();
    const probe = snap.probes.find((p) => p.hostId === 'h1');

    assert.strictEqual(calls.shellPool.length, 0, 'Windows 主机不得走 POSIX shell 池');
    assert.strictEqual(calls.bridge.length, 1, 'Windows 主机必须经 bridge 探测');
    assert.strictEqual(calls.bridge[0], WINDOWS_PROBE_SCRIPT, '必须发 Windows 探针脚本');
    assert.ok(!/\/proc|awk|df -Pk/.test(calls.bridge[0]), '不得把 POSIX 探针脚本发给 Windows');

    assert.strictEqual(probe.online, true);
    assert.strictEqual(probe.memoryUsage, 30.5);
    assert.strictEqual(probe.cpuUsage, 12);
    assert.strictEqual(probe.diskUsage, 45);
    assert.strictEqual(probe.processCount, 88);
    assert.strictEqual(probe.hostname, 'WINBOX');
  }

  {
    // 脚本没真正跑起来（cmd 回显垃圾）：必须明确报错，不能"在线但全 null"
    // —— 这正是修复前 windows-rig 详情页空白的根因
    const { probeService } = makeProbeHarness({
      osInfo: { os: 'windows' },
      bridgeResult: {
        stdout: "'cat' 不是内部或外部命令，也不是可运行的程序",
        stderr: '', exitCode: 1, durationMs: 50,
      },
    });
    const snap = await probeService.refreshSnapshot();
    const probe = snap.probes.find((p) => p.hostId === 'h1');
    assert.strictEqual(probe.online, false, '解析不出任何指标时不能装作在线');
    assert.strictEqual(probe.errorCode, 'REMOTE_ERROR');
    assert.ok(probe.error, '必须给出错误原因，而不是静默留空');
  }

  {
    // 没有 bridge（老装配）：明确标注不可用，而不是退回 POSIX 拿假数据
    const { probeService, calls } = makeProbeHarness({
      osInfo: { os: 'windows' },
      withBridge: false,
    });
    const snap = await probeService.refreshSnapshot();
    const probe = snap.probes.find((p) => p.hostId === 'h1');
    assert.strictEqual(calls.shellPool.length, 0, '无 bridge 时也不得退回 POSIX 路径');
    assert.strictEqual(probe.online, false);
    assert.strictEqual(probe.errorCode, 'WINDOWS_PROBE_UNAVAILABLE');
  }

  {
    // setBridgeService 事后注入（server.js 的真实装配顺序）
    const { probeService } = makeProbeHarness({ osInfo: { os: 'windows' }, withBridge: false });
    probeService.setBridgeService({
      execOnHost: async () => ({
        stdout: 'PLATFORM_OS=windows\nMEM=50.0\nUPTIME=10', stderr: '', exitCode: 0, durationMs: 10,
      }),
    });
    const snap = await probeService.refreshSnapshot();
    const probe = snap.probes.find((p) => p.hostId === 'h1');
    assert.strictEqual(probe.online, true, '回注 bridge 后应能正常探测');
    assert.strictEqual(probe.memoryUsage, 50);
  }

  {
    // Linux 主机：行为完全不变（回归保护）
    const { probeService, calls } = makeProbeHarness({
      osInfo: { os: 'linux' },
      bridgeResult: { stdout: '', stderr: '', exitCode: 0, durationMs: 10 },
    });
    await probeService.refreshSnapshot();
    assert.strictEqual(calls.bridge.length, 0, 'Linux 主机不应走 bridge 探测');
    assert.strictEqual(calls.shellPool.length, 1, 'Linux 主机仍走 POSIX shell 池');
    assert.ok(/\/proc/.test(calls.shellPool[0]), 'Linux 仍发 POSIX 探针脚本');
  }

  {
    // OS 未知：保守走 POSIX（等于本功能之前的行为）
    const { probeService, calls } = makeProbeHarness({
      osInfo: null,
      bridgeResult: { stdout: '', stderr: '', exitCode: 0, durationMs: 10 },
    });
    await probeService.refreshSnapshot();
    assert.strictEqual(calls.shellPool.length, 1, 'OS 未知时应保守走原有 POSIX 路径');
    assert.strictEqual(calls.bridge.length, 0);
  }
}

runAsyncChecks()
  .then(() => { console.log('windows probe (M-W3) checks passed'); })
  .catch((err) => { console.error(err); process.exit(1); });
