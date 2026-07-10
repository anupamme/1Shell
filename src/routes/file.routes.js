'use strict';

const express = require('express');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// 下载接口按扩展名回真实 Content-Type：前端图片预览走 fetch→blob→<img>，
// blob 类型若是 octet-stream 浏览器会拒绝解码（裂图）。仅映射预览需要的类型，
// 其余保持 octet-stream 不影响"下载"语义
const DOWNLOAD_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

function downloadContentType(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return DOWNLOAD_MIME_BY_EXT[ext] || 'application/octet-stream';
}

function createFileRouter({ fileService }) {
  const router = express.Router();

  /**
   * GET /api/files/list?hostId=xxx&path=/some/dir
   */
  router.get('/files/list', async (req, res, next) => {
    try {
      const hostId = req.query.hostId || 'local';
      const dirPath = req.query.path || '';
      const result = await fileService.listDir(hostId, dirPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/files/read?hostId=xxx&path=/some/file.txt
   */
  router.get('/files/read', async (req, res, next) => {
    try {
      const hostId = req.query.hostId || 'local';
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.readFile(hostId, filePath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/files/download?hostId=xxx&path=/some/file
   */
  router.get('/files/download', async (req, res, next) => {
    try {
      const hostId = req.query.hostId || 'local';
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const { stream, size, filename, source } = await fileService.downloadFile(hostId, filePath);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Type', downloadContentType(filename));
      if (source) res.setHeader('X-1Shell-File-Download-Source', source);
      if (size) res.setHeader('Content-Length', size);
      let completed = false;
      res.on('finish', () => { completed = true; });
      res.on('close', () => {
        if (!completed && typeof stream.destroy === 'function' && !stream.destroyed) {
          stream.destroy();
        }
      });
      stream.on('error', (err) => {
        if (!res.headersSent) next(err);
        else res.end();
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/upload
   * Body: multipart/form-data { hostId, dirPath, file }
   */
  router.post('/files/upload', upload.single('file'), async (req, res, next) => {
    try {
      const hostId = req.body.hostId || 'local';
      const dirPath = req.body.dirPath;
      if (!dirPath) {
        return res.status(400).json({ error: '缺少 dirPath 参数' });
      }
      if (!req.file) {
        return res.status(400).json({ error: '缺少上传文件' });
      }
      const result = await fileService.uploadFile(hostId, dirPath, req.file.originalname, req.file.buffer);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/write
   * Body: { hostId, path, content }
   */
  router.post('/files/write', express.json({ limit: '10mb' }), async (req, res, next) => {
    try {
      const { hostId = 'local', path: filePath, content } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      if (typeof content !== 'string') {
        return res.status(400).json({ error: '缺少 content 参数' });
      }
      const result = await fileService.writeFile(hostId, filePath, content);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/files/write-check
   * 写入自检：验证 1Shell 本机写工具链是否可用，并报告是否运行在 Docker 容器内
   */
  router.get('/files/write-check', async (req, res, next) => {
    try {
      const result = await fileService.writeSelfCheck();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/mkdir
   * Body: { hostId, path }
   */
  router.post('/files/mkdir', express.json(), async (req, res, next) => {
    try {
      const { hostId = 'local', path: dirPath } = req.body;
      if (!dirPath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.createDirectory(hostId, dirPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/touch
   * Body: { hostId, path } — 创建空文件，已存在时报错
   */
  router.post('/files/touch', express.json(), async (req, res, next) => {
    try {
      const { hostId = 'local', path: filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.createFile(hostId, filePath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/delete
   * Body: { hostId, path }
   */
  router.post('/files/delete', express.json(), async (req, res, next) => {
    try {
      const { hostId = 'local', path: targetPath } = req.body;
      if (!targetPath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.deletePath(hostId, targetPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/rename
   * Body: { hostId, path, newPath }
   */
  router.post('/files/rename', express.json(), async (req, res, next) => {
    try {
      const { hostId = 'local', path: oldPath, newPath } = req.body;
      if (!oldPath || !newPath) {
        return res.status(400).json({ error: '缺少 path 或 newPath 参数' });
      }
      const result = await fileService.renamePath(hostId, oldPath, newPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/archive
   * Body: { hostId, path, format? }
   */
  router.post('/files/archive', express.json(), async (req, res, next) => {
    try {
      const { hostId = 'local', path: targetPath, format } = req.body;
      if (!targetPath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.archivePath(hostId, targetPath, { format });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/files/extract
   * Body: { hostId, path }
   */
  router.post('/files/extract', express.json(), async (req, res, next) => {
    try {
      const { hostId = 'local', path: targetPath } = req.body;
      if (!targetPath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }
      const result = await fileService.extractArchive(hostId, targetPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  createFileRouter,
};
