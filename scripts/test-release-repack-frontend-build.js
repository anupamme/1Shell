'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'repack-release-assets.js');
const source = fs.readFileSync(scriptPath, 'utf8');

assert.match(source, /function\s+runFrontendBuild\s*\(/, 'repack script must define an explicit frontend build step');
assert.match(source, /function\s+runNpm\s*\(/, 'repack script must run npm through a cross-platform helper');
assert.match(source, /runNpm\(\s*\[\s*'--prefix',\s*'frontend',\s*'run',\s*'build'\s*\]\s*\)/, 'repack script must run npm --prefix frontend run build');
assert.match(source, /frontend\/dist\/index\.html is missing after build/, 'repack script must fail if frontend build output is missing');
assert.match(source, /\.1shell-build\.json/, 'repack script must stamp the frontend build marker');
assert.match(source, /writeFrontendBuildMarker\(\);/, 'repack script must write the frontend build marker after build');
assert.match(source, /sanitizeBasePackage\s*\(\s*packageDir\s*\)\s*;/, 'repack script must sanitize inherited runtime data before overlay');
assert.match(source, /syncMissingRuntimeDependencies\s*\(\s*packageDir\s*\)\s*;/, 'repack script must verify runtime dependencies before archiving');
assert.match(source, /assertPortableJavaScriptPackage\s*\(/, 'repack script must not copy native/platform packages across release assets');
assert.match(source, /'data\/skills\/_templates'/, 'repack script must include only skill templates');
assert.doesNotMatch(source, /'data\/skills'\s*,/, 'repack script must not include imported host skills');

const runBuildIndex = source.indexOf('runFrontendBuild();');
const repackLoopIndex = source.indexOf('for (const asset of ASSETS)');
assert.ok(runBuildIndex >= 0, 'repack script must call runFrontendBuild');
assert.ok(repackLoopIndex >= 0, 'repack script must loop over release assets');
assert.ok(runBuildIndex < repackLoopIndex, 'frontend build must run before release assets are repacked');

console.log('release repack frontend build guard checks passed');
