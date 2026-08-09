#!/usr/bin/env node
// M-W1 真机验收：对 Windows 靶机跑完整 bridge.execOnHost 链路
// 用法: RIG_HOST/RIG_PORT/RIG_USER/RIG_PASS + node scripts/test-windows-rig-live.js
//
// 与 test-windows-ssh-probe.js（裸 ssh2 特征化）不同，本脚本走的是产品真实链路：
// hostService.connectToHost → bridge.execOnHost → OS 探测 → PowerShell 包装 → 解码。

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOST = process.env.RIG_HOST || '';
const PORT = Number(process.env.RIG_PORT || 22);
const USER = process.env.RIG_USER || '';
const PASS = process.env.RIG_PASS || '';

if (!HOST || !USER || !PASS) {
  console.error('缺少 RIG_HOST / RIG_USER / RIG_PASS 环境变量');
  process.exit(2);
}

// 用临时数据目录，绝不碰用户真实的 hosts 库
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-rig-'));
process.env.ONESHELL_DATA_DIR = tmpDir;

const { createHostService } = require('../src/services/host.service');
const { createBridgeService } = require('../src/services/bridge.service');
const { createSshPool } = require('../src/services/ssh-pool.service');
const { createSshShellPool } = require('../src/services/ssh-shell-pool.service');

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
  name: 'rig', host: HOST, port: PORT, username: USER, authType: 'password', password: PASS,
}));
const hostId = stored[0].id;

const sshPool = createSshPool({ hostService });
const sshShellPool = createSshShellPool({ hostService });
const bridge = createBridgeService({ hostService, auditService: null, sshPool, sshShellPool });

const CASES = [
  { id: 'ascii',      cmd: 'Write-Output hello',              expectExit: 0, expectOut: /hello/ },
  { id: 'chinese',    cmd: 'Write-Output "中文测试OK"',        expectExit: 0, expectOut: /中文测试OK/ },
  { id: 'service',    cmd: 'Get-Service sshd | Select-Object -ExpandProperty Status', expectExit: 0, expectOut: /Running/i },
  { id: 'exitcode',   cmd: 'cmd /c "exit 7"',                 expectExit: 7 },
  { id: 'cmdlet-err', cmd: 'Get-Item C:\\definitely-not-here-xyz', expectExit: 1, expectErr: /definitely-not-here-xyz/ },
  { id: 'env',        cmd: 'Write-Output $env:RIG_TOKEN',     expectExit: 0, expectOut: /tok-值-42/, env: { RIG_TOKEN: 'tok-值-42' } },
  { id: 'quotes',     cmd: `Write-Output 'it''s "quoted"'`,   expectExit: 0, expectOut: /it's "quoted"/ },
  { id: 'multiline',  cmd: '$a = 1\n$b = 2\nWrite-Output ($a + $b)', expectExit: 0, expectOut: /^3\s*$/m },
  // 超过 MAX_PAYLOAD_CHARS 必须自动改走 stdin（cmd.exe 命令行只有 8191 字符）
  {
    id: 'long-script',
    cmd: `$pad = '${'x'.repeat(4000)}'\nWrite-Output "长度=$($pad.Length)"\ncmd /c "exit 3"`,
    expectExit: 3,
    expectOut: /长度=4000/,
  },
];

let failures = 0;

async function checkWorkloadPanel() {
  // M-W2：工作负载面板此前被写死的 os:'linux' 挡住，M-W1 一通就该自动激活。
  // 它是验证"路子对不对"的最低成本信号，也曾因二次 base64 包装撞上载荷上限。
  const { createPanelWorkloadsService, _internals } = require('../src/services/panel-workloads.service');
  const host = hostService.findHost(hostId);
  const platform = _internals.detectHostPlatform(host);
  if (platform !== 'windows') {
    console.log(`FAIL workload-panel: detectHostPlatform=${platform}，应为 windows`);
    failures += 1;
    return;
  }

  const svc = createPanelWorkloadsService({ hostService, bridgeService: bridge, auditService: null });
  try {
    const res = await svc.getHostWorkloads(hostId, { timeoutMs: 60000 });
    const items = res?.workloads || res?.items || [];
    if (res?.ok === false || (!items.length && res?.error)) {
      console.log(`FAIL workload-panel: ${JSON.stringify(res).slice(0, 300)}`);
      failures += 1;
    } else {
      const services = items.filter((w) => w.source === 'windows-service').length;
      console.log(`PASS workload-panel (${items.length} 个工作负载，其中 windows-service ${services} 个)`);
    }
  } catch (err) {
    console.log(`FAIL workload-panel: 抛异常 ${err.message}`);
    failures += 1;
  }
}

async function main() {
  const osInfo = await hostService.ensureHostOsInfo(hostId);
  console.log('# OS 探测:', JSON.stringify(osInfo));
  if (osInfo?.os !== 'windows') {
    console.error('FAIL: 靶机未被识别为 windows');
    failures += 1;
  }

  for (const c of CASES) {
    let result;
    try {
      result = await bridge.execOnHost(hostId, c.cmd, 30000, { source: 'rig-test', env: c.env });
    } catch (err) {
      console.log(`FAIL ${c.id}: 抛异常 ${err.message}`);
      failures += 1;
      continue;
    }
    const problems = [];
    if (result.exitCode !== c.expectExit) problems.push(`exitCode ${result.exitCode} ≠ ${c.expectExit}`);
    if (c.expectOut && !c.expectOut.test(result.stdout)) problems.push(`stdout 不匹配 ${c.expectOut}`);
    if (c.expectErr && !c.expectErr.test(result.stderr)) problems.push(`stderr 不匹配 ${c.expectErr}`);
    if (result.stdout.includes('�')) problems.push('stdout 含替换字符（编码坏了）');
    if (result.stderr.includes('CLIXML')) problems.push('stderr 残留 CLIXML 骨架');
    if (/bash|sh -lc|__1shell_exit_code/.test(result.stdout)) problems.push('stdout 回显了 POSIX 包装（说明走错分支）');

    if (problems.length) {
      failures += 1;
      console.log(`FAIL ${c.id}: ${problems.join('; ')}`);
      console.log(`     stdout=${JSON.stringify(result.stdout.slice(0, 300))}`);
      console.log(`     stderr=${JSON.stringify(result.stderr.slice(0, 300))}`);
    } else {
      console.log(`PASS ${c.id} (exit=${result.exitCode}, ${result.durationMs}ms)`);
    }
  }

  // M-W2：脚本库转义风格必须跟着主机 OS 走
  const { createScriptService } = require('../src/services/script.service');
  const scriptService = createScriptService({
    scriptRepository: { findScript: () => null },
    hostService,
    bridgeService: bridge,
    auditService: null,
  });
  const style = scriptService.renderContent(
    { content: 'Write-Output {{msg}}' },
    { msg: "it's" },
    { hostId },
  );
  if (style.shellStyle === 'powershell' && style.rendered.includes("'it''s'")) {
    console.log(`PASS script-shell-style (${style.shellStyle})`);
  } else {
    console.log(`FAIL script-shell-style: style=${style.shellStyle} rendered=${JSON.stringify(style.rendered)}`);
    failures += 1;
  }

  await checkWorkloadPanel();
}

main()
  .catch((err) => { console.error('运行失败:', err); failures += 1; })
  .finally(() => {
    try { sshPool.closeAll(); } catch { /* ignore */ }
    try { sshShellPool.closeAll(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
    process.exit(failures === 0 ? 0 : 1);
  });
