'use strict';

/**
 * Windows 远端执行支持（M-W1）
 *
 * 远端 Windows 主机（OpenSSH Server，DefaultShell 通常是 cmd.exe）无法执行 POSIX 包装，
 * 本模块提供另一套包装与解码原语：
 *
 *   - 命令一律走 `powershell -EncodedCommand <base64(UTF-16LE)>`，彻底绕开
 *     Windows OpenSSH 的引号处理（实测 `cmd /c "..."` 这类嵌套调用会被搅坏）。
 *   - 载荷前导统一编码与进度输出，尾部把 `$LASTEXITCODE` / `$?` 归一成进程退出码。
 *   - stderr 在 PowerShell 5.1 下是 CLIXML，需要还原成纯文本。
 *   - 未走包装的输出（如 OS 探测用的裸 `ver`）是 cp936 原始字节，需要回退解码。
 */

let iconvLite = null;
try { iconvLite = require('iconv-lite'); } catch { /* optional */ }

// cmd.exe 的命令行上限是 8191 字符（32767 是 CreateProcess 的，Windows OpenSSH
// 走的是前者，超了会得到「命令行太长。」）。base64(UTF-16LE) 约为载荷的 2.67 倍，
// 留出余量后限制载荷本身；超过这个长度改走 stdin 通道（见 STDIN_BOOTSTRAP）。
const MAX_PAYLOAD_CHARS = 2600;

const POWERSHELL_ARGS = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand';

function isWindowsOsName(value) {
  return String(value || '').trim().toLowerCase() === 'windows';
}

/** PowerShell 单引号字符串转义：内部单引号翻倍。 */
function psQuote(value) {
  return `'${String(value === undefined || value === null ? '' : value).replace(/'/g, "''")}'`;
}

/**
 * 载荷前导：
 *   1. 关掉进度流（否则 stderr 混入 CLIXML 进度噪音）
 *   2. chcp 65001 让子进程（native 命令）以 UTF-8 输出
 *   3. 显式把 .NET 控制台编码设为 UTF-8（必须在 chcp 之后，.NET 会缓存编码）
 */
const PAYLOAD_PREAMBLE = [
  "$ProgressPreference = 'SilentlyContinue'",
  'try { $null = chcp.com 65001 } catch { }',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
];

/**
 * 尾部退出码归一：
 *   - native 命令非零退出 → 原样透传（最有信息量，优先）
 *   - cmdlet 失败（$? 为 false）→ 1
 *   - 其余 → 0
 * 必须在用户命令前把 $LASTEXITCODE 清空，否则前导里 chcp.com 留下的 0 会掩盖 cmdlet 失败。
 */
const PAYLOAD_EPILOGUE = [
  '$__1shellOk = $?',
  'if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  'if (-not $__1shellOk) { exit 1 }',
  'exit 0',
];

function buildWindowsPayload(command, env) {
  const lines = [...PAYLOAD_PREAMBLE];
  for (const [key, value] of Object.entries(env || {})) {
    if (!key) continue;
    lines.push(`$env:${key} = ${psQuote(value)}`);
  }
  lines.push('$global:LASTEXITCODE = $null');
  lines.push(String(command || ''));
  lines.push(...PAYLOAD_EPILOGUE);
  return lines.join('\n');
}

/**
 * 本机 PowerShell 用的精简载荷：**只做退出码归一，不碰编码**。
 *
 * 本机是把脚本喂给 powershell 的 stdin，输出走管道而非控制台：
 * 此时 `chcp 65001` 那套反而会让中文被二次转换（实测变乱码），
 * 而 lib/exec-local 的 decodeBuffer 已有 cp936 回退，本来就能正确解码。
 *
 * 不加这层归一的话，本机 PowerShell 的退出码是错的：
 * `cmd /c "exit 7"` 会返回 1 而不是 7（PowerShell -Command 只反映 $?）。
 */
function buildLocalWindowsPayload(command) {
  return [
    '$global:LASTEXITCODE = $null',
    String(command || ''),
    ...PAYLOAD_EPILOGUE,
  ].join('\n');
}

