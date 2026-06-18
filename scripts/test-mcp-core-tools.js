'use strict';

process.env.ONESHELL_MCP_INLINE_UPLOAD_MAX_BYTES = '8';
process.env.ONESHELL_MCP_TEXT_WRITE_MAX_BYTES = '8';
process.env.ONESHELL_MCP_UPLOAD_CHUNK_MAX_BYTES = '8';
process.env.ONESHELL_MCP_UPLOAD_SESSION_MAX_BYTES = '64';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createOneShellCoreTools } = require('../src/tools/oneshell-core.tools');
const { createFileService } = require('../src/services/file.service');

function parseToolJson(result) {
  assert.strictEqual(result.is_error, false, result.content);
  return JSON.parse(result.content);
}

function parseToolJsonAny(result) {
  return JSON.parse(String(result.content).replace(/^\[ERROR\]\s*/, ''));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function failingThenResumableFileService() {
  let calls = 0;
  return {
    async downloadFile(hostId, filePath, options = {}) {
      calls += 1;
      const startOffset = Number(options.startOffset) || 0;
      if (calls === 1) {
        let sent = false;
        const stream = new Readable({
          read() {
            if (sent) return;
            sent = true;
            this.push(Buffer.from('hello', 'utf8'));
            setImmediate(() => this.destroy(new Error('simulated disconnect')));
          },
        });
        return { stream, size: 10, filename: path.basename(filePath), source: 'fake' };
      }
      assert.strictEqual(startOffset, 5, 'resume must request the partial offset');
      return {
        stream: Readable.from(Buffer.from('world', 'utf8')),
        size: 10,
        filename: path.basename(filePath),
        source: 'fake',
      };
    },
  };
}

function delayedDownloadFileService(content = 'direct') {
  return {
    async downloadFile(hostId, filePath, options = {}) {
      assert.strictEqual(Number(options.startOffset) || 0, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        stream: Readable.from(Buffer.from(content, 'utf8')),
        size: Buffer.byteLength(content),
        filename: path.basename(filePath),
        source: 'fake',
      };
    },
  };
}

async function main() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oneshell-mcp-core-'));
  try {
    const sourcePath = path.join(tmpRoot, 'source.bin');
    const uploadDir = path.join(tmpRoot, 'upload-target');
    const chunkDir = path.join(tmpRoot, 'chunk-target');
    const backgroundChunkDir = path.join(tmpRoot, 'chunk-background-target');
    const mcpBackgroundChunkDir = path.join(tmpRoot, 'chunk-mcp-background-target');
    await fs.promises.mkdir(uploadDir);
    await fs.promises.mkdir(chunkDir);
    await fs.promises.mkdir(backgroundChunkDir);
    await fs.promises.mkdir(mcpBackgroundChunkDir);
    await fs.promises.writeFile(sourcePath, Buffer.from('0123456789abcdef', 'utf8'));

    const hostService = {
      findHost(hostId) {
        return hostId === 'local' ? { id: 'local', type: 'local' } : null;
      },
    };
    const fileService = createFileService({ hostService });
    const tools = createOneShellCoreTools({
      hostService,
      fileService,
      auditService: { log() {} },
      ideService: {
        async ask(payload) {
          assert.strictEqual(payload.detached, true, 'background ask must detach from the MCP call');
          assert.ok(payload.sessionId, 'background ask must provide a stable sessionId');
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { text: 'background done', toolCalls: [{ name: 'noop', input: {} }] };
        },
      },
    });

    const tooLargeInline = await tools.handle('upload_file', {
      hostId: 'local',
      dirPath: uploadDir,
      filename: 'too-large.txt',
      content: '0123456789',
    }, {});
    assert.strictEqual(tooLargeInline.is_error, true, 'large inline upload should be rejected');
    assert.match(tooLargeInline.content, /inline 上传上限/, 'large inline upload error should be actionable');

    const tooLargeWrite = await tools.handle('write_remote_file', {
      hostId: 'local',
      path: path.join(uploadDir, 'too-large.txt'),
      content: '0123456789',
    }, {});
    assert.strictEqual(tooLargeWrite.is_error, true, 'large text write should be rejected');
    assert.match(tooLargeWrite.content, /write_remote_file 只用于小型文本/, 'large write error should point to upload flow');

    const localUpload = parseToolJson(await tools.handle('upload_file', {
      hostId: 'local',
      dirPath: uploadDir,
      localPath: sourcePath,
    }, {}));
    assert.strictEqual(localUpload.ok, true, 'localPath upload should succeed');
    assert.strictEqual(await fs.promises.readFile(path.join(uploadDir, 'source.bin'), 'utf8'), '0123456789abcdef');

    const start = parseToolJson(await tools.handle('start_file_upload', {
      hostId: 'local',
      dirPath: chunkDir,
      filename: 'chunked.txt',
      size: 11,
    }, {}));
    const uploadId = start.data.uploadId;
    assert.ok(uploadId, 'start_file_upload must return uploadId');
    const first = parseToolJson(await tools.handle('append_file_upload', {
      uploadId,
      offset: 0,
      base64Content: Buffer.from('hello ', 'utf8').toString('base64'),
    }, {}));
    assert.strictEqual(first.data.nextOffset, 6);
    const second = parseToolJson(await tools.handle('append_file_upload', {
      uploadId,
      offset: 6,
      base64Content: Buffer.from('world', 'utf8').toString('base64'),
    }, {}));
    assert.strictEqual(second.data.complete, true);
    const finish = parseToolJson(await tools.handle('finish_file_upload', { uploadId }, {}));
    assert.strictEqual(finish.data.size, 11);
    assert.strictEqual(await fs.promises.readFile(path.join(chunkDir, 'chunked.txt'), 'utf8'), 'hello world');

    const bgStart = parseToolJson(await tools.handle('start_file_upload', {
      hostId: 'local',
      dirPath: backgroundChunkDir,
      filename: 'background.txt',
      size: 6,
    }, {}));
    const bgUploadId = bgStart.data.uploadId;
    await tools.handle('append_file_upload', {
      uploadId: bgUploadId,
      offset: 0,
      base64Content: Buffer.from('async!', 'utf8').toString('base64'),
    }, {});
    const bgFinish = parseToolJson(await tools.handle('finish_file_upload', {
      uploadId: bgUploadId,
      background: true,
    }, {}));
    const uploadTransferId = bgFinish.data.transferId;
    assert.ok(uploadTransferId, 'background upload finish must return transferId');
    const uploaded = await waitFor(async () => {
      const current = parseToolJson(await tools.handle('get_file_transfer', { transferId: uploadTransferId }, {}));
      return current.data.status === 'succeeded' ? current : null;
    });
    assert.strictEqual(uploaded.data.type, 'upload');
    assert.strictEqual(uploaded.data.sha256, sha256('async!'));
    assert.strictEqual(await fs.promises.readFile(path.join(backgroundChunkDir, 'background.txt'), 'utf8'), 'async!');

    const mcpBgStart = parseToolJson(await tools.handle('start_file_upload', {
      hostId: 'local',
      dirPath: mcpBackgroundChunkDir,
      filename: 'mcp-background.txt',
      size: 4,
    }, {}));
    const mcpBgUploadId = mcpBgStart.data.uploadId;
    await tools.handle('append_file_upload', {
      uploadId: mcpBgUploadId,
      offset: 0,
      base64Content: Buffer.from('mcp!', 'utf8').toString('base64'),
    }, {});
    const mcpBgFinish = parseToolJson(await tools.handle('finish_file_upload', { uploadId: mcpBgUploadId }, { source: 'mcp' }));
    const mcpUploadTransferId = mcpBgFinish.data.transferId;
    assert.ok(mcpUploadTransferId, 'MCP finish_file_upload must return transferId by default');
    const mcpUploaded = await waitFor(async () => {
      const current = parseToolJson(await tools.handle('get_file_transfer', { transferId: mcpUploadTransferId }, {}));
      return current.data.status === 'succeeded' ? current : null;
    });
    assert.strictEqual(mcpUploaded.data.type, 'upload');
    assert.strictEqual(await fs.promises.readFile(path.join(mcpBackgroundChunkDir, 'mcp-background.txt'), 'utf8'), 'mcp!');

    const askStart = parseToolJson(await tools.handle('ask_1shell_ai', {
      goal: 'run a background check',
      background: true,
    }, {}));
    const runId = askStart.data.runId;
    assert.ok(runId, 'background ask must return runId');
    const completed = await waitFor(async () => {
      const current = parseToolJson(await tools.handle('get_1shell_ai_run', { runId }, {}));
      return current.data.status === 'succeeded' ? current : null;
    });
    assert.strictEqual(completed.data.response, 'background done');

    const execTools = createOneShellCoreTools({
      bridgeService: {
        async execOnHost(hostId, command, timeout, options = {}) {
          assert.strictEqual(hostId, 'remote');
          assert.strictEqual(command, 'long-running command');
          assert.strictEqual(timeout, 120000);
          assert.strictEqual(options.signal, undefined, 'background host_exec must detach from the MCP request signal');
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { stdout: 'done\n', stderr: '', exitCode: 0, durationMs: 50 };
        },
      },
      auditService: { log() {} },
    });
    const execStartedAt = Date.now();
    const execStart = parseToolJson(await execTools.handle('host_exec', {
      hostId: 'remote',
      command: 'long-running command',
      timeout: 120000,
    }, { source: 'mcp' }));
    assert.ok(Date.now() - execStartedAt < 100, 'long MCP host_exec must return quickly');
    const execRunId = execStart.data.runId;
    assert.ok(execRunId, 'background host_exec must return runId');
    const execDone = await waitFor(async () => {
      const current = parseToolJson(await execTools.handle('get_host_exec_run', { runId: execRunId }, {}));
      return current.data.status === 'succeeded' ? current : null;
    });
    assert.strictEqual(execDone.data.stdout, 'done\n');
    assert.strictEqual(execDone.data.exitCode, 0);

    const directDownloadTarget = path.join(tmpRoot, 'downloads', 'direct.txt');
    const directDownloadTools = createOneShellCoreTools({
      hostService,
      fileService: delayedDownloadFileService('direct'),
      auditService: { log() {} },
    });
    const directDownloadStart = parseToolJson(await directDownloadTools.handle('download_file', {
      hostId: 'local',
      path: '/remote/direct.txt',
      localPath: directDownloadTarget,
      expectedSha256: sha256('direct'),
    }, { source: 'mcp' }));
    const directTransferId = directDownloadStart.data.transferId;
    assert.ok(directTransferId, 'MCP download_file localPath must return transferId by default');
    assert.strictEqual(await fs.promises.access(directDownloadTarget).then(() => true).catch(() => false), false, 'background download must not create final file before commit');
    const directDownloaded = await waitFor(async () => {
      const current = parseToolJson(await directDownloadTools.handle('get_file_transfer', { transferId: directTransferId }, {}));
      return current.data.status === 'succeeded' ? current : null;
    });
    assert.strictEqual(directDownloaded.data.sha256, sha256('direct'));
    assert.strictEqual(await fs.promises.readFile(directDownloadTarget, 'utf8'), 'direct');

    const transferTarget = path.join(tmpRoot, 'downloads', 'resumable.txt');
    const transferTools = createOneShellCoreTools({
      hostService,
      fileService: failingThenResumableFileService(),
      auditService: { log() {} },
    });
    const transferStart = parseToolJson(await transferTools.handle('start_file_download', {
      hostId: 'local',
      path: '/remote/resumable.txt',
      localPath: transferTarget,
      expectedSha256: sha256('helloworld'),
    }, {}));
    const transferId = transferStart.data.transferId;
    assert.ok(transferId, 'background download must return transferId');

    const failedTransfer = await waitFor(async () => {
      const currentResult = await transferTools.handle('get_file_transfer', { transferId }, {});
      const current = parseToolJsonAny(currentResult);
      return current.data.status === 'failed' ? current : null;
    });
    assert.strictEqual(failedTransfer.data.receivedBytes, 5);
    assert.strictEqual(await fs.promises.access(transferTarget).then(() => true).catch(() => false), false, 'failed transfer must not create final file');
    assert.strictEqual(failedTransfer.data.canResume, true, 'failed partial transfer should be resumable');

    const resume = parseToolJson(await transferTools.handle('resume_file_transfer', { transferId }, {}));
    assert.strictEqual(resume.data.status, 'running');
    const succeededTransfer = await waitFor(async () => {
      const current = parseToolJson(await transferTools.handle('get_file_transfer', { transferId }, {}));
      return current.data.status === 'succeeded' ? current : null;
    });
    assert.strictEqual(succeededTransfer.data.sha256, sha256('helloworld'));
    assert.strictEqual(await fs.promises.readFile(transferTarget, 'utf8'), 'helloworld');

    console.log('mcp-core-tools: upload guard, chunk upload, background ask, host exec, and transfer job checks passed');
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
