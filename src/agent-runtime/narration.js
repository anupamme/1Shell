'use strict';

const { isReadonlyCommand } = require('../harness/capabilities');

const CONCRETE_READ_TOOLS = new Set([
  'read_file',
  'read_remote_file',
  'list_remote_dir',
  'download_file',
  'get_probe',
  'get_probe_samples',
  'get_probe_timeseries',
  'get_probe_traffic',
  'query_probe',
  'list_probe_alerts',
  'query_audit',
]);

function buildPublicNarration({ type = '', payload = {}, state = {}, event = {} } = {}) {
  const sessionId = String(state?.spec?.metadata?.sessionId || payload.sessionId || '').trim();
  const base = {
    runId: state?.runId || event.runId || '',
    sessionId,
    source: state?.source || event.source || '',
    sourceEventType: type,
    at: event.at || new Date().toISOString(),
  };

  // Do not expose internal graph nodes such as understand/plan/decide/finalize.
  // Public narration is only for concrete external behavior or user-visible recovery.
  if (type === 'agent:tool-call-started') return narrationFromToolStart(base, payload.toolCall || {});
  if (type === 'agent:tool-call-ended') return narrationFromToolEnd(base, payload.toolCall || {});
  if (type === 'agent:tool-policy-denied' || type === 'agent:budget-exceeded') return narrationFromPolicyBlock(base, payload);
  if (type === 'agent:approval-required') return narrationFromApproval(base, payload);
  if (type === 'agent:interrupt-created') return narrationFromInterrupt(base, payload.interrupt || {});
  if (type === 'agent:recovery-policy-updated') return narrationFromRecovery(base, payload.recovery || {});
  if (type === 'agent:verification-recorded') return narrationFromVerification(base, payload.verification || {});

  return null;
}

function narrationFromToolStart(base, toolCall = {}) {
  const toolName = String(toolCall.toolName || '').trim();
  if (!toolName) return null;

  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const args = normalizeObject(toolCall.args);
    const command = String(args.command || '').trim();
    if (!command || !isReadonlyCommand(command)) return null;
    return narration(base, {
      kind: 'info',
      stage: 'observe',
      toolName,
      message: `我开始在 ${String(args.hostId || 'local')} 上做只读检查：${compactCommand(command)}`,
      data: toolCallData(toolCall),
    });
  }

  if (!CONCRETE_READ_TOOLS.has(toolName)) return null;
  const target = toolInputSummary(toolName, toolCall.args);
  return narration(base, {
    kind: 'info',
    stage: 'observe',
    toolName,
    message: target
      ? `我开始${verbForTool(toolName)}：${target}`
      : `我开始${verbForTool(toolName)}。`,
    data: toolCallData(toolCall),
  });
}

function narrationFromToolEnd(base, toolCall = {}) {
  const result = toolCall.result || {};
  const failed = result.ok === false || toolCall.status === 'error' || Boolean(result.error);
  if (!failed) return null;
  const detail = safeText(result.error || result.stderrExcerpt || result.content || '工具返回失败', 260);
  return narration(base, {
    kind: 'error',
    stage: 'observe',
    toolName: toolCall.toolName || '',
    message: `这一步失败了：${displayToolName(toolCall.toolName)}${result.exitCode !== undefined ? ` exit ${result.exitCode}` : ''}。${detail}`,
    data: {
      ...toolCallData(toolCall),
      exitCode: result.exitCode,
      durationMs: toolCall.durationMs ?? null,
    },
  });
}

function narrationFromPolicyBlock(base, payload = {}) {
  return narration(base, {
    kind: 'error',
    stage: 'policy',
    toolName: payload.toolName || '',
    message: `安全策略拦截了 ${displayToolName(payload.toolName)}：${safeText(payload.reason || payload.kind || '不允许继续', 220)}`,
    data: {
      kind: payload.kind || '',
      approvalRequired: payload.approvalRequired === true,
      providerToolUseId: payload.providerToolUseId || payload.toolUseId || '',
      toolCallId: payload.toolCallId || payload.toolUseId || '',
    },
  });
}

function narrationFromApproval(base, payload = {}) {
  const toolName = String(payload.toolName || '').trim();
  const summary = summarizeApprovalPayload(toolName, payload.summary || payload.args || payload.input || '');
  return narration(base, {
    kind: 'thought',
    stage: 'approval',
    toolName,
    message: summary
      ? `接下来会产生副作用，需要你审批：${summary}`
      : `接下来要使用 ${displayToolName(toolName)}，这一步需要你审批。`,
    data: { reason: payload.reason || '', summary: payload.summary || null },
  });
}

function narrationFromInterrupt(base, interrupt = {}) {
  const type = String(interrupt.type || '').trim();
  if (type === 'request_approval') {
    return null;
  }
  if (type === 'ask_user' || type === 'request_secret') {
    return narration(base, {
      kind: 'thought',
      stage: 'approval',
      message: `我需要你补充信息后再继续：${safeText(interrupt.reason || interrupt.message || '等待输入', 220)}`,
      data: { interruptId: interrupt.id || '', interruptType: type },
    });
  }
  return null;
}

