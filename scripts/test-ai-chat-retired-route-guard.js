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
const agentView = read('frontend/src/views/AgentView.vue');

assert(!exists('frontend/src/composables/useAiChat.ts'), 'old useAiChat composable must stay deleted');
assert(!exists('frontend/src/components/main/AiChatPanel.vue'), 'old AiChatPanel component must stay deleted');
// 4.7.2 终端页并入 Agent 页：整页与右栏两面板一并退役
assert(!exists('frontend/src/views/MainConsoleView.vue'), 'MainConsoleView must stay deleted (merged into AgentView)');
assert(!exists('frontend/src/components/main/IdePanel.vue'), 'IdePanel must stay deleted (superseded by AgentView chat)');
assert(!exists('frontend/src/components/main/AgentPanel.vue'), 'AgentPanel must stay deleted (agent:* PTY channel retired)');
assert(!exists('src/agents/agent-pty.service.js'), 'agent-pty service must stay deleted');
assert(!exists('src/sockets/registerAgentSocketHandlers.js'), 'agent:* socket handlers must stay deleted');
// 4.7.2 合并后的孤儿清理：老终端页/老 AI 面板的遗留部件一并退役
assert(!exists('frontend/src/components/main/TopBar.vue'), 'TopBar must stay deleted (AgentView header supersedes it)');
assert(!exists('frontend/src/components/main/ProbeWidget.vue'), 'ProbeWidget must stay deleted (AgentView renders probe via useTopbarProbe)');
assert(!exists('frontend/src/components/ToolProgressBar.vue'), 'ToolProgressBar must stay deleted (old AI panel tool card)');
assert(!exists('frontend/src/composables/useTerminal.ts'), 'old useTerminal must stay deleted (useSessionTerminal supersedes it)');
assert(!exists('frontend/src/composables/useAiAgentStream.ts'), 'old useAiAgentStream must stay deleted (useIdeChat supersedes it)');
assert(!exists('frontend/src/utils/aiMessages.ts'), 'old aiMessages helpers must stay deleted');
assert(!exists('frontend/src/stores/ide.ts'), 'old ide store must stay deleted');
assert(!exists('frontend/src/stores/sessions.ts'), 'old sessions store must stay deleted');
assert(!aiRoutes.includes("router.post('/chat'"), 'old /api/chat route must stay removed');
assert(!aiRoutes.includes('createChatUpstream'), 'old chat upstream must not be routed');
assert(!aiService.includes('createChatUpstream'), 'old chat upstream service must stay removed');
assert(!validators.includes('validateChatRequestBody'), 'old chat request validator must stay removed');
assert(!validators.includes('validateChatMessages'), 'old chat message validator must stay removed');
assert(!terminalArea.includes('useAiChat'), 'terminal toolbar must not initialize old AI Chat');
assert(!terminalArea.includes('activeScopeKey'), 'terminal toolbar must not render old AI Chat range selector');
assert(!terminalArea.includes('scopeOptions'), 'terminal toolbar must not render old AI Chat scope options');
assert(!agentView.includes('AiChatPanel'), 'AgentView must not mount old AI Chat');
assert(agentView.includes('TerminalArea'), 'terminal split must stay mounted in AgentView');

console.log('ai-chat retired route guard ok');
