#!/usr/bin/env node
// 云电脑靶机体检：走 1Shell 真实链路（hostService + bridgeService）采集机器画像
// 用法: RIG_HOST/RIG_PORT/RIG_USER/RIG_PASS + node scripts/probe-windows-rig.js

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-probe-'));
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
  name: 'windows-rig', host: HOST, port: PORT, username: USER, authType: 'password', password: PASS,
}));
const hostId = stored[0].id;

const sshPool = createSshPool({ hostService });
const sshShellPool = createSshShellPool({ hostService });
const bridge = createBridgeService({ hostService, auditService: null, sshPool, sshShellPool });

async function run(label, command, timeout = 45000) {
  try {
    const r = await bridge.execOnHost(hostId, command, timeout, { source: 'rig-probe' });
    if (r.exitCode !== 0 && !String(r.stdout || '').trim()) {
      return { label, error: (r.stderr || `exit ${r.exitCode}`).trim().slice(0, 300) };
    }
    return { label, text: String(r.stdout || '').trim() };
  } catch (err) {
    return { label, error: err.message.slice(0, 200) };
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(64)}\n  ${title}\n${'═'.repeat(64)}`);
}

function show(result) {
  if (result.error) console.log(`  [失败] ${result.error}`);
  else console.log(result.text.split('\n').map((l) => `  ${l}`).join('\n'));
}

const PROBES = [
  ['系统与硬件', `
$cs = Get-CimInstance Win32_ComputerSystem
$osx = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS
Write-Output "计算机名   : $($cs.Name)"
Write-Output "域/工作组  : $($cs.Domain)"
Write-Output "制造商     : $($cs.Manufacturer) / $($cs.Model)"
Write-Output "虚拟化标识 : $($bios.Manufacturer) | SN=$($bios.SerialNumber)"
Write-Output "系统       : $($osx.Caption) build $($osx.BuildNumber)"
Write-Output "安装时间   : $($osx.InstallDate)"
Write-Output "上次启动   : $($osx.LastBootUpTime)"
Write-Output "运行时长   : $([math]::Round(((Get-Date) - $osx.LastBootUpTime).TotalHours,1)) 小时"
Write-Output "CPU        : $($cpu.Name.Trim())"
Write-Output "CPU 核心   : $($cpu.NumberOfCores) 核 / $($cpu.NumberOfLogicalProcessors) 线程"
Write-Output "内存       : $([math]::Round($cs.TotalPhysicalMemory/1GB,1)) GB (可用 $([math]::Round($osx.FreePhysicalMemory/1MB,1)) GB)"
Write-Output "时区       : $((Get-TimeZone).DisplayName)"
Write-Output "当前用户   : $env:USERNAME"
Write-Output "管理员权限 : $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
`],

  ['磁盘', `
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  $pct = if ($_.Size -gt 0) { [math]::Round(($_.Size - $_.FreeSpace) / $_.Size * 100, 1) } else { 0 }
  Write-Output ("{0} {1,8:N1} GB 总 / {2,8:N1} GB 可用 / 已用 {3}%  [{4}]" -f $_.DeviceID, ($_.Size/1GB), ($_.FreeSpace/1GB), $pct, $_.VolumeName)
}
`],

  ['网络', `
Write-Output "-- 网卡 --"
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | ForEach-Object {
  Write-Output ("  {0,-24} {1}/{2}" -f $_.InterfaceAlias, $_.IPAddress, $_.PrefixLength)
}
Write-Output "-- 公网出口 --"
try {
  $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 8).ip
  Write-Output "  $ip"
} catch { Write-Output "  (查询失败: $($_.Exception.Message))" }
Write-Output "-- 监听端口 (前 20) --"
Get-NetTCPConnection -State Listen | Sort-Object LocalPort -Unique | Select-Object -First 20 | ForEach-Object {
  $p = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue)
  Write-Output ("  {0,-22} <- {1}" -f "$($_.LocalAddress):$($_.LocalPort)", $(if ($p) { $p.ProcessName } else { 'pid ' + $_.OwningProcess }))
}
`],

  ['穿透与远程访问相关', `