function narrationFromRecovery(base, recovery = {}) {
  const reason = safeText(recovery.reason || recovery.strategy || '', 240);
  if (!reason) return null;
  return narration(base, {
    kind: 'thought',
    stage: 'recover',
    message: `刚才的步骤没有成功，我会按失败原因调整下一步：${reason}`,
    data: { recoveryType: recovery.recoveryType || recovery.recovery_type || '' },
  });
}

function narrationFromVerification(base, verification = {}) {
  const status = String(verification.status || '').trim();
  if (!status) return null;
  const ok = verification.ok === true || status === 'passed';
  const target = verification.target ? ` ${safeText(verification.target, 120)}` : '';
  const reason = firstReason(verification.reasons) || verification.type || status;
  return narration(base, {
    kind: ok ? 'success' : 'error',
    stage: 'verify',
    message: `${ok ? '验证通过' : '验证没有通过'}${target}：${safeText(reason, 220)}`,
    data: { verificationId: verification.id || '', status, taskStatus: verification.taskStatus || '' },
  });
}

function narration(base, patch) {
  const message = safeText(patch.message || '', 500);
  if (!message) return null;
  return {
    ...base,
    kind: normalizeKind(patch.kind),
    stage: String(patch.stage || 'runtime'),
    turn: patch.turn ?? null,
    toolName: patch.toolName ? String(patch.toolName) : '',
    message,
    text: message,
    data: normalizeObject(patch.data),
  };
}

function normalizeKind(kind) {
  const value = String(kind || '').trim();
  return ['thought', 'info', 'success', 'error'].includes(value) ? value : 'thought';
}

function verbForTool(name = '') {
  return ({
    read_file: '读取文件',
    read_remote_file: '读取远程文件',
    list_remote_dir: '查看远程目录',
    download_file: '下载文件',
    get_probe: '读取探针状态',
    get_probe_samples: '读取探针样本',
    get_probe_timeseries: '读取探针时序',
    get_probe_traffic: '读取流量数据',
    query_probe: '查询探针',
    list_probe_alerts: '查看探针告警',
    query_audit: '查询审计记录',
  })[String(name || '').trim()] || `使用 ${displayToolName(name)}`;
}

function displayToolName(name = '') {
  const value = String(name || '').trim();
  return ({
    execute_command: '执行命令',
    host_exec: '执行命令',
    read_file: '读取文件',
    list_hosts: '列出主机',
    get_probe: '读取探针',
    list_remote_dir: '列出目录',
    read_remote_file: '读取文件',
    write_remote_file: '写入文件',
    upload_file: '上传文件',
    download_file: '下载文件',
    verify_outcome: '验证结果',
    create_task: '创建任务草稿',
    write_task: '写入任务',
    package_agent_run: '打包 AgentRun',
    ask_user: '询问信息',
    request_secret: '请求凭据引用',
  })[value] || value || '工具';
}

function toolInputSummary(toolName = '', args = {}) {
  const input = normalizeObject(args);
  if (toolName === 'read_file') return input.path || '';
  if (['list_remote_dir', 'read_remote_file', 'download_file'].includes(toolName)) {
    return [input.hostId || '', input.path || ''].filter(Boolean).join(' · ');
  }
  if (toolName === 'get_probe' || toolName.startsWith('get_probe_')) return input.hostId || '';
  if (toolName === 'query_probe' || toolName === 'list_probe_alerts' || toolName === 'query_audit') {
    return [input.hostId || '', input.keyword || input.status || input.limit || ''].filter(Boolean).join(' · ');
  }
  try {
    return safeText(JSON.stringify(redactPotentialSecrets(input)), 160);
  } catch {
    return '';
  }
}

function summarizeApprovalPayload(toolName = '', value = '') {
  const text = typeof value === 'string' ? value : JSON.stringify(redactPotentialSecrets(value));
  if (!text) return displayToolName(toolName);
  const commandMatch = text.match(/(?:command=|命令：\s*\n?)([^\n]+)/i);
  const hostMatch = text.match(/(?:hostId=|主机：)([^\n]+)/i);
  if (commandMatch) {
    return `${displayToolName(toolName)}${hostMatch ? ` · ${hostMatch[1].trim()}` : ''} · ${compactCommand(commandMatch[1])}`;
  }
  return `${displayToolName(toolName)} · ${safeText(text, 180)}`;
}

function toolCallData(toolCall = {}) {
  return {
    toolCallId: toolCall.id || '',
    providerToolUseId: toolCall.providerToolUseId || '',
  };
}

function compactCommand(command = '') {
  return safeText(String(command || '').replace(/\s+/g, ' ').trim(), 180);
}

function firstReason(reasons) {
  if (!Array.isArray(reasons)) return '';
  return reasons.map((item) => String(item || '').trim()).find(Boolean) || '';
}

function safeText(value, maxLength = 500) {
  const text = redactPotentialSecrets(String(value ?? '').replace(/\s+/g, ' ').trim());
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function redactPotentialSecrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(/((?:api[-_]?key|secret|token|password|passwd|credential|auth)[\w.-]*\s*[:=]\s*)(["']?)[^\s"',;]+/ig, '$1$2<redacted>')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1<redacted>');
  }
  try {
    return JSON.parse(JSON.stringify(value || {}, (key, item) => {
      if (/token|key|secret|password|auth|credential/i.test(key)) return '<redacted>';
      return item;
    }));
  } catch {
    return {};
  }
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

module.exports = {
  buildPublicNarration,
};
