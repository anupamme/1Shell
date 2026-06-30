'use strict';

const assert = require('assert');

const { __private } = require('../src/services/bridge.service');

const command = [
  'set -o pipefail',
  "printf 'a\\n' | grep a",
].join('\n');

const wrapped = __private.wrapRemoteCommand(command);

assert.ok(
  wrapped.includes('exec bash -lc'),
  'remote commands should prefer bash so pipefail works when bash is installed',
);
assert.ok(
  wrapped.includes('exec sh -lc'),
  'remote commands should retain a sh fallback for minimal systems',
);
assert.ok(
  wrapped.includes("printf '\\''a\\n'\\'' | grep a"),
  'single quotes inside commands must be safely shell-quoted',
);
assert.ok(
  !wrapped.includes('/bin/sh -c'),
  'remote wrapper should not force /bin/sh for bash-compatible commands',
);

console.log('bridge command shell checks passed');
