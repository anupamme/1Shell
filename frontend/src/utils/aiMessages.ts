export type AiLineKind = 'stdout' | 'stderr' | 'info' | 'thought' | 'error' | 'success' | 'stream';
export type AiMessageStatus = 'idle' | 'thinking' | 'streaming' | 'tool_running' | 'done' | 'error' | 'cancelled';
export type AiToolCallStatus = 'running' | 'done' | 'error';
export type AiToolLogStream = 'stdout' | 'stderr';

export interface AiTextLine {
  kind: AiLineKind;
  text: string;
}

export type AiAssistantEvent =
  | { type: 'line'; line: AiTextLine }
  | { type: 'tool'; toolUseId: string };

export interface AiToolLogEntry {
  stream: AiToolLogStream;
  text: string;
}

export interface AiToolNoteEntry {
  kind: AiLineKind;
  text: string;
}

export interface AiToolCallState {
  toolUseId: string;
  name: string;
  status: AiToolCallStatus;
  startedAt: number;
  durationMs?: number;
  input?: unknown;
  result?: unknown;
  error?: string;
  logs?: AiToolLogEntry[];
  notes?: AiToolNoteEntry[];
}

export interface AiUserTurn {
  role: 'user';
  text: string;
}

export interface AiAssistantTurn {
  role: 'assistant';
  status: AiMessageStatus;
  lines: AiTextLine[];
  toolCalls: AiToolCallState[];
  events: AiAssistantEvent[];
}

export type AiAgentTurn = AiUserTurn | AiAssistantTurn;

export function createAiUserTurn(text: string): AiUserTurn {
  return { role: 'user', text };
}

export function createAiAssistantTurn(status: AiMessageStatus = 'thinking'): AiAssistantTurn {
  return { role: 'assistant', status, lines: [], toolCalls: [], events: [] };
}

export function appendAiLine(turn: AiAssistantTurn, kind: AiLineKind, text: string): void {
  const line = { kind, text };
  turn.lines.push(line);
  ensureAiAssistantEvents(turn).push({ type: 'line', line });
  if (kind === 'error') turn.status = 'error';
  else if (kind === 'stream') turn.status = 'streaming';
}

export function appendAiStreamDelta(turn: AiAssistantTurn, delta: string): void {
  const last = turn.lines[turn.lines.length - 1];
  if (last && last.kind === 'stream') {
    last.text += delta;
  } else {
    const line = { kind: 'stream' as const, text: delta };
    turn.lines.push(line);
    ensureAiAssistantEvents(turn).push({ type: 'line', line });
  }
  turn.status = 'streaming';
}

export function startAiToolCall(turn: AiAssistantTurn, toolUseId: string, name: string, input?: unknown): AiToolCallState {
  const existing = turn.toolCalls.find((item) => item.toolUseId === toolUseId);
  if (existing) {
    existing.name = name || existing.name;
    existing.input = input ?? existing.input;
    turn.toolCalls = [...turn.toolCalls];
    if (existing.status === 'running') turn.status = 'tool_running';
    return existing;
  }
  const call: AiToolCallState = {
    toolUseId,
    name,
    status: 'running',
    startedAt: Date.now(),
    input,
  };
  turn.toolCalls = [...turn.toolCalls, call];
  ensureAiAssistantEvents(turn).push({ type: 'tool', toolUseId });
  turn.status = 'tool_running';
  return call;
}

export function finishAiToolCall(turn: AiAssistantTurn, toolUseId: string, isError = false, result?: unknown): AiToolCallState | null {
  const call = turn.toolCalls.find((item) => item.toolUseId === toolUseId);
  if (!call) return null;
  call.status = isError ? 'error' : 'done';
  call.durationMs = Date.now() - call.startedAt;
  call.result = result;
  call.error = isError ? summarizeToolValue(result) || '工具返回错误' : undefined;
  turn.toolCalls = [...turn.toolCalls];
  turn.status = isError ? 'error' : 'thinking';
  return call;
}

