'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'SettingsView.vue'), 'utf8');

assert.match(
  source,
  /function\s+hardReloadApp\(\)/,
  'Settings update flow must hard-reload the browser after server-side updates',
);
assert.match(
  source,
  /_1shellUpdated/,
  'Settings update hard reload must include a cache-busting query parameter',
);
assert.match(
  source,
  /\/api\/updater\/status\?_/,
  'Settings update flow must poll server updater status before reloading',
);
assert.match(
  source,
  /srvBusy\.value\s*=\s*'restart'/,
  'Settings update flow must keep controls disabled while waiting for restart',
);
assert.match(
  source,
  /reloadAfterServerUpdate\(toVersion,\s*'更新'\)/,
  'Apply update must wait for the target version and reload the frontend',
);
assert.match(
  source,
  /reloadAfterServerUpdate\(toVersion,\s*'回退'\)/,
  'Rollback must wait for the target version and reload the frontend',
);

console.log('updater client reload guard checks passed');
