'use strict';

const { EventEmitter } = require('events');
const fetch = require('node-fetch');
const { emitIdeEvent } = require('./ide.events');
const {
  ONESHELL_CORE_SYSTEM_PROMPT,
  ONESHELL_AUTHORING_SYSTEM_PROMPT,
  SAFE_MODE_ADDENDUM,
} = require('../ai/oneshell-ai-prompt');

function emitToSession(session, fallbackSocket, event, payload) {
  const target = session?.socket || fallbackSocket;
  try { emitIdeEvent(target, event, payload); } catch { /* ignore */ }
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
        };
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
        }
        return;
      }
      if (evt.type === 'content_block_stop') {
        const blk = blocks[evt.index];
        if (blk && blk._inputJson) {
          try { blk.input = JSON.parse(blk._inputJson); } catch { blk.input = {}; }
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
const KEEP_RECENT = 8;
const TRUNCATE_TO = 200;
const MAX_PROVIDER_TRANSIENT_RETRIES = 2;
const MAX_AUTHORING_DRAFT_REPAIR_ROUNDS = 4;

function toolContentPreview(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'image') return '[image]';
    return JSON.stringify(block);
  }).join('\n');
}

function isTransientProviderError(err) {
  const message = String(err?.message || err || '');
  return /Provider 返回 (429|500|502|503|504)|Gateway Time-out|gateway timeout|api_error|ECONNRESET|socket hang up|ETIMEDOUT|premature close/i.test(message);
}

function compactToolResultForModel(toolName, content) {
  const text = toolContentPreview(content);
  if (!text) return content;
  if (!['start_program_draft', 'create_program_draft', 'update_authoring_draft', 'validate_program_draft', 'request_commit_approval'].includes(toolName)) {
    return text.length > 5000 ? `${text.slice(0, 5000)}\n...(tool_result 已裁剪，原 ${text.length} 字符)` : content;
  }
  if (text.length <= 1800) return content;
  const important = text
    .split('\n')
    .filter((line) => /artifact|validation|ERROR:|WARN:|失败|通过|update_authoring_draft|下一步|缺少|未知|必须|ui_artifact|sandbox/i.test(line))
    .join('\n')
    .trim();
  const compacted = important || text.slice(0, 1800);
  return `${compacted}\n...(authoring tool_result 已裁剪，保留 artifact id 与 validation 关键错误，原 ${text.length} 字符)`;
}

function needsDraftRepairDirective(toolCalls, toolResults, authoringSession) {
  if (!authoringSession || authoringSession.stage !== 'draft') return false;
  const calledDraftTool = toolCalls.some((tc) => ['start_program_draft', 'create_program_draft', 'update_authoring_draft', 'validate_program_draft', 'request_commit_approval'].includes(tc.name));
  if (!calledDraftTool) return false;
  return toolResults.some((item) => /Draft validation 失败|validation: failed|Program Draft validation 失败|update_authoring_draft/.test(toolContentPreview(item.content)));
}

