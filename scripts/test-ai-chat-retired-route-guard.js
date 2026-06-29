'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const aiRoutes = read('src/routes/ai.routes.js');
const aiService = read('src/services/ai.service.js');
const validators = read('src/utils/validators.js');
const terminalArea = read('frontend/src/components/main/TerminalArea.vue');
const mainConsole = read('frontend/src/views/MainConsoleView.vue');

assert(!exists('frontend/src/composables/useAiChat.ts'), 'old useAiChat composable must stay deleted');
assert(!exists('frontend/src/components/main/AiChatPanel.vue'), 'old AiChatPanel component must stay deleted');
assert(!aiRoutes.includes("router.post('/chat'"), 'old /api/chat route must stay removed');
assert(!aiRoutes.includes('createChatUpstream'), 'old chat upstream must not be routed');
assert(!aiService.includes('createChatUpstream'), 'old chat upstream service must stay removed');
assert(!validators.includes('validateChatRequestBody'), 'old chat request validator must stay removed');
assert(!validators.includes('validateChatMessages'), 'old chat message validator must stay removed');
assert(!terminalArea.includes('useAiChat'), 'terminal toolbar must not initialize old AI Chat');
assert(!terminalArea.includes('activeScopeKey'), 'terminal toolbar must not render old AI Chat range selector');
assert(!terminalArea.includes('scopeOptions'), 'terminal toolbar must not render old AI Chat scope options');
assert(!mainConsole.includes('AiChatPanel'), 'MainConsole must not mount old AI Chat');
assert(!mainConsole.includes("rightTab === 'chat'"), 'MainConsole must not keep old AI Chat tab state');
assert(mainConsole.includes('IdePanel'), '1Shell AI panel must remain mounted');
assert(mainConsole.includes('AgentPanel'), 'AI Agent panel must remain mounted');

console.log('ai-chat retired route guard ok');
