'use strict';

// 仅拦截不可逆的灾难性命令。
// 不拦 reboot / shutdown / 改 sshd_config 等合法的服务器运维操作 —— 1Shell 本就是服务器管理工具。

/**
 * 命令归一化：在做灾难匹配前，剥掉包裹根目录/设备路径的引号，
 * 使 `rm -rf "/"`、`rm -rf '/'`、`rm -rf /'*'` 这类带引号写法也能被识别。
 * 只针对灾难匹配用途的轻量归一化，不改变实际执行的命令。
 */
function normalizeForRiskMatch(text) {
  return String(text || '')
    // 去掉成对的单/双引号（保留内容），把 "/"、'/' 还原成 /
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'([^']*)'/g, '$1')
    // 去掉对路径分隔符与根的反斜杠转义：\/ -> /
    .replace(/\\(\/)/g, '$1');
}

function isCatastrophicRm(text) {
  if (!/\brm\b/.test(text)) return false;
  const recursive = /\s-{1,2}[a-z]*r/i.test(text) || /--recursive\b/.test(text);
  // 仅当目标是根目录或全盘通配时才算灾难性（删子目录不拦）
  const rootTarget = /\s\/(?:\s|$|[|;&])/.test(text)   // rm ... /
    || /\s\/\*/.test(text)                              // rm ... /*
    || /\s\*\s*(?:$|[|;&])/.test(text)                  // rm ... *
    || /--no-preserve-root\b/.test(text);
  // --no-preserve-root 是"我真要删根"的显式标志：无论有无 -f 一律灾难。
  if (/--no-preserve-root\b/.test(text)) return true;
  // 其余情况：递归 + 根/全盘目标即灾难（不再强制要求 -f，AI 手滑跑 rm -r / 同样拦）。
  if (!recursive) return false;
  return rootTarget;
}

// ── Windows ────────────────────────────────────────────────────────────────
// 与 POSIX 红线同级：只拦不可逆的灾难，不拦 Restart-Computer / 改服务等正常运维。
// 匹配在归一化文本上进行（引号已剥离），反斜杠保留原样，故按 C:\ 的真实形态书写。

