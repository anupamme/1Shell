'use strict';

// 从 tool 事件的入参中提取涉及的文件路径，归一化为 [{ path, line? }]。
// ACP 自带 locations；claude stream-json / codex app-server 需要从入参推断。

// 只认显式指向单个文件的键；不收 `path`（Grep/Glob 等工具里是目录，噪音多）。
const FILE_PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'target_file', 'targetFile'];

function looksLikeAbsolutePath(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 1024 || text.includes('\n')) return false;
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('~/');
}

function normalizeLocations(rawList) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const path = String(raw?.path || raw || '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const loc = { path };
    if (Number.isInteger(raw?.line) && raw.line >= 0) loc.line = raw.line;
    out.push(loc);
  }
  return out;
}

function extractToolLocations(input) {
  if (!input || typeof input !== 'object') return [];
  const found = [];
  for (const key of FILE_PATH_KEYS) {
    if (looksLikeAbsolutePath(input[key])) found.push({ path: String(input[key]).trim() });
  }
  // codex fileChange：{ changes: [{ path, kind }] }
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      const path = String(change?.path || change?.file || '').trim();
      if (path) found.push({ path });
    }
  }
  return normalizeLocations(found);
}

module.exports = { extractToolLocations, normalizeLocations };
