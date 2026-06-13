// useIdePanel.ts — MainConsole 刀 5a · 1Shell AI 右栏面板
// 1:1 复刻 [public/ide-panel.js](public/ide-panel.js)（467 行）
// 单例：socket lifecycle 绑定 / cc toggle / Agent 审批 / send / stop / clear
//
// 老版 index.html 实际没有 ide-tool-toggle / ide-tool-picker / ide-tool-chips DOM
// （ide-panel.js 里 getElementById 为 null 时静默 no-op），故 1:1 不带工具选择器 UI
// → 不调 loadTools / buildContext 也不带 skills / mcpServers 字段（用户看到的与老版一致）

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useApiClient } from '@/composables/useApiClient';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
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
  mode: 'approval' | 'ask_user' | 'request_secret';
  responseEvent: 'ide:approve-response' | 'ide:ask-user-response' | 'ide:secret-response';
  secretName?: string;
  label?: string;
  provider?: string;
  /** 剩余秒数（响应式倒计时） */
  countdown: number;
}

export interface IdePackageDraftResult {
  ok?: boolean;
  programId: string;
  trustLevel: string;
  sourceTrustLevel?: string;
  written?: boolean;
  path?: string;
  yaml?: string;
  warnings?: string[];
  provenance?: { agentRunId?: string; [key: string]: unknown };
}

export interface IdePackageDraftState {
  visible: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  programId: string;
  result: IdePackageDraftResult | null;
}

export interface IdePanelApi {
  readonly turns: Ref<IdeTurn[]>;
  readonly isRunning: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly statusText: Ref<string>;
  readonly claudeCodeEnabled: Ref<boolean>;
  readonly approveRequest: Ref<IdeApproveRequest | null>;
  readonly approveCustomText: Ref<string>;
  readonly packageDraft: Ref<IdePackageDraftState>;
  readonly hasMessages: ComputedRef<boolean>;
  readonly canPackageLastRun: ComputedRef<boolean>;

  initialize(): void;
  sendMessage(): void;
  stop(): void;
  resetChat(): void;
  packageLastRun(): Promise<void>;
  savePackageDraft(): Promise<void>;
  closePackageDraft(): void;
  setClaudeCodeEnabled(v: boolean): void;
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
  const { requestJson } = useApiClient();
  const hosts = useHostsStore();
  const notify = useNotifyStore();

  const turns = ref<IdeTurn[]>([]);
  const isRunning = ref(false);
  const inputText = ref('');
  const statusText = ref('待命');
  const claudeCodeEnabled = ref(false);

  const approveRequest = ref<IdeApproveRequest | null>(null);
  const approveCustomText = ref('');
  const packageDraft = ref<IdePackageDraftState>({
    visible: false,
    loading: false,
    saving: false,
    error: '',
    programId: '',
    result: null,
  });
  const lastVerifiedRunId = ref('');
  let approveTickHandle: number | null = null;

  const hasMessages = computed(() => turns.value.length > 0);
  const canPackageLastRun = computed(() => Boolean(lastVerifiedRunId.value && !isRunning.value));

  let sessionId: string | null = null;
  let socket: MinimalSocket | null = null;
  let currentAssistant: AiAssistantTurn | null = null;
  let stopFallbackHandle: number | null = null;
  let sendAckHandle: number | null = null;
  let sendConnectHandle: number | null = null;
  let pendingConnectSend: (() => void) | null = null;
  let streamCleanup: (() => void) | null = null;
  const streamController = createAiAgentStreamController(() => sessionId);

  function getSocket(): MinimalSocket | null {
    const s = sessionTerminal.getSocket?.() as MinimalSocket | undefined | null;
    return s ?? null;
  }

  function setStatus(text: string): void { statusText.value = text; }

  function doneStatusText(taskStatus?: string, round?: number): string {
    const suffix = `(${round ?? 0} 轮)`;
    if (taskStatus === 'blocked') return `已阻塞 ${suffix}`;
    if (taskStatus === 'failed') return `失败 ${suffix}`;
    if (taskStatus === 'unverified' || taskStatus === 'partial') return `未验证 ${suffix}`;
    return `完成 ${suffix}`;
  }

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
    const s = getSocket();
    if (!s || socket === s) return;
    streamCleanup?.();
    streamCleanup = null;
    socket = s;

