// useIdePanel.ts — MainConsole 刀 5a · 1Shell AI 右栏面板
// 1:1 复刻 [public/ide-panel.js](public/ide-panel.js)（467 行）
// 单例：socket lifecycle 绑定 / safe / cc / unlimited 三 toggle / 安全模式审批 / send / stop / clear
//
// 老版 index.html 实际没有 ide-tool-toggle / ide-tool-picker / ide-tool-chips DOM
// （ide-panel.js 里 getElementById 为 null 时静默 no-op），故 1:1 不带工具选择器 UI
// → 不调 loadTools / buildContext 也不带 skills / mcpServers 字段（用户看到的与老版一致）

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { bindIdeStreamHandlers } from '@/utils/ideStreamEvents';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import { createStreamDeltaBuffer } from '@/utils/streaming';
import {
  appendAiLine,
  appendAiStreamDelta,
  appendAiToolLog,
  createAiAssistantTurn,
  createAiUserTurn,
  finishAiToolCall,
  markAiAssistantStatus,
  startAiToolCall,
  type AiAgentTurn,
  type AiAssistantTurn,
  type AiLineKind,
  type AiTextLine,
  type AiToolCallState,
} from '@/utils/aiMessages';

interface MinimalSocket {
  connected?: boolean;
  connect?(): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener?: (...args: unknown[]) => void): unknown;
}

export type IdeLine = AiTextLine;
export type IdeToolCall = AiToolCallState;
export type IdeTurn = AiAgentTurn;

export interface IdeApproveRequest {
  requestId: string;
  sessionId: string;
  title: string;
  toolName: string;
  detail: string;
  /** 剩余秒数（响应式倒计时） */
  countdown: number;
}

export interface IdePanelApi {
  readonly turns: Ref<IdeTurn[]>;
  readonly isRunning: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly statusText: Ref<string>;
  readonly safeMode: Ref<boolean>;
  readonly claudeCodeEnabled: Ref<boolean>;
  readonly unlimitedTurns: Ref<boolean>;
  readonly approveRequest: Ref<IdeApproveRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly hasMessages: ComputedRef<boolean>;

  initialize(): void;
  sendMessage(): void;
  stop(): void;
  resetChat(): void;
  setSafeMode(v: boolean): void;
  setClaudeCodeEnabled(v: boolean): void;
  setUnlimitedTurns(v: boolean): void;
  approveAllow(): void;
  approveDeny(): void;
  approveCustom(): void;
}

type InternalIdePanelApi = IdePanelApi & { dispose(): void };

let _instance: InternalIdePanelApi | null = null;

export function useIdePanel(): IdePanelApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetIdePanelSingleton(): void {
  _instance?.dispose();
  _instance = null;
}

function truncate(s: unknown): string {
  const t = String(s ?? '').trim();
  return t.length > 2000 ? t.slice(0, 2000) + '\n...[truncated]' : t;
}

