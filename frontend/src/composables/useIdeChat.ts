import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Socket } from 'socket.io-client';

import { useSocket } from '@/composables/useSocket';
import { bindIdeStreamHandlers, type IdeLegacyHandler } from '@/utils/ideStreamEvents';
import { createStreamDeltaBuffer } from '@/utils/streaming';

type IdeChatRole = 'user' | 'assistant';
type IdeChatStatus = 'streaming' | 'done' | 'error' | 'cancelled';
type IdeTimelineKind = 'user' | 'assistant' | 'thinking' | 'tool';
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
}

export interface IdeThinkingTimelineItem {
  id: string;
  kind: 'thinking';
  text: string;
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
  logs: IdeToolLogEntry[];
}

export type IdeTimelineItem = IdeChatMessage | IdeThinkingTimelineItem | IdeToolTimelineItem;

export interface IdeApprovalRequest {
  requestId: string;
  sessionId: string;
  title: string;
  toolName: string;
  detail: string;
  mode: 'approval' | 'ask_user' | 'request_secret';
  responseEvent: 'ide:approve-response' | 'ide:ask-user-response' | 'ide:secret-response';
  secretName?: string;
  label?: string;
  provider?: string;
  countdown: number;
}

export interface IdeChatOptions {
  sessionPrefix?: string;
  context?: () => Record<string, unknown>;
  messagePayload?: () => Record<string, unknown>;
}

export interface IdeChatApi {
  readonly timeline: Ref<IdeTimelineItem[]>;
  readonly inputText: Ref<string>;
  readonly isRunning: Ref<boolean>;
  readonly statusText: Ref<string>;
  readonly approveRequest: Ref<IdeApprovalRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly hasMessages: ComputedRef<boolean>;
  sendMessage(): void;
  prefillAndSend(message: string, onOpen?: () => void): void;
  stop(): void;
  resetChat(): void;
  approveAllow(): void;
  approveDeny(): void;
  approveCustom(): void;
  dispose(): void;
}

interface StreamMessage {
  sessionId?: string;
  runId?: string;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function messageText(value: unknown): string {
  return String(value ?? '').trim();
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
  let socket: Socket | null = null;
  let cleanupHandlers: (() => void) | null = null;
  let currentAssistant: IdeChatMessage | null = null;
  let activeRunId: string | null = null;
  let stoppedRunId: string | null = null;
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
    if (currentAssistant.text.trim()) {
      if (status) currentAssistant.status = status;
      touchTimeline();
    } else {
      const emptyId = currentAssistant.id;
      timeline.value = timeline.value.filter((item) => item.id !== emptyId);
    }
    currentAssistant = null;
  }

  function convertCurrentAssistantToThinking(): void {
    deltaBuffer.flushNow();
    if (!currentAssistant) return;
    const assistant = currentAssistant;
    currentAssistant = null;
    if (!assistant.text.trim()) {
      timeline.value = timeline.value.filter((item) => item.id !== assistant.id);
      return;
    }
    const thinking: IdeThinkingTimelineItem = {
      id: assistant.id,
      kind: 'thinking',
      text: assistant.text,
    };
    timeline.value = timeline.value.map((item) => (item.id === assistant.id ? thinking : item));
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

  function startTool(msg: StreamMessage & { name?: string; phase?: string; toolUseId?: string; input?: unknown }): void {
    convertCurrentAssistantToThinking();
    const tool = ensureTool(msg.toolUseId, msg.name || 'unknown');
    if (!tool) return;
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
      last.text += msg.text;
    } else {
      tool.logs.push({ stream, text: msg.text });
    }
    while (tool.logs.length > 80) tool.logs.shift();
    const current = tool.logs[tool.logs.length - 1];
    if (current && current.text.length > 12000) current.text = current.text.slice(-12000);
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

  function matchesCurrentRun(msg: StreamMessage | null | undefined, allowAfterStop = false): boolean {
    if (!msg || msg.sessionId !== sessionId) return false;
    if (msg.runId) {
      if (stoppedRunId && msg.runId === stoppedRunId && !allowAfterStop) return false;
      if (activeRunId && msg.runId !== activeRunId) return false;
      activeRunId = msg.runId;
    }
    if (stopRequested && !allowAfterStop) return false;
    return true;
  }

  function finalize(status: IdeChatStatus = 'done'): void {
    closeCurrentAssistant(status);
    isRunning.value = false;
    stopRequested = false;
    activeRunId = null;
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
    clearSendTimers();
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
        const msg = raw as StreamMessage & { name?: string; phase?: string; toolUseId?: string; input?: unknown };
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
      ['ide:done', (raw: unknown) => {
        const msg = raw as StreamMessage & { taskStatus?: string };
        if (!matchesCurrentRun(msg)) return;
        const status = ['blocked', 'failed'].includes(String(msg.taskStatus || '')) ? 'error' : 'done';
        setStatus(doneStatusText(msg.taskStatus));
        finalize(status);
      }],
      ['ide:error', (raw: unknown) => {
        const msg = raw as StreamMessage & { error?: string };
        if (!matchesCurrentRun(msg)) return;
        appendAssistantLine(`请求失败：${msg.error || '未知错误'}`, 'error');
        setStatus('出错');
        finalize('error');
      }],
      ['ide:cancelled', (raw: unknown) => {
        const msg = raw as StreamMessage;
        if (!matchesCurrentRun(msg, true)) return;
        if (msg.runId) stoppedRunId = msg.runId;
        setStatus('已停止');
        finalize('cancelled');
      }],
      ['ide:approve-request', (raw: unknown) => {
        const msg = raw as StreamMessage & { requestId?: string; title?: string; toolName?: string; detail?: string };
        if (!matchesCurrentRun(msg) || !msg.requestId) return;
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: msg.requestId,
          sessionId: msg.sessionId || sessionId,
          title: msg.title || '操作需要确认',
          toolName: msg.toolName || '操作',
          detail: msg.detail || '',
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

  function emitIdeMessage(sock: Socket, text: string): void {
    sendAckHandle = window.setTimeout(() => {
      appendAssistantLine('ide:message 已发送但未收到后端确认，请检查后端 Socket handler', 'error');
      setStatus('启动超时');
      finalize('error');
    }, 8000);

    sock.emit('ide:message', {
      sessionId,
      message: text,
      context: options.context?.() || {},
      ...(options.messagePayload?.() || {}),
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

  function sendWhenSocketReady(sock: Socket, text: string): void {
    if (sock.connected) {
      emitIdeMessage(sock, text);
      return;
    }

    setStatus('连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        window.clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(sock, text);
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

  function sendMessage(): void {
    const text = messageText(inputText.value);
    if (!text || isRunning.value) return;

    const sock = bindSocket();
    pushUserMessage(text);
    inputText.value = '';
    currentAssistant = null;
    activeRunId = null;
    stoppedRunId = null;
    stopRequested = false;
    currentTextHadDelta = false;
    isRunning.value = true;
    setStatus('启动中...');
    sendWhenSocketReady(sock, text);
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
    sessionId = makeId(options.sessionPrefix || 'ide-page');
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
    sendMessage,
    prefillAndSend,
    stop,
    resetChat,
    approveAllow,
    approveDeny,
    approveCustom,
    dispose,
  };
}
