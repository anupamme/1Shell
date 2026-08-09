'use strict';

/**
 * Windows 探针脚本（PowerShell 版）
 *
 * 与 POSIX 版（commands.js）输出**完全相同的 KEY=VALUE 契约**，
 * 因此 probe/parsers.js 一行都不用改，本机与远端共用同一份采集逻辑：
 *   - 远端 Windows：经 bridgeService 发过去（bridge 负责 EncodedCommand 包装与解码）
 *   - 本机 Windows：填掉 probe.service 里 getLocalDiskUsage / getLocalLinuxExtras
 *     的 win32 空返回（那两个函数名带 Linux，本来就只为 Linux 写的）
 *
 * 约定与坑：
 *   - **值里不能出现 `=` 和换行**，parseProbeOutput 按首个 `=` 切分、按行读。
 *     所有自由文本（CPU 型号、服务名、日志行）都要过 `Clean-Field`。
 *   - CPU 使用率取瞬时值：`Win32_PerfFormattedData_PerfOS_Processor` 的 `_Total`，
 *     不做两次采样 —— 探针 60 秒一轮，采样间隔会拖长每轮耗时。
 *   - Windows 没有 load average，LOAD 留空（前端本来就允许 null）。
 *   - 磁盘用**系统盘**占用率，与 POSIX 版的 `df /` 语义对齐。
 *   - 每段都用 try/catch 包住：任何一项失败只让该字段为空，不能让整个脚本失败
 *     （权限受限的机器上 Get-NetTCPConnection / Get-EventLog 都可能抛）。
 */

const { KEY_PROCESS_NAMES } = require('./commands');

// 关键进程名：POSIX 版比对 `ps -eo comm=`，Windows 的 Get-Process 拿到的是
// 不带扩展名的进程名，这里按同名匹配（nginx/node/redis-server 等在 Windows 上同名）。
function buildKeyProcessBlock() {
  if (!KEY_PROCESS_NAMES.length) return "Write-Output 'KEY_PROC='";
  const names = KEY_PROCESS_NAMES.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
  return `
try {
  $targets = @(${names})
  $procNames = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)
  $pairs = foreach ($t in $targets) {
    $c = @($procNames | Where-Object { $_ -ieq $t }).Count
    ($t + ':' + $c)
  }
  Write-Output ('KEY_PROC=' + ($pairs -join ','))
} catch { Write-Output 'KEY_PROC=' }`.trim();
}

const WINDOWS_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

# 值里不能有 = 或换行，否则 parseProbeOutput 会切错
function Clean-Field($Value) {
  if ($null -eq $Value) { return '' }
  $t = [string]$Value
  $t = $t -replace '[\\r\\n]+', ' '
  $t = $t -replace '[=|]', ' '
  return $t.Trim()
}

# ── 基础指标 ────────────────────────────────────────────────
try { Write-Output ('HOSTNAME=' + (Clean-Field $env:COMPUTERNAME)) } catch { Write-Output 'HOSTNAME=' }

try {
  $osx = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $up = [int]((Get-Date) - $osx.LastBootUpTime).TotalSeconds
  Write-Output ('UPTIME=' + $up)
  if ($osx.TotalVisibleMemorySize -gt 0) {
    $memPct = (($osx.TotalVisibleMemorySize - $osx.FreePhysicalMemory) / $osx.TotalVisibleMemorySize) * 100
    Write-Output ('MEM=' + ('{0:N2}' -f $memPct))
  } else { Write-Output 'MEM=' }
  Write-Output ('PLATFORM_PRETTY_NAME=' + (Clean-Field $osx.Caption))
  Write-Output ('PLATFORM_KERNEL=' + (Clean-Field $osx.Version))
} catch { Write-Output 'UPTIME=0'; Write-Output 'MEM=' }

# CPU：取瞬时值，不做两次采样（探针 60s 一轮，不值得为此拖长每轮耗时）
try {
  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop |
    Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1).PercentProcessorTime
  if ($null -ne $cpu) { Write-Output ('CPU=' + ('{0:N2}' -f [double]$cpu)) } else { Write-Output 'CPU=' }
} catch { Write-Output 'CPU=' }

# 磁盘：系统盘占用率，对齐 POSIX 版的 df /
try {
  $sys = $env:SystemDrive
  $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$sys'" -ErrorAction Stop
  if ($d -and $d.Size -gt 0) {
    Write-Output ('DISK=' + ('{0:N2}' -f ((($d.Size - $d.FreeSpace) / $d.Size) * 100)))
  } else { Write-Output 'DISK=' }
} catch { Write-Output 'DISK=' }

# Windows 无 load average
Write-Output 'LOAD='

# ── 网络与磁盘 IO 累计字节（上层据此算速率）────────────────
try {
  $nic = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface -ErrorAction Stop |
    Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' }
  $rx = ($nic | Measure-Object -Property BytesReceivedPersec -Sum).Sum
  $tx = ($nic | Measure-Object -Property BytesSentPersec -Sum).Sum
  Write-Output ('NET_RX=' + [long]($rx | ForEach-Object { $_ }))
  Write-Output ('NET_TX=' + [long]($tx | ForEach-Object { $_ }))
} catch { Write-Output 'NET_RX='; Write-Output 'NET_TX=' }

try {
  $pd = Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -ErrorAction Stop |
    Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
  if ($pd) {
    Write-Output ('DISK_READ_BYTES=' + [long]$pd.DiskReadBytesPersec)
    Write-Output ('DISK_WRITE_BYTES=' + [long]$pd.DiskWriteBytesPersec)
  } else { Write-Output 'DISK_READ_BYTES='; Write-Output 'DISK_WRITE_BYTES=' }
} catch { Write-Output 'DISK_READ_BYTES='; Write-Output 'DISK_WRITE_BYTES=' }

