'use strict';

/**
 * Harness Command Rules — 用户自定义命令白/黑名单。
 *
 * 每条规则：{ id, pattern, action: 'allow' | 'deny', note, enabled }
 *
 * 评估语义（防混淆/防绕过，方向不对称是有意的）：
 *   - deny（黑名单）：对整条命令做"正文包含"扫描。宁可误拦
 *     `echo "git push --force"`，也不放过 `bash -c "git push --force"`、
 *     `echo $(git push --force)`、`/usr/bin/git push --force` 这类包装——
 *     误拦只是让人重写命令，漏拦是真放走了危险操作。
 *   - allow（白名单）：严格得多的"整词前缀"匹配，且按 shell 段（; && || | 分割）
 *     逐段豁免——只有真正命中规则的段才免审，同一条命令里其他段照常分级。
 *     这样 `docker compose up && chmod -R 777 /etc` 不会被 `docker compose *`
 *     连带豁免。段匹配前先剥掉 sudo/-u xxx、env 赋值、nohup/nice/timeout
 *     包装与绝对路径前缀（/usr/bin/docker → docker），否则白名单匹配不上
 *     绝对路径写法造成"加了规则还是不放行"的困惑。
 *
 * 优先级（见 guard.check）：灾难红线 > deny > 风险规则库 > allow 豁免 > 挡位。
 * allow 永远豁免不了红线（command-safety）与 deny。
 */

const { createId } = require('../utils/common');

const MAX_RULES = 200;
const MAX_PATTERN_LENGTH = 256;
const MAX_NOTE_LENGTH = 200;

function normalizePattern(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return action === 'deny' ? 'deny' : 'allow';
}

// 白名单 token 黑字：灾难级动词不允许出现在 pattern 里被 allow 规则整体放行
// （如 pattern "rm -rf *" 会被红线兜住，这里只是提前拒绝保存，给出清晰报错）
const DISALLOWED_ALLOW_PATTERN_REGEXES = [
  /(?:^|\s)rm\s+[^|;&]*-[a-z]*r[a-z]*f/i,
  /--no-preserve-root\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|;&]*of=\/dev\//i,
  /\bformat-volume\b/i,
  /\bdiskpart\b[^|;&]*clean\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

function validatePattern(pattern, action) {
  if (!pattern) return '规则不能为空';
  if (pattern.length > MAX_PATTERN_LENGTH) return `规则过长（上限 ${MAX_PATTERN_LENGTH} 字符）`;
  if (/[\r\n]/.test(pattern)) return '规则不能包含换行';
  if (/[;&|]/.test(pattern)) return '规则匹配单条命令段，不能包含 ; & | 分隔符';
  if (action === 'allow') {
    for (const regex of DISALLOWED_ALLOW_PATTERN_REGEXES) {
      if (regex.test(pattern)) return '该 pattern 属于灾难级操作，不能用 allow 规则放行（红线无法豁免）';
    }
  }
  return null;
}

function normalizeRule(input) {
  const pattern = normalizePattern(input?.pattern);
  const action = normalizeAction(input?.action);
  return {
    id: String(input?.id || '').trim() || createId('crule'),
    pattern,
    action,
    note: String(input?.note || '').trim().slice(0, MAX_NOTE_LENGTH),
    enabled: input?.enabled !== false,
  };
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRule)
    .filter((rule) => rule.pattern)
    .slice(0, MAX_RULES);
}

// ── 段切分与归一化 ─────────────────────────────────────────────────────────

function segmentsOf(command) {
  // 按 ; && || 与换行切"语句"；管道 | 保留在语句内（curl|sh 这类跨管道的
  // 高危组合必须整体交给风险规则库，切碎了分级规则会失明）
  const text = String(command || '');
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      out.push(current);
      current = '';
      continue;
    }
    if (ch === '|' && next === '|') { out.push(current); current = ''; i += 1; continue; }
    if (ch === '&' && next === '&') { out.push(current); current = ''; i += 1; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 语句内按管道 | 切子段（引号内不算）。白名单豁免的粒度判定用：
 * 语句内所有管道子段都命中 allow 规则才豁免整条语句——
 * `curl https://internal/* | sh` 里的 `sh` 不在白名单，整条语句不豁免。
 */
function pipeSegmentsOf(statement) {
  const text = String(statement || '');
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|' && next === '|') { current += ch; i += 1; continue; }
    if (ch === '|') { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

// sudo 的"选项+参数"型旗标（跳两格）；其余 sudo 旗标跳一格
const SUDO_ARG_OPTIONS = new Set(['-u', '-g', '-p', '--user', '--group', '--prompt']);

/**
 * 把一段命令归一化成"可匹配形态"：
 *   剥引号 → 剥 ( ) / if / then / do 结构 → 从头部剥 sudo(含旗标)/env 赋值/
 *   nohup/command/exec/nice/timeout/stdbuf(含旗标与时长参数) 惰性包装 →
 *   首个 token 剥绝对路径前缀与 .exe/.cmd/.bat/.ps1 后缀。
 * 例：`sudo -u root /usr/bin/docker.exe compose up` → `docker compose up`
 * 刻意不剥 bash -c / sh -c：剥了会让 allow 规则去匹配引号内的内层命令，
 * 语义就乱了——deny 侧靠不锚定扫描兜住包装绕过。
 */
function stripLead(segment) {
  let text = String(segment || '').trim();
  if (!text) return '';
  while (text.startsWith('(') || text.startsWith('&')) {
    text = text.slice(1).trim();
  }
  while (text.endsWith(')')) text = text.slice(0, -1).trim();
  text = text.replace(/^(?:if|while|until|do|then|else|fi|done)\s+/i, '').trim();
  if (!text) return '';

  // 构造初始 token：带引号的首 token（如 PowerShell & "C:\Program Files\...\git.exe" push）
  // 整体作为单一 token，否则路径里的空格会把首 token 切断
  const quoted = text.match(/^"([^"]+)"\s*([\s\S]*)$/) || text.match(/^'([^']+)'\s*([\s\S]*)$/);
  let tokens;
  if (quoted) {
    const restText = quoted[2].replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1').trim();
    tokens = [quoted[1], ...(restText ? restText.split(/\s+/).filter(Boolean) : [])];
  } else {
    const unquoted = text.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1').trim();
    if (!unquoted) return '';
    tokens = unquoted.split(/\s+/);
  }
  if (tokens.length === 0) return '';

  const bareOf = (t) => t.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const bare = bareOf(t);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i += 1; continue; }
    if (bare === 'sudo') {
      i += 1;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        i += SUDO_ARG_OPTIONS.has(tokens[i]) ? 2 : 1;
      }
      continue;
    }
    if (bare === 'env' || bare === 'nohup' || bare === 'command' || bare === 'exec') { i += 1; continue; }
    if (bare === 'nice' || bare === 'timeout' || bare === 'stdbuf') {
      i += 1;
      while (i < tokens.length) {
        const t2 = tokens[i];
        if (t2.startsWith('-')) {
          if (bare === 'timeout' && t2.startsWith('--') && !t2.includes('=')) { i += 2; continue; }
          if (/^-[a-z]$/i.test(t2)) { i += 2; continue; }
          i += 1; continue;
        }
        if (/^[\d.]+[a-z]?$/i.test(t2)) { i += 1; continue; }
        break;
      }
      continue;
    }
    break;
  }
  const rest = tokens.slice(i);
  if (rest.length === 0) return '';
  return [bareOf(rest[0]), ...rest.slice(1)].join(' ');
}

