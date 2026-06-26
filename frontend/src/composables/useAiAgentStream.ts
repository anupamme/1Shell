import { bindIdeStreamHandlers, type IdeEventSocket, type IdeLegacyHandler } from '@/utils/ideStreamEvents';
import { createStreamDeltaBuffer, type StreamDeltaBuffer } from '@/utils/streaming';
import {
  appendAiLine,
  appendAiStreamDelta,
  appendAiToolLog,
  finishAiToolCall,
  markAiAssistantStatus,
  startAiToolCall,
  type AiAssistantTurn,
  type AiLineKind,
} from '@/utils/aiMessages';

export interface AiAgentSocketMessage {
  sessionId?: string;
  runId?: string;
  phase?: string;
}

export interface AiAgentApprovePayload extends AiAgentSocketMessage {
  requestId?: string;
  title?: string;
  toolName?: string;
  detail?: string;
}

export type AiAgentApproveRequest = AiAgentApprovePayload & { requestId: string };

export type AiAgentUserInputKind = 'ask_user' | 'request_secret';

export interface AiAgentUserInputPayload extends AiAgentSocketMessage {
  requestId?: string;
  title?: string;
  toolName?: string;
  detail?: string;
  question?: string;
  reason?: string;
  options?: string[];
  secretName?: string;
  label?: string;
  provider?: string;
  responseEvent?: string;
}

export type AiAgentUserInputRequest = AiAgentUserInputPayload & {
  requestId: string;
  kind: AiAgentUserInputKind;
  responseEvent: 'ide:ask-user-response' | 'ide:secret-response';
};

export interface AiAgentStreamController {
  readonly currentTextHadDelta: boolean;
  matchesCurrentRun(msg: AiAgentSocketMessage | null | undefined, options?: { allowStopped?: boolean; allowAfterStop?: boolean }): boolean;
  rememberStoppedRun(runId?: string | null): void;
  resetForNewRun(): void;
  resetForNewSession(): void;
  markStopRequested(): void;
  clearStopRequested(): void;
  setCurrentTextHadDelta(value: boolean): void;
}

export interface AiAgentStreamCallbacks {
  setStatus(text: string): void;
  finalize(): void;
  appendLine?: (kind: AiLineKind, text: string) => void;
  appendDelta?: (text: string) => void;
  replaceText?: (text: string) => void;
  flushDelta?: () => void;
  ensureAssistant?: () => AiAssistantTurn;
  getAssistant?: () => AiAssistantTurn | null;
  touchAssistant?: () => void;
  onToolStart?: (msg: AiAgentSocketMessage & { name?: string; toolUseId?: string; input?: unknown; phase?: string }) => void;
  onToolDelta?: (msg: AiAgentSocketMessage & { toolUseId?: string; stream?: string; text?: string }) => void;
  onToolEnd?: (msg: AiAgentSocketMessage & { result?: unknown; is_error?: boolean; toolUseId?: string }) => void;
  onDone?: (msg: AiAgentSocketMessage & { round?: number; taskStatus?: string }) => void;
  onError?: (msg: AiAgentSocketMessage & { error?: string }) => void;
  onCancelled?: (msg: AiAgentSocketMessage) => void;
  onApproveRequest?: (msg: AiAgentApproveRequest) => void;
  onUserInputRequest?: (msg: AiAgentUserInputRequest) => void;
}

function isPreparingToolInput(msg: { phase?: string; input?: unknown }): boolean {
  return msg.phase === 'preparing_input' || msg.input === null;
}

function isToolPreparationDelta(text: string): boolean {
  return /参数已生成|正在准备\s+\S+\s+参数|prepar(?:e|ing).{0,30}(argument|input)/i.test(text);
}

