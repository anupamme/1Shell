'use strict';

const express = require('express');
const Busboy = require('busboy');

const UPLOAD_MAX_BYTES = 512 * 1024 * 1024; // 上传大小上限

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
   *
   * 流式转发到目标主机：multipart 解析边收边传，不把整个文件读进内存。
   * 字段顺序要求 hostId/dirPath 在 file 之前（浏览器 FormData 按 append 顺序发送）。
   */
  router.post('/files/upload', (req, res, next) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: UPLOAD_MAX_BYTES } });
    } catch (err) {
      return res.status(400).json({ error: `解析上传请求失败: ${err.message}` });
    }

    const fields = {};
    let handled = false;
    let uploadPromise = null;
    let sizeExceeded = false;

    function failOnce(status, message) {
      if (handled) return;
      handled = true;
      req.unpipe(busboy);
      res.status(status).json({ error: message });
    }

    busboy.on('field', (name, value) => { fields[name] = value; });

    busboy.on('file', (name, fileStream, info) => {
      const hostId = fields.hostId || 'local';
      const dirPath = fields.dirPath;
      if (!dirPath) {
        fileStream.resume();
        return failOnce(400, '缺少 dirPath 参数');
      }
      const declaredSize = Number(req.headers['x-1shell-file-size']);
      const expectedSize = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null;

      fileStream.on('limit', () => {
        sizeExceeded = true;
        fileStream.unpipe?.();
        fileStream.destroy(new Error(`文件超过上传上限 ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)}MB`));
      });

      uploadPromise = fileService
        .uploadFileStream(hostId, dirPath, info.filename, fileStream, expectedSize)
        .then((result) => {
          if (handled) return;
          handled = true;
          res.json(result);
        })
        .catch((err) => {
          if (handled) return;
          handled = true;
          if (sizeExceeded) {
            res.status(413).json({ error: `文件超过上传上限 ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)}MB` });
          } else {
            next(err);
          }
        });
    });

    busboy.on('error', (err) => {
      if (handled) return;
      handled = true;
      next(err);
    });

    busboy.on('close', () => {
      if (!uploadPromise && !handled) {
        failOnce(400, '缺少上传文件');
      }
    });

    req.pipe(busboy);
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