// ── 匹配 ───────────────────────────────────────────────────────────────────

function patternBody(pattern) {
  // 尾部 "*" 剥掉；返回 { body, glued }（glued=true 表示 * 是粘连在 token 上的）
  const normalized = normalizePattern(pattern);
  if (!normalized || normalized === '*') return { body: '', glued: false };
  if (/\s\*$/.test(normalized)) return { body: normalized.slice(0, -1).trimEnd(), glued: false };
  if (/\*$/.test(normalized)) return { body: normalized.slice(0, -1), glued: true };
  return { body: normalized, glued: false };
}

function escapeBody(body) {
  return body
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\s+/g, '[ ]+');
}

/**
 * allow 匹配：段级整词前缀。`docker *` 命中 "docker ps" 但不命中 "dockerxyz"；
 * 粘连尾星（"--force*"、"https://x/*"）= 前缀后跟任意字符（不再要求空格）。
 */
function allowMatchesSegment(segment, allowRules) {
  const stripped = stripLead(segment);
  if (!stripped) return null;
  for (const rawRule of allowRules) {
    const rule = normalizeRule(rawRule);
    if (rule.action !== 'allow' || !rule.pattern || rule.enabled === false) continue;
    const { body, glued } = patternBody(rule.pattern);
    const tail = glued ? '.*' : '(?:[ ].*)?';
    const source = !body ? '^.*$' : `^${escapeBody(body)}${tail}$`;
    if (new RegExp(source, 'i').test(stripped)) return rule;
  }
  return null;
}

/**
 * deny 匹配：整条命令"词边界包含"扫描（不锚定）。包装命令
 * （bash -c "x"、$(x)、/usr/bin/x）里只要出现 pattern 正文即命中；
 * 词边界约束防止短规则混淆相似命令（deny `ls` 不会命中 `lsblk`——
 * 引号/空格/括号算边界，字母数字不算）。
 */
function findDenyMatch(command, rules) {
  const text = String(command || '');
  if (!text.trim()) return null;
  const segments = segmentsOf(text);
  for (const rawRule of rules) {
    const rule = normalizeRule(rawRule);
    if (rule.action !== 'deny' || !rule.pattern || rule.enabled === false) continue;
    const { body, glued } = patternBody(rule.pattern);
    if (!body) return rule; // pattern "*" = 拦一切
    // 粘连尾星（--force*）语义是"前缀后跟任意字符"，尾部不加边界；
    // 普通规则尾部必须落在词边界上，否则 `ls` 会误拦 `lsblk`
    const source = `(?:^|[^A-Za-z0-9_])${escapeBody(body)}${glued ? '' : '(?:[^A-Za-z0-9_]|$)'}`;
    const regex = new RegExp(source, 'i');
    // 先剥包装后扫（抓住 /usr/bin/、sudo -u 形态），再对原文兜底（抓 $()、bash -c）
    if (segments.some((seg) => regex.test(stripLead(seg))) || regex.test(text)) {
      return rule;
    }
  }
  return null;
}

// 兼容旧调用（script.service）：deny 即拦截
function evaluateCommandRules(command, rules) {
  const list = Array.isArray(rules) ? rules : [];
  const denyRule = findDenyMatch(command, list);
  return {
    denied: Boolean(denyRule),
    matchedRule: denyRule || null,
    matchedSegment: '',
  };
}

module.exports = {
  MAX_RULES,
  normalizeRules,
  normalizeRule,
  normalizePattern,
  normalizeAction,
  validatePattern,
  findDenyMatch,
  allowMatchesSegment,
  evaluateCommandRules,
  segmentsOf,
  pipeSegmentsOf,
  stripLead,
};