export function createAiAgentStreamController(getSessionId: () => string | null): AiAgentStreamController {
  let currentTextHadDelta = false;
  let activeRunId: string | null = null;
  let stopRequested = false;
  const stoppedRunIds = new Set<string>();

  function rememberStoppedRun(runId = activeRunId): void {
    if (!runId) return;
    stoppedRunIds.add(runId);
    if (stoppedRunIds.size > 20) {
      const firstStopped = stoppedRunIds.values().next().value;
      if (firstStopped) stoppedRunIds.delete(firstStopped);
    }
  }

  return {
    get currentTextHadDelta() { return currentTextHadDelta; },
    matchesCurrentRun(msg, options = {}) {
      if (!msg || msg.sessionId !== getSessionId()) return false;
      if (msg.runId) {
        if (stoppedRunIds.has(msg.runId) && !options.allowStopped) return false;
        if (activeRunId && msg.runId !== activeRunId) return false;
        activeRunId = msg.runId;
      }
      if (stopRequested && !options.allowAfterStop) return false;
      return true;
    },
    rememberStoppedRun,
    resetForNewRun() {
      activeRunId = null;
      stopRequested = false;
      currentTextHadDelta = false;
    },
    resetForNewSession() {
      activeRunId = null;
      stopRequested = false;
      currentTextHadDelta = false;
      stoppedRunIds.clear();
    },
    markStopRequested() { stopRequested = true; },
    clearStopRequested() { stopRequested = false; },
    setCurrentTextHadDelta(value) { currentTextHadDelta = value; },
  };
}

export function createAiAssistantDeltaBuffer(ensureAssistant: () => AiAssistantTurn, touchAssistant: () => void): StreamDeltaBuffer {
  return createStreamDeltaBuffer((flushed) => {
    appendAiStreamDelta(ensureAssistant(), flushed);
    touchAssistant();
  });
}

export function appendAiAssistantLine(
  deltaBuffer: StreamDeltaBuffer,
  ensureAssistant: () => AiAssistantTurn,
  touchAssistant: () => void,
  kind: AiLineKind,
  text: string,
): void {
  deltaBuffer.flushNow();
  appendAiLine(ensureAssistant(), kind, text);
  touchAssistant();
}

