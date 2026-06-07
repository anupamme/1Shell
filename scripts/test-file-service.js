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
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('file-service: dot file checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
