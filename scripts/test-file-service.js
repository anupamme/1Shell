'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileService } = require('../src/services/file.service');

async function main() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oneshell-file-service-'));
  try {
    await fs.promises.writeFile(path.join(tmpRoot, '.hidden-file'), 'hidden', 'utf8');
    await fs.promises.writeFile(path.join(tmpRoot, 'visible-file'), 'visible', 'utf8');
    await fs.promises.mkdir(path.join(tmpRoot, '.hidden-dir'));

    const service = createFileService({
      hostService: {
        findHost(hostId) {
          return hostId === 'local' ? { id: 'local', type: 'local' } : null;
        },
      },
    });

    const listed = await service.listDir('local', tmpRoot);
    const names = listed.items.map((item) => item.name);
    assert.ok(names.includes('.hidden-file'), 'local listDir must include dot files');
    assert.ok(names.includes('.hidden-dir'), 'local listDir must include dot directories');
    assert.ok(names.includes('visible-file'), 'local listDir must include visible files');

    const hidden = await service.readFile('local', path.join(tmpRoot, '.hidden-file'));
    assert.strictEqual(hidden.content, 'hidden', 'local readFile must read dot files');

    const tinyCapPath = path.join(tmpRoot, 'tiny-cap.txt');
    const tinyCapContent = 'x'.repeat(6000);
    await fs.promises.writeFile(tinyCapPath, tinyCapContent, 'utf8');

    const tinyCapRead = await service.readFile('local', tinyCapPath, 5);
    assert.strictEqual(tinyCapRead.content, tinyCapContent, 'tiny maxBytes hints must not shrink previews below the service minimum');

    const tooLargePreviewPath = path.join(tmpRoot, 'too-large-preview.txt');
    await fs.promises.writeFile(tooLargePreviewPath, Buffer.alloc((2 * 1024 * 1024) + 1, 'x'));

    await assert.rejects(
      () => service.readFile('local', tooLargePreviewPath, 5),
      (error) => {
        assert.match(error.message, /2\.0MB/, 'preview limit should be formatted in useful units');
        assert.strictEqual(/0\.0MB/.test(error.message), false, 'preview limit error must not show 0.0MB');
        return true;
      },
    );
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('file-service: dot file and preview limit checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
