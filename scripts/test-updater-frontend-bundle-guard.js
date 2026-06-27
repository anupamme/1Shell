'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertReleaseFrontendBundle } = require('../src/services/updater.service');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function makePackage(version = '4.6.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-updater-frontend-'));
  writeJson(path.join(root, 'package.json'), { version });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makePackage();
  try {
    assert.throws(
      () => assertReleaseFrontendBundle(root),
      /missing frontend\/dist\/index\.html/
    );
  } finally {
    cleanup(root);
  }
}

{
  const root = makePackage();
  try {
    writeFile(path.join(root, 'frontend', 'dist', 'index.html'), '<!doctype html>');
    assert.throws(
      () => assertReleaseFrontendBundle(root),
      /missing frontend\/dist\/\.1shell-build\.json/
    );
  } finally {
    cleanup(root);
  }
}

{
  const root = makePackage('4.6.3');
  try {
    writeFile(path.join(root, 'frontend', 'dist', 'index.html'), '<!doctype html>');
    writeJson(path.join(root, 'frontend', 'dist', '.1shell-build.json'), { version: '4.6.2' });
    assert.throws(
      () => assertReleaseFrontendBundle(root),
      /frontend bundle version mismatch/
    );
  } finally {
    cleanup(root);
  }
}

{
  const root = makePackage('v4.6.3');
  try {
    writeFile(path.join(root, 'frontend', 'dist', 'index.html'), '<!doctype html>');
    writeJson(path.join(root, 'frontend', 'dist', '.1shell-build.json'), { version: '4.6.3' });
    assert.deepStrictEqual(assertReleaseFrontendBundle(root), {
      packageVersion: '4.6.3',
      frontendVersion: '4.6.3',
    });
  } finally {
    cleanup(root);
  }
}

console.log('updater frontend bundle guard checks passed');