// 盘根：C: / C:\ / C:/ / C:\*
const WIN_DRIVE_ROOT_REGEX = /(?:^|[\s|;&,'"])[a-z]:(?:[\\/]+\*?)?(?:\s|$|[|;&,'"])/i;
// OS 目录及其下任意路径：删 C:\Windows\System32 与删 C:\Windows 同样致命
const WIN_OS_DIR_REGEX = /[a-z]:[\\/]+windows(?:[\\/][^\s|;&,'"]*)?(?:\s|$|[|;&,'"])/i;
// 系统级目录「根本身」—— 其子目录不算红线（删 C:\ProgramData\myapp 是正常清理），
// 由 risk-rules 的分级规则按 critical/high 处理。
const WIN_SYSTEM_DIR_ROOT_REGEX = /[a-z]:[\\/]+(?:program files(?:\s*\(x86\))?|programdata|users)(?:[\\/]+\*?)?(?:\s|$|[|;&,'"])/i;
const WIN_OS_VAR_REGEX = /\$env:(?:systemroot|windir)(?:[\\/][^\s|;&,'"]*)?(?:\s|$|[|;&,'"])/i;
const WIN_SYSTEM_VAR_ROOT_REGEX = /\$env:(?:systemdrive|programfiles(?:\(x86\))?|programdata)(?:[\\/]+\*?)?(?:\s|$|[|;&,'"])/i;

function hasWindowsRootTarget(text) {
  const padded = `${text} `;
  return WIN_DRIVE_ROOT_REGEX.test(padded)
    || WIN_OS_DIR_REGEX.test(padded)
    || WIN_SYSTEM_DIR_ROOT_REGEX.test(padded)
    || WIN_OS_VAR_REGEX.test(padded)
    || WIN_SYSTEM_VAR_ROOT_REGEX.test(padded);
}

function isCatastrophicWindowsDelete(text) {
  // Remove-Item / ri / rd / rmdir / del / erase，递归或 /s，目标是盘根或系统目录
  const deleteVerb = /\b(?:remove-item|ri|rd|rmdir|del|erase)\b/i.test(text);
  if (!deleteVerb) return false;
  const recursive = /(?:^|\s)(?:-r(?:ecurse)?\b|\/s\b)/i.test(text);
  // rd /s C:\ 与 Remove-Item -Recurse C:\ 都要求"递归"语义，避免误伤删单文件
  if (!recursive) return false;
  return hasWindowsRootTarget(text);
}

function isCatastrophicWindowsFormat(text) {
  // format C: /y、Format-Volume（格式化卷）
  // format 必须处于命令位（避免误伤 docker/git 的 --format=… 参数）
  return /(?:^|[|;&\n]|\s)format(?:\.com)?\s+["']?[a-z]:/i.test(text)
    || /\bformat-volume\b/i.test(text);
}

function isCatastrophicWindowsDiskWipe(text) {
  // 抹盘/删分区：Clear-Disk、diskpart clean、Remove-Partition、重新初始化磁盘
  return /\bclear-disk\b/i.test(text)
    || /\bremove-partition\b/i.test(text)
    || /\binitialize-disk\b[^|;&\n]*-partitionstyle/i.test(text)
    || /\bdiskpart\b[^|;&\n]*(?:\/s\b|-s\b)/i.test(text)
    || (/\bdiskpart\b/i.test(text) && /\bclean\b/i.test(text));
}

function isCatastrophicRegistryDelete(text) {
  // reg delete HKLM\SOFTWARE /f 或 Remove-Item -Path HKLM:\ ... -Recurse
  const hiveRoot = /\bhk(?:lm|cu|cr|u|cc)\b[:\\][\\]?(?:software|system|sam|security)?(?:\s|$|[|;&\\])/i.test(text)
    || /\bhkey_local_machine\b|\bhkey_classes_root\b/i.test(text);
  if (!hiveRoot) return false;
  return /\breg(?:\.exe)?\s+delete\b/i.test(text)
    || (/\bremove-item\b/i.test(text) && /(?:^|\s)-r(?:ecurse)?\b/i.test(text));
}

function isCatastrophicBcdDestroy(text) {
  // 删除引导配置 = 系统再也起不来
  return /\bbcdedit\b[^|;&\n]*\/(?:delete|deletevalue)\b[^|;&\n]*\{?(?:default|current|bootmgr)/i.test(text)
    || /\bbcdboot\b[^|;&\n]*\/f\b[^|;&\n]*\ball\b/i.test(text);
}

function isCatastrophicVssDelete(text) {
  // 删除卷影副本 —— 勒索软件标志动作，删完无法回滚
  return /\bvssadmin\b[^|;&\n]*\bdelete\b[^|;&\n]*\bshadows\b/i.test(text)
    || /\bwmic\b[^|;&\n]*\bshadowcopy\b[^|;&\n]*\bdelete\b/i.test(text)
    || /\bget-?wmiobject\b[^|;&\n]*win32_shadowcopy[^|;&\n]*\|[^|;&\n]*\b(?:remove-wmiobject|delete)\b/i.test(text);
}

const CATASTROPHIC_PATTERNS = [
  { id: 'fork-bomb', test: (t) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(t), label: 'fork bomb' },
  { id: 'mkfs', test: (t) => /\bmkfs(?:\.\w+)?\b[^\n|;&]*\/dev\//.test(t), label: '格式化块设备' },
  { id: 'dd-to-device', test: (t) => /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|vd|hd|disk|mmcblk|loop)/.test(t), label: '向块设备底层写入 (dd)' },
  { id: 'rm-rf-root', test: isCatastrophicRm, label: '递归强制删除根目录或全盘通配' },
  // ── Windows 红线 ──
  { id: 'win-delete-system-root', test: isCatastrophicWindowsDelete, label: '递归删除 Windows 盘根或系统目录' },
  { id: 'win-format-volume', test: isCatastrophicWindowsFormat, label: '格式化/抹除磁盘卷' },
  { id: 'win-disk-wipe', test: isCatastrophicWindowsDiskWipe, label: '磁盘分区抹除 (diskpart clean / Remove-Partition)' },
  { id: 'win-registry-hive-delete', test: isCatastrophicRegistryDelete, label: '删除注册表根配置单元' },
  { id: 'win-boot-destroy', test: isCatastrophicBcdDestroy, label: '破坏系统引导配置 (bcdedit)' },
  { id: 'win-shadow-copy-delete', test: isCatastrophicVssDelete, label: '删除卷影副本（不可回滚）' },
];

function assessCommandRisk(command) {
  const raw = String(command || '');
  // 同时对原文与归一化文本匹配：归一化能识别带引号/转义的灾难写法，
  // 原文兜底（避免归一化意外改变某些 pattern 的语义）。
  const normalized = normalizeForRiskMatch(raw);
  const matches = CATASTROPHIC_PATTERNS.filter((item) => item.test(raw) || item.test(normalized));
  return {
    dangerous: matches.length > 0,
    matches,
    reason: matches.map((m) => m.label).join('、'),
  };
}

function isDangerousCommand(command) {
  return assessCommandRisk(command).dangerous;
}

/**
 * 命令护栏：注入 bridgeService，对每条执行的命令做灾难性检查。
 * 返回 { allow: false, reason } 时 bridge 会阻断执行并写审计。
 */
function createCommandGuard() {
  return {
    check({ command }) {
      const verdict = assessCommandRisk(command);
      if (verdict.dangerous) {
        return { allow: false, reason: `已拦截灾难性命令：${verdict.reason}` };
      }
      return { allow: true };
    },
  };
}

module.exports = { CATASTROPHIC_PATTERNS, assessCommandRisk, isDangerousCommand, createCommandGuard };
