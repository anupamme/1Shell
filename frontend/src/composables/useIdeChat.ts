import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Socket } from 'socket.io-client';

import { useSocket } from '@/composables/useSocket';
import { bindIdeStreamHandlers, type IdeLegacyHandler } from '@/utils/ideStreamEvents';
import { createStreamDeltaBuffer } from '@/utils/streaming';
import { displayAssistantTextAfterToolResult } from '@/utils/structuredToolResults';

type IdeChatRole = 'user' | 'assistant';
type IdeChatStatus = 'streaming' | 'done' | 'error' | 'cancelled';
type IdeTimelineKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'system';
export type IdeApprovalMode = 'manual' | 'delegated' | 'full_access';
export type IdeToolStatus = 'preparing' | 'running' | 'done' | 'error';
export type IdeToolLogStream = 'stdout' | 'stderr';

export interface IdeChatMessage {
  id: string;
  kind: Extract<IdeTimelineKind, 'user' | 'assistant'>;
  role: IdeChatRole;
  text: string;
  status?: IdeChatStatus;
}

export interface IdeToolLogEntry {
  stream: IdeToolLogStream;
  text: string;
  terminalText?: string;
}

export interface IdeThinkingTimelineItem {
  id: string;
  kind: 'thinking';
  text: string;
}

export interface IdeSystemTimelineItem {
  id: string;
  kind: 'system';
  title: string;
  text: string;
  tone?: 'info' | 'success' | 'warning';
}

export interface IdeToolTimelineItem {
  id: string;
  kind: 'tool';
  toolUseId: string;
  name: string;
  status: IdeToolStatus;
  startedAt: number;
  durationMs?: number;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  workNote?: string;
  logs: IdeToolLogEntry[];
}

export type IdeTimelineItem = IdeChatMessage | IdeThinkingTimelineItem | IdeToolTimelineItem | IdeSystemTimelineItem;

export interface IdeApprovalFacts {
  schemaVersion?: number;
  source?: string;
  toolName?: string;
  title?: string;
  reason?: string;
  riskReason?: string;
  riskLevel?: string;
  required?: boolean;
  recommended?: boolean;
  actionKind?: string;
  actionText?: string;
  detail?: string;
  hostId?: string;
  input?: unknown;
  summary?: {
    title?: string;
    detail?: string;
  };
  risk?: unknown;
}

export interface IdeApprovalRequest {
  requestId: string;
  sessionId: string;
  toolUseId?: string;
  title: string;
  toolName: string;
  detail: string;
  workNote?: string;
  reason?: string;
  riskReason?: string;
  riskLevel?: string;
  hostId?: string;
  actionKind?: string;
  actionText?: string;
  input?: unknown;
  approval?: IdeApprovalFacts;
  mode: 'approval' | 'ask_user' | 'request_secret';
  responseEvent: 'ide:approve-response' | 'ide:ask-user-response' | 'ide:secret-response';
  secretName?: string;
  label?: string;
  provider?: string;
  countdown: number;
}

export interface IdeChatOptions {
  sessionPrefix?: string;
  approvalMode?: IdeApprovalMode | (() => IdeApprovalMode);
  context?: () => Record<string, unknown>;
  messagePayload?: () => Record<string, unknown>;
  onTaskSaved?: (payload: IdeTaskSavedMessage) => void;
  onRunComplete?: () => void;
}

export interface IdeLoadableSession {
  id: string;
  timeline: IdeTimelineItem[];
  running?: boolean;
  runId?: string;
}

export interface IdeTaskSavedMessage extends StreamMessage {
  action?: 'created' | 'updated' | string;
  taskId?: string;
  task?: unknown;
  authoringEvidence?: unknown;
}

export interface IdeRewindPoint {
  id: string;
  ordinal: number;
  text: string;
  createdAt: string;
  undoCount: number;
  hostId?: string;
  messageLength?: number;
}

export interface IdeChatApi {
  readonly timeline: Ref<IdeTimelineItem[]>;
  readonly inputText: Ref<string>;
  readonly isRunning: Ref<boolean>;
  readonly statusText: Ref<string>;
  readonly approveRequest: Ref<IdeApprovalRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly hasMessages: ComputedRef<boolean>;
  readonly currentSessionId: Ref<string>;
  sendMessage(): void;
  prefillAndSend(message: string, onOpen?: () => void): void;
  listRewindPoints(): Promise<IdeRewindPoint[]>;
  loadSession(session: IdeLoadableSession): void;
  reattachSession(): Promise<{ ok?: boolean; running?: boolean; runId?: string; error?: string }>;
  stop(): void;
  resetChat(): void;
  approveAllow(): void;
  approveDeny(): void;
  approveCustom(): void;
  pushSystemEvent(title: string, text: string, tone?: IdeSystemTimelineItem['tone']): void;
  dispose(): void;
}