function createDraftRepairDirective(authoringSession) {
  const draft = [...(authoringSession?.artifacts || [])].reverse().find((item) => item.type === 'program_draft' || item.type === 'skill_draft');
  const artifactId = draft?.id || '(latest)';
  const errors = (draft?.validation?.errors || []).slice(0, 12).map((item) => `- ${item}`).join('\n');
  return [
    '[AUTHORING_REPAIR_REQUIRED]',
    '上一轮 Draft validation 失败，本轮不能结束、不能请求用户手动修复、不能整份重建。',
    `必须立即调用 update_authoring_draft 修复现有 artifact: ${artifactId}。`,
    '只替换 validation errors 涉及的文件/字段，保留已有正确 UI artifact 和其它文件。',
    errors ? `当前 validation errors:\n${errors}` : '',
  ].filter(Boolean).join('\n');
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
      if (text.length <= TRUNCATE_TO) return block;
      return { ...block, content: text.slice(0, TRUNCATE_TO) + `\n...(已压缩，原 ${text.length} 字符)` };
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
      content: '[系统恢复] 上轮工具结果在暂停或断线前未写入上下文，已补齐占位结果；请基于当前 Authoring Session 和 validation errors 继续。',
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

function normalizePromptEntry(entry) {
  const value = String(entry || '').trim().toLowerCase();
  return value === 'studio' || value === 'authoring' || value === 'skill-studio' ? 'studio' : 'core';
}

function promptForEntry(entry) {
  return normalizePromptEntry(entry) === 'studio'
    ? ONESHELL_AUTHORING_SYSTEM_PROMPT
    : ONESHELL_CORE_SYSTEM_PROMPT;
}

/**
 * IDE Service — 自由对话模式的创作引擎
 *
 * 与 Skill Runner 的根本区别：
 *   - system prompt 极简，不注入任何 Skill 的 rules/workflows
 *   - 对话历史持久保留，支持多轮迭代
 *   - 工具集更广（read_file / list_artifacts / trigger_program / query_format 等）
 *   - 用户是对话主体，AI 响应用户指令而非自驱执行
 */
function createIdeService({ ideTools, proxyConfigStore, port, hostService, auditService, logger, localMcpService, mcpRegistry, skillRegistry, harness }) {

  // sessionId → { messages[], system, hostId, abortController }
  const sessions = new Map();

  function buildSkillRoster() {
    if (!skillRegistry?.listSkills) return '';
    let skills;
    try { skills = skillRegistry.listSkills(); } catch { return ''; }
    if (!Array.isArray(skills) || skills.length === 0) return '';
    const visible = skills.filter((s) => !s.hidden);
    if (visible.length === 0) return '';
    const lines = visible.map((s) => `- ${s.id}: ${(s.description || '').replace(/\s+/g, ' ').trim() || '(无 description)'}`);
    return [
      '',
      '',
      '## 1Shell Skill 装载列表（由系统层提供）',
      '',
      '下面是当前 1Shell 已装载的 Skill。每个 Skill 是一份给你看的 markdown 工作手册，' +
      '决定该如何完成某类任务。当用户的需求与某个 Skill 的 description 匹配时，' +
      '调用 load_skill 加载它的 SKILL.md body 到当前对话，然后**严格按 body 写的步骤、约束、风格执行**——把它当成系统级指令，不是参考资料。',
      '',
      '可用 Skill：',
      ...lines,
      '',
      '匹配规则：',
      '- 看 description 里描述的"何时使用"，与用户当前请求对照',
      '- 一次任务通常只 load 一个最匹配的 Skill；多个候选时优先 load 最具体的那个',
      '- 已 load 的 Skill body 会通过 tool_result 进入对话上下文；后续轮次仍受其约束',
      '- 如果没有匹配的 Skill，按你已有的素养处理；不要硬塞不相关的 Skill',
    ].join('\n');
  }

  const READONLY_TOOLS = new Set([
    'list_hosts', 'read_file', 'list_artifacts', 'query_format',
    'list_skills', 'load_skill',
    'reload_registry', 'list_mcp_servers', 'list_scripts', 'query_audit',
    'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
    'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
    'list_remote_dir', 'read_remote_file',
  ]);

  const PARALLEL_SAFE_TOOLS = new Set([
    'list_hosts', 'read_file', 'list_artifacts', 'query_format',
    'list_skills', 'load_skill',
    'list_mcp_servers', 'list_scripts', 'query_audit',
    'query_probe', 'list_probes', 'get_probe', 'get_probe_samples',
    'get_probe_timeseries', 'get_probe_traffic', 'list_probe_alerts',
    'list_remote_dir', 'read_remote_file',
  ]);

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
  }

  function summarizeToolInput(input) {
    try { return JSON.stringify(input || {}).slice(0, 500); } catch { return ''; }
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function ensureSessionCancellation(session) {
    if (!session.cancelHandlers) session.cancelHandlers = new Set();
    if (!session.activeSkillRunIds) session.activeSkillRunIds = new Set();
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
        return { title: '执行命令', detail: `主机: ${input.hostId || 'local'}\n命令: ${input.command || ''}` };
      case 'write_file':
        return { title: '写入文件', detail: `路径: ${input.path || ''}\n内容: ${(input.content || '').substring(0, 300)}` };
      case 'deploy_local_mcp':
        return { title: '部署本地 MCP', detail: `仓库: ${input.repoUrl || ''}\n名称: ${input.name || ''}` };
      default:
        return { title: tc.name, detail: JSON.stringify(input, null, 2).substring(0, 400) };
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
      upload_file: 'upload_file',
      download_file: 'download_file',
    };
    const directTool = requiredDirectToolByInternalTool[tc.name];
    if (directTool && policy.allowedTools.length > 0 && !policy.allowedTools.includes('*') && !policy.allowedTools.includes(directTool)) {
      return deniedByPolicy(`Remote MCP Token 不允许 1Shell AI 使用能力: ${directTool}`);
    }
    const writeTools = new Set([
      'execute_command', 'write_file', 'write_program', 'run_skill', 'trigger_program',
      'run_script', 'write_remote_file', 'upload_file', 'download_file', 'add_mcp_server',
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
      run_skill: ['hostId'],
      run_script: ['hostId'],
      trigger_program: ['hostId'],
      list_remote_dir: ['hostId'],
      read_remote_file: ['hostId'],
      write_remote_file: ['hostId'],
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
      upload_file: ['dirPath', 'localPath'],
      download_file: ['path', 'localPath'],
    };
    for (const field of pathFieldsByTool[tc.name] || []) {
      const value = String(input[field] || '').trim();
      if (value && !allowsPath(value, policy.allowedPaths)) return deniedByPolicy(`Remote MCP Token 不允许访问路径: ${value}`);
    }
    return null;
  }

  function waitForApproval(socket, sessionId, tc, session, runId, options = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `apr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const baseSummary = getApprovalSummary(tc);
      const summary = options.summary || baseSummary;
      const riskReason = String(options.riskReason || '').trim();
      let unregisterCancel = null;
      let settled = false;

      const cleanup = () => {
        socket.off('ide:approve-response', handler);
        clearTimeout(timer);
        if (unregisterCancel) unregisterCancel();
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      const handler = (resp) => {
        if (resp.requestId !== requestId) return;
        settle(resolve, resp);
      };
      socket.on('ide:approve-response', handler);

      const timer = setTimeout(() => settle(resolve, { action: 'deny' }), 5 * 60 * 1000);
      unregisterCancel = registerCancelHandler(session, () => settle(reject, makeAbortError()));

      try {
        throwIfStopped(session, runId);
        emitToSession(session, socket, 'ide:approve-request', {
          sessionId,
          runId,
          requestId,
          toolName: tc.name,
          title: options.title || summary.title,
          detail: [summary.detail, riskReason ? `风险原因：${riskReason}` : ''].filter(Boolean).join('\n\n'),
        });
      } catch (err) {
        settle(reject, err);
      }
    });
  }

  function applyPromptEntry(session, entry) {
    if (entry == null || String(entry).trim() === '') return;
    const nextEntry = normalizePromptEntry(entry);
    if (session.entry === nextEntry) return;
    session.entry = nextEntry;
    session.system = promptForEntry(nextEntry);
  }

  function getOrCreateSession(sessionId, context, entry) {
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      applyPromptEntry(session, entry);
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
      if (context.skills?.length > 0) {
        parts.push('**用户选择的 Skill**（可通过 read_file 读取其内容，通过 execute_command 在目标主机执行）：');
        for (const s of context.skills) parts.push(`  - \`${s.id}\` · ${s.name}`);
      }
      if (parts.length > 0) contextBlock = parts.join('\n') + '\n\n';
    }

    const promptEntry = normalizePromptEntry(entry);
    const session = {
      messages: [],
      entry: promptEntry,
      system: promptForEntry(promptEntry),
      contextBlock,
      hostId: context?.hosts?.[0]?.id || 'local',
      abortController: null,
      activeChildProcess: null,
      activeSkillRunIds: new Set(),
      cancelHandlers: new Set(),
      cancelNotified: false,
      cancelled: false,
      currentRunId: null,
      socket: null,
      socketId: null,
      safeMode: true,
      unlimitedTurns: false,
      claudeCodeEnabled: false,
      toolPolicy: context?.toolPolicy ? normalizeToolPolicy(context.toolPolicy) : null,
    };
    sessions.set(sessionId, session);
    return session;
  }

  async function handleMessage({ socket, sessionId, message, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry }) {
    const session = getOrCreateSession(sessionId, context, entry);
    ensureSessionCancellation(session);
    const runId = newRunId();
    session.currentRunId = runId;
    session.cancelled = false;
    session.cancelNotified = false;
    session.socket = socket;
    session.socketId = socket.id;

    if (safeMode !== undefined) {
      session.safeMode = safeMode !== false;
    }
    if (claudeCodeEnabled !== undefined) {
      session.claudeCodeEnabled = !!claudeCodeEnabled;
    }
    if (unlimitedTurns !== undefined) {
      session.unlimitedTurns = !!unlimitedTurns;
    }

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
      return;
    }

    const model = provider.model || 'claude-sonnet-4-20250514';
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy/skills/v1/messages`;

    emitToSession(session, socket, 'ide:thinking', { sessionId, runId });

    auditService?.log?.({ action: 'ide_message', sessionId, message: message.substring(0, 500) });

    // 合并内置工具 + 已启动的本地 MCP 工具（去重，剥离内部字段）
    const seenToolNames = new Set();
    const allTools = [];
    const mcpToolMap = new Map(); // name → { mcpId, mcpToolName }
    for (const t of ideTools.TOOL_SCHEMAS) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      allTools.push(t);
    }
    // Claude Code 协作：开关开启时注入工具
    if (session.claudeCodeEnabled && ideTools.CLAUDE_CODE_TOOL) {
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
    logger?.info?.(`[ide] tools: ${allTools.length} total (${allTools.map(t => t.name).join(', ')})`);

    const MAX_TOOL_ROUNDS = session.unlimitedTurns ? Infinity : 30;
    let round = 0;
    let providerTransientRetryCount = 0;
    let authoringDraftRepairRounds = 0;

    try {
      while (round < MAX_TOOL_ROUNDS) {
        round++;

        throwIfStopped(session, runId);

        let data;
        try {
          repairDanglingToolUseMessages(session.messages);
          const compactedMessages = compactMessages(session.messages);
          const skillRoster = buildSkillRoster();
          const baseSystem = session.system + skillRoster;
          const apiBody = JSON.stringify({
            model,
            max_tokens: 8192,
            stream: true,
            system: session.safeMode ? baseSystem + SAFE_MODE_ADDENDUM : baseSystem,
            messages: compactedMessages,
            tools: allTools,
          });

          for (let attempt = 0; attempt <= MAX_PROVIDER_TRANSIENT_RETRIES; attempt++) {
            const ac = new AbortController();
            session.abortController = ac;
            // 总体响应超时：连接 + 整个 SSE 流 ≤ 240s（4 分钟）
            // 模型生成大 input_json 可能慢，但绝不应超过 4 分钟无任何输出
            const overallTimeout = setTimeout(() => {
              try { ac.abort(); } catch { /* ignore */ }
            }, 240000);
            try {
              logger?.info?.(`[ide] round ${round} attempt ${attempt} fetching provider (timeout=240s)`);
              const fetchStartedAt = Date.now();
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
                throw new Error(`Provider 返回 ${resp.status}: ${errText.substring(0, 300)}`);
              }

              logger?.info?.(`[ide] round ${round} got headers in ${Date.now() - fetchStartedAt}ms, streaming...`);
              // 增量 SSE 解析 — 实时推送 text delta 到前端
              data = await streamAnthropicSSE(resp.body, ac, session, socket, sessionId, runId);
              clearTimeout(overallTimeout);
              session.abortController = null;
              logger?.info?.(`[ide] round ${round} stream done (${Date.now() - fetchStartedAt}ms total), tools=${data.content.filter(b=>b.type==='tool_use').map(b=>b.name).join(',')||'(none)'}, stop_reason=${data.stop_reason}`);
              break;
            } catch (retryErr) {
              clearTimeout(overallTimeout);
              session.abortController = null;
              const wasTimeout = retryErr.name === 'AbortError' && !session.cancelled;
              if (wasTimeout) {
                logger?.warn?.(`[ide] round ${round} attempt ${attempt} TIMEOUT after 240s`);
              }
              if (retryErr.name === 'AbortError' && session.cancelled) throw retryErr;
              const isRetryable = wasTimeout || isTransientProviderError(retryErr);
              if (!isRetryable || attempt >= MAX_PROVIDER_TRANSIENT_RETRIES) throw retryErr;
              if (isRunCurrent(session, runId)) {
                emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: `\n[${wasTimeout ? '超时 240 秒' : '连接中断'}，第 ${attempt + 1} 次重试...]\n` });
              }
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
        } catch (err) {
          session.abortController = null;
          if (isAbortError(err)) {
            if (session.currentRunId === runId) emitCancelledOnce(session, sessionId, socket);
            return;
          }
          if (isTransientProviderError(err) && providerTransientRetryCount < 1) {
            providerTransientRetryCount += 1;
            const retryMessage = `[PROVIDER_TRANSIENT_RETRY]\n上游 Provider 暂时失败：${String(err.message || err).slice(0, 500)}`;
            session.messages.push({ role: 'user', content: retryMessage });
            if (isRunCurrent(session, runId)) {
              emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: '\n[上游 Provider 暂时超时，已保留上下文并自动续跑一次...]\n' });
              emitToSession(session, socket, 'ide:thinking', { sessionId, runId });
            }
            continue;
          }
          throw err;
        }

        if (data.type === 'error') {
          throw new Error(data.error?.message || 'API error');
        }

        throwIfStopped(session, runId);

        const textParts = data.content.filter(b => b.type === 'text').map(b => b.text);
        const toolCalls = data.content.filter(b => b.type === 'tool_use');

        // ide:text 仍发一次完整文本（兼容旧前端 / 历史记录用途）
        if (textParts.length > 0) {
          const fullText = textParts.join('');
          if (!data._emittedTextDelta) {
            emitToSession(session, socket, 'ide:text-delta', { sessionId, runId, delta: fullText });
          }
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

        session.messages.push({ role: 'assistant', content: data.content });

        if (toolCalls.length === 0 || data.stop_reason === 'end_turn') {
          if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:done', { sessionId, runId, round });
          return;
        }

        // 执行工具调用。只读查询可并发；会改变 Authoring/主机/文件状态的工具保持串行。
        const toolResults = [];
        const runToolCall = async (tc) => {
          throwIfStopped(session, runId);

          recordTraceEvent('reasoning', 'tool_decision', {
            source: 'ide',
            runId,
            sessionId,
            hostId: session.hostId,
            toolName: tc.name,
            summary: `AI 决定调用工具 ${tc.name}: ${summarizeToolInput(tc.input)}`,
          });
          emitToSession(session, socket, 'ide:tool-start', { sessionId, runId, toolUseId: tc.id, name: tc.name, input: tc.input });

          let result;

          const policyResult = applyToolPolicy(tc, session);
          if (policyResult) {
            result = policyResult;
            emitToSession(session, socket, 'ide:tool-end', { sessionId, runId, toolUseId: tc.id, name: tc.name, result: toolContentPreview(result.content).substring(0, 4000), is_error: result.is_error });
            return { type: 'tool_result', tool_use_id: tc.id, content: compactToolResultForModel(tc.name, result.content), ...(result.is_error ? { is_error: true } : {}) };
          }

          if (session.safeMode && !READONLY_TOOLS.has(tc.name) && tc.name !== 'execute_command') {
            const approval = await waitForApproval(socket, sessionId, tc, session, runId);
            throwIfStopped(session, runId);
            if (approval.action === 'deny') {
              result = { content: '[用户拒绝了此操作]', is_error: true };
              emitToSession(session, socket, 'ide:tool-end', { sessionId, runId, toolUseId: tc.id, name: tc.name, result: result.content, is_error: true });
              return { type: 'tool_result', tool_use_id: tc.id, content: compactToolResultForModel(tc.name, result.content), is_error: true };
            }
            if (approval.action === 'custom') {
              result = { content: approval.text || '[用户自定义回复]', is_error: false };
              emitToSession(session, socket, 'ide:tool-end', { sessionId, runId, toolUseId: tc.id, name: tc.name, result: result.content, is_error: false });
              return { type: 'tool_result', tool_use_id: tc.id, content: compactToolResultForModel(tc.name, result.content) };
            }
          }

          const requestHarnessApproval = async (toolName, input, summary, riskReason) => {
            const approval = await waitForApproval(socket, sessionId, { name: toolName, input: input || {} }, session, runId, {
              summary,
              riskReason,
              title: '高风险操作确认',
            });
            throwIfStopped(session, runId);
            return approval.action === 'allow';
          };

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

          const toolAc = new AbortController();
          const unregisterToolCancel = registerCancelHandler(session, () => toolAc.abort());
          try {
            const mcpInfo = mcpToolMap.get(tc.name);
            if (mcpInfo && localMcpService) {
              try {
                result = await localMcpService.callTool(mcpInfo.mcpId, mcpInfo.mcpToolName, tc.input || {}, {
                  signal: toolAc.signal,
                  killOnAbort: true,
                });
              } catch (err) {
                if (isAbortError(err) || toolAc.signal.aborted) throw makeAbortError();
                result = { content: `[ERROR] ${err.message}`, is_error: true };
              }
            } else {
              result = await ideTools.handle(tc.name, tc.input || {}, {
                socket,
                sessionId,
                runId,
                safeMode: session.safeMode,
                session,
                signal: toolAc.signal,
                requestApproval: requestHarnessApproval,
                onToolDelta: emitToolDelta,
              });
            }
          } finally {
            unregisterToolCancel();
          }

          throwIfStopped(session, runId);

          emitToSession(session, socket, 'ide:tool-end', {
            sessionId,
            runId,
            toolUseId: tc.id,
            name: tc.name,
            result: toolContentPreview(result.content).substring(0, 4000),
            is_error: result.is_error,
          });

          return {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: compactToolResultForModel(tc.name, result.content),
            ...(result.is_error ? { is_error: true } : {}),
          };
        };

        const canRunAllInParallel = toolCalls.length > 1 && toolCalls.every((tc) => PARALLEL_SAFE_TOOLS.has(tc.name));
        if (canRunAllInParallel) {
          toolResults.push(...await Promise.all(toolCalls.map((tc) => runToolCall(tc))));
        } else {
          for (const tc of toolCalls) toolResults.push(await runToolCall(tc));
        }

        throwIfStopped(session, runId);
        session.messages.push({ role: 'user', content: toolResults });

        if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:thinking', { sessionId, runId });
      }

      if (isRunCurrent(session, runId)) {
        emitToSession(session, socket, 'ide:error', { sessionId, runId, error: `工具调用轮次过多 (${MAX_TOOL_ROUNDS})，已中断。` });
      }
    } catch (err) {
      if (isAbortError(err)) {
        if (session.currentRunId === runId) emitCancelledOnce(session, sessionId, socket);
        return;
      }
      logger?.error?.('IDE 执行异常', { sessionId, error: err.message });
      if (isRunCurrent(session, runId)) emitToSession(session, socket, 'ide:error', { sessionId, runId, error: err.message });
    }
  }

  async function ask({ message, context = null, safeMode = true, claudeCodeEnabled = false, unlimitedTurns = false, entry = 'core', timeoutMs = 300000, approvalAction = 'deny' } = {}) {
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
      return originalEmit(event, payload);
    };

    const timeout = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 600000) : 300000;
    let timer = null;
    try {
      await Promise.race([
        handleMessage({ socket, sessionId, message: text, context, safeMode, claudeCodeEnabled, unlimitedTurns, entry }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            cancelSession(sessionId);
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

  function cancelSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    ensureSessionCancellation(session);
    session.cancelled = true;
    if (session.abortController) {
      try { session.abortController.abort(); } catch { /* ignore */ }
      session.abortController = null;
    }
    for (const handler of [...session.cancelHandlers]) {
      try { handler(); } catch { /* ignore */ }
    }
    for (const runId of [...session.activeSkillRunIds]) {
      try { session.skillRunner?.cancelRun?.(runId); } catch { /* ignore */ }
    }
    if (session.activeChildProcess) {
      try { session.activeChildProcess.kill(); } catch { /* ignore */ }
      session.activeChildProcess = null;
    }
    emitCancelledOnce(session, sessionId);
    return true;
  }

  function deleteSession(sessionId) {
    cancelSession(sessionId);
    sessions.delete(sessionId);
  }

  function cancelSessionsForSocket(socketId) {
    for (const [sessionId, session] of sessions) {
      if (session.socketId === socketId) cancelSession(sessionId);
    }
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  function setSafeMode(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.safeMode = enabled;
  }

  function getSafeMode(sessionId) {
    const session = sessions.get(sessionId);
    return session ? session.safeMode : true;
  }

  function setUnlimitedTurns(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) session.unlimitedTurns = enabled;
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
    if (session.currentRunId && !session.cancelled) {
      emitIdeEvent(socket, 'ide:thinking', { sessionId, runId: session.currentRunId });
    }
    return { ok: true, running: !!session.currentRunId && !session.cancelled, runId: session.currentRunId };
  }

  return { handleMessage, ask, cancelSession, cancelSessionsForSocket, deleteSession, hasSession, setSafeMode, getSafeMode, setUnlimitedTurns, setClaudeCodeEnabled, recordAuthoringUserReply, reattachSession };
}

module.exports = { createIdeService };