function encodePowerShellCommand(payload) {
  const script = String(payload || '');
  if (script.length > MAX_PAYLOAD_CHARS) {
    const err = new Error(
      `PowerShell 载荷过长（${script.length} 字符，上限 ${MAX_PAYLOAD_CHARS}）：`
      + 'Windows 命令行有 8191 字符上限，长脚本请走 stdin 通道。',
    );
    err.code = 'WIN_PAYLOAD_TOO_LARGE';
    throw err;
  }
  return `powershell ${POWERSHELL_ARGS} ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/**
 * 长脚本走 stdin：命令行只放一段**长度恒定**的引导程序，真正的脚本从 stdin 读。
 * 这样彻底摆脱 8191 上限（工作负载探测脚本 4.4k，直传必然超限）。
 *
 * 引导程序同样负责编码与退出码归一，语义和直传路径保持一致。
 */
const STDIN_BOOTSTRAP = [
  ...PAYLOAD_PREAMBLE,
  'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  '$__1shellSrc = [Console]::In.ReadToEnd()',
  '$global:LASTEXITCODE = $null',
  'Invoke-Expression $__1shellSrc',
  ...PAYLOAD_EPILOGUE,
].join('\n');

const STDIN_BOOTSTRAP_COMMAND = `powershell ${POWERSHELL_ARGS} ${Buffer.from(STDIN_BOOTSTRAP, 'utf16le').toString('base64')}`;

/**
 * 把一条用户命令包装成可直接投给 Windows OpenSSH exec 通道的命令行。
 * 环境变量折进载荷（外层是 cmd.exe，`VAR=x` 前缀那套完全不适用）。
 *
 * 返回 `{ command, stdin }`：
 *   - 短命令 → stdin 为 null，一切都在命令行里
 *   - 长命令 → command 是恒定的引导程序，脚本正文经 stdin 送达
 */
function buildWindowsRemoteCommand(command, env) {
  const payload = buildWindowsPayload(command, env);
  if (payload.length <= MAX_PAYLOAD_CHARS) {
    return { command: encodePowerShellCommand(payload), stdin: null };
  }
  // stdin 路径：编码/退出码由引导程序负责，这里只送"环境变量 + 用户命令"。
  const lines = [];
  for (const [key, value] of Object.entries(env || {})) {
    if (!key) continue;
    lines.push(`$env:${key} = ${psQuote(value)}`);
  }
  lines.push(String(command || ''));
  return { command: STDIN_BOOTSTRAP_COMMAND, stdin: lines.join('\n') };
}

// ─── 输出解码 ──────────────────────────────────────────────────────────────

/**
 * 远端输出解码：优先 UTF-8，出现替换字符时回退 cp936。
 * 包装路径的输出确定是 UTF-8；裸命令（探测用）与 chcp 失败的机器才会用到回退。
 */
function decodeRemoteOutput(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value)) return String(value || '');
  if (value.length === 0) return '';
  const utf8 = value.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  if (iconvLite) {
    try { return iconvLite.decode(value, 'cp936'); } catch { /* fallback */ }
  }
  return utf8;
}

function unescapeClixml(text) {
  return String(text || '')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, '&');
}

/**
 * PowerShell 5.1 在 stderr 被重定向时输出 CLIXML，形如：
 *   #< CLIXML
 *   <Objs ...><S S="Error">真正的错误文本_x000D__x000A_</S></Objs>
 * 这里把错误文本还原出来，顺带丢掉进度记录之类的非字符串对象。
 */
function decodeClixml(text) {
  const raw = String(text || '');
  if (!raw.includes('#< CLIXML')) return raw;
  return raw
    .replace(/#<\s*CLIXML\s*/g, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, (block) => {
      const parts = [];
      const re = /<S(?:\s[^>]*)?>([\s\S]*?)<\/S>/g;
      let match = re.exec(block);
      while (match) {
        parts.push(unescapeClixml(match[1]));
        match = re.exec(block);
      }
      return parts.join('');
    })
    .replace(/^[ \t]*\r?\n/, '');
}

// ─── OS 探测 ───────────────────────────────────────────────────────────────

/** 顶层裸命令：`cmd /c ver` 这类嵌套调用会被 Windows OpenSSH 的引号处理搅坏。 */
const WINDOWS_VER_PROBE_COMMAND = 'ver';

const WINDOWS_DETAIL_MARKER = '__1SHELL_WINOS__';

const WINDOWS_DETAIL_PROBE_COMMAND = encodePowerShellCommand([
  ...PAYLOAD_PREAMBLE,
  "$key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
  '$props = $null',
  'try { $props = Get-ItemProperty -Path $key -ErrorAction Stop } catch { }',
  `Write-Output '${WINDOWS_DETAIL_MARKER}'`,
  "Write-Output ('product=' + $(if ($props) { $props.ProductName } else { '' }))",
  "Write-Output ('release=' + $(if ($props -and $props.DisplayVersion) { $props.DisplayVersion } elseif ($props) { $props.ReleaseId } else { '' }))",
  "Write-Output ('build=' + [Environment]::OSVersion.Version.ToString())",
  "Write-Output ('arch=' + $env:PROCESSOR_ARCHITECTURE)",
  "Write-Output ('ps=' + $PSVersionTable.PSVersion.ToString())",
  'exit 0',
].join('\n'));

/** `Microsoft Windows [版本 10.0.19044.1889]` / `[Version ...]`，中文段乱码也能匹配。 */
function parseWindowsVerOutput(text) {
  const value = String(text || '');
  if (!/Microsoft\s+Windows/i.test(value)) return null;
  const match = value.match(/Microsoft\s+Windows\s*\[[^\]\d]*(\d+(?:\.\d+)+)\s*\]/i);
  return { kernel: match ? match[1] : null };
}

function normalizeWindowsArch(value) {
  const arch = String(value || '').trim().toLowerCase();
  if (arch === 'amd64' || arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x86') return 'ia32';
  return arch || null;
}

function parseWindowsDetailOutput(text) {
  const value = String(text || '');
  if (!value.includes(WINDOWS_DETAIL_MARKER)) return null;
  const fields = {};
  for (const line of value.slice(value.indexOf(WINDOWS_DETAIL_MARKER)).split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const product = fields.product || '';
  const release = fields.release || '';
  return {
    prettyName: [product, release].filter(Boolean).join(' ') || null,
    versionId: release || null,
    kernel: fields.build || null,
    arch: normalizeWindowsArch(fields.arch),
    powershellVersion: fields.ps || null,
  };
}

module.exports = {
  MAX_PAYLOAD_CHARS,
  STDIN_BOOTSTRAP_COMMAND,
  WINDOWS_DETAIL_MARKER,
  WINDOWS_DETAIL_PROBE_COMMAND,
  WINDOWS_VER_PROBE_COMMAND,
  buildWindowsPayload,
  buildLocalWindowsPayload,
  buildWindowsRemoteCommand,
  decodeClixml,
  decodeRemoteOutput,
  encodePowerShellCommand,
  isWindowsOsName,
  normalizeWindowsArch,
  parseWindowsDetailOutput,
  parseWindowsVerOutput,
  psQuote,
};
