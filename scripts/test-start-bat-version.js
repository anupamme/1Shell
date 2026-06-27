'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const startBat = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'utf8');

assert.ok(startBat.includes('APP_VERSION'), 'start.bat must use APP_VERSION for its banner');
assert.ok(startBat.includes("process.env.APP_ROOT,'package.json'"), 'start.bat must read package.json for the displayed version');
assert.ok(startBat.includes('1Shell v%APP_VERSION%'), 'start.bat banner must render the package version variable');
assert.ok(!/1Shell v\d+\.\d+\.\d+/.test(startBat), 'start.bat must not hardcode a semantic version in the banner');

console.log('start.bat version banner checks passed');
