'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'ProviderModal.vue'), 'utf8');

assert.match(source, /const\s+SHOW_CONFIG_FILE_DRAFTS\s*=\s*true\s*;/, 'native config file editor must stay enabled');
assert.match(source, /原生配置文件生成器/, 'provider modal must render the native config file generator');
assert.match(source, /<textarea[\s\S]*configDraft/, 'provider modal must expose editable generated config content');
assert.match(source, /applyRequestedMode\(\s*props\.editProviderId\s*\|\|\s*null\s*\)/, 'opening add mode must not auto-select an existing provider');
assert.match(source, /applyRequestedMode\(\s*newId\s*\|\|\s*null\s*\)/, 'editProviderId watcher must respect explicit add mode');
assert.doesNotMatch(source, /prepareModal[\s\S]{0,500}applyRequestedMode\(\s*getPreferredProviderId\(\s*\)\s*\)/, 'prepareModal must not convert add mode into editing the preferred provider');

// 主模型输入:非 Claude Code 的入口(含 1Shell AI 引擎/Codex)必须有可见的模型输入框,
// 否则 fPrimaryModel 变成无 UI 绑定的死状态,用户无法选择模型(4.7 曾回归过)。
assert.match(source, /v-if="!isClaudeCode"[\s\S]{0,600}v-model="fPrimaryModel"/, 'non-claude-code providers must expose a primary model input bound to fPrimaryModel');
assert.match(source, /modelSuggestions/, 'provider modal should offer preset model quick picks');

console.log('provider modal native config UI guard checks passed');
