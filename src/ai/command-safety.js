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

const CATASTROPHIC_PATTERNS = [
  { id: 'fork-bomb', test: (t) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(t), label: 'fork bomb' },
  { id: 'mkfs', test: (t) => /\bmkfs(?:\.\w+)?\b[^\n|;&]*\/dev\//.test(t), label: '格式化块设备' },
  { id: 'dd-to-device', test: (t) => /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|vd|hd|disk|mmcblk|loop)/.test(t), label: '向块设备底层写入 (dd)' },
  { id: 'rm-rf-root', test: isCatastrophicRm, label: '递归强制删除根目录或全盘通配' },
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