    streamCleanup = bindAiAgentStreamHandlers(s, streamController, {
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
          requestId: m.requestId || '',
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
      onDone: (m) => {
        lastVerifiedRunId.value = m.runId && m.taskStatus === 'verified' ? m.runId : '';
        deltaBuffer.flushNow();
        if (currentAssistant) currentAssistant.status = ['blocked', 'failed'].includes(String(m.taskStatus || '')) ? 'error' : 'done';
        touchTurns();
        setStatus(doneStatusText(m.taskStatus, m.round));
        finalize();
      },
    }, [
      ['connect', () => {
        if (sessionId && isRunning.value) {
          s.emit('ide:reattach', { sessionId });
          setStatus('Socket 已重连，恢复接收...');
        }
      }],
      ['disconnect', () => {
        if (isRunning.value) setStatus('Socket 已断开，等待重连...');
      }],
      ['connect_error', () => {
        if (isRunning.value) setStatus('Socket 连接异常，等待重连...');
      }],
    ]);
  }

  function setClaudeCodeEnabled(v: boolean): void {
    claudeCodeEnabled.value = v;
    if (socket && sessionId) {
      socket.emit('ide:claude-code-collab', { sessionId, enabled: v });
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
      claudeCodeEnabled: claudeCodeEnabled.value,
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
      if (claudeCodeEnabled.value) {
        socket.emit('ide:claude-code-collab', { sessionId, enabled: true });
      }
    }

    streamController.resetForNewRun();
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
    if (sessionId && socket) {
      socket.emit('ide:clear', { sessionId });
    }
    sessionId = null;
    lastVerifiedRunId.value = '';
    packageDraft.value = {
      visible: false,
      loading: false,
      saving: false,
      error: '',
      programId: '',
      result: null,
    };
    streamController.resetForNewSession();
    currentAssistant = null;
    deltaBuffer.clear();
    turns.value = [];
    setStatus('待命');
  }

  async function packageLastRun(): Promise<void> {
    const runId = lastVerifiedRunId.value;
    if (!runId || isRunning.value) {
      notify.warn('没有可打包的已完成 AgentRun');
      return;
    }
    packageDraft.value = {
      ...packageDraft.value,
      visible: true,
      loading: true,
      saving: false,
      error: '',
      result: null,
    };
    try {
      const result = await requestJson<IdePackageDraftResult>('/api/task-drafts/from-agent-run', {
        method: 'POST',
        body: JSON.stringify({
          runId,
          programId: packageDraft.value.programId.trim() || undefined,
          write: false,
        }),
      });
      packageDraft.value = {
        ...packageDraft.value,
        loading: false,
        programId: result.programId || packageDraft.value.programId,
        result,
      };
      notify.success('已生成自动化任务草稿预览');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      packageDraft.value = { ...packageDraft.value, loading: false, error: message };
      notify.error(`打包失败：${message}`);
    }
  }

  async function savePackageDraft(): Promise<void> {
    const runId = lastVerifiedRunId.value;
    if (!runId || packageDraft.value.saving) return;
    packageDraft.value = { ...packageDraft.value, saving: true, error: '' };
    try {
      const result = await requestJson<IdePackageDraftResult>('/api/task-drafts/from-agent-run', {
        method: 'POST',
        body: JSON.stringify({
          runId,
          programId: packageDraft.value.programId.trim() || packageDraft.value.result?.programId || undefined,
          write: true,
          overwrite: false,
        }),
      });
      packageDraft.value = {
        ...packageDraft.value,
        saving: false,
        programId: result.programId || packageDraft.value.programId,
        result,
      };
      notify.success(`自动化任务草稿已保存：${result.programId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      packageDraft.value = { ...packageDraft.value, saving: false, error: message };
      notify.error(`保存失败：${message}`);
    }
  }

  function closePackageDraft(): void {
    packageDraft.value = { ...packageDraft.value, visible: false, error: '' };
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
    claudeCodeEnabled,
    approveRequest,
    approveCustomText,
    packageDraft,
    hasMessages,
    canPackageLastRun,
    initialize,
    sendMessage,
    stop,
    resetChat,
    packageLastRun,
    savePackageDraft,
    closePackageDraft,
    setClaudeCodeEnabled,
    approveAllow,
    approveDeny,
    approveCustom,
    dispose,
  };
}
