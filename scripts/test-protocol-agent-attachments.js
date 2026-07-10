'use strict';

// 协议 agent 附件落盘回归测试（无外部依赖）：
//   - base64 图片 / 文本 → cwd/.1shell-attachments/ 下真实文件，路径可读
//   - 文件名清洗防路径穿越，保留扩展名 / 按 mime 补扩展名
//   - 超限（数量 / 二进制 / 文本）与空内容进 skipped，不抛错
//   - buildAttachmentHint 产出含全部落盘路径的提示块

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  materializeAttachments,
  buildAttachmentHint,
  ATTACHMENT_DIR_NAME,
} = require('../src/agents/protocol/attachment-store');

const silentLogger = { info() {}, warn() {}, error() {} };

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '1shell-att-'));
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// ── Part 1：图片 + 文本落盘 ────────────────────────────────────────────
{
  const cwd = tmpCwd();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { stored, skipped } = materializeAttachments({
    attachments: [
      { name: 'shot.png', mime: 'image/png', kind: 'image', base64: pngBytes.toString('base64') },
      { name: 'note.txt', mime: 'text/plain', kind: 'text', text: 'hello 附件' },
    ],
    cwd,
    logger: silentLogger,
  });
  assert.strictEqual(skipped.length, 0, '正常附件不该被跳过');
  assert.strictEqual(stored.length, 2, '两个附件都该落盘');

  const dir = path.join(cwd, ATTACHMENT_DIR_NAME);
  assert.ok(fs.existsSync(dir), '附件目录应被创建');

  const png = stored.find((a) => a.kind === 'image');
  assert.ok(png && fs.existsSync(png.path), '图片文件应存在于磁盘');
  assert.ok(png.path.endsWith('.png'), '图片应保留 .png 扩展名');
  assert.deepStrictEqual(fs.readFileSync(png.path), pngBytes, '图片字节应与输入一致');
  assert.ok(path.dirname(png.path) === dir, '附件应落在 .1shell-attachments 目录内');

  const txt = stored.find((a) => a.kind === 'text');
  assert.ok(txt && fs.existsSync(txt.path), '文本文件应存在');
  assert.strictEqual(fs.readFileSync(txt.path, 'utf8'), 'hello 附件', '文本内容应保真');

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('✓ Part 1 图片+文本落盘并保真');
}

// ── Part 2：文件名清洗 / 防路径穿越 ────────────────────────────────────
{
  const cwd = tmpCwd();
  const { stored } = materializeAttachments({
    attachments: [
      { name: '../../etc/passwd', mime: 'text/plain', text: 'x' },
      { name: '', mime: 'image/png', base64: b64('img') },
    ],
    cwd,
    logger: silentLogger,
  });
  assert.strictEqual(stored.length, 2, '两个附件应落盘');
  const dir = path.join(cwd, ATTACHMENT_DIR_NAME);
  for (const att of stored) {
    assert.strictEqual(path.dirname(att.path), dir, `文件名穿越必须被消解：${att.path}`);
    assert.ok(!att.path.includes('..'), '路径不得含 ..');
  }
  const unnamed = stored[1];
  assert.ok(unnamed.path.endsWith('.png'), '无名图片应按 mime 补 .png');
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('✓ Part 2 文件名清洗与防穿越');
}

// ── Part 3：超限与空内容 → skipped ─────────────────────────────────────
{
  const cwd = tmpCwd();
  const bigBinary = Buffer.alloc(17 * 1024 * 1024, 1).toString('base64'); // >16MB
  const bigText = 'a'.repeat(3 * 1024 * 1024); // >2MB
  const { stored, skipped } = materializeAttachments({
    attachments: [
      { name: 'huge.bin', mime: 'application/octet-stream', base64: bigBinary },
      { name: 'huge.txt', mime: 'text/plain', text: bigText },
      { name: 'empty.txt', mime: 'text/plain' },
    ],
    cwd,
    logger: silentLogger,
  });
  assert.strictEqual(stored.length, 0, '超限与空内容都不该落盘');
  assert.strictEqual(skipped.length, 3, '三个都应进 skipped');
  assert.ok(skipped.every((s) => s.reason), '每个 skipped 应带原因');
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('✓ Part 3 超限与空内容进 skipped');
}

// ── Part 4：数量上限（>8）────────────────────────────────────────────
{
  const cwd = tmpCwd();
  const attachments = [];
  for (let i = 0; i < 10; i += 1) {
    attachments.push({ name: `f${i}.txt`, mime: 'text/plain', text: `content ${i}` });
  }
  const { stored, skipped } = materializeAttachments({ attachments, cwd, logger: silentLogger });
  assert.strictEqual(stored.length, 8, '最多落盘 8 个');
  assert.strictEqual(skipped.length, 2, '超出的 2 个进 skipped');
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('✓ Part 4 数量上限 8');
}

// ── Part 5：无 cwd / 空列表 → 空结果，不抛错 ──────────────────────────
{
  assert.deepStrictEqual(
    materializeAttachments({ attachments: [], cwd: tmpCwd() }),
    { stored: [], skipped: [] },
    '空列表应返回空结果',
  );
  assert.deepStrictEqual(
    materializeAttachments({ attachments: [{ name: 'x', text: 'y' }], cwd: '' }),
    { stored: [], skipped: [] },
    '无 cwd 应返回空结果',
  );
  console.log('✓ Part 5 空列表 / 无 cwd 安全');
}

// ── Part 6：buildAttachmentHint 含全部路径 ────────────────────────────
{
  const hint = buildAttachmentHint(
    [{ path: '/tmp/w/.1shell-attachments/a.png', name: 'a.png', mime: 'image/png', size: 1234 }],
    [{ name: 'bad.bin', reason: '超过上限' }],
  );
  assert.ok(hint.includes('/tmp/w/.1shell-attachments/a.png'), '提示应含落盘路径');
  assert.ok(hint.includes('a.png'), '提示应含文件名');
  assert.ok(hint.includes('bad.bin') && hint.includes('超过上限'), '提示应含 skipped 说明');
  assert.strictEqual(buildAttachmentHint([], []), '', '无附件时提示为空');
  console.log('✓ Part 6 buildAttachmentHint');
}

console.log('\n✓ test-protocol-agent-attachments 全部通过');