Write-Output "-- frp / 隧道类进程 --"
$tunnel = Get-Process | Where-Object { $_.ProcessName -match 'frp|ngrok|tailscale|zerotier|cloudflared|nps|sunny' }
if ($tunnel) { $tunnel | ForEach-Object { Write-Output ("  {0} (pid {1})  路径: {2}" -f $_.ProcessName, $_.Id, $_.Path) } }
else { Write-Output "  (无)" }
Write-Output "-- OpenSSH --"
Get-Service sshd,ssh-agent -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output ("  {0,-12} {1,-10} 启动类型={2}" -f $_.Name, $_.Status, $_.StartType)
}
$sshd = Get-Command sshd.exe -ErrorAction SilentlyContinue
if ($sshd) { Write-Output "  sshd 路径: $($sshd.Source)" }
if (Test-Path 'C:\\ProgramData\\ssh\\sshd_config') {
  Write-Output "-- sshd_config 关键项 --"
  Get-Content 'C:\\ProgramData\\ssh\\sshd_config' | Where-Object { $_ -match '^\\s*(Port|PasswordAuthentication|PubkeyAuthentication|Subsystem|DefaultShell|PermitRootLogin)' } | ForEach-Object { Write-Output "  $_" }
}
Write-Output "-- DefaultShell 注册表 --"
$ds = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue
if ($ds) { Write-Output "  $($ds.DefaultShell)" } else { Write-Output "  (未设置，即默认 cmd.exe)" }
Write-Output "-- 远程桌面 --"
$rdp = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -ErrorAction SilentlyContinue
Write-Output ("  RDP: {0}" -f $(if ($rdp -and $rdp.fDenyTSConnections -eq 0) { '已启用' } else { '已禁用' }))
`],

  ['运行时与开发工具', `
$tools = @(
  @{n='PowerShell'; c={ $PSVersionTable.PSVersion.ToString() }},
  @{n='Node.js';    c={ (node --version) }},
  @{n='Python';     c={ (python --version 2>&1) }},
  @{n='Git';        c={ (git --version) }},
  @{n='Docker';     c={ (docker --version) }},
  @{n='Go';         c={ (go version) }},
  @{n='Java';       c={ (java -version 2>&1 | Select-Object -First 1) }},
  @{n='.NET';       c={ (dotnet --version) }}
)
foreach ($t in $tools) {
  try { $v = & $t.c; if ($v) { Write-Output ("  {0,-12} {1}" -f $t.n, ($v -join ' ').Trim()) } else { Write-Output ("  {0,-12} (未安装)" -f $t.n) } }
  catch { Write-Output ("  {0,-12} (未安装)" -f $t.n) }
}
`],

  ['安全状态', `
Write-Output "-- Defender --"
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  Write-Output "  实时保护   : $($mp.RealTimeProtectionEnabled)"
  Write-Output "  防病毒启用 : $($mp.AntivirusEnabled)"
  Write-Output "  特征库版本 : $($mp.AntivirusSignatureVersion) ($($mp.AntivirusSignatureLastUpdated))"
} catch { Write-Output "  (无法读取: $($_.Exception.Message))" }
Write-Output "-- 防火墙 --"
Get-NetFirewallProfile | ForEach-Object { Write-Output ("  {0,-10} Enabled={1}" -f $_.Name, $_.Enabled) }
Write-Output "-- 本地管理员组 --"
try { Get-LocalGroupMember -Group Administrators | ForEach-Object { Write-Output "  $($_.Name) [$($_.ObjectClass)]" } }
catch { Write-Output "  (读取失败)" }
Write-Output "-- 待重启的更新 --"
Write-Output ("  RebootRequired: {0}" -f (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'))
`],

  ['负载 Top 10 进程', `
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 | ForEach-Object {
  Write-Output ("  {0,-28} pid={1,-7} 内存={2,7:N1} MB" -f $_.ProcessName, $_.Id, ($_.WorkingSet64/1MB))
}
`],

  ['自启动项', `
Get-CimInstance Win32_StartupCommand | Select-Object -First 15 | ForEach-Object {
  Write-Output ("  {0,-26} <- {1}" -f $_.Name, $_.Command)
}
`],
];

async function main() {
  section('OS 探测（1Shell 真实链路）');
  const osInfo = await hostService.ensureHostOsInfo(hostId);
  console.log('  ' + JSON.stringify(osInfo, null, 2).split('\n').join('\n  '));

  for (const [title, command] of PROBES) {
    section(title);
    show(await run(title, command));
  }

  section('工作负载面板（1Shell 功能视角）');
  try {
    const { createPanelWorkloadsService } = require('../src/services/panel-workloads.service');
    const svc = createPanelWorkloadsService({ hostService, bridgeService: bridge, auditService: null });
    const res = await svc.getHostWorkloads(hostId, { timeoutMs: 60000 });
    const items = res?.items || res?.workloads || [];
    console.log(`  平台支持=${res.platformSupported} Docker安装=${res.dockerInstalled} 可达=${res.dockerReachable}`);
    console.log(`  共 ${items.length} 个工作负载：`);
    const byKind = {};
    for (const w of items) byKind[w.source || w.kind || '?'] = (byKind[w.source || w.kind || '?'] || 0) + 1;
    for (const [k, v] of Object.entries(byKind)) console.log(`    ${k}: ${v}`);
    console.log('  前 12 个：');
    for (const w of items.slice(0, 12)) {
      console.log(`    ${(w.displayName || w.name || w.id).padEnd(30)} [${w.source}] ${w.status || ''}`);
    }
  } catch (err) {
    console.log('  [失败] ' + err.message);
  }
}

main()
  .catch((err) => { console.error('探测失败:', err); })
  .finally(() => {
    try { sshPool.closeAll(); } catch { /* ignore */ }
    try { sshShellPool.closeAll(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('\n探测结束');
  });
