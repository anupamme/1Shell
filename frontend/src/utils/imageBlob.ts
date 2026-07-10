// 图片 blob 预览兜底：/api/files/download 的 blob 若带的不是 image/* 类型
// （旧后端回 octet-stream、代理剥头等），<img> 会拒绝解码显示裂图 ——
// 按文件扩展名重标 MIME 再建 blob URL
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

export function imageMimeForFile(fileName: string): string {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase() || '';
  return IMAGE_MIME_BY_EXT[ext] || '';
}

export function ensureImageBlob(blob: Blob, fileName: string): Blob {
  if (blob.type.startsWith('image/')) return blob;
  const mime = imageMimeForFile(fileName);
  return mime ? new Blob([blob], { type: mime }) : blob;
}
