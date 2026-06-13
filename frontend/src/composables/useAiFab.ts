// useAiFab.ts — P5 跨页浮动 1Shell AI · 业务 composable
// 1:1 复刻 [public/ai-fab.js](public/ai-fab.js)（482 行）
// 与 useIdePanel（MainConsole 内置 1Shell AI）独立 —— sessionId 用 `fab-*` 前缀,会话隔离
// 拖拽位置 + 持久化 + 模块感知由 AppAiFab.vue 处理；本 composable 只管业务
//
// 1:1 沿用 ai-fab.js:273-283：自己 new io() 独立 socket 连接,不复用 useSessionTerminal 的主终端 socket。
// 原因：(1) 老版本就这样;(2) 复用 useSessionTerminal 会把 xterm 等重量级依赖 hoist 到 root bundle,
// 影响非 MainConsole 7 页的初次加载性能。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';

import { useNotifyStore } from '@/stores/notify';
import {
  appendAiAssistantLine,
  bindAiAgentStreamHandlers,
  createAiAgentStreamController,
  createAiAssistantDeltaBuffer,
} from '@/composables/useAiAgentStream';
import {
  createAiAssistantTurn,
  createAiUserTurn,
  type AiAgentTurn,
  type AiAssistantTurn,
  type AiLineKind,
  type AiTextLine,
  type AiToolCallState,
} from '@/utils/aiMessages';

export type FabLine = AiTextLine;
export type FabToolCall = AiToolCallState;
export type FabTurn = AiAgentTurn;

export interface FabApproveRequest {
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

export interface ModuleContext {
  name: string;
  icon: string;
  hint: string;
}

export interface AiFabApi {
  readonly turns: Ref<FabTurn[]>;
  readonly isRunning: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly statusText: Ref<string>;
  readonly approveRequest: Ref<FabApproveRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly hasMessages: ComputedRef<boolean>;
  readonly moduleCtx: Ref<ModuleContext>;

