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
assert(!exists('frontend/src/components/main/ProbeWidget.vue'), 'ProbeWidget must stay deleted (probe strip retired)');
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

// 4.7.5 AI 任务板块整体退役（用户判定鸡肋）：/task 创作模式、功能页任务
// tab、task_run 执行链、后端存储/路由/工具全部删除，脚本库回归 /config/features
assert(!exists('frontend/src/views/FeaturesView.vue'), 'FeaturesView must stay deleted (AI tasks retired in 4.7.5)');
assert(!exists('frontend/src/utils/aiTasks.ts'), 'aiTasks utils must stay deleted');
assert(!exists('src/repositories/ai-task.repository.js'), 'ai-task repository must stay deleted');
assert(!exists('src/services/ai-task.service.js'), 'ai-task service must stay deleted');
assert(!exists('src/routes/ai-task.routes.js'), 'ai-task routes must stay deleted');
{
  const ideTools = read('src/ide/ide.tools.js');
  const ideService = read('src/ide/ide.service.js');
  const agentKernel = read('src/ide/ide.agent-kernel.js');
  const capabilities = read('src/harness/capabilities.js');
  const slashCommands = read('frontend/src/utils/agentSlashCommands.ts');
  assert(!ideTools.includes('create_ai_task'), 'task authoring tools must stay removed from ide.tools');
  assert(!ideService.includes('TASK_AUTHORING_SYSTEM_PROMPT'), 'task authoring prompt must stay removed');
  assert(!ideService.includes('taskRepair'), 'task repair authorization must stay removed');
  assert(!agentKernel.includes('task_authoring'), 'task_authoring capability must stay out of IDE policies');
  assert(!capabilities.includes('task_authoring'), 'task_authoring capability must stay removed from harness');
  assert(!slashCommands.includes("'/task'"), '/task slash command must stay removed');
  assert(!agentView.includes('taskMode'), 'AgentView must not track task mode');
}

// 4.7.5 顶栏探针条 + AI 行内补全退役：多开 tab 时探针会挤占工具条，
// 补全占位条显隐会把终端区上下顶动，二者整体删除
assert(!exists('frontend/src/composables/useTopbarProbe.ts'), 'useTopbarProbe must stay deleted (probe strip retired in 4.7.5)');
assert(!exists('frontend/src/components/main/SuggestionBox.vue'), 'SuggestionBox must stay deleted (inline AI completion retired in 4.7.5)');
assert(!exists('frontend/src/components/main/GhostOverlay.vue'), 'GhostOverlay must stay deleted (inline AI completion retired in 4.7.5)');
assert(!exists('frontend/src/composables/useTerminalAi.ts'), 'useTerminalAi must stay deleted (superseded by useTerminalCommandHistory)');
assert(exists('frontend/src/composables/useTerminalCommandHistory.ts'), 'useTerminalCommandHistory must exist (analyze-selection recent commands)');
assert(!terminalArea.includes('terminal-probe-strip'), 'terminal toolbar must not render probe strip');
assert(!terminalArea.includes('SuggestionBox'), 'terminal area must not mount SuggestionBox');
assert(!terminalArea.includes('GhostOverlay'), 'terminal area must not mount GhostOverlay');
assert(!agentView.includes('useTopbarProbe'), 'AgentView must not poll topbar probe');
assert(!aiRoutes.includes('complete-inline'), 'terminal inline completion route must stay removed');
assert(!aiService.includes('requestTerminalInlineCompletion'), 'inline completion service must stay removed');
assert(!validators.includes('validateTerminalInlineCompletionBody'), 'inline completion validator must stay removed');