export function appendAiToolLog(turn: AiAssistantTurn, toolUseId: string, stream: AiToolLogStream, text: string): AiToolCallState | null {
  const call = turn.toolCalls.find((item) => item.toolUseId === toolUseId);
  if (!call || !text) return null;
  const logs = call.logs || (call.logs = []);
  const last = logs[logs.length - 1];
  if (last && last.stream === stream) {
    last.text += text;
  } else {
    logs.push({ stream, text });
  }
  while (logs.length > 80) logs.shift();
  const current = logs[logs.length - 1];
  if (current && current.text.length > 12000) current.text = current.text.slice(-12000);
  turn.toolCalls = [...turn.toolCalls];
  turn.status = 'tool_running';
  return call;
}

export function appendAiToolNote(turn: AiAssistantTurn, toolUseId: string, kind: AiLineKind, text: string): AiToolCallState | null {
  const call = turn.toolCalls.find((item) => item.toolUseId === toolUseId);
  if (!call || !text) return null;
  const notes = call.notes || (call.notes = []);
  const last = notes[notes.length - 1];
  if (last && last.kind === kind && last.text === text) return call;
  notes.push({ kind, text });
  while (notes.length > 12) notes.shift();
  turn.toolCalls = [...turn.toolCalls];
  return call;
}

export function summarizeToolValue(value: unknown, maxLength = 1200): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

function shortText(value: unknown, maxLength = 90): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function pathTail(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

function countLabel(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === 'object') return `${Object.keys(value).length} 项`;
  return '';
}