# ── 进程 ────────────────────────────────────────────────────
try {
  Write-Output ('PROC_COUNT=' + @(Get-Process -ErrorAction SilentlyContinue).Count)
} catch { Write-Output 'PROC_COUNT=' }

${buildKeyProcessBlock()}

# Windows 没有僵尸进程概念
Write-Output 'ZOMBIE_COUNT=0'

# ── 平台信息 ────────────────────────────────────────────────
Write-Output 'PLATFORM_OS=windows'
Write-Output 'PLATFORM_DISTRO_ID=windows'
try {
  $cv = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction Stop
  $rel = if ($cv.DisplayVersion) { $cv.DisplayVersion } else { $cv.ReleaseId }
  Write-Output ('PLATFORM_VERSION_ID=' + (Clean-Field $rel))
} catch { Write-Output 'PLATFORM_VERSION_ID=' }
try {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x86_64' } 'ARM64' { 'arm64' } 'x86' { 'i686' } default { $env:PROCESSOR_ARCHITECTURE }
  }
  Write-Output ('PLATFORM_ARCH=' + (Clean-Field $arch))
} catch { Write-Output 'PLATFORM_ARCH=' }
try {
  $cpuInfo = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
  Write-Output ('CPU_MODEL=' + (Clean-Field $cpuInfo.Name))
  Write-Output ('CPU_VENDOR=' + (Clean-Field $cpuInfo.Manufacturer))
} catch { Write-Output 'CPU_MODEL='; Write-Output 'CPU_VENDOR=' }
try {
  if (Get-Command winget -ErrorAction SilentlyContinue) { Write-Output 'PACKAGE_MANAGER=winget' }
  elseif (Get-Command choco -ErrorAction SilentlyContinue) { Write-Output 'PACKAGE_MANAGER=choco' }
  elseif (Get-Command scoop -ErrorAction SilentlyContinue) { Write-Output 'PACKAGE_MANAGER=scoop' }
  else { Write-Output 'PACKAGE_MANAGER=unknown' }
} catch { Write-Output 'PACKAGE_MANAGER=unknown' }

# ── 系统健康 ────────────────────────────────────────────────
# 端口/连接数走 .NET 的 IPGlobalProperties：比 Get-NetTCPConnection 快 8 倍
# （2110ms → 256ms，探针 60s 一轮，这个差价必须省）。
# 代价：拿不到进程归属，所以 TOP_LISTEN_PORTS 只在需要时单独查。
try {
  $ipProps = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
  $listeners = $ipProps.GetActiveTcpListeners()
  Write-Output ('LISTEN_PORT_COUNT=' + $listeners.Count)
  Write-Output ('TCP_CONN_COUNT=' + $ipProps.GetActiveTcpConnections().Count)
  $topPorts = $listeners | Select-Object -ExpandProperty Port -Unique | Sort-Object | Select-Object -First 5 |
    ForEach-Object { 'tcp:' + $_ + ':' }
  Write-Output ('TOP_LISTEN_PORTS=' + ($topPorts -join ','))
} catch {
  Write-Output 'LISTEN_PORT_COUNT='
  Write-Output 'TCP_CONN_COUNT='
  Write-Output 'TOP_LISTEN_PORTS='
}

# 失败的服务 = 设为自动启动但没在跑。
# Get-Service 比 Get-CimInstance Win32_Service 快 4 倍（976ms → 253ms）。
try {
  $failed = @(Get-Service -ErrorAction Stop |
    Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } |
    Select-Object -ExpandProperty Name)
  Write-Output ('FAILED_SERVICE_COUNT=' + $failed.Count)
  Write-Output ('FAILED_SERVICES=' + (($failed | Select-Object -First 5 | ForEach-Object { Clean-Field $_ }) -join ','))
} catch { Write-Output 'FAILED_SERVICE_COUNT='; Write-Output 'FAILED_SERVICES=' }

# 最近一小时系统日志里的错误
try {
  $since = (Get-Date).AddHours(-1)
  $errors = @(Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=$since} -MaxEvents 200 -ErrorAction Stop)
  Write-Output ('RECENT_ERROR_COUNT=' + $errors.Count)
  $recent = $errors | Select-Object -First 3 | ForEach-Object {
    Clean-Field ($_.ProviderName + ' ' + $_.Message)
  }
  $joined = ($recent -join '|')
  if ($joined.Length -gt 500) { $joined = $joined.Substring(0, 500) }
  Write-Output ('RECENT_ERRORS=' + $joined)
} catch { Write-Output 'RECENT_ERROR_COUNT=0'; Write-Output 'RECENT_ERRORS=' }

try {
  $fw = @(Get-NetFirewallProfile -ErrorAction Stop)
  $on = @($fw | Where-Object { $_.Enabled }).Count
  if ($on -eq 0) { Write-Output 'FIREWALL_STATE=inactive' }
  elseif ($on -eq $fw.Count) { Write-Output 'FIREWALL_STATE=running' }
  else { Write-Output ('FIREWALL_STATE=partial ' + $on + ' of ' + $fw.Count) }
} catch { Write-Output 'FIREWALL_STATE=unknown' }

# Windows 无 SELinux
Write-Output 'SELINUX_STATE=unknown'
`.trim();

module.exports = {
  WINDOWS_PROBE_SCRIPT,
};