function genSessionId(): string {
  return 'ide-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create(): InternalIdePanelApi {
  const sessionTerminal = useSessionTerminal();
  const hosts = useHostsStore();
  const notify = useNotifyStore();

  const turns = ref<IdeTurn[]>([]);
  const isRunning = ref(false);
  const inputText = ref('');
  const statusText = ref('待命');
  const safeMode = ref(false);
  const claudeCodeEnabled = ref(false);
  const unlimitedTurns = ref(false);

  const approveRequest = ref<IdeApproveRequest | null>(null);
  const approveCustomText = ref('');
  let approveTickHandle: number | null = null;

  const hasMessages = computed(() => turns.value.length > 0);

  let sessionId: string | null = null;
  let socket: MinimalSocket | null = null;
  let currentAssistant: AiAssistantTurn | null = null;
  let currentTextHadDelta = false;
  let stopFallbackHandle: number | null = null;
  let sendAckHandle: number | null = null;
  let sendConnectHandle: number | null = null;
  let pendingConnectSend: (() => void) | null = null;
  let streamCleanup: (() => void) | null = null;
  let activeRunId: string | null = null;
  let stopRequested = false;
  const stoppedRunIds = new Set<string>();

  interface IdeSocketMessage {
    sessionId?: string;
    runId?: string;
  }

  function matchesCurrentRun(msg: IdeSocketMessage | null | undefined, options: { allowStopped?: boolean; allowAfterStop?: boolean } = {}): boolean {
    if (!msg || msg.sessionId !== sessionId) return false;
    if (msg.runId) {
      if (stoppedRunIds.has(msg.runId) && !options.allowStopped) return false;
      if (activeRunId && msg.runId !== activeRunId) return false;
      activeRunId = msg.runId;
    }
    if (stopRequested && !options.allowAfterStop) return false;
    return true;
  }

  function rememberStoppedRun(runId = activeRunId): void {
    if (!runId) return;
    stoppedRunIds.add(runId);
    if (stoppedRunIds.size > 20) {
      const firstStopped = stoppedRunIds.values().next().value;
      if (firstStopped) stoppedRunIds.delete(firstStopped);
    }
  }

  function getSocket(): MinimalSocket | null {
    const s = sessionTerminal.getSocket?.() as MinimalSocket | undefined | null;
    return s ?? null;
  }

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
    const t = ensureAssistant();
    appendAiLine(t, kind, text);
    touchTurns();
  }

  const deltaBuffer = createStreamDeltaBuffer((flushed) => {
    appendAiStreamDelta(ensureAssistant(), flushed);
    touchTurns();
  });

  function appendDelta(text: string): void {
    deltaBuffer.push(text);
  }

  function finalize(): void {
    deltaBuffer.flushNow();
    isRunning.value = false;
    stopRequested = false;
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
      socket.off?.('connect', pendingConnectSend);
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
    if (!req || !socket) {
      approveRequest.value = null;
      clearApproveTick();
      return;
    }
    socket.emit('ide:approve-response', {
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
    const s = getSocket();
    if (!s || socket === s) return;
    streamCleanup?.();
    streamCleanup = null;
    socket = s;

    streamCleanup = bindIdeStreamHandlers(s, [
      ['ide:thinking', (msg: unknown) => {
        const m = msg as IdeSocketMessage;
        if (!matchesCurrentRun(m)) return;
        currentTextHadDelta = false;
        setStatus('思考中...');
      }],
      ['ide:text', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { text?: string };
        if (!matchesCurrentRun(m) || !m.text || currentTextHadDelta) return;
        appendDelta(m.text);
      }],
      ['ide:text-delta', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { delta?: string };
        if (!matchesCurrentRun(m) || !m.delta) return;
        currentTextHadDelta = true;
        setStatus('生成中...');
        appendDelta(m.delta);
      }],
      ['ide:tool-start', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { name?: string; input?: unknown; toolUseId?: string };
        if (!matchesCurrentRun(m)) return;
        deltaBuffer.flushNow();
        startAiToolCall(ensureAssistant(), m.toolUseId || `tool-${Date.now()}`, m.name || 'unknown', m.input);
        touchTurns();
        setStatus(m.name ? `调用 ${m.name}...` : '调用工具...');
      }],
      ['ide:tool-delta', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { toolUseId?: string; stream?: string; text?: string };
        if (!matchesCurrentRun(m) || !m.toolUseId || !m.text || !currentAssistant) return;
        deltaBuffer.flushNow();
        if (appendAiToolLog(currentAssistant, m.toolUseId, m.stream === 'stderr' ? 'stderr' : 'stdout', m.text)) {
          touchTurns();
          setStatus('工具执行中...');
        }
      }],
      ['ide:tool-end', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { result?: unknown; is_error?: boolean; toolUseId?: string };
        if (!matchesCurrentRun(m)) return;
        if (currentAssistant && m.toolUseId && finishAiToolCall(currentAssistant, m.toolUseId, Boolean(m.is_error), m.result)) {
          touchTurns();
        }
        setStatus(m.is_error ? '工具返回错误' : '思考中...');
      }],
      ['ide:done', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { round?: number };
        if (!matchesCurrentRun(m)) return;
        deltaBuffer.flushNow();
        markAiAssistantStatus(currentAssistant, 'done');
        touchTurns();
        setStatus(`完成 (${m.round ?? 0} 轮)`);
        finalize();
      }],
      ['ide:error', (msg: unknown) => {
        const m = msg as IdeSocketMessage & { error?: string };
        if (!matchesCurrentRun(m)) return;
        setStatus('出错');
        appendLine('error', `✘ ${m.error || '未知错误'}`);
        finalize();
      }],
      ['ide:cancelled', (msg: unknown) => {
        const m = msg as IdeSocketMessage;
        if (!matchesCurrentRun(m, { allowStopped: true, allowAfterStop: true })) return;
        deltaBuffer.flushNow();
        markAiAssistantStatus(currentAssistant, 'cancelled');
        touchTurns();
        rememberStoppedRun(m.runId);
        setStatus('已取消');
        finalize();
      }],
      ['ide:approve-request', (msg: unknown) => {
        const m = msg as IdeSocketMessage & {
          requestId?: string;
          title?: string;
          toolName?: string;
          detail?: string;
        };
        if (!matchesCurrentRun(m) || !m.requestId) return;

        clearApproveTick();
        approveCustomText.value = '';
        approveRequest.value = {
          requestId: m.requestId,
          sessionId: m.sessionId!,
          title: m.title || '安全模式',
          toolName: m.toolName || '操作',
          detail: m.detail || '',
          countdown: 120,
        };
        approveTickHandle = window.setInterval(() => {
          const req = approveRequest.value;
          if (!req) { clearApproveTick(); return; }
          req.countdown -= 1;
          if (req.countdown <= 0) respondApprove('deny');
        }, 1000);
      }],
    ]);
  }

  function setSafeMode(v: boolean): void {
    safeMode.value = v;
    if (socket && sessionId) {
      socket.emit('ide:safe-mode', { sessionId, enabled: v });
    }
  }

  function setClaudeCodeEnabled(v: boolean): void {
    claudeCodeEnabled.value = v;
    if (socket && sessionId) {
      socket.emit('ide:claude-code-collab', { sessionId, enabled: v });
    }
  }

  function setUnlimitedTurns(v: boolean): void {
    unlimitedTurns.value = v;
    if (socket && sessionId) {
      socket.emit('ide:unlimited-turns', { sessionId, enabled: v });
    }
  }

  function buildContext(): Record<string, unknown> {
    const ctx: { hosts?: Array<Record<string, unknown>> } = {};
    const hostId = sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
    const host = hosts.hostMap.get(hostId);
    if (host) {
      ctx.hosts = [{
        id: host.id || 'local',
        name: host.name,
        username: (host as { username?: string }).username,
        host: (host as { host?: string }).host,
        port: (host as { port?: number }).port,
      }];
    }
    return ctx;
  }

  function emitIdeMessage(text: string): void {
    if (!socket || !sessionId) return;
    sendAckHandle = window.setTimeout(() => {
      setStatus('启动超时');
      appendLine('error', 'ide:message 已发送但未收到后端确认，请检查后端 Socket handler');
      finalize();
    }, 8000);

    socket.emit('ide:message', {
      sessionId,
      message: text,
      context: buildContext(),
      safeMode: safeMode.value,
      claudeCodeEnabled: claudeCodeEnabled.value,
      unlimitedTurns: unlimitedTurns.value,
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

  function sendWhenSocketReady(text: string): void {
    if (!socket) return;
    if (socket.connected !== false) {
      emitIdeMessage(text);
      return;
    }
    setStatus('连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        window.clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(text);
    };
    socket.once?.('connect', pendingConnectSend);
    socket.connect?.();
    sendConnectHandle = window.setTimeout(() => {
      if (pendingConnectSend && socket) socket.off?.('connect', pendingConnectSend);
      pendingConnectSend = null;
      setStatus('Socket 未连接');
      appendLine('error', 'Socket 尚未连接，ide:message 未发送；请确认后端已启动并刷新页面重试');
      finalize();
    }, 8000);
  }

  function sendMessage(): void {
    const text = inputText.value.trim();
    if (!text || isRunning.value) return;
    if (!socket) bindSocket();
    if (!socket) {
      notify.error('Socket 未连接');
      return;
    }

    if (!sessionId) {
      sessionId = genSessionId();
      socket.emit('ide:safe-mode', { sessionId, enabled: safeMode.value });
      if (claudeCodeEnabled.value) {
        socket.emit('ide:claude-code-collab', { sessionId, enabled: true });
      }
      if (unlimitedTurns.value) {
        socket.emit('ide:unlimited-turns', { sessionId, enabled: true });
      }
    }

    activeRunId = null;
    stopRequested = false;
    pushUser(text);
    inputText.value = '';

    // 提前建 assistant turn,触发"思考中..."占位（与老 renderAiTurn 同步）
    ensureAssistant();
    isRunning.value = true;
    setStatus('启动中...');

    sendWhenSocketReady(text);
  }

  function stop(): void {
    if (!socket || !sessionId) return;
    const stoppedSessionId = sessionId;
    stopRequested = true;
    rememberStoppedRun();
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
    if (sessionId && socket) {
      socket.emit('ide:clear', { sessionId });
    }
    sessionId = null;
    activeRunId = null;
    stopRequested = false;
    stoppedRunIds.clear();
    currentAssistant = null;
    deltaBuffer.clear();
    turns.value = [];
    setStatus('待命');
  }

  let initialized = false;
  let waitSocketHandle: number | null = null;
  function initialize(): void {
    if (initialized) return;
    initialized = true;
    waitSocketHandle = window.setInterval(() => {
      if (getSocket()) {
        if (waitSocketHandle !== null) window.clearInterval(waitSocketHandle);
        waitSocketHandle = null;
        bindSocket();
      }
    }, 500);
  }

  function dispose(): void {
    if (waitSocketHandle !== null) {
      window.clearInterval(waitSocketHandle);
      waitSocketHandle = null;
    }
    streamCleanup?.();
    streamCleanup = null;
    finalize();
    socket = null;
  }

  return {
    turns,
    isRunning,
    inputText,
    statusText,
    safeMode,
    claudeCodeEnabled,
    unlimitedTurns,
    approveRequest,
    approveCustomText,
    hasMessages,
    initialize,
    sendMessage,
    stop,
    resetChat,
    setSafeMode,
    setClaudeCodeEnabled,
    setUnlimitedTurns,
    approveAllow,
    approveDeny,
    approveCustom,
    dispose,
  };
}