function genericInputSummary(input: unknown): string {
  const record = asRecord(input);
  const entries = Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${shortText(typeof value === 'object' ? summarizeToolValue(value, 80) : value, 80)}`);
  if (entries.length) return entries.join(' · ');
  return summarizeToolValue(input, 120).replace(/\s+/g, ' ').trim() || '无参数';
}

export function toolDisplayName(name: string): string {
  return ({
    host_exec: '执行命令',
    execute_command: '执行命令',
    list_hosts: '列出主机',
    list_scripts: '列出脚本',
    run_script: '运行脚本',
    list_remote_dir: '列出目录',
    read_remote_file: '读取文件',
    write_remote_file: '写入文件',
    upload_file: '上传文件',
    download_file: '下载文件',
    list_mcp_servers: '列出 MCP',
    add_mcp_server: '添加 MCP',
    remove_mcp_server: '删除 MCP',
    deploy_local_mcp: '部署 MCP',
    query_audit: '查询审计',
    ask_user: '询问信息',
    request_secret: '请求凭据引用',
    verify_outcome: '验证结果',
    query_probe: '查询探针',
    list_probes: '列出探针',
    get_probe: '读取探针',
    get_probe_samples: '探针样本',
    get_probe_timeseries: '探针时序',
    get_probe_traffic: '探针流量',
    list_probe_alerts: '探针告警',
    ack_probe_alert: '忽略告警',
    install_probe_agent: '安装探针 Agent',
    restart_probe_agent: '重启探针 Agent',
    uninstall_probe_agent: '卸载探针 Agent',
    probe_diag_ping: 'Ping 诊断',
    probe_diag_http: 'HTTP 诊断',
    probe_diag_dns: 'DNS 诊断',
  } as Record<string, string>)[name] || name;
}

export function summarizeToolInput(call: AiToolCallState): string {
  const input = asRecord(call.input);
  const hostId = textField(input, 'hostId');
  const command = textField(input, 'command');
  const path = textField(input, 'path');
  const dirPath = textField(input, 'dirPath');
  const localPath = textField(input, 'localPath');
  const filename = textField(input, 'filename');

  switch (call.name) {
    case 'host_exec':
    case 'execute_command':
      return [hostId, shortText(command, 120)].filter(Boolean).join(' · ') || genericInputSummary(call.input);
    case 'run_script':
      return [hostId, `script: ${textField(input, 'scriptId')}`, countLabel(input.params)].filter(Boolean).join(' · ');
    case 'list_remote_dir':
      return [hostId, pathTail(path || '~')].filter(Boolean).join(' · ');
    case 'read_remote_file':
    case 'download_file':
      return [hostId, pathTail(path), localPath ? `保存到 ${pathTail(localPath)}` : ''].filter(Boolean).join(' · ');
    case 'write_remote_file':
      return [hostId, pathTail(path), input.backup ? '备份' : '', textField(input, 'content') ? `${String(textField(input, 'content')).length} 字符` : ''].filter(Boolean).join(' · ');
    case 'upload_file':
      return [hostId, pathTail([dirPath, filename].filter(Boolean).join('/')), localPath ? `来自 ${pathTail(localPath)}` : ''].filter(Boolean).join(' · ');
    case 'list_scripts':
      return [textField(input, 'category'), textField(input, 'keyword')].filter(Boolean).join(' · ') || '全部脚本';
    case 'add_mcp_server':
      return [textField(input, 'name'), textField(input, 'url') || shortText(textField(input, 'command'))].filter(Boolean).join(' · ');
    case 'remove_mcp_server':
      return textField(input, 'id') || genericInputSummary(call.input);
    case 'deploy_local_mcp':
      return [textField(input, 'name'), textField(input, 'repoUrl')].filter(Boolean).join(' · ');
    case 'ask_user':
      return shortText(textField(input, 'question') || textField(input, 'reason'), 120) || genericInputSummary(call.input);
    case 'request_secret':
      return [textField(input, 'label') || textField(input, 'name'), textField(input, 'provider')].filter(Boolean).join(' · ') || genericInputSummary(call.input);
    case 'verify_outcome':
      return [textField(input, 'type'), textField(input, 'hostId'), textField(input, 'url') || textField(input, 'path') || textField(input, 'port')].filter(Boolean).join(' · ') || genericInputSummary(call.input);
    case 'query_audit':
      return [textField(input, 'action'), textField(input, 'source'), textField(input, 'hostId'), textField(input, 'keyword')].filter(Boolean).join(' · ') || '最近审计';
    case 'get_probe':
    case 'get_probe_samples':
    case 'get_probe_timeseries':
    case 'get_probe_traffic':
    case 'install_probe_agent':
    case 'restart_probe_agent':
    case 'uninstall_probe_agent':
      return hostId || genericInputSummary(call.input);
    case 'probe_diag_ping':
      return [hostId, textField(input, 'target')].filter(Boolean).join(' · ');
    case 'probe_diag_http':
      return [hostId, textField(input, 'method') || 'GET', textField(input, 'url')].filter(Boolean).join(' · ');
    case 'probe_diag_dns':
      return [hostId, textField(input, 'name')].filter(Boolean).join(' · ');
    case 'list_hosts':
    case 'list_mcp_servers':
    case 'list_probes':
      return '无参数';
    case 'list_probe_alerts':
      return [textField(input, 'status') || 'open', textField(input, 'limit') ? `${textField(input, 'limit')} 条` : ''].filter(Boolean).join(' · ');
    case 'ack_probe_alert':
      return input.ackAll ? '全部告警' : textField(input, 'eventId') || genericInputSummary(call.input);
    default:
      return genericInputSummary(call.input);
  }
}

export function summarizeToolResult(call: AiToolCallState): string {
  if (call.status === 'running') return '等待结果';
  if (call.error) return shortText(call.error, 120);
  const result = call.result;
  const record = asRecord(result);
  const exitCode = textField(record, 'exitCode');
  if (exitCode) {
    const stdout = textField(record, 'stdout');
    const stderr = textField(record, 'stderr');
    return [`exit ${exitCode}`, stdout ? `stdout ${stdout.length} 字符` : '', stderr ? `stderr ${stderr.length} 字符` : ''].filter(Boolean).join(' · ');
  }
  const counted = countLabel(result);
  if (counted) return counted;
  const text = summarizeToolValue(result, 160).trim();
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return shortText(firstLine || text, 120) || '无输出';
}

export function markAiAssistantStatus(turn: AiAssistantTurn | null, status: AiMessageStatus): void {
  if (turn) turn.status = status;
}

export function orderedAiAssistantEvents(turn: AiAssistantTurn): AiAssistantEvent[] {
  const events = ensureAiAssistantEvents(turn);
  if (events.length > 0) return events;
  return [
    ...(turn.lines || []).map((line) => ({ type: 'line' as const, line })),
    ...(turn.toolCalls || []).map((call) => ({ type: 'tool' as const, toolUseId: call.toolUseId })),
  ];
}

export function aiToolCallById(turn: AiAssistantTurn, toolUseId: string): AiToolCallState | null {
  return (turn.toolCalls || []).find((call) => call.toolUseId === toolUseId) || null;
}

function ensureAiAssistantEvents(turn: AiAssistantTurn): AiAssistantEvent[] {
  if (!Array.isArray(turn.events)) turn.events = [];
  return turn.events;
}