interface StreamMessage {
  sessionId?: string;
  runId?: string;
}

type IdeOutgoingMessagePayload = Record<string, unknown> & {
  context?: Record<string, unknown>;
};

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function messageText(value: unknown): string {
  return String(value ?? '').trim();
}

const TOOL_LOG_MAX_ENTRIES = 12;
const TOOL_LOG_MAX_VISIBLE_LINES = 140;
const TOOL_LOG_MAX_VISIBLE_CHARS = 9000;
const TOOL_LOG_MAX_STATE_LINES = 260;
const TOOL_LOG_MAX_STATE_CHARS = 18000;

function normalizeAnsiIntroducers(value: string): string {
  return value.replace(/(?:\uFFFD|\?)\[/g, '\x1b[');
}

function stripAnsi(value: string): string {
  return normalizeAnsiIntroducers(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '');
}

function parseCsiParam(params: string, fallback = 1): number {
  const first = String(params || '').split(';')[0]?.replace(/[^\d]/g, '');
  const value = first ? Number(first) : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimTerminalState(value: string): string {
  let text = value;
  const lines = text.split('\n');
  if (lines.length > TOOL_LOG_MAX_STATE_LINES) text = lines.slice(-TOOL_LOG_MAX_STATE_LINES).join('\n');
  if (text.length > TOOL_LOG_MAX_STATE_CHARS) text = text.slice(-TOOL_LOG_MAX_STATE_CHARS);
  return text;
}

function compactToolLogText(value: string): string {
  const lines = stripAnsi(value).replace(/\t/g, '  ').split('\n').map((line) => line.trimEnd());
  const compacted: string[] = [];
  let previous: string | null = null;
  let repeats = 0;

  const flush = () => {
    if (previous === null) return;
    if (repeats > 1 && previous.trim()) compacted.push(`${previous}  (重复 ${repeats} 次)`);
    else compacted.push(previous);
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
  if (visible.length > TOOL_LOG_MAX_VISIBLE_LINES) {
    const omitted = visible.length - TOOL_LOG_MAX_VISIBLE_LINES + 1;
    visible = [`... 已折叠前 ${omitted} 行输出 ...`, ...visible.slice(-(TOOL_LOG_MAX_VISIBLE_LINES - 1))];
  }

  let text = visible.join('\n');
  if (text.length > TOOL_LOG_MAX_VISIBLE_CHARS) {
    text = `... 已折叠前部输出 ...\n${text.slice(-TOOL_LOG_MAX_VISIBLE_CHARS)}`;
  }
  return text;
}

function applyTerminalDelta(existing: string, delta: string): string {
  const input = normalizeAnsiIntroducers(String(delta || '')).replace(/\r\n/g, '\n');
  const lines = existing ? existing.split('\n') : [''];
  let row = Math.max(0, lines.length - 1);
  let col = lines[row]?.length || 0;

  const ensureRow = () => {
    while (row >= lines.length) lines.push('');
    if (row < 0) row = 0;
  };

  const writeChar = (ch: string) => {
    ensureRow();
    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow();
      return;
    }
    if (ch === '\r') {
      col = 0;
      return;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      return;
    }
    const line = lines[row] || '';
    lines[row] = col >= line.length
      ? `${line}${' '.repeat(col - line.length)}${ch}`
      : `${line.slice(0, col)}${ch}${line.slice(col + 1)}`;
    col += 1;
  };

  const handleCsi = (params: string, final: string) => {
    const amount = parseCsiParam(params, 1);
    if (final === 'A') {
      row = Math.max(0, row - amount);
      col = Math.min(col, lines[row]?.length || 0);
      return;
    }
    if (final === 'B') {
      row += amount;
      ensureRow();
      col = Math.min(col, lines[row]?.length || 0);
      return;
    }
    if (final === 'G') {
      col = Math.max(0, amount - 1);
      return;
    }
    if (final === 'K') {
      ensureRow();
      const mode = Number(String(params || '0').replace(/[^\d]/g, '') || 0);
      const line = lines[row] || '';
      if (mode === 1) lines[row] = line.slice(col);
      else if (mode === 2) {
        lines[row] = '';
        col = 0;
      } else {
        lines[row] = line.slice(0, col);
      }
      return;
    }
    if (final === 'J' && String(params || '').includes('2')) {
      lines.splice(0, lines.length, '');
      row = 0;
      col = 0;
    }
  };

  for (let i = 0; i < input.length;) {
    const ch = input[i];
    if (ch === '\x1b' && input[i + 1] === '[') {
      let end = i + 2;
      while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end += 1;
      if (end < input.length) {
        handleCsi(input.slice(i + 2, end), input[end]);
        i = end + 1;
        continue;
      }
    }
    if (ch === '\x1b' && input[i + 1] === ']') {
      const bel = input.indexOf('\x07', i + 2);
      const st = input.indexOf('\x1b\\', i + 2);
      const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : (st >= 0 ? st + 2 : -1);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (ch === '\x9b') {
      let end = i + 1;
      while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end += 1;
      if (end < input.length) {
        handleCsi(input.slice(i + 1, end), input[end]);
        i = end + 1;
        continue;
      }
    }
    writeChar(ch);
    i += 1;
  }

  return trimTerminalState(stripAnsi(lines.join('\n')));
}

export function useIdeChat(options: IdeChatOptions = {}): IdeChatApi {
  const timeline = ref<IdeTimelineItem[]>([]);
  const inputText = ref('');
  const isRunning = ref(false);
  const statusText = ref('待命');
  const approveRequest = ref<IdeApprovalRequest | null>(null);
  const approveCustomText = ref('');
  const hasMessages = computed(() => timeline.value.length > 0);

  let sessionId = makeId(options.sessionPrefix || 'ide-page');
  const currentSessionId = ref(sessionId);
  function setSessionId(id: string): void {
    sessionId = id;
    currentSessionId.value = id;
  }
  let socket: Socket | null = null;
  let cleanupHandlers: (() => void) | null = null;
  let currentAssistant: IdeChatMessage | null = null;
  let activeRunId: string | null = null;
  let stoppedRunId: string | null = null;
  const completedRunIds = new Set<string>();
  let stopRequested = false;
  let currentTextHadDelta = false;
  let sendAckHandle: number | null = null;
  let sendConnectHandle: number | null = null;
  let stopFallbackHandle: number | null = null;
  let approveTickHandle: number | null = null;
  let pendingConnectSend: (() => void) | null = null;

  const deltaBuffer = createStreamDeltaBuffer((delta) => {
    const assistant = ensureAssistant();
    assistant.text += delta;
    assistant.status = 'streaming';
    touchTimeline();
  });

  function setStatus(text: string): void {
    statusText.value = text;
  }

  function touchTimeline(): void {
    timeline.value = [...timeline.value];
  }

  function ensureAssistant(): IdeChatMessage {
    if (!currentAssistant) {
      currentAssistant = {
        id: makeId('assistant'),
        kind: 'assistant',
        role: 'assistant',
        text: '',
        status: 'streaming',
      };
      timeline.value.push(currentAssistant);
    }
    return currentAssistant;
  }

  function pushUserMessage(text: string): void {
    timeline.value.push({
      id: makeId('user'),
      kind: 'user',
      role: 'user',
      text,
    });
  }

  function pushSystemEvent(title: string, text: string, tone: IdeSystemTimelineItem['tone'] = 'info'): void {
    const cleanTitle = messageText(title) || '系统事件';
    const cleanText = messageText(text);
    if (!cleanText) return;
    timeline.value.push({
      id: makeId('system'),
      kind: 'system',
      title: cleanTitle,
      text: cleanText,
      tone,
    });
  }

  function appendAssistantText(text: string): void {
    if (!text) return;
    deltaBuffer.push(text);
  }

  function appendAssistantLine(text: string, status: IdeChatStatus = 'error'): void {
    deltaBuffer.flushNow();
    const assistant = ensureAssistant();
    assistant.text = assistant.text ? `${assistant.text}\n\n${text}` : text;
    assistant.status = status;
    touchTimeline();
  }

  function closeCurrentAssistant(status?: IdeChatStatus): void {
    deltaBuffer.flushNow();
    if (!currentAssistant) return;
    const assistantIndex = timeline.value.findIndex((item) => item.id === currentAssistant?.id);
    if (assistantIndex >= 0) {
      currentAssistant.text = displayAssistantTextAfterToolResult(timeline.value, assistantIndex, currentAssistant.text);
    }
    if (currentAssistant.text.trim()) {
      if (status) currentAssistant.status = status;
      touchTimeline();
    } else {
      const emptyId = currentAssistant.id;
      timeline.value = timeline.value.filter((item) => item.id !== emptyId);
    }
    currentAssistant = null;
  }

  function convertCurrentAssistantToThinking(): string {
    deltaBuffer.flushNow();
    if (!currentAssistant) return '';
    const assistant = currentAssistant;
    currentAssistant = null;
    if (!assistant.text.trim()) {
      timeline.value = timeline.value.filter((item) => item.id !== assistant.id);
      return '';
    }
    const workNote = assistant.text.trim();
    const thinking: IdeThinkingTimelineItem = {
      id: assistant.id,
      kind: 'thinking',
      text: assistant.text,
    };
    timeline.value = timeline.value.map((item) => (item.id === assistant.id ? thinking : item));
    return workNote;
  }

  function findTool(toolUseId: string): IdeToolTimelineItem | null {
    return timeline.value.find((item): item is IdeToolTimelineItem => item.kind === 'tool' && item.toolUseId === toolUseId) || null;
  }

  function ensureTool(toolUseId: string | undefined, name = 'unknown'): IdeToolTimelineItem | null {
    const id = String(toolUseId || '').trim();
    if (!id) return null;
    const existing = findTool(id);
    if (existing) {
      if (name && name !== 'unknown') existing.name = name;
      return existing;
    }
    const tool: IdeToolTimelineItem = {
      id: `tool-${id}`,
      kind: 'tool',
      toolUseId: id,
      name: name || 'unknown',
      status: 'preparing',
      startedAt: Date.now(),
      logs: [],
    };
    timeline.value.push(tool);
    return tool;
  }

  function latestToolWorkNote(toolUseId?: string, toolName?: string): string {
    const id = String(toolUseId || '').trim();
    const name = String(toolName || '').trim();
    const tools = timeline.value.filter((item): item is IdeToolTimelineItem => item.kind === 'tool').slice().reverse();
    const exact = id ? tools.find((tool) => tool.toolUseId === id && tool.workNote?.trim()) : null;
    if (exact?.workNote) return exact.workNote.trim();
    const matching = name ? tools.find((tool) => tool.name === name && tool.workNote?.trim()) : null;
    if (matching?.workNote) return matching.workNote.trim();
    const active = tools.find((tool) => ['preparing', 'running'].includes(tool.status) && tool.workNote?.trim());
    return active?.workNote?.trim() || '';
  }

  function startTool(msg: StreamMessage & { name?: string; phase?: string; toolUseId?: string; input?: unknown; workNote?: string; modelNote?: string }): void {
    const visibleWorkNote = convertCurrentAssistantToThinking();
    const tool = ensureTool(msg.toolUseId, msg.name || 'unknown');
    if (!tool) return;
    const workNote = messageText(msg.workNote || msg.modelNote) || visibleWorkNote;
    if (workNote) tool.workNote = workNote;
    if (msg.phase === 'preparing_input' || msg.input === null) {
      if (tool.status !== 'running') tool.status = 'preparing';
    } else {
      tool.status = 'running';
      tool.input = msg.input;
    }
    touchTimeline();
  }

  function appendToolLog(msg: StreamMessage & { name?: string; toolUseId?: string; stream?: string; text?: string }): void {
    if (!msg.text) return;
    const tool = ensureTool(msg.toolUseId, msg.name || 'unknown');
    if (!tool) return;
    const stream: IdeToolLogStream = msg.stream === 'stderr' ? 'stderr' : 'stdout';
    const last = tool.logs[tool.logs.length - 1];
    if (last && last.stream === stream) {
      last.terminalText = applyTerminalDelta(last.terminalText ?? last.text, msg.text);
      last.text = compactToolLogText(last.terminalText);
    } else {
      const terminalText = applyTerminalDelta('', msg.text);
      tool.logs.push({ stream, terminalText, text: compactToolLogText(terminalText) });
    }
    while (tool.logs.length > TOOL_LOG_MAX_ENTRIES) tool.logs.shift();
    const current = tool.logs[tool.logs.length - 1];
    if (current?.terminalText) {
      current.terminalText = trimTerminalState(current.terminalText);
      current.text = compactToolLogText(current.terminalText);
    }
    touchTimeline();
  }

  function finishTool(msg: StreamMessage & { name?: string; toolUseId?: string; is_error?: boolean; result?: unknown }): void {
    closeCurrentAssistant();
    const tool = ensureTool(msg.toolUseId, msg.name || 'unknown');
    if (!tool) return;
    tool.status = msg.is_error ? 'error' : 'done';
    tool.isError = Boolean(msg.is_error);
    tool.result = msg.result;
    tool.durationMs = Date.now() - tool.startedAt;
    touchTimeline();
  }

  function rememberCompletedRun(runId = activeRunId): void {
    const id = String(runId || '').trim();
    if (!id) return;
    completedRunIds.add(id);
    if (completedRunIds.size > 30) {
      const first = completedRunIds.values().next().value;
      if (first) completedRunIds.delete(first);
    }
  }

  function matchesCurrentRun(msg: StreamMessage | null | undefined, allowAfterStop = false): boolean {
    if (!msg || msg.sessionId !== sessionId) return false;
    if (msg.runId) {
      const runId = String(msg.runId);
      if (completedRunIds.has(runId)) return false;
      if (stoppedRunId && runId === stoppedRunId && !allowAfterStop) return false;
      if (activeRunId && runId !== activeRunId) return false;
      activeRunId = runId;
    }
    if (stopRequested && !allowAfterStop) return false;
    return true;
  }

  function finalize(status: IdeChatStatus = 'done', runId?: string): void {
    rememberCompletedRun(runId || activeRunId);
    closeCurrentAssistant(status);
    deltaBuffer.clear();
    isRunning.value = false;
    stopRequested = false;
    activeRunId = null;
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
    clearSendTimers();
    options.onRunComplete?.();
  }

  function clearSendTimers(): void {
    if (sendAckHandle !== null) {
      window.clearTimeout(sendAckHandle);
      sendAckHandle = null;
    }
    if (sendConnectHandle !== null) {
      window.clearTimeout(sendConnectHandle);
      sendConnectHandle = null;
    }
    if (stopFallbackHandle !== null) {
      window.clearTimeout(stopFallbackHandle);
      stopFallbackHandle = null;
    }
    if (pendingConnectSend && socket) {
      socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
    }
  }

  function clearApproveTick(): void {
    if (approveTickHandle !== null) {
      window.clearInterval(approveTickHandle);
      approveTickHandle = null;
    }
  }

  function startApprovalCountdown(): void {
    clearApproveTick();
    approveTickHandle = window.setInterval(() => {
      const req = approveRequest.value;
      if (!req) {
        clearApproveTick();
        return;
      }
      req.countdown -= 1;
      if (req.countdown <= 0) respondApproval('deny');
    }, 1000);
  }

  function respondApproval(action: 'allow' | 'deny' | 'custom', text = ''): void {
    const req = approveRequest.value;
    if (!req || !socket) {
      approveRequest.value = null;
      clearApproveTick();
      return;
    }
    socket.emit(req.responseEvent, {
      requestId: req.requestId,
      sessionId: req.sessionId,
      action,
      text: text || '',
    });
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
  }

  function approveAllow(): void {
    respondApproval('allow');
  }

  function approveDeny(): void {
    respondApproval('deny');
  }

  function approveCustom(): void {
    const text = approveCustomText.value.trim();
    if (!text) return;
    respondApproval('custom', text);
  }

  function bindSocket(): Socket {
    if (!socket) socket = useSocket();
    if (cleanupHandlers) return socket;

    const handlers: IdeLegacyHandler[] = [
      ['ide:thinking', (raw: unknown) => {
        const msg = raw as StreamMessage;
        if (!matchesCurrentRun(msg)) return;
        currentTextHadDelta = false;
        setStatus('思考中...');
      }],
      ['ide:text-delta', (raw: unknown) => {
        const msg = raw as StreamMessage & { delta?: string };
        if (!matchesCurrentRun(msg) || !msg.delta) return;
        currentTextHadDelta = true;
        setStatus('生成中...');
        appendAssistantText(msg.delta);
      }],
      ['ide:text', (raw: unknown) => {
        const msg = raw as StreamMessage & { text?: string };
        if (!matchesCurrentRun(msg) || !msg.text || currentTextHadDelta) return;
        appendAssistantText(msg.text);
      }],
      ['ide:tool-start', (raw: unknown) => {
        const msg = raw as StreamMessage & { name?: string; phase?: string; toolUseId?: string; input?: unknown; workNote?: string; modelNote?: string };
        if (!matchesCurrentRun(msg)) return;
        startTool(msg);
        if (msg.phase === 'preparing_input' || msg.input === null) {
          setStatus('正在准备工具参数...');
          return;
        }
        setStatus(msg.name ? `正在调用 ${msg.name}...` : '正在调用工具...');
      }],
      ['ide:tool-delta', (raw: unknown) => {
        const msg = raw as StreamMessage & { name?: string; toolUseId?: string; stream?: string; text?: string };
        if (!matchesCurrentRun(msg) || !msg.text) return;
        appendToolLog(msg);
        setStatus('工具执行中...');
      }],
      ['ide:tool-end', (raw: unknown) => {
        const msg = raw as StreamMessage & { name?: string; toolUseId?: string; result?: unknown; is_error?: boolean };
        if (!matchesCurrentRun(msg)) return;
        finishTool(msg);
        setStatus(msg.is_error ? '工具返回错误' : '思考中...');
      }],
      ['ide:task-saved', (raw: unknown) => {
        const msg = raw as IdeTaskSavedMessage;
        if (!matchesCurrentRun(msg)) return;
        options.onTaskSaved?.(msg);
      }],
      ['ide:rewind', (raw: unknown) => {
        const msg = raw as StreamMessage & { timeline?: IdeTimelineItem[] };
        if (!matchesCurrentRun(msg)) return;
        deltaBuffer.clear();
        currentAssistant = null;
        timeline.value = Array.isArray(msg.timeline) ? [...msg.timeline] : [];
        approveRequest.value = null;
        approveCustomText.value = '';
        clearApproveTick();
        setStatus('已回溯');
      }],
      ['ide:done', (raw: unknown) => {
        const msg = raw as StreamMessage & { taskStatus?: string };
        if (!matchesCurrentRun(msg)) return;
        const status = ['blocked', 'failed'].includes(String(msg.taskStatus || '')) ? 'error' : 'done';
        setStatus(doneStatusText(msg.taskStatus));
        finalize(status, msg.runId);
      }],
      ['ide:error', (raw: unknown) => {
        const msg = raw as StreamMessage & { error?: string };
        if (!matchesCurrentRun(msg)) return;
        appendAssistantLine(`请求失败：${msg.error || '未知错误'}`, 'error');
        setStatus('出错');
        finalize('error', msg.runId);
      }],
      ['ide:cancelled', (raw: unknown) => {
        const msg = raw as StreamMessage;
        if (!matchesCurrentRun(msg, true)) return;
        if (msg.runId) stoppedRunId = msg.runId;
        setStatus('已停止');
        finalize('cancelled', msg.runId);
      }],
      ['ide:approve-request', (raw: unknown) => {
        const msg = raw as StreamMessage & {
          requestId?: string;
          toolUseId?: string;
          title?: string;
          toolName?: string;
          detail?: string;
          workNote?: string;
          modelNote?: string;
          reason?: string;
          riskReason?: string;
          riskLevel?: string;
          hostId?: string;
          actionKind?: string;
          actionText?: string;
          input?: unknown;
          approval?: IdeApprovalFacts;
        };
        if (!matchesCurrentRun(msg) || !msg.requestId) return;
        const approval = msg.approval && typeof msg.approval === 'object' ? msg.approval : undefined;
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: msg.requestId,
          sessionId: msg.sessionId || sessionId,
          toolUseId: msg.toolUseId || '',
          title: msg.title || approval?.title || '操作需要确认',
          toolName: msg.toolName || approval?.toolName || '操作',
          detail: msg.detail || approval?.detail || '',
          workNote: messageText(msg.workNote || msg.modelNote) || latestToolWorkNote(msg.toolUseId, msg.toolName || approval?.toolName),
          reason: msg.reason || approval?.reason || '',
          riskReason: msg.riskReason || approval?.riskReason || '',
          riskLevel: msg.riskLevel || approval?.riskLevel || '',
          hostId: msg.hostId || approval?.hostId || '',
          actionKind: msg.actionKind || approval?.actionKind || '',
          actionText: msg.actionText || approval?.actionText || '',
          input: msg.input ?? approval?.input,
          approval,
          mode: 'approval',
          responseEvent: 'ide:approve-response',
          countdown: 120,
        };
        startApprovalCountdown();
      }],
      ['ide:ask-user', (raw: unknown) => {
        const msg = raw as StreamMessage & { requestId?: string; title?: string; toolName?: string; detail?: string; question?: string; reason?: string };
        if (!matchesCurrentRun(msg) || !msg.requestId) return;
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: msg.requestId,
          sessionId: msg.sessionId || sessionId,
          title: msg.title || '需要补充信息',
          toolName: msg.toolName || 'ask_user',
          detail: msg.detail || msg.question || msg.reason || '',
          reason: msg.reason || '',
          actionKind: 'question',
          actionText: msg.question || msg.detail || msg.reason || '',
          mode: 'ask_user',
          responseEvent: 'ide:ask-user-response',
          countdown: 120,
        };
        startApprovalCountdown();
      }],
      ['ide:secret-request', (raw: unknown) => {
        const msg = raw as StreamMessage & { requestId?: string; title?: string; toolName?: string; detail?: string; question?: string; reason?: string; secretName?: string; label?: string; provider?: string };
        if (!matchesCurrentRun(msg) || !msg.requestId) return;
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: msg.requestId,
          sessionId: msg.sessionId || sessionId,
          title: msg.title || '需要 Secret 引用',
          toolName: msg.toolName || 'request_secret',
          detail: msg.detail || msg.question || msg.reason || '',
          reason: msg.reason || '',
          actionKind: 'secret',
          actionText: msg.question || msg.detail || msg.reason || '',
          mode: 'request_secret',
          responseEvent: 'ide:secret-response',
          secretName: msg.secretName || '',
          label: msg.label || '',
          provider: msg.provider || '',
          countdown: 120,
        };
        startApprovalCountdown();
      }],
    ];

    cleanupHandlers = bindIdeStreamHandlers(socket, handlers);
    return socket;
  }

  function doneStatusText(taskStatus?: string): string {
    if (taskStatus === 'blocked') return '已阻塞';
    if (taskStatus === 'failed') return '失败';
    if (taskStatus === 'unverified' || taskStatus === 'partial') return '未验证';
    return '完成';
  }

  function buildOutgoingMessagePayload(): IdeOutgoingMessagePayload {
    const approvalMode = typeof options.approvalMode === 'function'
      ? options.approvalMode()
      : options.approvalMode;
    return {
      context: options.context?.() || {},
      ...(approvalMode ? { approvalMode } : {}),
      ...(options.messagePayload?.() || {}),
    };
  }

  function emitIdeMessage(sock: Socket, text: string, payload: IdeOutgoingMessagePayload): void {
    sendAckHandle = window.setTimeout(() => {
      appendAssistantLine('ide:message 已发送但未收到后端确认，请检查后端 Socket handler', 'error');
      setStatus('启动超时');
      finalize('error');
    }, 8000);

    sock.emit('ide:message', {
      sessionId,
      message: text,
      ...payload,
    }, (ack: { ok?: boolean; error?: string } | undefined) => {
      if (sendAckHandle !== null) {
        window.clearTimeout(sendAckHandle);
        sendAckHandle = null;
      }
      if (!ack?.ok) {
        appendAssistantLine(ack?.error || 'ide:message 被拒绝', 'error');
        setStatus('启动失败');
        finalize('error');
      }
    });
  }

  function sendWhenSocketReady(sock: Socket, text: string, payload: IdeOutgoingMessagePayload): void {
    if (sock.connected) {
      emitIdeMessage(sock, text, payload);
      return;
    }

    setStatus('连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        window.clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(sock, text, payload);
    };
    sock.once('connect', pendingConnectSend);
    sock.connect();

    sendConnectHandle = window.setTimeout(() => {
      if (pendingConnectSend) sock.off('connect', pendingConnectSend);
      pendingConnectSend = null;
      appendAssistantLine('Socket 尚未连接，消息未发送；请确认后端已启动并刷新页面重试', 'error');
      setStatus('Socket 未连接');
      finalize('error');
    }, 8000);
  }

  function listRewindPoints(): Promise<IdeRewindPoint[]> {
    const sock = bindSocket();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: number | null = null;

      const finish = (err: Error | null, points: IdeRewindPoint[] = []) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
        sock.off('connect', emitRequest);
        if (err) reject(err);
        else resolve(points);
      };

      const emitRequest = () => {
        sock.emit('ide:rewind-list', { sessionId }, (ack: { ok?: boolean; error?: string; points?: IdeRewindPoint[] } | undefined) => {
          if (!ack?.ok) {
            finish(new Error(ack?.error || 'failed to load rewind points'));
            return;
          }
          finish(null, Array.isArray(ack.points) ? ack.points : []);
        });
      };

      timeoutHandle = window.setTimeout(() => {
        finish(new Error('rewind list request timed out'));
      }, 8000);

      if (sock.connected) {
        emitRequest();
        return;
      }

      sock.once('connect', emitRequest);
      sock.connect();
    });
  }

  function reattachSession(): Promise<{ ok?: boolean; running?: boolean; runId?: string; error?: string }> {
    const sock = bindSocket();
    return new Promise((resolve) => {
      const emitRequest = () => {
        sock.emit('ide:reattach', { sessionId }, (ack: { ok?: boolean; running?: boolean; runId?: string; error?: string } | undefined) => {
          const result = ack || { ok: false, error: 'reattach failed' };
          if (result.ok && result.running) {
            activeRunId = result.runId || activeRunId;
            isRunning.value = true;
            stopRequested = false;
            stoppedRunId = null;
            setStatus('思考中...');
          }
          resolve(result);
        });
      };

      if (sock.connected) {
        emitRequest();
        return;
      }
      sock.once('connect', emitRequest);
      sock.connect();
    });
  }

  function sendMessage(): void {
    const text = messageText(inputText.value);
    if (!text || isRunning.value) return;

    const sock = bindSocket();
    const payload = buildOutgoingMessagePayload();
    pushUserMessage(text);
    inputText.value = '';
    currentAssistant = null;
    activeRunId = null;
    stoppedRunId = null;
    completedRunIds.clear();
    stopRequested = false;
    currentTextHadDelta = false;
    isRunning.value = true;
    setStatus('启动中...');
    sendWhenSocketReady(sock, text, payload);
  }

  function prefillAndSend(message: string, onOpen?: () => void): void {
    const text = messageText(message);
    if (!text || isRunning.value) return;
    onOpen?.();
    inputText.value = text;
    window.setTimeout(() => sendMessage(), 120);
  }

  function stop(): void {
    if (!socket || !sessionId || !isRunning.value) return;
    stopRequested = true;
    if (activeRunId) stoppedRunId = activeRunId;
    socket.emit('ide:stop', { sessionId }, (ack: { ok?: boolean } | undefined) => {
      if (!ack?.ok && isRunning.value) {
        setStatus('停止请求失败');
        finalize('error');
      }
    });
    setStatus('正在停止...');
    if (stopFallbackHandle !== null) window.clearTimeout(stopFallbackHandle);
    stopFallbackHandle = window.setTimeout(() => {
      if (!isRunning.value) return;
      setStatus('已停止');
      finalize('cancelled');
    }, 2500);
  }

  function resetChat(): void {
    if (isRunning.value) return;
    if (socket && sessionId) socket.emit('ide:clear', { sessionId });
    setSessionId(makeId(options.sessionPrefix || 'ide-page'));
    timeline.value = [];
    currentAssistant = null;
    activeRunId = null;
    stoppedRunId = null;
    stopRequested = false;
    currentTextHadDelta = false;
    deltaBuffer.clear();
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
    setStatus('待命');
  }

  // Resume a persisted conversation: swap the active session id and rebuild the
  // timeline from the server projection. Does NOT emit ide:clear — the previous
  // session stays in history. The backend rehydrates model context (from its
  // in-memory map or DB) on the next ide:message for this id.
  function loadSession(session: IdeLoadableSession): void {
    if (isRunning.value || !session?.id) return;
    deltaBuffer.clear();
    setSessionId(session.id);
    timeline.value = Array.isArray(session.timeline) ? [...session.timeline] : [];
    currentAssistant = null;
    activeRunId = session.runId || null;
    stoppedRunId = null;
    stopRequested = false;
    currentTextHadDelta = false;
    completedRunIds.clear();
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
    isRunning.value = Boolean(session.running);
    setStatus('待命');
  }

  function dispose(): void {
    cleanupHandlers?.();
    cleanupHandlers = null;
    clearSendTimers();
    clearApproveTick();
    deltaBuffer.clear();
  }

  return {
    timeline,
    inputText,
    isRunning,
    statusText,
    approveRequest,
    approveCustomText,
    hasMessages,
    currentSessionId,
    sendMessage,
    prefillAndSend,
    listRewindPoints,
    loadSession,
    reattachSession,
    stop,
    resetChat,
    approveAllow,
    approveDeny,
    approveCustom,
    pushSystemEvent,
    dispose,
  };
}
