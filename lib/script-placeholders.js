'use strict';

/**
 * 脚本占位符扫描。
 *
 * 脚本库不再结构化定义参数，改为从脚本正文里扫描 `{{变量名}}` 派生。
 * 变量名规则与 shell 变量一致（字母/下划线开头，后接字母/数字/下划线），
 * 与 validators.js 的 PARAM_NAME_RE 保持同一套语义。
 *
 * 这里是全仓唯一的占位符正则来源：repository 派生 placeholders 字段、
 * service 渲染替换、以及测试都必须走这里，避免两处正则漂移。
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * 扫描脚本正文里出现的占位符名，按首次出现顺序去重。
 * @param {string} content
 * @returns {string[]}
 */
function extractPlaceholders(content) {
  const text = String(content || '');
  const seen = new Set();
  const names = [];
  // 每次调用重置 lastIndex：PLACEHOLDER_RE 带 g 标志且为模块级共享对象
  PLACEHOLDER_RE.lastIndex = 0;
  let match = PLACEHOLDER_RE.exec(text);
  while (match) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    match = PLACEHOLDER_RE.exec(text);
  }
  return names;
}

/**
 * 构造某个占位符名的替换正则（允许 {{ name }} 内部有空白）。
 * @param {string} name
 * @returns {RegExp}
 */
function placeholderPattern(name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'g');
}

module.exports = { extractPlaceholders, placeholderPattern };