  initialize(): void;
  setModuleContext(ctx: ModuleContext): void;
  sendMessage(): void;
  stop(): void;
  resetChat(): void;
  approveAllow(): void;
  approveDeny(): void;
  approveCustom(): void;
  /** 外部接口（替代老 window.sendToAiFab）：预填消息并发送 */
  prefillAndSend(message: string, onOpen?: () => void): void;
}

type InternalAiFabApi = AiFabApi & { dispose(): void };

let _instance: InternalAiFabApi | null = null;

export function useAiFab(): AiFabApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetAiFabSingleton(): void {
  _instance?.dispose();
  _instance = null;
}

function truncate1500(s: unknown): string {
  const t = String(s ?? '').trim();
  return t.length > 1500 ? t.slice(0, 1500) + '\n...[truncated]' : t;
}

function genSessionId(): string {
  return 'fab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create(): InternalAiFabApi {
  const notify = useNotifyStore();

  const turns = ref<FabTurn[]>([]);
  const isRunning = ref(false);
  const inputText = ref('');
  const statusText = ref('待命');
  const approveRequest = ref<FabApproveRequest | null>(null);
  const approveCustomText = ref('');
  const moduleCtx = ref<ModuleContext>({ name: '1Shell', icon: '🖥', hint: '' });

  const hasMessages = computed(() => turns.value.length > 0);

  let sessionId: string | null = null;
  let currentAssistant: AiAssistantTurn | null = null;
  let socket: Socket | null = null;
  let socketBound = false;
  let approveTickHandle: number | null = null;
  let stopFallbackHandle: number | null = null;
  let sendAckHandle: number | null = null;
  let sendConnectHandle: number | null = null;
  let pendingConnectSend: (() => void) | null = null;
  let streamCleanup: (() => void) | null = null;
  const streamController = createAiAgentStreamController(() => sessionId);

  function ensureSocket(): Socket | null {
    if (socket) return socket;
    // 1:1 复刻 ai-fab.js:281-283 — 独立 io 连接（vite proxy 自动转发到后端）
    socket = io({ transports: ['websocket', 'polling'] });
    return socket;
  }

  function getSocket(): Socket | null { return socket; }

  function setStatus(text: string): void { statusText.value = text; }

  function pushUser(text: string): void {
    turns.value.push(createAiUserTurn(text));
    currentAssistant = null;
  }

  function ensureAssistant(): AiAssistantTurn {
    if (!currentAssistant) {
      const t = createAiAssistantTurn();
      turns.value.push(t);
      currentAssistant = t;
    }
    return currentAssistant;
  }

  function touchTurns(): void {
    turns.value = [...turns.value];
  }

  function appendLine(kind: AiLineKind, text: string): void {
    appendAiAssistantLine(deltaBuffer, ensureAssistant, touchTurns, kind, text);
  }

  const deltaBuffer = createAiAssistantDeltaBuffer(ensureAssistant, touchTurns);

  function appendDelta(text: string): void {
    deltaBuffer.push(text);
  }

  function finalize(): void {
    deltaBuffer.flushNow();
    isRunning.value = false;
    streamController.clearStopRequested();
    currentAssistant = null;
    approveRequest.value = null;
    approveCustomText.value = '';
    clearApproveTick();
    if (stopFallbackHandle !== null) {
      window.clearTimeout(stopFallbackHandle);
      stopFallbackHandle = null;
    }
    if (sendAckHandle !== null) {
      window.clearTimeout(sendAckHandle);
      sendAckHandle = null;
    }
    if (sendConnectHandle !== null) {
      window.clearTimeout(sendConnectHandle);
      sendConnectHandle = null;
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

  function respondApprove(action: 'allow' | 'deny' | 'custom', text = ''): void {
    const req = approveRequest.value;
    const socket = getSocket();
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

  function approveAllow(): void { respondApprove('allow'); }
  function approveDeny(): void { respondApprove('deny'); }
  function approveCustom(): void {
    const text = approveCustomText.value.trim();
    if (!text) return;
    respondApprove('custom', text);
  }

  function bindSocket(): void {
    if (socketBound) return;
    const socket = getSocket();
    if (!socket) return;
    socketBound = true;

    streamCleanup = bindAiAgentStreamHandlers(socket, streamController, {
      setStatus,
      finalize,
      appendLine,
      appendDelta,
      flushDelta: () => deltaBuffer.flushNow(),
      ensureAssistant,
      getAssistant: () => currentAssistant,
      touchAssistant: touchTurns,
      onApproveRequest: (m) => {
        clearApproveTick();
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: m.requestId,
          sessionId: m.sessionId || sessionId || '',
          title: m.title || 'Agent 审批',
          toolName: m.toolName || '操作',
          detail: m.detail || '',
          mode: 'approval',
          responseEvent: 'ide:approve-response',
          countdown: 120,
        };
        approveTickHandle = window.setInterval(() => {
          const req = approveRequest.value;
          if (!req) { clearApproveTick(); return; }
          req.countdown -= 1;
          if (req.countdown <= 0) respondApprove('deny');
        }, 1000);
      },
      onUserInputRequest: (m) => {
        clearApproveTick();
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: m.requestId,
          sessionId: m.sessionId || sessionId || '',
          title: m.title || (m.kind === 'request_secret' ? '需要 Secret 引用' : '需要补充信息'),
          toolName: m.toolName || (m.kind === 'request_secret' ? 'request_secret' : 'ask_user'),
          detail: m.detail || m.question || m.reason || '',
          mode: m.kind,
          responseEvent: m.responseEvent,
          secretName: m.secretName || '',
          label: m.label || '',
          provider: m.provider || '',
          countdown: 120,
        };
        approveTickHandle = window.setInterval(() => {
          const req = approveRequest.value;
          if (!req) { clearApproveTick(); return; }
          req.countdown -= 1;
          if (req.countdown <= 0) respondApprove('deny');
        }, 1000);
      },
    });
  }

  function setModuleContext(ctx: ModuleContext): void {
    moduleCtx.value = ctx;
  }

  function buildContext(): Record<string, unknown> {
    // 1:1 复刻 ai-fab.js:369-379 — module + moduleHint（无 hostSel,新版本路由内自动取）
    return {
      module: moduleCtx.value.name,
      moduleHint: moduleCtx.value.hint,
    };
  }

  function emitIdeMessage(socket: Socket, text: string): void {
    sendAckHandle = window.setTimeout(() => {
      setStatus('启动超时');
      appendLine('error', 'ide:message 已发送但未收到后端确认，请检查后端 Socket handler');
      finalize();
    }, 8000);

    socket.emit('ide:message', {
      sessionId,
      message: text,
      context: buildContext(),
    }, (ack: { ok?: boolean; error?: string } | undefined) => {
      if (sendAckHandle !== null) {
        window.clearTimeout(sendAckHandle);
        sendAckHandle = null;
      }
      if (!ack?.ok) {
        setStatus('启动失败');
        appendLine('error', ack?.error || 'ide:message 被拒绝');
        finalize();
      }
    });
  }

  function sendWhenSocketReady(socket: Socket, text: string): void {
    if (socket.connected) {
      emitIdeMessage(socket, text);
      return;
    }
    setStatus('连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        window.clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(socket, text);
    };
    socket.once('connect', pendingConnectSend);
    socket.connect();
    sendConnectHandle = window.setTimeout(() => {
      if (pendingConnectSend) socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
      setStatus('Socket 未连接');
      appendLine('error', 'Socket 尚未连接，ide:message 未发送；请确认后端已启动并刷新页面重试');
      finalize();
    }, 8000);
  }

  function sendMessage(): void {
    const text = inputText.value.trim();
    if (!text || isRunning.value) return;
    const socket = ensureSocket();
    if (!socket) {
      notify.error('Socket 未连接');
      return;
    }

    bindSocket();

    if (!sessionId) {
      sessionId = genSessionId();
    }

    streamController.resetForNewRun();
    pushUser(text);
    inputText.value = '';

    ensureAssistant();
    isRunning.value = true;
    setStatus('启动中...');

    sendWhenSocketReady(socket, text);
  }

  function stop(): void {
    const socket = getSocket();
    if (!socket || !sessionId) return;
    const stoppedSessionId = sessionId;
    streamController.markStopRequested();
    streamController.rememberStoppedRun();
    socket.emit('ide:stop', { sessionId: stoppedSessionId }, (ack: { ok?: boolean } | undefined) => {
      if (!ack?.ok && isRunning.value) {
        setStatus('停止请求失败');
        finalize();
      }
    });
    setStatus('正在停止...');
    if (stopFallbackHandle !== null) window.clearTimeout(stopFallbackHandle);
    stopFallbackHandle = window.setTimeout(() => {
      if (isRunning.value && sessionId === stoppedSessionId) {
        setStatus('已停止');
        finalize();
      }
    }, 2500);
  }

  function resetChat(): void {
    if (isRunning.value) return;
    const socket = getSocket();
    if (sessionId && socket) {
      socket.emit('ide:clear', { sessionId });
    }
    sessionId = null;
    streamController.resetForNewSession();
    currentAssistant = null;
    deltaBuffer.clear();
    turns.value = [];
    setStatus('待命');
  }

  function prefillAndSend(message: string, onOpen?: () => void): void {
    onOpen?.();
    inputText.value = message;
    setTimeout(() => sendMessage(), 300);
  }

  let initialized = false;
  function initialize(): void {
    if (initialized) return;
    initialized = true;
  }

  function dispose(): void {
    streamCleanup?.();
    streamCleanup = null;
    finalize();
    socketBound = false;
    socket?.disconnect();
    socket = null;
  }

  return {
    turns,
    isRunning,
    inputText,
    statusText,
    approveRequest,
    approveCustomText,
    hasMessages,
    moduleCtx,
    initialize,
    setModuleContext,
    sendMessage,
    stop,
    resetChat,
    approveAllow,
    approveDeny,
    approveCustom,
    prefillAndSend,
    dispose,
  };
}