// 4.7.6 脚本库重构：回归"存脚本 + 在终端里注入"。Web 端服务端执行入口、批量
// 执行、执行历史（script_runs 表）、AI 生成脚本弹窗全部退役；结构化参数定义
// 换成从正文扫描 {{变量}}；分类/风险等级/图标/运行次数四类元数据删除。
// 服务端执行只保留给 agent 的 run_script。
{
  const scriptRoutes = read('src/routes/script.routes.js');
  const scriptService = read('src/services/script.service.js');
  const scriptRepo = read('src/repositories/script.repository.js');
  const scriptsUtil = read('frontend/src/utils/scripts.ts');
  const coreTools = read('src/tools/oneshell-core.tools.js');
  const ideTools = read('src/ide/ide.tools.js');
  const capabilities = read('src/harness/capabilities.js');
  const guard = read('src/harness/guard.js');

  assert(!exists('frontend/src/components/scripts/RunModal.vue'), 'RunModal must stay deleted (web-side script execution retired in 4.7.6)');
  assert(!exists('frontend/src/components/scripts/HistoryPane.vue'), 'HistoryPane must stay deleted (script_runs table dropped in 4.7.6)');
  assert(!exists('frontend/src/components/scripts/AiGenModal.vue'), 'AiGenModal must stay deleted (superseded by agent save_script)');
  assert(exists('lib/script-placeholders.js'), 'script placeholder scanner must exist (single source of the {{var}} regex)');

  assert(!scriptRoutes.includes("'/scripts/:id/run'"), 'web script run route must stay removed');
  assert(!scriptRoutes.includes('run-batch'), 'batch script run route must stay removed');
  assert(!scriptRoutes.includes('script-runs'), 'script run history routes must stay removed');
  assert(!scriptRoutes.includes('ai-generate'), 'AI script generation route must stay removed');
  assert(scriptRoutes.includes("'/scripts/:id/render'"), 'render route must exist (terminal injection needs server-side escaping)');

  assert(!scriptService.includes('runScriptBatch'), 'batch execution must stay removed');
  assert(!scriptService.includes('checkRisk'), 'per-script riskLevel gate must stay removed');
  assert(!scriptService.includes('DANGER_KEYWORDS'), 'keyword-based risk heuristic must stay removed');
  assert(scriptService.includes('assessCommandRisk'), 'rendered command must still go through catastrophic-command interception');
  assert(!scriptRepo.includes('script_runs'), 'script_runs statements must stay removed from repository');
  assert(!scriptRepo.includes('risk_level'), 'risk_level column must stay out of the repository');
  assert(scriptRepo.includes('placeholders'), 'repository must derive placeholders');

  assert(!validators.includes('validateScriptRunPayload'), 'script run payload validator must stay removed');
  assert(!validators.includes('validateScriptParameters'), 'structured script parameter validator must stay removed');
  assert(!validators.includes('SCRIPT_RISK_LEVELS'), 'script risk levels must stay removed');

  assert(!scriptsUtil.includes('RunHistoryEntry'), 'run history types must stay removed from frontend');
  assert(!scriptsUtil.includes('RISK_BADGES'), 'risk badges must stay removed from frontend');
  assert(!scriptsUtil.includes('CATEGORY_LABELS'), 'fixed categories must stay removed from frontend');
  assert(!scriptsUtil.includes('HostInfo'), 'HostInfo must live in utils/mainConsole, not the script module');

  // agent 侧：读/写/执行三件套齐全，且都通过了 capability 准入
  assert(coreTools.includes("name: 'get_script'"), 'get_script tool must be registered');
  assert(coreTools.includes("name: 'save_script'"), 'save_script tool must be registered');
  assert(capabilities.includes('list_scripts'), 'list_scripts must be allowed by a capability rule (was blocked by guard before 4.7.6)');
  assert(capabilities.includes('save_script'), 'save_script must be allowed under exec_command');
  assert(guard.includes("toolName === 'save_script'"), 'save_script must have a readable approval card');
  assert(!ideTools.includes("case 'run_script'"), 'shadowed run_script handler in ide.tools must stay deleted');
}

console.log('ai-chat retired route guard ok');
