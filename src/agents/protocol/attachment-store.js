'use strict';

/**
 * 协议 agent 附件落盘
 *
 * 前端 composer 的附件以 base64/text 随 socket 消息到达，而第三方 CLI agent
 * （claude / codex / ACP）只能读文件路径。这里把附件写进会话工作目录下的
 * .1shell-attachments/，返回真实路径供 prompt 注入 —— agent 用自己的文件
 * 读取工具查看（图片走多模态 Read，文本直接读），而非内联识别。
 *
 * 目录选在 cwd 内是有意的：codex 沙箱与 claude code 的权限模型对工作目录
 * 内的读取默认放行，落到 tmp 或 dataDir 反而可能被沙箱拦下。
 */

const fs = require('fs');
const path = require('path');

const ATTACHMENT_DIR_NAME = '.1shell-attachments';
const MAX_COUNT = 8;
const MAX_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LENGTH = 80;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function sizeLabel(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeKind(kind, mime) {
  if (['image', 'text', 'document', 'file'].includes(String(kind || ''))) return String(kind);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/pdf') return 'document';
  return 'file';
}

/** 文件名白名单清洗（字母数字/点/横线/下划线/CJK），防路径穿越，保底补扩展名 */
function safeFileName(name, mime, seq) {
  const base = path.basename(String(name || '').trim()).normalize('NFC');
  let cleaned = base
    .replace(/[^\w.\-一-鿿]/g, '_')
    .replace(/^[._]+/, '')
    .trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    const ext = path.extname(cleaned).slice(0, 12);
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  if (!cleaned) cleaned = `attachment-${seq}${EXT_BY_MIME[mime] || ''}`;
  else if (!path.extname(cleaned) && EXT_BY_MIME[mime]) cleaned += EXT_BY_MIME[mime];
  return cleaned;
}

function decodeContent(item) {
  const base64 = typeof item.base64 === 'string'
    ? item.base64.replace(/^data:[^,]*,/i, '').replace(/\s+/g, '')
    : '';
  if (base64) {
    let buffer;
    try { buffer = Buffer.from(base64, 'base64'); } catch { return { error: 'base64 内容无法解码' }; }
    if (!buffer.length) return { error: 'base64 内容为空' };
    if (buffer.length > MAX_BINARY_BYTES) return { error: `文件超过 ${sizeLabel(MAX_BINARY_BYTES)} 上限` };
    return { buffer };
  }
  const text = typeof item.text === 'string' ? item.text : '';
  if (text) {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length > MAX_TEXT_BYTES) return { error: `文本超过 ${sizeLabel(MAX_TEXT_BYTES)} 上限` };
    return { buffer };
  }
  return { error: String(item.error || '').trim() || '附件不含内容（可能超过前端大小上限）' };
}

/**
 * 把消息附件写到 dir（默认 cwd/.1shell-attachments/）下。
 * @returns {{ stored: Array<{path,name,mime,kind,size}>, skipped: Array<{name,reason}> }}
 */
function materializeAttachments({ attachments, cwd, dir: dirOverride, logger = console } = {}) {
  const stored = [];
  const skipped = [];
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length || (!cwd && !dirOverride)) return { stored, skipped };

  const dir = dirOverride || path.join(cwd, ATTACHMENT_DIR_NAME);
  const stamp = Date.now().toString(36);
  let dirReady = false;
  let seq = 0;

  for (const raw of list) {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const name = String(item.name || '').trim();
    seq += 1;
    if (stored.length >= MAX_COUNT) {
      skipped.push({ name, reason: `超过 ${MAX_COUNT} 个附件上限` });
      continue;
    }
    const { buffer, error } = decodeContent(item);
    if (!buffer) {
      skipped.push({ name, reason: error });
      continue;
    }
    const mime = String(item.mime || item.type || '').trim().toLowerCase();
    const fileName = `${stamp}-${seq}-${safeFileName(name, mime, seq)}`;
    const filePath = path.join(dir, fileName);
    try {
      if (!dirReady) {
        fs.mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      fs.writeFileSync(filePath, buffer);
    } catch (err) {
      logger.warn?.(`[protocol-agent] 附件写盘失败 ${fileName}: ${err?.message || err}`);
      skipped.push({ name, reason: `写入失败：${err?.message || err}` });
      continue;
    }
    stored.push({
      path: filePath,
      name: name || fileName,
      mime,
      kind: normalizeKind(item.kind, mime),
      size: buffer.length,
    });
  }
  return { stored, skipped };
}

/** 注入 CLI prompt 的附件提示块（不进会话展示记录，与 targetHint 同策略） */
function buildAttachmentHint(stored = [], skipped = []) {
  if (!stored.length && !skipped.length) return '';
  const lines = [];
  if (stored.length) {
    lines.push('**用户随本条消息上传了附件**，已保存到以下路径，请用文件读取工具查看（图片可直接 Read 查看内容）：');
    for (const att of stored) {
      lines.push(`- ${att.name}（${att.mime || '未知类型'}，${sizeLabel(att.size)}）→ ${att.path}`);
    }
  }
  if (skipped.length) {
    lines.push('以下附件未能保存，仅供知晓：');
    for (const item of skipped) {
      lines.push(`- ${item.name || '未命名附件'}：${item.reason || '原因未知'}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  materializeAttachments,
  buildAttachmentHint,
  ATTACHMENT_DIR_NAME,
};
