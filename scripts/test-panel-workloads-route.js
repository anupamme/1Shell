#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const router = read('frontend/src/router/index.ts');
const sidebar = read('frontend/src/components/AppSidebar.vue');
const aiFab = read('frontend/src/components/AppAiFab.vue');

assert.ok(
  router.includes("{ path: 'workloads', name: 'panel-workloads', component: () => import('@/views/WorkloadsView.vue') }"),
  'WorkloadsView must be registered under /panel/workloads',
);
assert.ok(
  router.includes("{ path: '/workloads', redirect: '/panel/workloads' }"),
  'legacy /workloads redirect must point at /panel/workloads',
);
assert.ok(
  sidebar.includes("to: '/panel/workloads'") && sidebar.includes("icon: 'play-square'"),
  'AppSidebar must expose the workloads page entry',
);
assert.ok(
  aiFab.includes("'panel-workloads'") && aiFab.includes("icon: 'play-square'"),
  'AppAiFab must understand the workloads route context',
);

console.log('panel workloads route registration ok');
