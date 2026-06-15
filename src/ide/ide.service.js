'use strict';

const { EventEmitter } = require('events');
const fetch = require('node-fetch');
const { emitIdeEvent } = require('./ide.events');
const {
  ONESHELL_CORE_SYSTEM_PROMPT,
} = require('../ai/oneshell-ai-prompt');
const {
  evaluateAgentRunOutcome,
} = require('../agent-runtime/outcome');
const {
  composeSystemPrompt,
  resolveAiSkillContext,
} = require('../skills/ai-skill-resolver');
const { canUseTool, createBudgetExceededResult } = require('../agent-runtime/budget');
const {
  DEFAULT_IDE_AGENT_LIMITS,
  IDE_AGENT_PHASE_DEFINITIONS,
  createIdeAgentPolicy,
  createIdeAgentGoalProfile,
  evaluateIdeAgentProfileToolUse,
  filterToolsForAgent,
  normalizeIdeApprovalMode,
  normalizeIdeAgentToolInput,
  shouldRequestAgentApproval,
} = require('./ide.agent-kernel');

function emitToSession(session, fallbackSocket, event, payload) {
  const target = session ? session.socket : fallbackSocket;
  try { emitIdeEvent(target, event, payload); } catch { /* ignore */ }
}

function normalizeVisibleWorkNote(value, maxLength = 1600) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}\n...[truncated]` : text;
}

function extractToolWorkNotes(content = []) {
  const notes = new Map();
  if (!Array.isArray(content)) return notes;
  let pendingText = '';
  let latestNote = '';
  for (const block of content) {
    if (block?.type === 'text') {
      pendingText += String(block.text || '');
      const note = normalizeVisibleWorkNote(pendingText);
      if (note) latestNote = note;
      continue;
    }
    if (block?.type === 'tool_use' && block.id && latestNote) {
      notes.set(String(block.id), latestNote);
    }
  }
  return notes;
}

function rememberToolWorkNotes(session, runId, content = []) {
  if (!session) return;
  const notes = extractToolWorkNotes(content);
  if (notes.size === 0) return;
  if (!(session.toolWorkNotes instanceof Map)) session.toolWorkNotes = new Map();
  for (const [toolUseId, workNote] of notes.entries()) {
    session.toolWorkNotes.set(toolUseId, { runId, workNote });
  }
}

function readToolWorkNote(session, runId, toolUseId) {
  const id = String(toolUseId || '').trim();
  if (!id || !(session?.toolWorkNotes instanceof Map)) return '';
  const entry = session.toolWorkNotes.get(id);
  if (!entry || (entry.runId && runId && entry.runId !== runId)) return '';
  return normalizeVisibleWorkNote(entry.workNote);
}

function resolveNullablePositiveInteger(value) {
  if (value === undefined || value === null || value === false) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || ['none', 'unbounded', 'runtime_policy', 'runtime-policy', 'long_running'].includes(text)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

// ─── 增量 SSE 解析（实时推送 text delta + 随时可中断） ─────────────────────
/**
 * 逐 chunk 解析 Anthropic SSE 流，实时 emit ide:text-delta 到前端。
 * AbortController 在整个流读取期间保持有效，cancelSession 可随时 abort。
 * 返回与 parseAnthropicSSE 相同结构的完整 message 对象。
 */
function streamAnthropicSSE(stream, abortController, session, socket, sessionId, runId) {
  return new Promise((resolve, reject) => {
    const blocks = [];
    let stopReason = 'end_turn';
    let stopSeq = null;
    let modelId = '';
    let inputTokens = 0, outputTokens = 0;
    let emittedTextDelta = false;
    let buffer = '';
    let resolved = false;

    const TOOL_INPUT_PROGRESS_CHARS = 2000;
    const TOOL_INPUT_PROGRESS_MS = 1200;

    function isCurrentRun() {
      return session?.currentRunId === runId && !session?.cancelled;
    }

    function formatProgressSize(size) {
      if (size < 1024) return `${size} chars`;
      return `${(size / 1024).toFixed(1)} KB`;
    }

    function emitToolInputProgress(blk, { force = false, done = false } = {}) {
      if (!blk || blk.type !== 'tool_use' || !blk.id || !isCurrentRun()) return;
      const size = String(blk._inputJson || '').length;
      const now = Date.now();
      const lastSize = blk._lastInputProgressSize || 0;
      const lastAt = blk._lastInputProgressAt || 0;
      if (!force && size - lastSize < TOOL_INPUT_PROGRESS_CHARS && now - lastAt < TOOL_INPUT_PROGRESS_MS) return;
      blk._lastInputProgressSize = size;
      blk._lastInputProgressAt = now;
      const name = blk.name || '工具';
      emitToSession(session, socket, 'ide:tool-delta', {
        sessionId,
        runId,
        toolUseId: blk.id,
        name,
        stream: 'stdout',
        text: done
          ? `${name} 参数已生成，准备执行...\n`
          : `正在准备 ${name} 参数... (${formatProgressSize(size)})\n`,
      });
    }

    function buildResult() {
      return {
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: blocks.filter(Boolean).map(blk => {
          if (blk.type === 'text') return { type: 'text', text: blk.text };
          if (blk.type === 'tool_use') {
            let input = blk.input;
            if (!input && blk._inputJson) {
              try { input = JSON.parse(blk._inputJson); } catch { input = {}; }
            }
            return { type: 'tool_use', id: blk.id, name: blk.name, input: input || {} };
          }
          return blk;
        }),
        stop_reason: stopReason,
        stop_sequence: stopSeq,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        _emittedTextDelta: emittedTextDelta,
      };
    }

    function cleanup() {
      abortController.signal.removeEventListener('abort', onAbort);
    }

    function finish() {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(buildResult());
    }

    function processLine(line) {
      if (resolved) return;
      if (!line.startsWith('data: ')) return;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') return;
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }
      if (!evt.type) return;

      if (evt.type === 'error') {
        resolved = true;
        cleanup();
        try { stream.destroy(); } catch { /* ignore */ }
        reject(new Error(evt.error?.message || 'SSE error'));
        return;
      }
      if (evt.type === 'message_start') {
        modelId = evt.message?.model || modelId;
        inputTokens = evt.message?.usage?.input_tokens || 0;
        outputTokens = evt.message?.usage?.output_tokens || 0;
        return;
      }
      if (evt.type === 'content_block_start') {
        const cb = evt.content_block || {};
        blocks[evt.index] = {
          type: cb.type,
          text: cb.text || '',
          id: cb.id || '',
          name: cb.name || '',
          _inputJson: '',
          _lastInputProgressSize: 0,
          _lastInputProgressAt: 0,
        };
        const blk = blocks[evt.index];
        if (blk.type === 'tool_use' && blk.id && isCurrentRun()) {
          blk._lastInputProgressAt = Date.now();
          emitToSession(session, socket, 'ide:tool-start', {
            sessionId,
            runId,
            toolUseId: blk.id,
            name: blk.name || 'unknown',
            input: null,
            phase: 'preparing_input',
          });
          emitToolInputProgress(blk, { force: true });
        }
        return;
      }
      if (evt.type === 'content_block_delta') {
        const blk = blocks[evt.index];
        if (!blk) return;
        const d = evt.delta || {};
        if (d.type === 'text_delta' && d.text) {
          blk.text += d.text;
          emittedTextDelta = true;
          if (session.currentRunId === runId && !session.cancelled) {
            emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: d.text });
          }
        }
        if (d.type === 'input_json_delta') {
          blk._inputJson += d.partial_json || '';
          emitToolInputProgress(blk);
        }
        return;
      }
      if (evt.type === 'content_block_stop') {
        const blk = blocks[evt.index];
        if (blk && blk._inputJson) {
          try { blk.input = JSON.parse(blk._inputJson); } catch { blk.input = {}; }
          emitToolInputProgress(blk, { force: true, done: true });
          delete blk._inputJson;
        }
        return;
      }
      if (evt.type === 'message_delta') {
        stopReason = evt.delta?.stop_reason || stopReason;
        stopSeq = evt.delta?.stop_sequence || stopSeq;
        outputTokens = evt.usage?.output_tokens || outputTokens;
        return;
      }
      if (evt.type === 'message_stop') {
        finish();
      }
    }

    // 监听 abort — 流读取期间 cancelSession 触发时立即中断
    const onAbort = () => {
      if (resolved) return;
      resolved = true;
      try { stream.destroy(); } catch { /* ignore */ }
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    if (abortController.signal.aborted) {
      onAbort();
      return;
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true });

    stream.on('data', (chunk) => {
      if (resolved) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
        if (resolved) break;
      }
    });

    stream.on('end', () => {
      abortController.signal.removeEventListener('abort', onAbort);
      finish();
    });

    stream.on('error', (err) => {
      abortController.signal.removeEventListener('abort', onAbort);
      if (resolved) return;
      resolved = true;
      reject(err);
    });
  });
}

// ─── 上下文压缩 ─────────────────────────────────────────────────────────
// 保留最近 KEEP_RECENT 条消息完整，更早的 tool_result 截断到 TRUNCATE_TO 字符
const KEEP_RECENT = 40;
const TRUNCATE_TO = 6000;
const MAX_PROVIDER_TRANSIENT_RETRIES = 2;
const EMPTY_MODEL_RESPONSE_RETRY_LIMIT = 2;
const TASK_AUTHORING_PACKAGING_RETRY_LIMIT = 3;
const TASK_AUTHORING_CONNECTION_FAILURE_LIMIT = 3;

function toolContentPreview(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'image') return '[image]';
    return JSON.stringify(block);
  }).join('\n');
}

function stripTerminalControl(text) {
  return String(text || '')
    .replace(/(?:\uFFFD|\?)\[/g, '\x1b[')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '');
}

function compactTerminalOutputForModel(text, maxChars = 5000, maxLines = 160) {
  const lines = stripTerminalControl(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(line => line.trimEnd());
  const compacted = [];
  let previous = null;
  let repeats = 0;
  const flush = () => {
    if (previous === null) return;
    compacted.push(repeats > 1 && previous.trim() ? `${previous}  (重复 ${repeats} 次)` : previous);
    previous = null;
    repeats = 0;
  };
  for (const line of lines) {
    if (line === previous) {
      repeats += 1;
      continue;
    }
    flush();
    previous = line;
    repeats = 1;
  }
  flush();

  let visible = compacted;
  if (visible.length > maxLines) {
    const omitted = visible.length - maxLines + 1;
    visible = [`... 已折叠前 ${omitted} 行工具输出 ...`, ...visible.slice(-(maxLines - 1))];
  }

  let output = visible.join('\n');
  if (output.length > maxChars) {
    output = `${output.slice(0, maxChars)}\n...(tool_result 已裁剪，原 ${output.length} 字符)`;
  }
  return output;
}

function isTransientProviderError(err) {
  const message = String(err?.message || err || '');
  if (isProviderProtocolError(err)) return false;
  return /Provider 返回 (429|500|502|503|504)|Gateway Time-out|gateway timeout|api_error|ECONNRESET|socket hang up|ETIMEDOUT|premature close/i.test(message);
}

function isProviderProtocolError(err) {
  const message = String(err?.message || err || '');
  return /No tool call found for function call output|invalid_request_error|Provider (?:返回|杩斿洖) 400|HTTP 400|status 400/i.test(message);
}

function compactToolResultForModel(toolName, content) {
  const text = toolContentPreview(content);
  if (!text) return content;
  const compacted = compactTerminalOutputForModel(text, 5000, 160);
  return compacted === text && text.length <= 5000 ? content : compacted;
}

function compactMessages(messages) {
  if (messages.length <= KEEP_RECENT) return messages;

  const cutoff = messages.length - KEEP_RECENT;
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;

    const compacted = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const text = toolContentPreview(block.content);
      const compactedText = compactTerminalOutputForModel(text, TRUNCATE_TO, 120);
      if (compactedText === text && text.length <= TRUNCATE_TO) return block;
      return { ...block, content: compactedText };
    });
    return { ...msg, content: compacted };
  });
}

function toolUseIds(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block?.type === 'tool_use' && block.id).map((block) => block.id);
}

function toolResultIds(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return new Set();
  return new Set(message.content.filter((block) => block?.type === 'tool_result' && block.tool_use_id).map((block) => block.tool_use_id));
}

function allToolUseIds(messages = []) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const id of toolUseIds(message)) ids.add(id);
  }
  return ids;
}

function sanitizeProviderMessageHistory(messages = []) {
  const pendingToolUseIds = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const id of toolUseIds(message)) pendingToolUseIds.add(id);
      continue;
    }
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    const sanitized = [];
    for (const block of message.content) {
      if (block?.type !== 'tool_result') {
        sanitized.push(block);
        continue;
      }
      const id = String(block.tool_use_id || '').trim();
      if (id && pendingToolUseIds.has(id)) {
        pendingToolUseIds.delete(id);
        sanitized.push(block);
        continue;
      }
      sanitized.push({
        type: 'text',
        text: formatOrphanToolResultAsText(block),
      });
    }
    message.content = sanitized;
  }
  return messages;
}

function formatOrphanToolResultAsText(block = {}) {
  const id = String(block.tool_use_id || '').trim();
  const content = toolContentPreview(block.content || block.text || '').trim();
  return [
    'Previous tool result was detached from its tool call.',
    id ? `tool_result_id=${id}` : '',
    content || '(empty result)',
  ].filter(Boolean).join('\n');
}

function repairDanglingToolUseMessages(messages) {
  for (let i = 0; i < messages.length; i++) {
    const ids = toolUseIds(messages[i]);
    if (ids.length === 0) continue;

    const next = messages[i + 1];
    const resultIds = toolResultIds(next);
    const missing = ids.filter((id) => !resultIds.has(id));
    if (missing.length === 0) continue;

    const syntheticResults = missing.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'Previous tool call result is unavailable because the session was interrupted before it was recorded.',
      is_error: true,
    }));

    if (next?.role === 'user' && Array.isArray(next.content) && resultIds.size > 0) {
      next.content.push(...syntheticResults);
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: syntheticResults });
      i += 1;
    }
  }
}

const TASK_AUTHORING_SYSTEM_PROMPT = [
  '',
  '当前处于 IDE /task 任务创作模式。',
  '你可以创建或更新 1Shell AI 任务模板，但任务模板必须保持轻量：输入项 + 流程步骤卡片。',
  '不要设计新的权限系统、审批层、调度器、DSL 或第二套 Agent。',
  '当用户想创建新任务时，必须先真实实践或沙箱实践可行流程，再把成功路径包装成任务；不要凭空猜，也不要只写通用模板。',
  'list_hosts、list_scripts、read_remote_file 等发现类工具只算上下文收集，不算成功实践证据。',
  '如果缺少目标主机、仓库地址、分支、端口、运行方式、密钥或清理偏好，先用 ask_user 或 request_secret 补齐，不要静默结束。',
  '当用户想把上面对话打包成任务时，从当前会话历史提取成功路径，忽略失败分支；缺关键信息时先问用户。',
  '需要密钥、token、密码时使用 request_secret，不要要求用户在普通文本里粘贴明文。',
  'create_ai_task / update_ai_task have a hard evidence gate: practice first, record successful verify_outcome evidence, and never treat get_ai_task/database persistence as workflow verification.',
  'For GitHub deployment tasks, the practice run must actually use the repository, such as git clone/checkout plus build/run or docker build from the repo URL. If practice only used a prebuilt Docker image, package it as image-based deployment and do not include repo_url or GitHub-project claims.',
  '在 /task 模式中，preview_ai_task / create_ai_task / update_ai_task / get_ai_task 是保存任务的唯一入口；不要把任务 JSON 直接贴给用户来代替保存。',
  '当任务模板已经可信，使用 preview_ai_task 检查结构，再用 create_ai_task 或 update_ai_task 保存。',
].join('\n');

const TASK_AUTHORING_SAVE_TOOL_NAMES = new Set(['create_ai_task', 'update_ai_task']);
const REQUIRED_TASK_AUTHORING_TOOL_NAMES = ['preview_ai_task', 'create_ai_task', 'update_ai_task', 'get_ai_task'];
const TASK_AUTHORING_NON_PRACTICE_TOOL_NAMES = new Set([
  'preview_ai_task',
  'create_ai_task',
  'update_ai_task',
  'get_ai_task',
  'ask_user',
  'request_secret',
  'verify_outcome',
  'list_hosts',
  'list_artifacts',
  'query_format',
  'list_scripts',
  'list_mcp_servers',
  'query_audit',
]);

function normalizePromptEntry(entry, context = null, message = '') {
  const value = String(entry || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (value === 'core') return 'core';
  if (value === 'task') return 'task';
  if (value === 'task_run') return 'task_run';
  const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  if (ctx.taskRun || ctx.task_run || ctx.taskExecution || ctx.task_execution) return 'task_run';
  if (ctx.taskAuthoring || ctx.task_authoring) return 'task';
  const text = String(message || '').trim();
  if (/^进入\s*\/task\s*任务创作模式|\/task\s+任务创作|task authoring/i.test(text)) return 'task';
  return 'core';
}

function promptForEntry(entry) {
  if (normalizePromptEntry(entry) === 'task') {
    return `${ONESHELL_CORE_SYSTEM_PROMPT}\n${TASK_AUTHORING_SYSTEM_PROMPT}`;
  }
  return ONESHELL_CORE_SYSTEM_PROMPT;
}

/**
 * IDE Service — 自由对话模式的创作引擎
 *
 * 默认对话路径保持极简 system prompt，不注入外部流程规则。
 *   - 对话历史持久保留，支持多轮迭代
 *   - 工具集更广（list_artifacts / query_format 等）
 *   - 用户是对话主体，AI 响应用户指令而非自驱执行
 */
function createIdeService({ ideTools, proxyConfigStore, port, hostService, auditService, logger, localMcpService, mcpRegistry, skillRegistry, harness, agentRuntime, secretService }) {

  // sessionId → { messages[], system, hostId, abortController }
  const sessions = new Map();

const READONLY_TOOLS = new Set([
  'list_hosts', 'list_artifacts', 'query_format',
  'verify_outcome',
  'reload_registry', 'list_mcp_servers', 'list_scripts', 'query_audit',
  'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
  'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
  'list_remote_dir', 'read_remote_file',
]);

  const PARALLEL_SAFE_TOOLS = new Set([
    'list_hosts', 'list_artifacts', 'query_format',
    'list_mcp_servers', 'list_scripts', 'query_audit',
    'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
    'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
    'list_remote_dir', 'read_remote_file',
  ]);

  const SIDE_EFFECT_TOOLS = new Set([
    'execute_command',
    'reload_registry', 'add_mcp_server', 'remove_mcp_server', 'deploy_local_mcp',
  ]);

const AGENT_CONTROL_TOOLS = new Set(['ask_user', 'request_secret', 'verify_outcome']);

  function makeAbortError(message = 'Cancelled') {
    const err = new Error(message);
    err.name = 'AbortError';
    err.code = 'CANCELLED';
    return err;
  }

  function isAbortError(err) {
    return err?.name === 'AbortError' || err?.code === 'CANCELLED' || err?.code === 'RUN_REPLACED';
  }

  function recordTraceEvent(stage, eventType, payload = {}) {
    try {
      harness?.recordEvent?.({ stage, eventType, ...payload });
    } catch { /* trace must not block IDE execution */ }
    try {
      const agentRunId = payload.agentRunId || payload.runId;
      agentRuntime?.recordTraceEvent?.(agentRunId, { stage, eventType, ...payload });
    } catch { /* AgentRun trace must not block IDE execution */ }
  }

  function resolveSessionSkillContext({ message, context, entry }) {
    try {
      const normalizedEntry = normalizePromptEntry(entry);
      const forcedSkillIds = normalizedEntry === 'task' ? ['oneshell-task-authoring'] : [];
      const existingSkillIds = []
        .concat(context?.activeSkillIds || [])
        .concat(context?.skillIds || [])
        .concat(context?.skillId || [])
        .filter(Boolean);
      const skillContext = forcedSkillIds.length > 0
        ? {
          ...(context && typeof context === 'object' && !Array.isArray(context) ? context : {}),
          activeSkillIds: [...new Set(existingSkillIds.concat(forcedSkillIds))],
        }
        : context;
      return resolveAiSkillContext({
        skillRegistry,
        message,
        context: skillContext,
        entry: normalizedEntry,
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to resolve active skills: ${err.message}`);
      return { skills: [], prompt: '' };
    }
  }

  function recordActiveSkills(runId, sessionId, session, skillContext) {
    const skills = Array.isArray(skillContext?.skills) ? skillContext.skills : [];
    if (skills.length === 0) return;
    const summary = skills.map((skill) => `${skill.id}${skill.reason ? ` (${skill.reason})` : ''}`).join(', ');
    recordTraceEvent('instruction', 'skills_activated', {
      source: 'ide',
      runId,
      sessionId,
      hostId: session?.hostId || 'local',
      toolName: 'skill_resolver',
      summary,
      data: { skills },
    });
  }

  function redactAgentTraceValue(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}, (key, item) => {
        if (/token|key|secret|password|auth|content|base64/i.test(key)) return '<redacted>';
        if (typeof item === 'string' && item.length > 1000) return `${item.slice(0, 1000)}…`;
        return item;
      }));
    } catch { return {}; }
  }

  function cloneToolInputForExecution(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}));
    } catch {
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    }
  }

  function defaultIdeAgentLedger() {
    return {
      schemaVersion: 1,
      phase: '',
      hasSideEffects: false,
      requiresVerification: false,
      sideEffects: [],
      verification: null,
      reasons: [],
      updatedAt: '',
    };
  }

  function formatIdeAgentLedgerContent(ledger) {
    const lines = [
      `phase: ${ledger.phase || '(none)'}`,
      `hasSideEffects: ${ledger.hasSideEffects === true}`,
      `requiresVerification: ${ledger.requiresVerification === true}`,
      ledger.verification ? `verification: ${ledger.verification.status || 'unknown'} (${ledger.verification.type || 'unknown'})` : 'verification: none',
      ledger.reasons?.length ? `reasons: ${ledger.reasons.join(', ')}` : '',
      ledger.sideEffects?.length ? 'sideEffects:' : '',
      ...(ledger.sideEffects || []).slice(-20).map((item) => `- ${item.toolName || 'tool'} ${item.toolUseId || ''} ${item.summary || ''}`.trim()),
    ].filter(Boolean);
    return lines.join('\n');
  }

  function readIdeAgentLedger(runId) {
    const state = safeGetIdeAgentState(runId);
    const artifact = [...(Array.isArray(state?.artifacts) ? state.artifacts : [])]
      .reverse()
      .find((item) => item?.type === 'agent_run_ledger' || item?.id === 'ide-agent-run-ledger');
    return { ...defaultIdeAgentLedger(), ...(artifact?.data && typeof artifact.data === 'object' ? artifact.data : {}) };
  }

  function writeIdeAgentLedger(runId, patch = {}) {
    if (!runId || !agentRuntime?.updateArtifact) return null;
    try {
      const current = readIdeAgentLedger(runId);
      const sideEffects = Array.isArray(current.sideEffects) ? [...current.sideEffects] : [];
      const incomingSideEffects = Array.isArray(patch.sideEffects) ? patch.sideEffects : (patch.sideEffect ? [patch.sideEffect] : []);
      for (const item of incomingSideEffects) {
        const normalized = item && typeof item === 'object' ? item : {};
        const toolUseId = String(normalized.toolUseId || normalized.tool_use_id || '').trim();
        if (toolUseId && sideEffects.some((existing) => existing.toolUseId === toolUseId)) continue;
        sideEffects.push({
          toolName: String(normalized.toolName || normalized.name || 'unknown').slice(0, 120),
          toolUseId,
          hostId: String(normalized.hostId || 'local').slice(0, 120),
          summary: String(normalized.summary || '').slice(0, 1000),
          isError: normalized.isError === true,
          recordedAt: normalized.recordedAt || new Date().toISOString(),
        });
      }
      const reasons = [...new Set([
        ...normalizeStringArrayForIde(current.reasons),
        ...normalizeStringArrayForIde(patch.reasons),
      ])];
      const ledger = {
        ...current,
        phase: patch.phase !== undefined ? String(patch.phase || '') : current.phase,
        hasSideEffects: current.hasSideEffects === true || patch.hasSideEffects === true || sideEffects.length > 0,
        requiresVerification: current.requiresVerification === true || patch.requiresVerification === true,
        verification: patch.verification !== undefined ? patch.verification : current.verification,
        reasons,
        sideEffects,
        updatedAt: new Date().toISOString(),
      };
      return agentRuntime.updateArtifact(runId, {
        id: 'ide-agent-run-ledger',
        type: 'agent_run_ledger',
        title: 'Agent Run Ledger',
        content: formatIdeAgentLedgerContent(ledger),
        data: ledger,
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to update AgentRun ledger: ${err.message}`);
      return null;
    }
  }

  function normalizeStringArrayForIde(value) {
    return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  }

  function recordIdeAgentPhase(runId, phaseId, message = '', { status = 'running', evidence = [], transition = true } = {}) {
    if (!runId || !phaseId) return;
    try {
      agentRuntime?.updatePhase?.(runId, phaseId, { status, message, evidence });
    } catch (err) {
      logger?.warn?.(`[ide] failed to update AgentRun phase: ${err.message}`);
    }
    writeIdeAgentLedger(runId, { phase: phaseId });
    if (transition !== false) recordIdeAgentTransition(runId, phaseId, message, { status });
  }

  function recordIdeAgentTurn(runId, round, patch = {}) {
    if (!runId || !round || !agentRuntime?.recordTurn) return;
    try {
      agentRuntime.recordTurn(runId, {
        index: Number(round) - 1,
        turn: Number(round),
        ...patch,
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun turn: ${err.message}`);
    }
  }

  function recordIdeAgentObservation(runId, observation = {}) {
    if (!runId || !agentRuntime?.recordObservation) return;
    try {
      agentRuntime.recordObservation(runId, observation);
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun observation: ${err.message}`);
    }
  }

  function recordIdeAgentTransition(runId, node, reason = '', data = {}) {
    if (!runId || !node || !agentRuntime?.recordRuntimeTransition) return;
    try {
      const runtimeNode = normalizeIdeRuntimeNode(node);
      if (!runtimeNode) return;
      const currentNode = String(safeGetIdeAgentState(runId)?.runtimeState?.currentNode || '').trim();
      if (['finalize', 'blocked', 'cancelled'].includes(currentNode) && currentNode !== runtimeNode) return;
      agentRuntime.recordRuntimeTransition(runId, {
        to: runtimeNode,
        status: data.status || 'running',
        reason,
        data: {
          bridge: 'ide-streaming-loop',
          idePhase: String(node || ''),
          ...redactAgentTraceValue(data),
        },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun transition: ${err.message}`);
    }
  }

  function normalizeIdeRuntimeNode(node) {
    const value = String(node || '').trim();
    if (value === 'context') return 'observe';
    if (value === 'result') return 'finalize';
    return value;
  }

  function toolRequiresVerification(toolName, input = {}) {
    const name = String(toolName || '').trim();
    if (!name || AGENT_CONTROL_TOOLS.has(name)) return false;
    if (SIDE_EFFECT_TOOLS.has(name)) return true;
    if (READONLY_TOOLS.has(name)) return false;
    return true;
  }

  function recordIdeAgentSideEffect(runId, tc, result = {}, session = {}) {
    if (!runId || !tc?.name || !toolRequiresVerification(tc.name, tc.input || {})) return;
    const summary = summarizeToolInput(tc.input || {});
    writeIdeAgentLedger(runId, {
      hasSideEffects: true,
      requiresVerification: true,
      reasons: [`side_effect_tool:${tc.name}`],
      sideEffect: {
        toolName: tc.name,
        toolUseId: tc.id,
        hostId: session.hostId || tc.input?.hostId || 'local',
        summary,
        isError: result?.is_error === true,
      },
    });
    recordTraceEvent('acting', 'side_effect_recorded', {
      source: 'ide',
      runId,
      sessionId: session.sessionId,
      hostId: session.hostId || tc.input?.hostId || 'local',
      toolName: tc.name,
      toolUseId: tc.id,
      summary: `记录副作用工具调用：${tc.name}: ${summary}`,
    });
  }

  function startIdeAgentRun({ session, sessionId, runId, message, context, entry, approvalMode, tools = [], claudeCodeEnabled, legacyFlags = {}, goalProfile = null }) {
    if (!agentRuntime?.startRun) throw new Error('Agent runtime 未初始化，1Shell AI 无法启动 AgentRun');
    try {
      const source = 'ide';
      const normalizedEntry = normalizePromptEntry(entry);
      const normalizedApprovalMode = normalizeIdeApprovalMode(approvalMode || session?.approvalMode, { entry: normalizedEntry });
      const policy = createIdeAgentPolicy({ tools, entry: normalizedEntry, approvalMode: normalizedApprovalMode, remotePolicy: session?.toolPolicy, goalProfile });
      const state = agentRuntime.startRun({
        source,
        goal: String(message || '').trim(),
        context: {
          ...redactAgentTraceValue(context),
          hostId: session?.hostId || context?.hosts?.[0]?.id || 'local',
          goalProfile,
        },
        tools: tools.map((tool) => ({ name: tool.name, type: 'ide' })),
        policy,
        outputContract: {
          status: 'unverified_until_verified',
          phases: IDE_AGENT_PHASE_DEFINITIONS,
        },
        metadata: {
          entrypoint: 'ide:message',
          sessionId,
          entry: normalizedEntry,
          approvalMode: normalizedApprovalMode,
          claudeCodeEnabled: !!claudeCodeEnabled,
          legacySafeMode: legacyFlags.safeMode,
          legacyUnlimitedTurns: legacyFlags.unlimitedTurns,
          goalProfile,
          tracePurpose: 'agent_run_is_the_runtime_owner_for_all_1shell_ai_behavior',
        },
      }, { runId });
      session.agentRunId = state.runId;
      session.agentPolicy = policy;
      writeIdeAgentLedger(state.runId, { phase: 'understand' });
      recordIdeAgentPhase(state.runId, 'understand', 'AgentRun started; understanding goal and available policy.');
      return state;
    } catch (err) {
      logger?.warn?.(`[ide] failed to start AgentRun trace: ${err.message}`);
      throw err;
    }
  }

  function endIdeAgentRun(runId, { runnerStatus = 'completed', taskStatus = 'unverified', result = null, error = '' } = {}) {
    if (!runId || !agentRuntime?.endRun) return;
    try {
      if (result && agentRuntime.publishResult) agentRuntime.publishResult(runId, result);
      agentRuntime.endRun(runId, { runnerStatus, taskStatus, error });
      for (const session of sessions.values()) {
        if (session.currentRunId === runId) {
          session.currentRunId = null;
          session.abortController = null;
        }
      }
    } catch (err) {
      logger?.warn?.(`[ide] failed to end AgentRun trace: ${err.message}`);
    }
  }

  function safeGetIdeAgentState(runId) {
    if (!runId || !agentRuntime?.getState) return null;
    try { return agentRuntime.getState(runId); } catch { return null; }
  }

  function resolveIdeAgentFinalTaskStatus(runId, fallback = 'unverified') {
    try {
      const outcome = evaluateAgentRunOutcome(safeGetIdeAgentState(runId), { fallbackTaskStatus: fallback });
      const status = String(outcome?.taskStatus || fallback || 'unverified').trim();
      if (['verified', 'failed', 'blocked', 'unverified', 'partial'].includes(status)) return status;
      return 'unverified';
    } catch (err) {
      logger?.warn?.(`[ide] failed to evaluate AgentRun outcome: ${err.message}`);
      return fallback;
    }
  }

  function resolveIdeAgentOutcome(runId, fallback = 'unverified') {
    try {
      return evaluateAgentRunOutcome(safeGetIdeAgentState(runId), { fallbackTaskStatus: fallback });
    } catch (err) {
      logger?.warn?.(`[ide] failed to evaluate AgentRun outcome: ${err.message}`);
      return { taskStatus: fallback, reasons: ['outcome_evaluation_failed'] };
    }
  }

  function buildIdeFinalResult(runId, textParts = [], meta = {}) {
    const state = safeGetIdeAgentState(runId);
    const existing = state?.result && typeof state.result === 'object' ? state.result : null;
    const outcome = resolveIdeAgentOutcome(runId, 'unverified');
    const forcedTaskStatus = String(meta.forcedTaskStatus || '').trim();
    const finalStatus = ['verified', 'failed', 'blocked', 'unverified', 'partial'].includes(forcedTaskStatus)
      ? forcedTaskStatus
      : (['verified', 'failed', 'blocked', 'unverified', 'partial'].includes(String(outcome.taskStatus || '')) ? outcome.taskStatus : 'unverified');
    const aiText = textParts.length > 0 ? textParts.join('').slice(0, 1000) : '';
    const existingSummary = Array.isArray(existing?.summary) ? existing.summary : [];
    const summary = [...existingSummary, ...(aiText ? [aiText] : [])].filter(Boolean).slice(-6);
    return {
      title: existing?.title || '1Shell AI run completed',
      status: finalStatus,
      taskStatus: finalStatus,
      summary,
      report: existing?.report || aiText,
      data: {
        ...(existing?.data && typeof existing.data === 'object' ? existing.data : {}),
        outcomeReasons: Array.isArray(outcome.reasons) ? outcome.reasons : [],
        agentLedger: readIdeAgentLedger(runId),
        ...meta,
      },
    };
  }

  function recordIdeVerificationOutcome(runId, result = {}, context = {}) {
    const verification = result?.verification && typeof result.verification === 'object' ? result.verification : null;
    if (!runId || !verification || !agentRuntime) return;
    const ok = verification.ok === true;
    const rawStatus = String(verification.status || '').trim().toLowerCase();
    const taskStatus = String(verification.taskStatus || (ok ? 'verified' : (rawStatus === 'unsupported' ? 'unverified' : 'failed'))).trim();
    const finalTaskStatus = ['verified', 'failed', 'blocked', 'unverified'].includes(taskStatus) ? taskStatus : (ok ? 'verified' : 'failed');
    const safeVerification = redactAgentTraceValue(verification);
    const evidence = toolContentPreview(result.content).slice(0, 4000);
    const summary = [
      `${verification.type || 'outcome'} verification ${ok ? 'passed' : rawStatus || 'failed'}`,
      verification.target ? `target=${verification.target}` : '',
      Array.isArray(verification.reasons) && verification.reasons.length ? `reasons=${verification.reasons.join(',')}` : '',
    ].filter(Boolean).join(' | ');
    try {
      agentRuntime.recordVerification?.(runId, {
        ...safeVerification,
        ok,
        status: ok ? 'passed' : (rawStatus || 'failed'),
        taskStatus: finalTaskStatus,
        type: verification.type || 'outcome',
        target: verification.target || '',
        reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
        evidence,
        checkedAt: verification.checkedAt || new Date().toISOString(),
      });
      agentRuntime.updateArtifact?.(runId, {
        id: 'ide-verification-result',
        type: 'verification_result',
        title: `Verification - ${verification.type || 'outcome'}`,
        content: evidence,
        data: {
          ...safeVerification,
          ok,
          status: ok ? 'passed' : (rawStatus || 'failed'),
          taskStatus: finalTaskStatus,
          reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
          checkedAt: verification.checkedAt || new Date().toISOString(),
        },
      });
      agentRuntime.publishResult?.(runId, {
        title: ok ? 'Outcome verified' : (finalTaskStatus === 'unverified' ? 'Outcome unverified' : 'Outcome verification failed'),
        status: finalTaskStatus,
        taskStatus: finalTaskStatus,
        summary: [summary],
        report: evidence,
        data: { verification: safeVerification },
      });
      writeIdeAgentLedger(runId, {
        phase: 'verify',
        verification: {
          ok,
          status: ok ? 'passed' : (rawStatus || 'failed'),
          taskStatus: finalTaskStatus,
          type: verification.type || '',
          target: verification.target || '',
          reasons: Array.isArray(verification.reasons) ? verification.reasons.map(String).filter(Boolean) : [],
          checkedAt: verification.checkedAt || new Date().toISOString(),
        },
        reasons: ok ? [] : [`verification_${finalTaskStatus}`],
      });
      recordIdeAgentPhase(runId, 'verify', summary, { status: ok ? 'done' : 'failed', evidence: [summary] });
      agentRuntime.recordTraceEvent?.(runId, {
        stage: 'verify',
        eventType: ok ? 'verification_passed' : (finalTaskStatus === 'unverified' ? 'verification_unverified' : 'verification_failed'),
        summary,
        toolName: 'verify_outcome',
        toolUseId: context.toolUseId,
        sessionId: context.sessionId,
        hostId: context.hostId,
        data: { verification: safeVerification },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record verification outcome: ${err.message}`);
    }
  }

  function cancelIdeAgentRun(runId, reason = 'cancelled') {
    if (!runId || !agentRuntime?.cancelRun) return;
    try {
      const state = agentRuntime.getState?.(runId);
      if (!state || ['completed', 'failed', 'cancelled'].includes(state.runnerStatus)) return;
      agentRuntime.cancelRun(runId, { reason, taskStatus: 'blocked' });
    } catch (err) {
      logger?.warn?.(`[ide] failed to cancel AgentRun trace: ${err.message}`);
    }
  }

  function startIdeAgentToolTrace(runId, tc, session) {
    if (!runId || !tc?.name || !agentRuntime?.recordToolCallStarted) return null;
    try {
      return agentRuntime.recordToolCallStarted(runId, tc.name, redactAgentTraceValue(tc.input || {}), {
        toolUseId: tc.id,
        scope: { hostId: session?.hostId || tc.input?.hostId || 'local' },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun tool start: ${err.message}`);
      return null;
    }
  }

  function guardIdeAgentToolCall(runId, tc, session = null) {
    if (!runId || !tc?.name || !agentRuntime?.getState) return null;
    try {
      const state = agentRuntime.getState(runId);
      const verdict = canUseTool(state, tc.name);
      if (verdict.allow) {
        const profileVerdict = evaluateIdeAgentProfileToolUse(session?.agentGoalProfile || state?.spec?.policy?.goalProfile, tc.name, tc.input || {});
        if (profileVerdict.allow) return null;
        recordTraceEvent('policy', 'tool_denied', {
          source: 'ide',
          runId,
          toolName: tc.name,
          toolUseId: tc.id,
          summary: profileVerdict.reason,
          data: { kind: profileVerdict.kind },
        });
        return createBudgetExceededResult(profileVerdict.reason, profileVerdict.kind || 'profile_policy_denied');
      }
      recordTraceEvent('policy', 'tool_denied', {
        source: 'ide',
        runId,
        toolName: tc.name,
        toolUseId: tc.id,
        summary: verdict.reason,
        data: { kind: verdict.kind },
      });
      return createBudgetExceededResult(verdict.reason, verdict.kind || 'policy_denied');
    } catch (err) {
      logger?.warn?.(`[ide] failed to enforce Agent tool policy: ${err.message}`);
      return null;
    }
  }

  function endIdeAgentToolTrace(runId, toolCall, result = {}) {
    if (!runId || !toolCall || !agentRuntime?.recordToolCallEnded) return;
    try {
      agentRuntime.recordToolCallEnded(runId, toolCall.id, {
        ...result,
        content: toolContentPreview(result.content).slice(0, 4000),
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to record AgentRun tool end: ${err.message}`);
    }
  }

  function createIdeApprovalInterrupt(runId, requestId, tc, summary = {}, riskReason = '', options = {}) {
    if (!runId || !requestId || !tc?.name || !agentRuntime?.createInterrupt) return null;
    try {
      const facts = options.approvalFacts || normalizeApprovalFacts(tc, summary, riskReason, options);
      const title = facts.title || options.title || summary.title || tc.name;
      const detail = formatApprovalDetail(summary, facts.riskReason || riskReason);
      const workNote = normalizeVisibleWorkNote(options.workNote);
      return agentRuntime.createInterrupt(runId, {
        type: 'request_approval',
        reason: 'approval_required',
        message: [title, detail].filter(Boolean).join('\n\n'),
        payload: {
          requestId,
          title,
          detail,
          action: tc.name,
          toolName: tc.name,
          args: redactAgentTraceValue(tc.input || {}),
          workNote,
          riskLevel: facts.riskLevel || String(options.riskLevel || options.risk_level || ''),
          riskReason: facts.riskReason || riskReason,
          approval: facts,
        },
        scope: { hostId: tc.input?.hostId || 'local' },
        runnerStatus: 'waiting_approval',
        taskStatus: 'blocked',
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to create AgentRun approval interrupt: ${err.message}`);
      return null;
    }
  }

  function resolveIdeApprovalInterrupt(runId, interrupt, response = {}) {
    if (!runId || !interrupt?.id || !agentRuntime?.resumeRun) return;
    const action = String(response.action || '').trim();
    const approved = action === 'allow';
    const rejected = action === 'deny';
    const custom = action === 'custom';
    try {
      agentRuntime.resumeRun(runId, {
        interruptId: interrupt.id,
        runnerStatus: 'running',
        resolution: {
          status: approved ? 'approved' : (rejected ? 'rejected' : (custom ? 'answered' : 'resolved')),
          decision: action || 'unknown',
          approved,
          reason: String(response.reason || (rejected ? 'denied_by_user_or_timeout' : '')).slice(0, 500),
          note: custom ? String(response.text || '').slice(0, 1000) : '',
        },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to resolve AgentRun approval interrupt: ${err.message}`);
    }
  }

  function createIdeUserInterrupt(runId, requestId, tc) {
    if (!runId || !requestId || !tc?.name || !agentRuntime?.createInterrupt) return null;
    const input = tc.input || {};
    const isSecret = tc.name === 'request_secret';
    const question = String(input.question || input.message || input.prompt || '').trim();
    const secretName = String(input.name || input.secretName || input.secret_name || '').trim();
    const label = String(input.label || secretName || 'secret').trim();
    const reason = String(input.reason || '').trim();
    const options = Array.isArray(input.options) ? input.options.map((item) => String(item || '').trim()).filter(Boolean) : [];
    try {
      return agentRuntime.createInterrupt(runId, {
        type: isSecret ? 'request_secret' : 'ask_user',
        reason: reason || tc.name,
        message: isSecret ? `需要 Secret 引用：${label}` : (question || 'Agent 需要用户补充信息'),
        payload: isSecret
          ? {
            requestId,
            secrets: [{ name: secretName || 'secret_ref', label, required: true, target: 'secret_ref', provider: input.provider || '' }],
            storePolicy: { plaintext: false, tracePlaintext: false },
          }
          : {
            requestId,
            questions: [{ id: 'answer', prompt: question || '请补充信息', type: options.length > 0 ? 'choice' : 'text', required: true, options }],
            allowMultiple: false,
          },
        scope: { hostId: input.hostId || 'local' },
        runnerStatus: 'interrupted',
        taskStatus: 'blocked',
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to create AgentRun ${tc.name} interrupt: ${err.message}`);
      return null;
    }
  }

  function normalizeSecretRefResponse(response = {}) {
    return String(response.secretRef || response.secret_ref || response.ref || response.text || '').trim();
  }

  function validateSecretRefForAgent(response = {}, input = {}) {
    const secretRef = normalizeSecretRefResponse(response);
    if (!secretRef) {
      return { ok: false, error: '用户未提供 secret ref/id。请不要粘贴密钥明文，只提供已保存的 secret 引用。' };
    }
    if (!/^sec_[a-zA-Z0-9-]+$/.test(secretRef)) {
      return { ok: false, error: '输入不是有效的 secret ref/id。请先保存到 Secret Manager，再选择或填写 sec_ 开头的引用。' };
    }
    if (!secretService?.get) {
      return { ok: false, error: 'Secret Manager 不可用，无法校验 secret ref。' };
    }
    let secret = null;
    try {
      secret = secretService.get(secretRef);
    } catch (err) {
      logger?.warn?.(`[ide] failed to validate secret ref: ${err.message}`);
      return { ok: false, error: '校验 secret ref 失败，请重新选择已保存凭据。' };
    }
    if (!secret) {
      return { ok: false, error: 'secret ref 不存在或已删除。请从 Secret Manager 选择已保存凭据。' };
    }
    return {
      ok: true,
      secretRef: secret.id,
      secretMeta: {
        id: secret.id,
        name: secret.name || String(input.name || input.secretName || input.secret_name || 'secret_ref'),
        type: secret.type || 'generic',
      },
    };
  }

  function resolveIdeUserInterrupt(runId, interrupt, tc, response = {}) {
    if (!runId || !interrupt?.id || !agentRuntime?.resumeRun) return;
    const action = String(response.action || '').trim();
    const text = String(response.text || '').trim();
    const denied = action === 'deny';
    const isSecret = tc?.name === 'request_secret';
    const input = tc?.input || {};
    const secretRef = isSecret ? normalizeSecretRefResponse(response) : '';
    const secretMeta = response.secretMeta && typeof response.secretMeta === 'object' ? response.secretMeta : {};
    try {
      agentRuntime.resumeRun(runId, {
        interruptId: interrupt.id,
        runnerStatus: 'running',
        resolution: isSecret
          ? {
            status: denied ? 'rejected' : (secretRef ? 'provided' : 'resolved'),
            secretRefs: secretRef ? [{
              name: String(secretMeta.name || input.name || input.secretName || input.secret_name || 'secret_ref').slice(0, 120),
              ref: secretRef.slice(0, 300),
              type: String(secretMeta.type || '').slice(0, 120),
            }] : [],
            redacted: true,
            note: denied ? String(response.reason || 'denied_by_user').slice(0, 500) : '用户通过 Secret Manager 提供已校验 secret 引用；trace 不保存密钥明文。',
          }
          : {
            status: denied ? 'rejected' : 'answered',
            answers: text ? { answer: text.slice(0, 2000) } : {},
            note: String(response.reason || '').slice(0, 500),
          },
      });
    } catch (err) {
      logger?.warn?.(`[ide] failed to resolve AgentRun ${tc?.name || 'user'} interrupt: ${err.message}`);
    }
  }

  function userInterruptDetail(tc) {
    const input = tc.input || {};
    if (tc.name === 'request_secret') {
      const label = input.label || input.name || 'secret';
      return [
        `需要 Secret 引用：${label}`,
        input.provider ? `平台/用途：${input.provider}` : '',
        input.reason ? `原因：${input.reason}` : '',
        '请不要粘贴密钥明文。请先在 Secret Manager 中保存密钥，然后用“自定义回复”填入 secret ref/id。',
      ].filter(Boolean).join('\n');
    }
    const options = Array.isArray(input.options) ? input.options.map((item, index) => `${index + 1}. ${item}`).join('\n') : '';
    return [
      input.question || input.message || 'Agent 需要用户补充信息',
      input.reason ? `原因：${input.reason}` : '',
      options ? `可选项：\n${options}` : '',
      '请使用“自定义回复”输入答案；如果拒绝提供，请点击拒绝。',
    ].filter(Boolean).join('\n\n');
  }

  function waitForUserInterruptTool(socket, sessionId, tc, session, runId) {
    return new Promise((resolve, reject) => {
      const isSecret = tc.name === 'request_secret';
      const requestId = `${isSecret ? 'sec' : 'ask'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const requestEvent = isSecret ? 'ide:secret-request' : 'ide:ask-user';
      const responseEvent = isSecret ? 'ide:secret-response' : 'ide:ask-user-response';
      const interrupt = createIdeUserInterrupt(runId, requestId, tc);
      const input = tc.input || {};
      let unregisterCancel = null;
      let settled = false;

      const cleanup = () => {
        socket.off(responseEvent, handler);
        clearTimeout(timer);
        if (unregisterCancel) unregisterCancel();
      };

      const settle = (fn, value, resolution = value) => {
        if (settled) return;
        settled = true;
        resolveIdeUserInterrupt(runId, interrupt, tc, resolution || {});
        cleanup();
        fn(value);
      };

      const buildResult = (resp = {}) => {
        const action = String(resp.action || '').trim();
        const text = String(resp.text || '').trim();
        if (action === 'deny') return { content: '[用户拒绝提供所需信息]', is_error: true };
        if (isSecret) {
          const validated = validateSecretRefForAgent(resp, input);
          if (!validated.ok) {
            return { content: `[ERROR] ${validated.error}`, is_error: true, secretValidationError: validated.error };
          }
          return {
            content: `用户提供了已校验的 secret 引用：${validated.secretRef} (${validated.secretMeta.type}/${validated.secretMeta.name})`,
            is_error: false,
            secretRef: validated.secretRef,
            secretMeta: validated.secretMeta,
          };
        }
        if (!text) return { content: '[ERROR] 用户未提供答案。', is_error: true };
        return { content: `用户回答：${text.slice(0, 4000)}`, is_error: false };
      };

      const handler = (resp) => {
        if (resp.requestId !== requestId) return;
        const result = buildResult(resp);
        const resolution = isSecret
          ? (result.is_error
            ? { action: 'deny', reason: resp.reason || result.secretValidationError || 'secret_ref_rejected' }
            : { ...resp, action: 'custom', text: result.secretRef, secretRef: result.secretRef, secretMeta: result.secretMeta })
          : resp;
        settle(resolve, result, resolution);
      };
      socket.on(responseEvent, handler);

      const timer = setTimeout(() => settle(resolve, { content: '[ERROR] 等待用户输入超时', is_error: true }, { action: 'deny', reason: 'user_input_timeout' }), 5 * 60 * 1000);
      unregisterCancel = registerCancelHandler(session, () => settle(reject, makeAbortError(), { action: 'deny', reason: 'cancelled' }));

      try {
        throwIfStopped(session, runId);
        emitToSession(session, socket, requestEvent, {
          sessionId,
          runId,
          requestId,
          toolName: tc.name,
          title: isSecret ? '需要 Secret 引用' : '需要补充信息',
          detail: userInterruptDetail(tc),
          question: input.question || input.message || input.prompt || '',
          reason: input.reason || '',
          options: Array.isArray(input.options) ? input.options : [],
          secretName: input.name || input.secretName || input.secret_name || '',
          label: input.label || input.name || input.secretName || '',
          provider: input.provider || '',
          responseEvent,
        });
      } catch (err) {
        settle(reject, err, { action: 'deny', reason: err.message || 'user_input_emit_failed' });
      }
    });
  }

  function summarizeToolInput(input) {
    try { return JSON.stringify(input || {}).slice(0, 500); } catch { return ''; }
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function ensureSessionCancellation(session) {
    if (!session.cancelHandlers) session.cancelHandlers = new Set();
  }

  function registerCancelHandler(session, handler) {
    ensureSessionCancellation(session);
    session.cancelHandlers.add(handler);
    return () => session.cancelHandlers?.delete(handler);
  }

  function isRunCurrent(session, runId) {
    return session.currentRunId === runId && !session.cancelled;
  }

  function throwIfStopped(session, runId) {
    if (session.currentRunId !== runId) {
      const err = makeAbortError('Run replaced');
      err.code = 'RUN_REPLACED';
      throw err;
    }
    if (session.cancelled) throw makeAbortError();
  }

  function emitCancelledOnce(session, sessionId, socket = session?.socket, runId = session?.currentRunId) {
    if (!session || session.cancelNotified) return;
    session.cancelNotified = true;
    emitToSession(session, socket, 'ide:cancelled', { sessionId, runId });
  }

  function getApprovalSummary(tc) {
    const input = tc.input || {};
    switch (tc.name) {
      case 'execute_command':
        return {
          title: '执行命令',
          detail: `主机: ${input.hostId || 'local'}\n命令: ${input.command || ''}`,
          actionKind: 'command',
          actionText: String(input.command || ''),
          hostId: input.hostId || 'local',
        };
      case 'create_directory':
        return {
          title: '创建目录',
          detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
          actionKind: 'file_change',
          actionText: `mkdir ${input.path || ''}`,
          hostId: input.hostId || 'local',
        };
      case 'delete_path':
        return {
          title: '删除文件/目录（不可恢复）',
          detail: `主机: ${input.hostId || 'local'}\n路径: ${input.path || ''}`,
          actionKind: 'file_delete',
          actionText: `delete_path ${input.path || ''}`,
          hostId: input.hostId || 'local',
        };
      case 'rename_path':
        return {
          title: '重命名/移动',
          detail: `主机: ${input.hostId || 'local'}\n原路径: ${input.path || ''}\n新路径: ${input.newPath || ''}`,
          actionKind: 'file_change',
          actionText: `rename_path ${input.path || ''} -> ${input.newPath || ''}`,
          hostId: input.hostId || 'local',
        };
      case 'deploy_local_mcp':
        return {
          title: '部署本地 MCP',
          detail: `仓库: ${input.repoUrl || ''}\n名称: ${input.name || ''}`,
          actionKind: 'tool',
          actionText: `deploy_local_mcp ${input.name || ''}\n${input.repoUrl || ''}`,
          hostId: input.hostId || 'local',
        };
      default:
        return {
          title: tc.name,
          detail: JSON.stringify(input, null, 2).substring(0, 600),
          actionKind: 'tool',
          actionText: `${tc.name}\n${JSON.stringify(input, null, 2).substring(0, 1200)}`,
          hostId: input.hostId || 'local',
        };
    }
  }

  function cleanPolicyList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }

  function normalizeToolPolicy(policy = {}) {
    const gatewayMode = String(policy.gatewayMode || '').trim();
    return {
      allowedTools: cleanPolicyList(policy.allowedTools),
      allowedHosts: cleanPolicyList(policy.allowedHosts),
      allowedScripts: cleanPolicyList(policy.allowedScripts),
      allowedPaths: cleanPolicyList(policy.allowedPaths),
      gatewayMode: ['answer', 'plan', 'execute'].includes(gatewayMode) ? gatewayMode : 'answer',
    };
  }

  function allowsValue(value, allowed) {
    if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes('*')) return true;
    return allowed.includes(String(value || '').trim());
  }

  function normalizePolicyPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }

  function wildcardPolicyPathMatch(targetPath, rulePath) {
    const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}($|/)`).test(targetPath);
  }

  function allowsPath(value, allowedPaths) {
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 || allowedPaths.includes('*')) return true;
    const target = normalizePolicyPath(value);
    return allowedPaths.some((rule) => {
      const normalizedRule = normalizePolicyPath(rule);
      if (normalizedRule.includes('*')) return wildcardPolicyPathMatch(target, normalizedRule);
      return target === normalizedRule || target.startsWith(`${normalizedRule}/`);
    });
  }

  function deniedByPolicy(message) {
    return { content: `[ERROR] ${message}`, is_error: true };
  }

  function createIdeRuntimeDispatchOptions({ socket, sessionId, runId, session, mcpToolMap, emitLifecycle = true, recordPhase = true, recordEffects = true } = {}) {
    const approvalMode = normalizeIdeApprovalMode(session?.approvalMode, { entry: session?.entry });
    const allowInteractiveApproval = approvalMode === 'manual';
    const preApproved = approvalMode === 'full_access';
    const requestHarnessApproval = async (toolName, input, summary, riskReason, approvalContext = {}) => {
      const toolUseId = String(approvalContext?.toolUseId || approvalContext?.tool_use_id || approvalContext?.providerToolUseId || approvalContext?.provider_tool_use_id || '').trim();
      const approval = await waitForApproval(socket, sessionId, { id: toolUseId, name: toolName, input: input || {} }, session, runId, {
        summary,
        riskReason,
        workNote: readToolWorkNote(session, runId, toolUseId),
        approval: approvalContext?.approval || null,
        risk: approvalContext?.risk || null,
        needApproval: approvalContext?.needApproval === true,
        approvalRequired: approvalContext?.approvalRequired === true,
        title: summary?.title || '操作需要确认',
      });
      throwIfStopped(session, runId);
      return approval.action === 'allow';
    };

    return ({ action = {} } = {}) => ({
      toolCallId: action.id,
      providerToolUseId: action.id,
      scope: { hostId: session?.hostId || action.args?.hostId || 'local' },
      approvalMode,
      allowApproval: allowInteractiveApproval,
      preApproved,
      requestApproval: allowInteractiveApproval ? (toolName, input, summary, riskReason, approvalContext = {}) => requestHarnessApproval(
        toolName,
        input,
        summary,
        riskReason,
        { ...approvalContext, toolUseId: action.id },
      ) : undefined,
      executeTool: async ({ toolName, args, toolCall, context: toolContext }) => {
        const tc = {
          id: toolCall?.providerToolUseId || toolCall?.id || action.id || `${toolName}-${Date.now()}`,
          name: toolName,
          input: args || {},
        };
        const toolAc = new AbortController();
        const unregisterToolCancel = registerCancelHandler(session, () => toolAc.abort());
        const emitToolDelta = ({ stream = 'stdout', text = '' } = {}) => {
          if (!text || !isRunCurrent(session, runId)) return;
          emitToSession(session, socket, 'ide:tool-delta', {
            sessionId,
            runId,
            toolUseId: tc.id,
            name: tc.name,
            stream: stream === 'stderr' ? 'stderr' : 'stdout',
            text: String(text),
          });
        };
        let result = null;
        try {
          throwIfStopped(session, runId);
          if (emitLifecycle) emitToSession(session, socket, 'ide:tool-start', { sessionId, runId, toolUseId: tc.id, name: tc.name, input: tc.input, workNote: readToolWorkNote(session, runId, tc.id) });
          if (recordPhase) {
            const phaseId = tc.name === 'verify_outcome'
              ? 'verify'
              : (tc.name === 'ask_user' || tc.name === 'request_secret' ? 'context' : 'act');
            recordIdeAgentPhase(runId, phaseId, `Calling tool ${tc.name}.`);
          }

          if (tc.name === 'ask_user' || tc.name === 'request_secret') {
            result = await waitForUserInterruptTool(socket, sessionId, tc, session, runId);
            return result;
          }

          const policyResult = applyToolPolicy(tc, session);
          if (policyResult) {
            result = policyResult;
            return result;
          }

          const mcpInfo = mcpToolMap?.get?.(toolName);
          if (mcpInfo && localMcpService) {
            try {
              result = await localMcpService.callTool(mcpInfo.mcpId, mcpInfo.mcpToolName, args || {}, {
                signal: toolAc.signal,
                killOnAbort: true,
              });
            } catch (err) {
              if (isAbortError(err) || toolAc.signal.aborted) throw makeAbortError();
              result = { content: `[ERROR] ${err.message}`, is_error: true };
            }
          } else {
            result = await ideTools.handle(toolName, args || {}, {
              socket,
              sessionId,
              runId,
              safeMode: false,
              session,
              signal: toolAc.signal,
              approvalMode,
              allowApproval: allowInteractiveApproval,
              preApproved,
              requestApproval: allowInteractiveApproval ? (approvalToolName, approvalInput, approvalSummary, approvalRiskReason, approvalContext = {}) => requestHarnessApproval(
                approvalToolName,
                approvalInput,
                approvalSummary,
                approvalRiskReason,
                { ...approvalContext, toolUseId: tc.id },
              ) : undefined,
              approvalGranted: toolContext?.approvalGranted === true,
              onToolDelta: emitToolDelta,
            });
          }

          if (recordEffects) recordIdeAgentSideEffect(runId, tc, result, { ...session, sessionId });
          if (recordEffects && tc.name === 'verify_outcome') {
            recordIdeVerificationOutcome(runId, result, {
              sessionId,
              hostId: session?.hostId || tc.input?.hostId || 'local',
              toolUseId: tc.id,
            });
          }
          return result;
        } finally {
          unregisterToolCancel();
          if (emitLifecycle && isRunCurrent(session, runId)) {
            emitToSession(session, socket, 'ide:tool-end', {
              sessionId,
              runId,
              toolUseId: tc.id,
              name: tc.name,
              result: toolContentPreview(result?.content || '').substring(0, 4000),
              is_error: isIdeToolResultError(result),
            });
          }
        }
      },
    });
  }

  function appendControllerObservationsToSession(session, observations = []) {
    const items = Array.isArray(observations) ? observations : [];
    if (items.length === 0) return;
    if (!session.controllerObservationIds) session.controllerObservationIds = new Set();
    const providerToolUseIds = allToolUseIds(session.messages);
    const blocks = [];
    for (const observation of items) {
      if (!observation || typeof observation !== 'object') continue;
      const id = String(observation.id || observation.toolCallId || '').trim();
      if (id && session.controllerObservationIds.has(id)) continue;
      if (id) session.controllerObservationIds.add(id);
      const block = observationToProviderMessageBlock(observation, { providerToolUseIds });
      if (block) blocks.push(block);
    }
    if (blocks.length > 0) {
      const lastMessage = session.messages[session.messages.length - 1];
      if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
        lastMessage.content.push(...blocks);
      } else {
        session.messages.push({ role: 'user', content: blocks });
      }
    }
  }

  // Normalize a Harness dispatchTool result into an observation the streaming adapter can
  // feed back to the model as a tool_result on the next turn.
  function normalizeIdeToolObservation(toolCall = {}, result = {}) {
    const raw = result?.raw && typeof result.raw === 'object' ? result.raw : {};
    const contentText = toolContentPreview(result.content || '');
    const facts = extractToolResultFacts(result, raw, contentText);
    const exitCode = firstFiniteNumber(raw.exitCode, result.exitCode, facts.exitCode);
    const isError = result.is_error === true
      || result.isError === true
      || facts.ok === false
      || facts.isError === true
      || (typeof exitCode === 'number' && exitCode !== 0);
    const stdout = String(raw.stdout || result.stdout || facts.stdout || '');
    const stderr = String(raw.stderr || result.stderr || facts.stderr || '');
    return {
      id: toolCall.id,
      providerToolUseId: toolCall.id,
      toolName: toolCall.toolName,
      ok: !isError,
      isError,
      exitCode,
      content: contentText || facts.summary || stdout || stderr || '',
      stdout,
      stderr,
      summary: facts.summary || '',
      error: String(result.error || facts.error || (isError ? facts.summary : '') || '').slice(0, 1000),
    };
  }

  function isIdeToolResultError(result = {}) {
    const raw = result?.raw && typeof result.raw === 'object' ? result.raw : {};
    const contentText = toolContentPreview(result?.content || '');
    const facts = extractToolResultFacts(result || {}, raw, contentText);
    const exitCode = firstFiniteNumber(raw.exitCode, result?.exitCode, facts.exitCode);
    return result?.is_error === true
      || result?.isError === true
      || facts.ok === false
      || facts.isError === true
      || (typeof exitCode === 'number' && exitCode !== 0);
  }

  function observationToProviderMessageBlock(observation = {}, { providerToolUseIds = new Set() } = {}) {
    if (isRuntimeOnlyObservation(observation)) {
      const runtimeText = runtimeObservationTextForProvider(observation);
      return runtimeText ? { type: 'text', text: runtimeText } : null;
    }
    const content = compactToolResultForModel(
      observation.toolName || observation.kind || 'observation',
      formatObservationContentForProvider(observation),
    );
    const toolUseId = providerToolUseIdForObservation(observation, providerToolUseIds);
    if (toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(observation.isError === true || observation.ok === false ? { is_error: true } : {}),
      };
    }
    return {
      type: 'text',
      text: toolContentPreview(content) || String(observation.content || observation.error || ''),
    };
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return undefined;
  }

  function extractToolResultFacts(result = {}, raw = {}, contentText = '') {
    const facts = {};
    mergeToolFactSource(facts, result);
    mergeToolFactSource(facts, raw);
    const parsed = parseToolResultJson(contentText);
    if (parsed) {
      mergeToolFactSource(facts, parsed);
      if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
        mergeToolFactSource(facts, parsed.data);
      }
    }
    if (facts.exitCode === undefined) {
      const match = String(contentText || '').match(/(?:\[exitCode\]|exitCode|exit_code)\s*[:=\]]?\s*(-?\d+)/i);
      if (match) facts.exitCode = Number(match[1]);
    }
    if (facts.ok === undefined && /"ok"\s*:\s*false/i.test(String(contentText || ''))) facts.ok = false;
    if (facts.ok === undefined && /"ok"\s*:\s*true/i.test(String(contentText || ''))) facts.ok = true;
    if (facts.isError === undefined && /^\s*\[ERROR\]/i.test(String(contentText || ''))) facts.isError = true;
    if (!facts.error && facts.isError) facts.error = facts.summary || String(contentText || '').slice(0, 1000);
    return facts;
  }

  function mergeToolFactSource(target, source = {}) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    if (typeof source.ok === 'boolean') target.ok = source.ok;
    if (typeof source.isError === 'boolean') target.isError = source.isError;
    if (typeof source.is_error === 'boolean') target.isError = source.is_error;
    const exitCode = firstFiniteNumber(source.exitCode, source.exit_code);
    if (exitCode !== undefined) target.exitCode = exitCode;
    if (!target.summary && source.summary !== undefined) target.summary = String(source.summary || '');
    if (!target.error && source.error !== undefined) target.error = String(source.error || '');
    if (!target.stdout && source.stdout !== undefined) target.stdout = String(source.stdout || '');
    if (!target.stderr && source.stderr !== undefined) target.stderr = String(source.stderr || '');
  }

  function parseToolResultJson(contentText = '') {
    const text = String(contentText || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function formatObservationContentForProvider(observation = {}) {
    const body = toolContentPreview(
      observation.content
      || observation.stdout
      || observation.stdoutExcerpt
      || observation.stderr
      || observation.stderrExcerpt
      || observation.error
      || '',
    ).trim();
    const lines = [
      observation.toolName ? `tool=${observation.toolName}` : '',
      observation.ok === true ? 'ok=true' : (observation.ok === false || observation.isError === true ? 'ok=false' : ''),
      observation.isError === true ? 'is_error=true' : '',
      Number.isFinite(Number(observation.exitCode)) ? `exitCode=${Number(observation.exitCode)}` : '',
      observation.error ? `error=${String(observation.error).slice(0, 1000)}` : '',
      observation.summary ? `summary=${String(observation.summary).slice(0, 1000)}` : '',
    ].filter(Boolean);
    if (lines.length === 0) return body;
    return [lines.join('\n'), body].filter(Boolean).join('\n\n');
  }

  function runtimeObservationTextForProvider(observation = {}) {
    const kind = String(observation.kind || observation.type || '').trim();
    const toolName = String(observation.toolName || observation.tool_name || '').trim();
    if (kind !== 'interrupt_resolution' && toolName !== 'agent_interrupt') {
      return toolContentPreview(observation.content || observation.summary || observation.error || '').trim();
    }
    const data = observation.data && typeof observation.data === 'object' && !Array.isArray(observation.data) ? observation.data : {};
    const resolution = data.resolution && typeof data.resolution === 'object' && !Array.isArray(data.resolution) ? data.resolution : {};
    const lines = ['User input received for the interrupted run.'];
    const status = String(data.status || resolution.status || '').trim();
    if (status) lines.push(`status=${status}`);
    const reason = String(resolution.reason || observation.error || '').trim();
    if (reason) lines.push(`reason=${reason.slice(0, 1000)}`);
    const note = String(resolution.note || '').trim();
    if (note) lines.push(`note=${note.slice(0, 1000)}`);
    if (resolution.answers && typeof resolution.answers === 'object' && !Array.isArray(resolution.answers)) {
      try {
        lines.push(`answers=${JSON.stringify(redactAgentTraceValue(resolution.answers)).slice(0, 2000)}`);
      } catch { /* ignore malformed answers */ }
    }
    return lines.filter(Boolean).join('\n');
  }

  function providerToolUseIdForObservation(observation = {}, providerToolUseIds = new Set()) {
    if (isRuntimeOnlyObservation(observation)) return '';
    const candidates = [
      observation.providerToolUseId,
      observation.provider_tool_use_id,
      observation.toolCallId,
      observation.tool_call_id,
      observation.tool_use_id,
      observation.id,
    ].map((item) => String(item || '').trim()).filter(Boolean);
    return candidates.find((id) => providerToolUseIds.has(id)) || '';
  }

  function isRuntimeOnlyObservation(observation = {}) {
    const kind = String(observation.kind || observation.type || '').trim();
    const toolName = String(observation.toolName || observation.tool_name || '').trim();
    return kind.startsWith('runtime_')
      || ['recover', 'verify', 'interrupt_resolution'].includes(kind)
      || ['agent_controller', 'agent_interrupt'].includes(toolName);
  }

  function createIdeStreamingModelAdapter({ socket, sessionId, runId, session, model, proxyUrl, agentTools, context }) {
    let providerTransientRetryCount = 0;
    return async function ideStreamingModelAdapter(request = {}) {
      appendControllerObservationsToSession(session, request.observations || []);
      throwIfStopped(session, runId);
      if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:thinking', { sessionId, runId });

      let data = null;
      try {
        sanitizeProviderMessageHistory(session.messages);
        repairDanglingToolUseMessages(session.messages);
        const compactedMessages = compactMessages(session.messages);
        const baseSystem = composeSystemPrompt(session.system, session.activeSkillContext);
        const apiBody = JSON.stringify({
          model,
          max_tokens: 8192,
          stream: true,
          system: baseSystem,
          messages: compactedMessages,
          tools: agentTools,
        });

        for (let attempt = 0; attempt <= MAX_PROVIDER_TRANSIENT_RETRIES; attempt++) {
          const ac = new AbortController();
          session.abortController = ac;
          const overallTimeout = setTimeout(() => {
            try { ac.abort(); } catch { /* ignore */ }
          }, 240000);
          try {
            logger?.info?.(`[ide] controller round ${request.turn || '?'} attempt ${attempt} fetching provider (timeout=240s)`);
            const fetchStartedAt = Date.now();
            recordTraceEvent('provider', 'provider_request_started', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `controller turn=${request.turn || '?'} attempt=${attempt}`,
              data: { turn: request.turn || null, attempt, timeoutMs: 240000 },
            });
            const resp = await fetch(proxyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: apiBody,
              signal: ac.signal,
            });

            if (!resp.ok) {
              clearTimeout(overallTimeout);
              session.abortController = null;
              const errText = await resp.text().catch(() => '');
              recordTraceEvent('provider', 'provider_http_error', {
                source: 'ide',
                runId,
                sessionId,
                hostId: session.hostId,
                toolName: 'model_provider',
                summary: `provider returned HTTP ${resp.status}`,
                data: { turn: request.turn || null, attempt, status: resp.status, bodyPreview: errText.substring(0, 500) },
              });
              throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
            }

            recordTraceEvent('provider', 'provider_headers_received', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `controller turn=${request.turn || '?'} headers received`,
              data: { turn: request.turn || null, attempt, elapsedMs: Date.now() - fetchStartedAt },
            });
            data = await streamAnthropicSSE(resp.body, ac, session, socket, sessionId, runId);
            clearTimeout(overallTimeout);
            session.abortController = null;
            logger?.info?.(`[ide] controller round ${request.turn || '?'} stream done (${Date.now() - fetchStartedAt}ms total), tools=${data.content.filter(b=>b.type==='tool_use').map(b=>b.name).join(',')||'(none)'}, stop_reason=${data.stop_reason}`);
            recordTraceEvent('provider', 'provider_stream_completed', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `controller turn=${request.turn || '?'} completed`,
              data: {
                turn: request.turn || null,
                attempt,
                elapsedMs: Date.now() - fetchStartedAt,
                stopReason: data.stop_reason || '',
                toolNames: data.content.filter(b => b.type === 'tool_use').map(b => b.name),
              },
            });
            break;
          } catch (retryErr) {
            clearTimeout(overallTimeout);
            session.abortController = null;
            const wasTimeout = retryErr.name === 'AbortError' && !session.cancelled;
            recordTraceEvent('provider', retryErr.name === 'AbortError' ? 'provider_request_aborted' : 'provider_attempt_failed', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: retryErr.message || retryErr.name || 'provider attempt failed',
              data: {
                turn: request.turn || null,
                attempt,
                timeout: wasTimeout,
                cancelled: !!session.cancelled,
                errorName: retryErr.name || '',
                retryable: wasTimeout || isTransientProviderError(retryErr),
              },
            });
            if (retryErr.name === 'AbortError' && session.cancelled) throw retryErr;
            const isRetryable = wasTimeout || isTransientProviderError(retryErr);
            if (!isRetryable || attempt >= MAX_PROVIDER_TRANSIENT_RETRIES) throw retryErr;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      } catch (err) {
        session.abortController = null;
        if (isAbortError(err)) throw err;
        if (isTransientProviderError(err) && providerTransientRetryCount < 1) {
          providerTransientRetryCount += 1;
          if (isRunCurrent(session, runId)) {
            emitToSession(session, socket, 'ide:thinking', { sessionId, runId });
          }
          return ideStreamingModelAdapter(request);
        }
        throw err;
      }

      if (data?.type === 'error') throw new Error(data.error?.message || 'API error');
      throwIfStopped(session, runId);

      const textParts = data.content.filter(b => b.type === 'text').map(b => b.text);
      const toolCalls = data.content.filter(b => b.type === 'tool_use');
      for (const tc of toolCalls) {
        tc.input = normalizeIdeAgentToolInput(session.agentGoalProfile, tc.name, tc.input || {});
      }
      rememberToolWorkNotes(session, runId, data.content);
      const fullText = textParts.join('');
      if (fullText.trim().length > 0) {
        if (!data._emittedTextDelta) emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: fullText });
        emitToSession(session, socket, 'ide:text', { sessionId, runId, text: fullText });
        recordTraceEvent('reasoning', toolCalls.length > 0 ? 'tool_decision' : 'reasoning_summary', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: toolCalls.length > 0 ? 'ai_tool_decision' : 'ai_response',
          summary: fullText,
        });
      }
      if (hasProviderAssistantContent(data.content)) {
        session.messages.push({ role: 'assistant', content: data.content });
      }
      return {
        text: fullText,
        toolCalls: toolCalls.map((tc) => {
          const executionInput = cloneToolInputForExecution(tc.input || {});
          return {
            id: tc.id,
            toolName: tc.name,
            args: executionInput,
            input: cloneToolInputForExecution(tc.input || {}),
            traceInput: redactAgentTraceValue(tc.input || {}),
            workNote: readToolWorkNote(session, runId, tc.id),
          };
        }),
        final: toolCalls.length === 0 || data.stop_reason === 'end_turn',
        finishReason: data.stop_reason || '',
      };
    };
  }

  function hasProviderAssistantContent(content = []) {
    return Array.isArray(content) && content.some((block) => {
      if (block?.type === 'tool_use') return true;
      if (block?.type === 'text') return String(block.text || '').trim().length > 0;
      return false;
    });
  }

  function isEmptyModelResult(result = {}) {
    const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    if (toolCalls.length > 0) return false;
    return ![result?.text, result?.report, result?.content].some((value) => String(value || '').trim().length > 0);
  }

  function createEmptyModelResponseObservation({ entry, attempt }) {
    const inTaskMode = normalizePromptEntry(entry) === 'task';
    const guidance = inTaskMode
      ? 'You are still in /task authoring mode. Continue by asking for missing required inputs, running the next real/sandbox practice tool, or explaining the blocker in visible assistant text. Do not call create_ai_task/update_ai_task until successful practice and verify_outcome evidence exist.'
      : 'Continue by producing visible assistant text, calling the next appropriate tool, asking a required user question, or explaining the blocker.';
    const content = [
      'RUNTIME_EMPTY_MODEL_RESPONSE',
      `attempt=${attempt}`,
      'The previous provider response contained no assistant text and no tool calls, so 1Shell did not treat it as completion.',
      guidance,
    ].join('\n');
    return {
      id: `runtime-empty-model-response-${Date.now()}-${attempt}`,
      kind: 'runtime_empty_model_response',
      toolName: 'agent_controller',
      content,
      summary: content,
      ok: false,
      isError: true,
    };
  }

  function shouldContinueTaskAuthoringPackaging({ session, runId }) {
    if (normalizePromptEntry(session?.entry) !== 'task') return false;
    const state = safeGetIdeAgentState(runId);
    if (!state) return false;
    if (hasSavedAiTaskInRun(state)) return false;
    if (!latestSuccessfulTaskAuthoringVerification(state)) return false;
    return successfulTaskAuthoringPracticeCalls(state).length > 0;
  }

  function hasSavedAiTaskInRun(state = {}) {
    return (Array.isArray(state.toolCalls) ? state.toolCalls : []).some((call) => {
      const name = String(call?.toolName || '').trim();
      if (!TASK_AUTHORING_SAVE_TOOL_NAMES.has(name)) return false;
      if (String(call.status || '') !== 'completed') return false;
      return !call.result || call.result.ok === true;
    });
  }

  function successfulTaskAuthoringPracticeCalls(state = {}) {
    return (Array.isArray(state.toolCalls) ? state.toolCalls : []).filter((call) => {
      const name = String(call?.toolName || '').trim();
      if (!name || TASK_AUTHORING_NON_PRACTICE_TOOL_NAMES.has(name)) return false;
      if (String(call.status || '') !== 'completed') return false;
      return !call.result || call.result.ok === true;
    });
  }

  function latestSuccessfulTaskAuthoringVerification(state = {}) {
    const candidates = [];
    if (state.verification) candidates.push(state.verification);
    if (state.memory?.verification) candidates.push(state.memory.verification);
    if (state.runtimeState?.worldState?.verification) candidates.push(state.runtimeState.worldState.verification);
    const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
    for (const artifact of artifacts) {
      if (artifact?.type === 'verification_result' && artifact.data) {
        candidates.push({ ...artifact.data, evidence: artifact.content || artifact.data.evidence || '' });
      }
    }
    return candidates
      .reverse()
      .find((item) => {
        const ok = item?.ok === true || String(item?.status || '').toLowerCase() === 'passed';
        if (!ok) return false;
        if (String(item?.type || '').toLowerCase() === 'manual') return false;
        return !looksLikeTaskPersistenceVerification(item);
      }) || null;
  }

  function looksLikeTaskPersistenceVerification(verification = {}) {
    const text = [
      verification.type,
      verification.target,
      verification.reason,
      verification.evidence,
      Array.isArray(verification.reasons) ? verification.reasons.join(' ') : '',
    ].map((item) => String(item || '').toLowerCase()).join('\n');
    return /(get_ai_task|create_ai_task|update_ai_task|ai_task|ai task|sqlite|database|db persistence|saved task|task id)/i.test(text);
  }

  function createTaskPackagingRequiredObservation({ attempt }) {
    const content = [
      'RUNTIME_TASK_PACKAGING_REQUIRED',
      `attempt=${attempt}`,
      'The /task practice path has successful tool execution and successful verify_outcome evidence, but no AI task has been saved yet.',
      'Continue now by extracting only the successful practiced path, calling preview_ai_task, then calling create_ai_task or update_ai_task.',
      'Do not finish with a report only. If task payload validation fails, fix the payload and call the save tool again.',
    ].join('\n');
    return {
      id: `runtime-task-packaging-required-${Date.now()}-${attempt}`,
      kind: 'runtime_task_packaging_required',
      toolName: 'agent_controller',
      content,
      summary: content,
      ok: false,
      isError: true,
    };
  }

  function taskAuthoringConnectionFailureText(observation = {}) {
    const text = [
      observation.error,
      observation.summary,
      observation.content,
      observation.stderr,
      observation.stdout,
    ].map((item) => String(item || '')).join('\n');
    return /(ssh\s+.*(handshake|timed out|timeout|connection)|timed out while waiting for handshake|shell connection closed|connection closed|连接失败|握手超时|连接断开|超时)/i.test(text)
      ? text
      : '';
  }

  function shouldBlockTaskAuthoringForConnectionFailures({ session, runId, observations, streak }) {
    if (normalizePromptEntry(session?.entry) !== 'task') return { blocked: false, streak };
    const failures = (Array.isArray(observations) ? observations : [])
      .filter((observation) => observation?.isError === true || observation?.ok === false)
      .map(taskAuthoringConnectionFailureText)
      .filter(Boolean);
    const nextStreak = failures.length > 0 ? streak + failures.length : 0;
    if (nextStreak < TASK_AUTHORING_CONNECTION_FAILURE_LIMIT) return { blocked: false, streak: nextStreak };
    const state = safeGetIdeAgentState(runId);
    if (latestSuccessfulTaskAuthoringVerification(state || {})) return { blocked: false, streak: nextStreak };
    return {
      blocked: true,
      streak: nextStreak,
      reason: failures[failures.length - 1] || 'remote connection failed repeatedly',
    };
  }

  function taskAuthoringConnectionBlockedMessage({ reason, streak }) {
    return [
      '这次 /task 实践已停止，原因是目标主机连续出现 SSH 握手超时或 shell 连接关闭。',
      '',
      `连续连接失败次数：${streak}`,
      `最后一次失败：${String(reason || '').split(/\r?\n/).find(Boolean) || 'remote connection failed repeatedly'}`,
      '',
      '没有完成成功实践，也没有 verify_outcome 成功证据，所以不会保存 AI 任务。',
      '请先恢复目标主机，或换成资源更充足/已准备构建缓存的测试环境后再重新创作这个任务。',
    ].join('\n');
  }

  function filteredHostsForPolicy(policy) {
    const hosts = hostService?.listHosts?.() || [];
    const allowedHosts = policy.allowedHosts || [];
    const visible = hosts.filter((host) => allowsValue(host.id, allowedHosts));
    const lines = visible.map(h => `id=${h.id}  name=${h.name}  ${h.host || '127.0.0.1'}:${h.port || '-'}  type=${h.type || 'ssh'}`);
    return { content: lines.length > 0 ? lines.join('\n') : '（无允许访问的主机）', is_error: false };
  }

  function applyToolPolicy(tc, session) {
    const policy = session?.toolPolicy;
    if (!policy) return null;
    const input = tc.input || {};
    const requiredDirectToolByInternalTool = {
      execute_command: 'host_exec',
      list_hosts: 'list_hosts',
      list_remote_dir: 'list_remote_dir',
      read_remote_file: 'read_remote_file',
      write_remote_file: 'write_remote_file',
      create_directory: 'create_directory',
      delete_path: 'delete_path',
      rename_path: 'rename_path',
      upload_file: 'upload_file',
      download_file: 'download_file',
    };
    const directTool = requiredDirectToolByInternalTool[tc.name];
    if (directTool && policy.allowedTools.length > 0 && !policy.allowedTools.includes('*') && !policy.allowedTools.includes(directTool)) {
      return deniedByPolicy(`Remote MCP Token 不允许 1Shell AI 使用能力: ${directTool}`);
    }
    const writeTools = new Set([
      'execute_command',
      'run_script', 'write_remote_file', 'create_directory', 'delete_path', 'rename_path',
      'upload_file', 'download_file', 'add_mcp_server',
      'remove_mcp_server', 'deploy_local_mcp', 'ack_probe_alert', 'install_probe_agent',
      'restart_probe_agent', 'uninstall_probe_agent', 'invoke_claude_code',
    ]);
    if ((policy.gatewayMode === 'answer' || policy.gatewayMode === 'plan') && writeTools.has(tc.name)) {
      return deniedByPolicy(`mode=${policy.gatewayMode} 不允许执行变更型工具: ${tc.name}`);
    }
    if (tc.name === 'list_hosts' && policy.allowedHosts.length > 0 && !policy.allowedHosts.includes('*')) {
      return filteredHostsForPolicy(policy);
    }
    const hostFieldsByTool = {
      execute_command: ['hostId'],
      run_script: ['hostId'],
      list_remote_dir: ['hostId'],
      read_remote_file: ['hostId'],
      write_remote_file: ['hostId'],
      create_directory: ['hostId'],
      delete_path: ['hostId'],
      rename_path: ['hostId'],
      upload_file: ['hostId'],
      download_file: ['hostId'],
      get_probe: ['hostId'],
      get_probe_samples: ['hostId'],
      get_probe_timeseries: ['hostId'],
      get_probe_traffic: ['hostId'],
      install_probe_agent: ['hostId'],
      restart_probe_agent: ['hostId'],
      uninstall_probe_agent: ['hostId'],
      probe_diag_ping: ['hostId'],
      probe_diag_http: ['hostId'],
      probe_diag_dns: ['hostId'],
    };
    for (const field of hostFieldsByTool[tc.name] || []) {
      const value = String(input[field] || '').trim();
      if (!value) continue;
      if (value === 'all' && policy.allowedHosts.length > 0 && !policy.allowedHosts.includes('*')) {
        return deniedByPolicy('Remote MCP Token 不允许访问全部主机');
      }
      if (!allowsValue(value, policy.allowedHosts)) return deniedByPolicy(`Remote MCP Token 不允许访问主机: ${value}`);
    }
    if (tc.name === 'run_script') {
      const scriptId = String(input.scriptId || '').trim();
      if (scriptId && !allowsValue(scriptId, policy.allowedScripts)) return deniedByPolicy(`Remote MCP Token 不允许运行脚本: ${scriptId}`);
    }
    const pathFieldsByTool = {
      list_remote_dir: ['path'],
      read_remote_file: ['path'],
      write_remote_file: ['path'],
      create_directory: ['path'],
      delete_path: ['path'],
      rename_path: ['path', 'newPath'],
      upload_file: ['dirPath', 'localPath'],
      download_file: ['path', 'localPath'],
    };
    for (const field of pathFieldsByTool[tc.name] || []) {
      const value = String(input[field] || '').trim();
      if (value && !allowsPath(value, policy.allowedPaths)) return deniedByPolicy(`Remote MCP Token 不允许访问路径: ${value}`);
    }
    return null;
  }

  function buildIdeToolCatalog(session) {
    const seenToolNames = new Set();
    const allTools = [];
    const mcpToolMap = new Map();
    for (const t of ideTools.TOOL_SCHEMAS) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      allTools.push(t);
    }
    if (session?.entry === 'task' && Array.isArray(ideTools.TASK_AUTHORING_TOOL_SCHEMAS)) {
      for (const t of ideTools.TASK_AUTHORING_TOOL_SCHEMAS) {
        if (seenToolNames.has(t.name)) continue;
        seenToolNames.add(t.name);
        allTools.push(t);
      }
    }
    if (session?.claudeCodeEnabled && ideTools.CLAUDE_CODE_TOOL) {
      const t = ideTools.CLAUDE_CODE_TOOL;
      if (!seenToolNames.has(t.name)) {
        seenToolNames.add(t.name);
        allTools.push(t);
      }
    }
    if (localMcpService) {
      const ideMcpIds = mcpRegistry
        ? mcpRegistry.listServers().filter((s) => s.enabled && s.exposeToIde).map((s) => s.id)
        : undefined;
      for (const t of localMcpService.getAllActiveTools({ allowedIds: ideMcpIds })) {
        if (seenToolNames.has(t.name)) continue;
        seenToolNames.add(t.name);
        mcpToolMap.set(t.name, { mcpId: t._mcpId, mcpToolName: t._mcpToolName });
        const { _mcpId, _mcpToolName, ...clean } = t;
        allTools.push(clean);
      }
    }
    return { allTools, mcpToolMap };
  }

  function validateTaskAuthoringToolCatalog(session, allTools = [], agentTools = [], agentPolicy = {}) {
    if (normalizePromptEntry(session?.entry) !== 'task') return '';
    const allNames = new Set((Array.isArray(allTools) ? allTools : []).map((tool) => String(tool?.name || '').trim()).filter(Boolean));
    const exposedNames = new Set((Array.isArray(agentTools) ? agentTools : []).map((tool) => String(tool?.name || '').trim()).filter(Boolean));
    const missingFromCatalog = REQUIRED_TASK_AUTHORING_TOOL_NAMES.filter((name) => !allNames.has(name));
    if (missingFromCatalog.length > 0) {
      return `Internal /task tool catalog error: missing task authoring tool(s): ${missingFromCatalog.join(', ')}.`;
    }
    const missingFromModel = REQUIRED_TASK_AUTHORING_TOOL_NAMES.filter((name) => !exposedNames.has(name));
    if (missingFromModel.length > 0) {
      const allowed = Array.isArray(agentPolicy.allowedTools) ? agentPolicy.allowedTools : [];
      return `Internal /task permission error: task authoring tool(s) were built but not exposed to the model: ${missingFromModel.join(', ')}. allowedTools=${allowed.join(',')}`;
    }
    return '';
  }

  function waitForApproval(socket, sessionId, tc, session, runId, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `apr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const baseSummary = getApprovalSummary(tc);
      const summary = options.summary || baseSummary;
      const riskReason = String(options.riskReason || '').trim();
      const workNote = normalizeVisibleWorkNote(options.workNote || readToolWorkNote(session, runId, tc.id));
      const approvalFacts = normalizeApprovalFacts(tc, summary, riskReason, options);
      const approvalInterrupt = createIdeApprovalInterrupt(runId, requestId, tc, summary, riskReason, { ...options, workNote, approvalFacts });
      let unregisterCancel = null;
      let settled = false;

      const cleanup = () => {
        socket.off('ide:approve-response', handler);
        clearTimeout(timer);
        if (unregisterCancel) unregisterCancel();
      };

      const settle = (fn, value, resolution = value) => {
        if (settled) return;
        settled = true;
        resolveIdeApprovalInterrupt(runId, approvalInterrupt, resolution || {});
        cleanup();
        fn(value);
      };

      const handler = (resp) => {
        if (resp.requestId !== requestId) return;
        settle(resolve, resp);
      };
      socket.on('ide:approve-response', handler);

      const timer = setTimeout(() => settle(resolve, { action: 'deny', reason: 'approval_timeout' }), 5 * 60 * 1000);
      unregisterCancel = registerCancelHandler(session, () => settle(reject, makeAbortError(), { action: 'deny', reason: 'cancelled' }));

      try {
        throwIfStopped(session, runId);
        emitToSession(session, socket, 'ide:approve-request', {
          sessionId,
          runId,
          requestId,
          toolUseId: tc.id || '',
          toolName: tc.name,
          title: approvalFacts.title || options.title || summary.title,
          detail: formatApprovalDetail(summary, approvalFacts.riskReason || riskReason),
          workNote,
          reason: approvalFacts.reason,
          riskReason: approvalFacts.riskReason,
          riskLevel: approvalFacts.riskLevel,
          hostId: approvalFacts.hostId,
          actionKind: approvalFacts.actionKind,
          actionText: approvalFacts.actionText,
          input: approvalFacts.input,
          approval: approvalFacts,
        });
      } catch (err) {
        settle(reject, err, { action: 'deny', reason: err.message || 'approval_emit_failed' });
      }
    });
  }

  function formatApprovalDetail(summary = {}, riskReason = '') {
    const detail = String(summary?.detail || '').trim();
    const reason = String(riskReason || '').trim();
    if (!reason) return detail;
    const readableReason = reason.startsWith('需要确认：') ? reason : `需要确认：${reason}`;
    if (!detail) return readableReason;
    if (detail.includes(reason) || detail.includes(readableReason)) return detail;
    return [readableReason, detail].filter(Boolean).join('\n\n');
  }

  function normalizeApprovalFacts(tc, summary = {}, riskReason = '', options = {}) {
    const input = tc.input || {};
    const provided = options.approval && typeof options.approval === 'object' ? options.approval : {};
    const risk = provided.risk && typeof provided.risk === 'object' ? provided.risk : (options.risk && typeof options.risk === 'object' ? options.risk : null);
    const title = String(options.title || provided.title || summary.title || tc.name || '操作需要确认').trim();
    const detail = String(provided.detail || summary.detail || '').trim();
    const normalizedRiskReason = String(provided.riskReason || riskReason || '').trim();
    const actionText = String(provided.actionText || summary.actionText || detail || '').trim();
    const riskLevel = String(provided.riskLevel || options.riskLevel || options.risk_level || risk?.level || '').trim();
    const hostId = String(provided.hostId || summary.hostId || input.hostId || 'local').trim() || 'local';
    const reason = String(
      provided.reason
      || (normalizedRiskReason ? `harness 判断需要人工确认：${normalizedRiskReason}` : '此操作需要你确认后才会继续。')
    ).trim();
    const required = provided.required === true || options.approvalRequired === true;
    return {
      schemaVersion: 1,
      source: String(provided.source || 'ide'),
      toolName: tc.name,
      title,
      reason,
      riskReason: normalizedRiskReason,
      riskLevel,
      required,
      recommended: provided.recommended === true || (options.needApproval === true && !required),
      actionKind: String(provided.actionKind || summary.actionKind || 'tool'),
      actionText,
      detail,
      hostId,
      input: redactAgentTraceValue(input || {}),
      summary: {
        title,
        detail,
      },
      risk: risk ? redactAgentTraceValue(risk) : null,
    };
  }

  function applyPromptEntry(session, entry, approvalMode = null) {
    const nextEntry = normalizePromptEntry(entry);
    const nextApprovalMode = normalizeIdeApprovalMode(approvalMode || session.approvalMode, { entry: nextEntry });
    if (session.entry !== nextEntry) {
      session.entry = nextEntry;
      session.system = promptForEntry(nextEntry);
      session.activeSkillContext = null;
    }
    session.approvalMode = nextApprovalMode;
  }

  function getOrCreateSession(sessionId, context, entry, approvalMode = null) {
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      applyPromptEntry(session, entry, approvalMode);
      if (context?.toolPolicy) session.toolPolicy = normalizeToolPolicy(context.toolPolicy);
      return session;
    }

    let contextBlock = '';
    if (context) {
      const parts = [];
      if (context.hosts?.length > 0) {
        parts.push('**目标主机**：');
        for (const h of context.hosts) {
          const osText = h.platform || h.os || '';
          const osSuffix = osText ? ` · OS: ${osText}` : '';
          parts.push(`  - \`${h.id}\` · ${h.name || h.id} (${h.username || 'root'}@${h.host || '127.0.0.1'}:${h.port || 22})${osSuffix}`);
        }
      }
      if (context.files?.length > 0) {
        parts.push('**相关文件**：');
        for (const f of context.files) parts.push(`  - hostId=\`${f.hostId}\` path=\`${f.path}\``);
      }
      if (context.containers?.length > 0) {
        parts.push('**相关容器**：');
        for (const c of context.containers) parts.push(`  - hostId=\`${c.hostId}\` name=\`${c.name || c.id}\`${c.image ? ` image=${c.image}` : ''}`);
      }
      if (context.mcpServers?.length > 0) {
        parts.push('**MCP Server**：');
        for (const s of context.mcpServers) parts.push(`  - \`${s.name}\` → ${s.url}`);
      }
      if (parts.length > 0) contextBlock = parts.join('\n') + '\n\n';
    }

    const promptEntry = normalizePromptEntry(entry);
    const promptApprovalMode = normalizeIdeApprovalMode(approvalMode, { entry: promptEntry });
    const session = {
      messages: [],
      entry: promptEntry,
      approvalMode: promptApprovalMode,
      system: promptForEntry(promptEntry),
      contextBlock,
      hostId: context?.hosts?.[0]?.id || 'local',
      abortController: null,
      activeChildProcess: null,
      cancelHandlers: new Set(),
      cancelNotified: false,
      cancelled: false,
      currentRunId: null,
      socket: null,
      socketId: null,
      detachedAt: null,
      detachReason: '',
      legacySafeMode: null,
      legacyUnlimitedTurns: null,
      claudeCodeEnabled: false,
      toolPolicy: context?.toolPolicy ? normalizeToolPolicy(context.toolPolicy) : null,
      agentPolicy: null,
      agentGoalProfile: null,
      activeSkillContext: null,
      finalizationRepairRounds: 0,
    };
    sessions.set(sessionId, session);
    return session;
  }

  async function handleMessage({ socket, sessionId, message, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry, approvalMode }) {
    if (!agentRuntime?.startRun || !agentRuntime?.getState) {
      emitToSession(null, socket, 'ide:error', { sessionId, error: 'Agent runtime 未初始化，1Shell AI 已停止旧聊天降级路径。' });
      return;
    }

    const effectiveEntry = normalizePromptEntry(entry, context, message);
    const contextApprovalMode = context && typeof context === 'object' && !Array.isArray(context) ? (context.approvalMode || context.approval_mode) : null;
    const effectiveApprovalMode = normalizeIdeApprovalMode(approvalMode || contextApprovalMode, { entry: effectiveEntry });
    const session = getOrCreateSession(sessionId, context, effectiveEntry, effectiveApprovalMode);
    ensureSessionCancellation(session);
    const runId = newRunId();
    session.currentRunId = runId;
    session.cancelled = false;
    session.cancelNotified = false;
    session.socket = socket;
    session.socketId = socket.id;
    session.detachedAt = null;
    session.detachReason = '';

    const ignoredLegacyFlags = {
      safeMode: safeMode === undefined ? undefined : safeMode !== false,
      unlimitedTurns: unlimitedTurns === undefined ? undefined : !!unlimitedTurns,
    };
    if (claudeCodeEnabled !== undefined) {
      session.claudeCodeEnabled = !!claudeCodeEnabled;
    }

    const agentGoalProfile = createIdeAgentGoalProfile({ message, context, entry: session.entry });
    session.agentGoalProfile = agentGoalProfile;
    session.finalizationRepairRounds = 0;
    const activeSkillContext = resolveSessionSkillContext({ message, context, entry: session.entry });
    session.activeSkillContext = activeSkillContext;
    const runContext = {
      ...(context && typeof context === 'object' && !Array.isArray(context) ? context : {}),
      activeSkills: activeSkillContext.skills,
    };

    const { allTools, mcpToolMap } = buildIdeToolCatalog(session);
    const agentState = startIdeAgentRun({
      session,
      sessionId,
      runId,
      message,
      context: runContext,
      entry: session.entry,
      approvalMode: session.approvalMode,
      tools: allTools,
      claudeCodeEnabled: session.claudeCodeEnabled,
      goalProfile: agentGoalProfile,
      legacyFlags: ignoredLegacyFlags,
    });
    recordActiveSkills(runId, sessionId, session, activeSkillContext);
    const agentPolicy = agentState?.spec?.policy || session.agentPolicy || createIdeAgentPolicy({ tools: allTools, entry: session.entry, approvalMode: session.approvalMode, remotePolicy: session.toolPolicy, goalProfile: agentGoalProfile });
    const agentTools = filterToolsForAgent(allTools, agentPolicy);
    const taskToolCatalogError = validateTaskAuthoringToolCatalog(session, allTools, agentTools, agentPolicy);
    if (taskToolCatalogError) {
      emitToSession(session, socket, 'ide:error', { sessionId, runId, error: taskToolCatalogError });
      endIdeAgentRun(runId, { runnerStatus: 'failed', taskStatus: 'blocked', error: taskToolCatalogError });
      return;
    }

    sanitizeProviderMessageHistory(session.messages);
    repairDanglingToolUseMessages(session.messages);

    const firstContextBlock = session.messages.length === 0 && session.contextBlock ? session.contextBlock : '';
    const userContent = firstContextBlock + message;

    session.messages.push({ role: 'user', content: userContent });
    recordTraceEvent('instruction', 'instruction_received', {
      source: 'ide',
      runId,
      sessionId,
      hostId: session.hostId,
      toolName: 'ide_message',
      summary: message,
    });

    const provider = proxyConfigStore.getActiveProvider('skills')
                  || proxyConfigStore.getActiveProvider('claude-code');
    if (!provider?.apiBase || !provider?.apiKey) {
      emitToSession(session, socket, 'ide:error', { sessionId, runId, error: 'AI Provider 未配置。请先在"AI 配置"页添加 Provider。' });
      endIdeAgentRun(runId, { runnerStatus: 'failed', taskStatus: 'blocked', error: 'AI Provider 未配置' });
      return;
    }

    const model = provider.model || 'claude-sonnet-4-20250514';
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;

    emitToSession(session, socket, 'ide:thinking', { sessionId, runId });

    auditService?.log?.({ action: 'ide_message', sessionId, message: message.substring(0, 500) });

    logger?.debug?.(`[ide] Agent tool catalog exposed (${agentTools.length}/${allTools.length} allowed by policy)`);

    const MAX_TOOL_ROUNDS = resolveNullablePositiveInteger(agentPolicy.maxTurns) || 128;

    const modelAdapter = createIdeStreamingModelAdapter({ socket, sessionId, runId, session, model, proxyUrl, agentTools, context });
    const dispatchOptionsForAction = createIdeRuntimeDispatchOptions({ socket, sessionId, runId, session, mcpToolMap });

    try {
      let observations = [];
      let lastResult = null;
      let emptyModelResponseRetries = 0;
      let taskPackagingRetries = 0;
      let taskConnectionFailureStreak = 0;
      let round = 0;
      for (; round < MAX_TOOL_ROUNDS; round++) {
        throwIfStopped(session, runId);
        recordIdeAgentTurn(runId, round + 1, { status: 'running', stage: observations.length > 0 ? 'observe' : 'decide' });
        lastResult = await modelAdapter({ runId, turn: round + 1, observations });
        const toolCalls = Array.isArray(lastResult?.toolCalls) ? lastResult.toolCalls : [];
        if (toolCalls.length === 0) {
          if (isEmptyModelResult(lastResult)) {
            emptyModelResponseRetries += 1;
            recordTraceEvent('provider', 'empty_model_response', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'model_provider',
              summary: `provider returned empty assistant response (${emptyModelResponseRetries}/${EMPTY_MODEL_RESPONSE_RETRY_LIMIT})`,
              data: { round: round + 1, retry: emptyModelResponseRetries, entry: session.entry },
            });
            if (emptyModelResponseRetries <= EMPTY_MODEL_RESPONSE_RETRY_LIMIT) {
              observations = [createEmptyModelResponseObservation({ entry: session.entry, attempt: emptyModelResponseRetries })];
              continue;
            }
            throw new Error('Cannot continue IDE agent run: provider returned empty assistant responses repeatedly.');
          }
          if (shouldContinueTaskAuthoringPackaging({ session, runId })) {
            taskPackagingRetries += 1;
            recordTraceEvent('task_authoring', 'task_packaging_required', {
              source: 'ide',
              runId,
              sessionId,
              hostId: session.hostId,
              toolName: 'agent_controller',
              summary: `task authoring packaging required (${taskPackagingRetries}/${TASK_AUTHORING_PACKAGING_RETRY_LIMIT})`,
              data: { round: round + 1, retry: taskPackagingRetries },
            });
            if (taskPackagingRetries <= TASK_AUTHORING_PACKAGING_RETRY_LIMIT) {
              observations = [createTaskPackagingRequiredObservation({ attempt: taskPackagingRetries })];
              continue;
            }
            throw new Error('Cannot complete /task authoring: the workflow was practiced and verified, but no AI task was saved.');
          }
          break; // model produced a visible final answer
        }
        emptyModelResponseRetries = 0;
        observations = [];
        for (const tc of toolCalls) {
          throwIfStopped(session, runId);
          const extra = dispatchOptionsForAction({ action: { id: tc.id, toolName: tc.toolName, args: tc.args, options: {} } });
          const dispatched = await agentRuntime.dispatchTool(runId, tc.toolName, tc.args || {}, extra);
          observations.push(normalizeIdeToolObservation(tc, dispatched));
        }
        const connectionBlock = shouldBlockTaskAuthoringForConnectionFailures({
          session,
          runId,
          observations,
          streak: taskConnectionFailureStreak,
        });
        taskConnectionFailureStreak = connectionBlock.streak;
        if (connectionBlock.blocked) {
          const message = taskAuthoringConnectionBlockedMessage(connectionBlock);
          recordTraceEvent('task_authoring', 'connection_failure_blocked', {
            source: 'ide',
            runId,
            sessionId,
            hostId: session.hostId,
            toolName: 'agent_controller',
            summary: `task authoring blocked after ${connectionBlock.streak} connection failures`,
            data: { round: round + 1, reason: connectionBlock.reason || '' },
          });
          if (isRunCurrent(session, runId)) {
            emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: message });
            emitToSession(session, socket, 'ide:text', { sessionId, runId, text: message });
            emitToSession(session, socket, 'ide:done', { sessionId, runId, round: round + 1, taskStatus: 'blocked' });
          }
          recordIdeAgentPhase(runId, 'blocked', 'Task authoring blocked by repeated remote connection failures', { status: 'blocked', evidence: [connectionBlock.reason || ''] });
          endIdeAgentRun(runId, { runnerStatus: 'blocked', taskStatus: 'blocked', error: message });
          return;
        }
      }

      const finalResult = buildIdeFinalResult(runId, [lastResult?.text || lastResult?.report || lastResult?.content || ''], {
        sessionId,
        round,
        entry: session.entry,
      });
      if (isRunCurrent(session, runId)) {
        emitToSession(session, socket, 'ide:done', { sessionId, runId, round, taskStatus: finalResult.taskStatus || 'unverified' });
      }
      recordIdeAgentPhase(runId, 'result', `Final outcome: ${finalResult.taskStatus || 'unverified'}`, { status: 'done', evidence: finalResult.data?.outcomeReasons || [] });
      endIdeAgentRun(runId, { runnerStatus: 'completed', taskStatus: finalResult.taskStatus || 'unverified', result: finalResult });
      return;
    } catch (err) {
      if (isAbortError(err)) {
        recordTraceEvent('runtime', 'run_aborted', {
          source: 'ide',
          runId,
          sessionId,
          hostId: session.hostId,
          toolName: 'agent_run',
          summary: err.message || 'agent run aborted',
          data: { cancelled: !!session.cancelled, code: err.code || '', name: err.name || '' },
        });
        if (session.currentRunId === runId) emitCancelledOnce(session, sessionId, socket);
        cancelIdeAgentRun(runId, err.message || 'cancelled');
        return;
      }
      logger?.error?.('IDE agent loop failed', { sessionId, error: err.message });
      recordTraceEvent('runtime', 'run_failed', {
        source: 'ide',
        runId,
        sessionId,
        hostId: session.hostId,
        toolName: 'agent_run',
        summary: err.message || 'agent run failed',
        data: { name: err.name || '', stack: String(err.stack || '').slice(0, 2000) },
      });
      if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:error', { sessionId, runId, error: err.message });
      endIdeAgentRun(runId, { runnerStatus: 'failed', taskStatus: 'failed', error: err.message });
      return;
    }

  }

  async function ask({ message, context = null, safeMode = undefined, claudeCodeEnabled = false, unlimitedTurns = undefined, entry = 'core', approvalMode = null, timeoutMs = 300000, approvalAction = 'deny' } = {}) {
    const text = String(message || '').trim();
    if (!text) throw new Error('message 为空');
    const sessionId = `mcp-ai-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const socket = new EventEmitter();
    socket.id = sessionId;
    const events = [];
    const toolCalls = [];
    const maxEvents = 100;
    const maxOutputChars = 200000;
    let output = '';
    let outputTruncated = false;
    let sawDelta = false;
    let error = null;
    const appendOutput = (value) => {
      if (outputTruncated) return;
      const textValue = String(value || '');
      const remaining = maxOutputChars - output.length;
      if (textValue.length <= remaining) {
        output += textValue;
        return;
      }
      output += textValue.slice(0, Math.max(0, remaining));
      output += '\n...(1Shell AI 输出已截断)';
      outputTruncated = true;
    };
    const redactInput = (value) => {
      try {
        return JSON.parse(JSON.stringify(value || {}, (key, item) => {
          if (/token|key|secret|password|auth|content|base64/i.test(key)) return '<redacted>';
          if (typeof item === 'string' && item.length > 500) return `${item.slice(0, 500)}…`;
          return item;
        }));
      } catch { return {}; }
    };
    const summarizeEventPayload = (payload = {}) => {
      const summary = { ...payload };
      if (summary.delta) summary.delta = String(summary.delta).slice(0, 200);
      if (summary.text) summary.text = String(summary.text).slice(0, 200);
      if (summary.result) summary.result = String(summary.result).slice(0, 500);
      if (summary.input) summary.input = redactInput(summary.input);
      return summary;
    };
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event, payload = {}) => {
      if (events.length < maxEvents) events.push({ event, payload: summarizeEventPayload(payload) });
      if (event === 'ide:text-delta' && payload.delta) {
        sawDelta = true;
        appendOutput(payload.delta);
      }
      if (event === 'ide:text' && !sawDelta && payload.text) {
        appendOutput(payload.text);
      }
      if (event === 'ide:tool-start') {
        toolCalls.push({ name: payload.name, input: redactInput(payload.input || {}) });
      }
      if (event === 'ide:error') {
        error = String(payload.error || '1Shell AI 执行失败');
      }
      if (event === 'ide:approve-request') {
        setImmediate(() => originalEmit('ide:approve-response', { requestId: payload.requestId, action: approvalAction }));
      }
      if (event === 'ide:ask-user') {
        setImmediate(() => originalEmit('ide:ask-user-response', { requestId: payload.requestId, action: 'deny', reason: 'headless_no_user_input' }));
      }
      if (event === 'ide:secret-request') {
        setImmediate(() => originalEmit('ide:secret-response', { requestId: payload.requestId, action: 'deny', reason: 'headless_no_secret_input' }));
      }
      return originalEmit(event, payload);
    };

    const timeout = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 600000) : 300000;
    let timer = null;
    try {
      await Promise.race([
        handleMessage({ socket, sessionId, message: text, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry, approvalMode }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            cancelSession(sessionId, `headless timeout (${timeout}ms)`);
            reject(new Error(`1Shell AI 超时 (${timeout}ms)`));
          }, timeout);
        }),
      ]);
      if (error) throw new Error(error);
      return { text: output.trim(), events, toolCalls };
    } finally {
      if (timer) clearTimeout(timer);
      sessions.delete(sessionId);
    }
  }

  function cancelSession(sessionId, reason = 'cancelled by user') {
    const session = sessions.get(sessionId);
    if (!session) return false;
    ensureSessionCancellation(session);
    const runId = session.currentRunId;
    recordTraceEvent('runtime', 'session_cancelled', {
      source: 'ide',
      runId,
      sessionId,
      hostId: session.hostId,
      toolName: 'session',
      summary: reason,
    });
    session.cancelled = true;
    if (session.abortController) {
      try { session.abortController.abort(); } catch { /* ignore */ }
      session.abortController = null;
    }
    for (const handler of [...session.cancelHandlers]) {
      try { handler(); } catch { /* ignore */ }
    }
    if (session.activeChildProcess) {
      try { session.activeChildProcess.kill(); } catch { /* ignore */ }
      session.activeChildProcess = null;
    }
    cancelIdeAgentRun(runId, reason);
    if (session.currentRunId === runId) session.currentRunId = null;
    emitCancelledOnce(session, sessionId);
    return true;
  }

  function deleteSession(sessionId) {
    cancelSession(sessionId, 'session deleted');
    sessions.delete(sessionId);
  }

  function cancelSessionsForSocket(socketId) {
    return detachSessionsForSocket(socketId, 'socket_disconnect_legacy_cancel_hook');
  }

  function detachSessionsForSocket(socketId, reason = 'socket_disconnect') {
    let detached = 0;
    for (const [sessionId, session] of sessions) {
      if (session.socketId !== socketId) continue;
      session.socket = null;
      session.socketId = null;
      session.detachedAt = new Date().toISOString();
      session.detachReason = reason;
      detached += 1;
      recordTraceEvent('runtime', 'session_detached', {
        source: 'ide',
        runId: session.currentRunId,
        sessionId,
        hostId: session.hostId,
        toolName: 'session',
        summary: reason,
      });
    }
    return detached;
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  function setSafeMode(_sessionId, _enabled) {
    return false;
  }

  function getSafeMode(_sessionId) {
    return false;
  }

  function setUnlimitedTurns(_sessionId, _enabled) {
    return false;
  }

  function setClaudeCodeEnabled(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.claudeCodeEnabled = enabled;
  }

  function recordAuthoringUserReply(_sessionId, _input) {
    return { ok: false, error: 'authoring 流程已废弃' };
  }

  function reattachSession(sessionId, socket) {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session 不存在' };
    session.socket = socket;
    session.socketId = socket.id;
    session.detachedAt = null;
    session.detachReason = '';
    recordTraceEvent('runtime', 'session_reattached', {
      source: 'ide',
      runId: session.currentRunId,
      sessionId,
      hostId: session.hostId,
      toolName: 'session',
      summary: `socket=${socket.id || ''}`,
    });
    if (session.currentRunId && !session.cancelled) {
      emitIdeEvent(socket, 'ide:thinking', { sessionId, runId: session.currentRunId });
    }
    return { ok: true, running: !!session.currentRunId && !session.cancelled, runId: session.currentRunId };
  }

  return { handleMessage, ask, cancelSession, cancelSessionsForSocket, detachSessionsForSocket, deleteSession, hasSession, setSafeMode, getSafeMode, setUnlimitedTurns, setClaudeCodeEnabled, recordAuthoringUserReply, reattachSession };
}

module.exports = { createIdeService };
