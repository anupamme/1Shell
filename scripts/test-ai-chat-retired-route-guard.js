'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const aiRoutes = read('src/routes/ai.routes.js');
const aiService = read('src/services/ai.service.js');
const validators = read('src/utils/validators.js');
const useAiChat = read('frontend/src/composables/useAiChat.ts');
const aiChatPanel = read('frontend/src/components/main/AiChatPanel.vue');
const terminalArea = read('frontend/src/components/main/TerminalArea.vue');
const mainConsole = read('frontend/src/views/MainConsoleView.vue');

assert(!aiRoutes.includes("router.post('/chat'"), 'old /api/chat route must stay removed');
assert(!aiRoutes.includes('createChatUpstream'), 'old chat upstream must not be routed');
assert(!aiService.includes('createChatUpstream'), 'old chat upstream service must stay removed');
assert(!validators.includes('validateChatRequestBody'), 'old chat request validator must stay removed');
assert(!validators.includes('validateChatMessages'), 'old chat message validator must stay removed');
assert(!useAiChat.includes("fetch('/api/chat'"), 'AI Chat panel must not call old /api/chat');
assert(!useAiChat.includes('scopeOptions'), 'AI Chat must not keep the old VPS/range scope options');
assert(!useAiChat.includes('activeScopeKey'), 'AI Chat must not keep the old active scope selector state');
assert(!useAiChat.includes('scopePrompt'), 'AI Chat must not inject old VPS/range scope prompts');
assert(!aiChatPanel.includes('activeScopeKey'), 'AI Chat panel must not render the old range selector');
assert(!aiChatPanel.includes('scopeOptions'), 'AI Chat panel must not render old VPS scope options');
assert(!terminalArea.includes('useAiChat'), 'terminal toolbar must not initialize old AI Chat');
assert(!terminalArea.includes('activeScopeKey'), 'terminal toolbar must not render old AI Chat range selector');
assert(!terminalArea.includes('scopeOptions'), 'terminal toolbar must not render old AI Chat scope options');
assert(mainConsole.includes('AiChatPanel'), 'AI Chat panel shell should remain until explicitly removed');
assert(mainConsole.includes('IdePanel'), '1Shell AI panel must remain mounted');
assert(mainConsole.includes('AgentPanel'), 'AI Agent panel must remain mounted');

console.log('ai-chat retired route guard ok');