export function bindAiAgentStreamHandlers(
  socket: IdeEventSocket,
  controller: AiAgentStreamController,
  callbacks: AiAgentStreamCallbacks,
  extraHandlers: IdeLegacyHandler[] = [],
): () => void {
  const flushDelta = () => callbacks.flushDelta?.();
  const cancelledRunIds = new Set<string>();

  const handlers: IdeLegacyHandler[] = [
    ['ide:thinking', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage;
      if (!controller.matchesCurrentRun(m)) return;
      controller.setCurrentTextHadDelta(false);
      callbacks.setStatus(m.phase === 'compact' ? '正在压缩...' : '思考中...');
    }],
    ['ide:text', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { text?: string };
      if (!controller.matchesCurrentRun(m) || !m.text || controller.currentTextHadDelta) return;
      callbacks.appendDelta?.(m.text);
    }],
    ['ide:text-delta', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { delta?: string };
      if (!controller.matchesCurrentRun(m) || !m.delta) return;
      controller.setCurrentTextHadDelta(true);
      callbacks.setStatus('生成中...');
      callbacks.appendDelta?.(m.delta);
    }],
    ['ide:text-replace', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { text?: string };
      if (!controller.matchesCurrentRun(m) || typeof m.text !== 'string') return;
      controller.setCurrentTextHadDelta(true);
      callbacks.setStatus('生成中...');
      if (callbacks.replaceText) callbacks.replaceText(m.text);
      else if (callbacks.ensureAssistant && callbacks.touchAssistant) {
        flushDelta();
        const assistant = callbacks.ensureAssistant();
        const line = { kind: 'stream' as AiLineKind, text: m.text };
        assistant.lines = [line];
        assistant.events = [{ type: 'line', line }, ...assistant.events.filter((event) => event.type !== 'line')];
        assistant.status = 'streaming';
        callbacks.touchAssistant();
      }
      else {
        flushDelta();
        callbacks.appendDelta?.(m.text);
      }
    }],
    ['ide:tool-start', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { name?: string; toolUseId?: string; input?: unknown; phase?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (isPreparingToolInput(m)) {
        callbacks.setStatus('正在准备工具参数...');
        return;
      }
      if (callbacks.onToolStart) {
        callbacks.onToolStart(m);
        return;
      }
      if (!callbacks.ensureAssistant || !callbacks.touchAssistant) return;
      flushDelta();
      startAiToolCall(callbacks.ensureAssistant(), m.toolUseId || `tool-${Date.now()}`, m.name || 'unknown', m.input);
      callbacks.touchAssistant();
      callbacks.setStatus(m.name ? `调用 ${m.name}...` : '调用工具...');
    }],
    ['ide:tool-delta', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { toolUseId?: string; stream?: string; text?: string };
      if (!controller.matchesCurrentRun(m) || !m.toolUseId || !m.text) return;
      if (isToolPreparationDelta(m.text)) {
        callbacks.setStatus('正在准备工具参数...');
        return;
      }
      if (callbacks.onToolDelta) {
        callbacks.onToolDelta(m);
        return;
      }
      const assistant = callbacks.getAssistant?.();
      if (!assistant || !callbacks.touchAssistant) return;
      flushDelta();
      if (appendAiToolLog(assistant, m.toolUseId, m.stream === 'stderr' ? 'stderr' : 'stdout', m.text)) {
        callbacks.touchAssistant();
        callbacks.setStatus('工具执行中...');
      }
    }],
    ['ide:tool-end', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { result?: unknown; is_error?: boolean; toolUseId?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (callbacks.onToolEnd) {
        callbacks.onToolEnd(m);
      } else {
        const assistant = callbacks.getAssistant?.();
        if (assistant && m.toolUseId && callbacks.touchAssistant && finishAiToolCall(assistant, m.toolUseId, Boolean(m.is_error), m.result)) {
          callbacks.touchAssistant();
        }
      }
      callbacks.setStatus(m.is_error ? '工具返回错误' : '思考中...');
    }],
    ['ide:done', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { round?: number; taskStatus?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (callbacks.onDone) {
        callbacks.onDone(m);
        return;
      }
      flushDelta();
      const assistant = callbacks.getAssistant?.();
      markAiAssistantStatus(assistant || null, 'done');
      callbacks.touchAssistant?.();
      callbacks.setStatus(`完成 (${m.round ?? 0} 轮)`);
      callbacks.finalize();
    }],
    ['ide:error', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { error?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (callbacks.onError) {
        callbacks.onError(m);
        return;
      }
      callbacks.setStatus('出错');
      callbacks.appendLine?.('error', `✘ ${m.error || '未知错误'}`);
      callbacks.finalize();
    }],
    ['ide:cancelled', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage;
      if (!controller.matchesCurrentRun(m, { allowStopped: true, allowAfterStop: true })) return;
      const cancelKey = `cancelled:${m.runId || m.sessionId || 'current'}`;
      if (cancelledRunIds.has(cancelKey)) return;
      cancelledRunIds.add(cancelKey);
      if (callbacks.onCancelled) {
        callbacks.onCancelled(m);
        return;
      }
      flushDelta();
      const assistant = callbacks.getAssistant?.();
      markAiAssistantStatus(assistant || null, 'cancelled');
      callbacks.touchAssistant?.();
      controller.rememberStoppedRun(m.runId);
      callbacks.setStatus('已取消');
      callbacks.finalize();
    }],
    ['ide:approve-request', (msg: unknown) => {
      const m = msg as AiAgentApprovePayload;
      if (!controller.matchesCurrentRun(m) || !m.requestId) return;
      callbacks.onApproveRequest?.({ ...m, requestId: m.requestId });
    }],
    ['ide:ask-user', (msg: unknown) => {
      const m = msg as AiAgentUserInputPayload;
      if (!controller.matchesCurrentRun(m) || !m.requestId) return;
      callbacks.onUserInputRequest?.({
        ...m,
        requestId: m.requestId,
        kind: 'ask_user',
        responseEvent: 'ide:ask-user-response',
      });
    }],
    ['ide:secret-request', (msg: unknown) => {
      const m = msg as AiAgentUserInputPayload;
      if (!controller.matchesCurrentRun(m) || !m.requestId) return;
      callbacks.onUserInputRequest?.({
        ...m,
        requestId: m.requestId,
        kind: 'request_secret',
        responseEvent: 'ide:secret-response',
      });
    }],
    ...extraHandlers,
  ];

  return bindIdeStreamHandlers(socket, handlers);
}
