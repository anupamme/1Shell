// useAgentPanel.ts — MainConsole 刀 5b · AI Agent 面板
// 1:1 复刻 [public/agent-panel.js](public/agent-panel.js)（627 行）
// 多会话 Map + 嵌入式 xterm（useAgentXterm multi-instance）+ Socket agent:* 事件 + Provider 切换 + MCP 一键接入

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { useAgentXterm, type AgentXtermInstance } from '@/composables/useAgentXterm';

interface MinimalSocket {
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener?: (...args: unknown[]) => void): unknown;
}

export interface AgentSession {
  agentSessionId: string;
  providerId: string;
  status: string;
  providerLabel: string;
  label: string;
  useLocalEnv: boolean;
  xterm: AgentXtermInstance;
}

export interface ProviderModelMeta {
  id: string;
  apiModel: string;
  displayName?: string;
  enabled?: boolean;
}

export interface ProviderMeta {
  id: string;
  label: string;
  configured: boolean;
  isDefault?: boolean;
  activeProviderId?: string;
  activeProviderName?: string;
  activeModelId?: string | null;
  model?: string;
  models?: ProviderModelMeta[];
}

export interface AgentModelOption {
  id: string;
  label: string;
  apiModel: string;
  active: boolean;
}

export interface AgentPanelApi {
  readonly sessions: Ref<Map<string, AgentSession>>;
  readonly activeSessionKey: Ref<string | null>;
  readonly statusText: Ref<string>;
  readonly providers: Ref<ProviderMeta[]>;
  readonly selectedProviderId: Ref<string>;
  readonly activeModelOptions: ComputedRef<AgentModelOption[]>;
  readonly mcpConfigured: Ref<boolean>;
  readonly hasSessions: ComputedRef<boolean>;

  initialize(parentEl: HTMLElement): void;
  startAgent(useLocalEnv: boolean): Promise<void>;
  stopAgent(): void;
  clearTerminal(): void;
  switchToSession(sessionKey: string): void;
  closeSession(sessionKey: string): void;
  newSession(): Promise<void>;
  setSelectedProvider(providerId: string): void;
  setSelectedModel(modelId: string): Promise<void>;
  setupMcp(): Promise<void>;
}

let _instance: AgentPanelApi | null = null;

export function useAgentPanel(): AgentPanelApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetAgentPanelSingleton(): void {
  _instance = null;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function create(): AgentPanelApi {
  const sessionTerminal = useSessionTerminal();
  const hosts = useHostsStore();
  const notify = useNotifyStore();
  const xtermManager = useAgentXterm();

  const sessions = ref<Map<string, AgentSession>>(new Map());
  const activeSessionKey = ref<string | null>(null);
  const statusText = ref('未启动');
  const providers = ref<ProviderMeta[]>([]);
  const selectedProviderId = ref('claude-code');
  const mcpConfigured = ref(false);

  const hasSessions = computed(() => sessions.value.size > 0);
  const activeModelOptions = computed<AgentModelOption[]>(() => {
    const provider = providers.value.find((p) => p.id === selectedProviderId.value);
    if (!provider) return [];
    const models = (provider.models || [])
      .filter((model) => model.enabled !== false && (model.apiModel || model.displayName || model.id))
      .map((model) => {
        const apiModel = model.apiModel || provider.model || '';
        const label = model.displayName || apiModel || model.id;
        return {
          id: model.id || apiModel,
          label,
          apiModel,
          active: Boolean(provider.activeModelId && model.id === provider.activeModelId) || (!provider.activeModelId && apiModel === provider.model),
        };
      });
    if (models.length > 0) return models;
    if (provider.model) {
      return [{
        id: provider.activeModelId || 'default',
        label: provider.model,
        apiModel: provider.model,
        active: true,
      }];
    }
    return [];
  });

  let sessionCounter = 0;
  let socketBound = false;
  let providersLoaded = false;
  let providerLoadPromise: Promise<ProviderMeta[]> | null = null;
  let parentElement: HTMLElement | null = null;

  // pendingOutput: Map<agentSessionId, string[]> — 竞态缓冲（agent:output 早于 agent:start ack）
  const pendingOutput = new Map<string, string[]>();

  function getSocket(): MinimalSocket | null {
    const s = sessionTerminal.getSocket?.() as MinimalSocket | undefined | null;
    return s ?? null;
  }

  function setStatus(text: string): void {
    statusText.value = text;
  }

  function appendSystemLine(text: string, sessionKey?: string): void {
    const key = sessionKey || activeSessionKey.value;
    if (!key) return;
    const sess = sessions.value.get(key);
    sess?.xterm.terminal.writeln(`\x1b[36m${text}\x1b[0m`);
  }

  function registerSession(sessionKey: string, data: Omit<AgentSession, 'xterm'>): void {
    if (!parentElement) {
      throw new Error('useAgentPanel not initialized: parentElement is null');
    }
    const xterm = xtermManager.createInstance(sessionKey, parentElement);

    // 1:1 复刻 agent-panel.js:92-102 — onData / onResize emit agent:input / agent:resize
    xterm.terminal.onData((d: string) => {
      const sess = sessions.value.get(sessionKey);
      if (!sess?.agentSessionId || activeSessionKey.value !== sessionKey) return;
      getSocket()?.emit('agent:input', { agentSessionId: sess.agentSessionId, data: d });
    });

    xterm.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      const sess = sessions.value.get(sessionKey);
      if (!sess?.agentSessionId || activeSessionKey.value !== sessionKey) return;
      getSocket()?.emit('agent:resize', { agentSessionId: sess.agentSessionId, cols, rows });
    });

    const sess: AgentSession = { ...data, xterm };
    sessions.value.set(sessionKey, sess);

    // 回放 pendingOutput（1:1 复刻 agent-panel.js:118-122）
    const buffered = pendingOutput.get(data.agentSessionId);
    if (buffered?.length) {
      for (const chunk of buffered) xterm.terminal.write(chunk);
      pendingOutput.delete(data.agentSessionId);
    }
  }

  function destroySession(sessionKey: string): void {
    const sess = sessions.value.get(sessionKey);
    if (!sess) return;
    pendingOutput.delete(sess.agentSessionId);
    xtermManager.destroyInstance(sessionKey);
    sessions.value.delete(sessionKey);
  }

  function switchToSession(sessionKey: string): void {
    xtermManager.switchToInstance(sessionKey);
    activeSessionKey.value = sessionKey;
    const sess = sessions.value.get(sessionKey);
    if (sess) {
      if (sess.status === 'ready') setStatus(`运行中 · ${sess.providerLabel || 'Agent'}`);
      else if (sess.status === 'stopped') setStatus('已停止');
      else if (sess.status === 'error') setStatus('错误');
      else setStatus(sess.status || '');
    } else {
      setStatus('未启动');
    }
  }

  function closeSession(sessionKey: string): void {
    const socket = getSocket();
    const sess = sessions.value.get(sessionKey);
    if (socket && sess?.agentSessionId) {
      socket.emit('agent:stop', { agentSessionId: sess.agentSessionId });
    }
    if (activeSessionKey.value === sessionKey) {
      const remaining = [...sessions.value.keys()].filter((k) => k !== sessionKey);
      if (remaining.length > 0) {
        switchToSession(remaining[remaining.length - 1]);
      } else {
        activeSessionKey.value = null;
        setStatus('未启动');
      }
    }
    destroySession(sessionKey);
  }

  function bindSocketEvents(): void {
    if (socketBound) return;
    const socket = getSocket();
    if (!socket) return;

    // 1:1 复刻 agent-panel.js:369-398 — agent:status
    socket.on('agent:status', (...args: unknown[]) => {
      const payload = args[0] as {
        id?: string;
        status?: string;
        providerId?: string;
        providerLabel?: string;
        useLocalEnv?: boolean;
        lastError?: string;
      };
      if (!payload?.id) return;
      let sessionKey: string | null = null;
      for (const [k, s] of sessions.value) {
        if (s.agentSessionId === payload.id) {
          sessionKey = k;
          break;
        }
      }
      if (!sessionKey) return;

      const sess = sessions.value.get(sessionKey);
      if (!sess) return;

      if (payload.status) sess.status = payload.status;
      if (payload.providerId) sess.providerId = payload.providerId;
      if (payload.providerLabel) sess.providerLabel = payload.providerLabel;
      if (typeof payload.useLocalEnv === 'boolean') sess.useLocalEnv = payload.useLocalEnv;

      if (payload.status === 'error' && payload.lastError) {
        appendSystemLine(`[Agent Error] ${payload.lastError}`, sessionKey);
      }
      if (payload.status === 'stopped') {
        appendSystemLine('[Agent] 会话已停止', sessionKey);
      }

      if (activeSessionKey.value === sessionKey) {
        if (payload.status === 'ready') setStatus(`运行中 · ${payload.providerLabel || sess.providerLabel}`);
        else if (payload.status === 'stopped') setStatus('已停止');
        else if (payload.status === 'error') setStatus(`错误：${payload.lastError || ''}`);
      }
    });

    // 1:1 复刻 agent-panel.js:400-414 — agent:output + pendingOutput 竞态缓冲
    socket.on('agent:output', (...args: unknown[]) => {
      const payload = args[0] as { agentSessionId?: string; data?: string };
      if (!payload?.agentSessionId) return;
      let sessionKey: string | null = null;
      for (const [k, s] of sessions.value) {
        if (s.agentSessionId === payload.agentSessionId) {
          sessionKey = k;
          break;
        }
      }

      if (!sessionKey) {
        // 竞态：agent:output 早于 agent:start ack 到达 → 缓冲到 pendingOutput
        if (!pendingOutput.has(payload.agentSessionId)) {
          pendingOutput.set(payload.agentSessionId, []);
        }
        pendingOutput.get(payload.agentSessionId)!.push(payload.data || '');
        return;
      }

      sessions.value.get(sessionKey)?.xterm.terminal.write(payload.data || '');
    });

    socketBound = true;
  }

  function loadProviders(force = false): Promise<ProviderMeta[]> {
    const socket = getSocket();
    if (!socket) return Promise.resolve([]);
    if (!force && providersLoaded) return Promise.resolve(providers.value);
    if (!force && providerLoadPromise) return providerLoadPromise;

    providerLoadPromise = new Promise((resolve) => {
      socket.emit('agent:providers', (result: { ok?: boolean; providers?: ProviderMeta[]; error?: string }) => {
        if (!result?.ok) {
          providerLoadPromise = null;
          setStatus(result?.error || '加载 Provider 失败');
          resolve([]);
          return;
        }
        providers.value = result.providers || [];
        providersLoaded = true;
        providerLoadPromise = null;
        void checkMcpStatus();
        syncProviderRuntimeStatus(result.providers || []);
        resolve(result.providers || []);
      });
    });

    return providerLoadPromise;
  }

  function syncProviderRuntimeStatus(provs: ProviderMeta[]): void {
    const selected = provs.find((p) => p.id === selectedProviderId.value);
    if (!selected) {
      setStatus('未启动');
      return;
    }

    const activeSess = activeSessionKey.value ? sessions.value.get(activeSessionKey.value) : null;
    if (activeSess?.status === 'ready' || activeSess?.status === 'starting') {
      return;
    }

    if (selected.configured) {
      const channel = selected.activeProviderName || '已配置渠道';
      setStatus(`就绪 · ${channel}`);
      return;
    }

    setStatus('未配置 API · 请先到 AI CLI 接入页配置');
  }

  async function checkMcpStatus(): Promise<boolean> {
    try {
      const res = await fetch(`/api/agent/sandbox/status/${encodeURIComponent(selectedProviderId.value)}`);
      const json = await res.json() as { sandboxed?: boolean };
      const sandboxed = Boolean(json?.sandboxed);
      mcpConfigured.value = sandboxed;
      return sandboxed;
    } catch {
      mcpConfigured.value = false;
      return false;
    }
  }

  async function ensureMcpSetup(): Promise<boolean> {
    const configured = await checkMcpStatus();
    if (configured) return false;

    const meta = providers.value.find((p) => p.id === selectedProviderId.value);
    const label = meta?.label || selectedProviderId.value;
    appendSystemLine(`[Setup] 检测到 ${label} 沙箱未就绪，正在自动创建…`);

    const res = await fetch(`/api/agent/sandbox/ensure/${encodeURIComponent(selectedProviderId.value)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
      body: JSON.stringify({}),
    });
    const json = await res.json() as { ok?: boolean; error?: string; sandboxDir?: string };

    if (!json.ok) {
      throw new Error(json.error || '沙箱创建失败');
    }

    mcpConfigured.value = true;
    appendSystemLine(`[Setup] ${label} 沙箱已就绪，新启动的会话将自动加载 1Shell 工具。`);
    return true;
  }

  async function ensureProviderReadyForLaunch(): Promise<ProviderMeta> {
    await loadProviders(true);
    const selected = providers.value.find((p) => p.id === selectedProviderId.value);
    if (!selected) {
      throw new Error('当前 CLI 不存在，请刷新页面后重试');
    }
    if (!selected.configured) {
      throw new Error('当前 CLI 未配置 API 渠道，请先到 AI CLI 接入页配置');
    }
    return selected;
  }

  async function startAgent(useLocalEnv: boolean): Promise<void> {
    const socket = getSocket();
    if (!socket) {
      throw new Error('当前环境未就绪，无法启动 Agent');
    }

    bindSocketEvents();
    setStatus(useLocalEnv ? '本地启动中…' : '启动中…');

    try {
      if (!useLocalEnv) {
        await ensureProviderReadyForLaunch();
      }
      await ensureMcpSetup();
    } catch (error) {
      setStatus((error as Error).message || '启动 Agent 失败');
      throw error;
    }

    const sessionKey = `s${++sessionCounter}`;
    const providerMeta = providers.value.find((p) => p.id === selectedProviderId.value);
    const label = `${providerMeta?.label || selectedProviderId.value} #${sessionCounter}`;

    return new Promise((resolve, reject) => {
      socket.emit('agent:start', {
        providerId: selectedProviderId.value,
        hostId: 'local',
        cols: 100,
        rows: 28,
        useLocalEnv,
      }, (result: { ok?: boolean; session?: { id: string; providerId: string; status: string; providerLabel: string; useLocalEnv?: boolean }; error?: string }) => {
        if (!result?.ok) {
          setStatus(result?.error || '启动 Agent 失败');
          reject(new Error(result?.error || '启动 Agent 失败'));
          return;
        }

        const session = result.session!;

        registerSession(sessionKey, {
          agentSessionId: session.id,
          providerId: session.providerId,
          status: session.status,
          providerLabel: session.providerLabel,
          label,
          useLocalEnv: Boolean(session.useLocalEnv),
        });

        const sess = sessions.value.get(sessionKey);
        if (sess?.xterm.terminal) {
          const { cols, rows } = sess.xterm.terminal;
          if (cols !== 100 || rows !== 28) {
            socket.emit('agent:resize', { agentSessionId: session.id, cols, rows });
          }
        }

        switchToSession(sessionKey);
        setStatus(`运行中 · ${session.providerLabel || 'Agent'}${useLocalEnv ? ' · 本地环境' : ''}`);
        resolve();
      });
    });
  }

  function stopAgent(): void {
    if (activeSessionKey.value) closeSession(activeSessionKey.value);
  }

  function clearTerminal(): void {
    const sess = activeSessionKey.value ? sessions.value.get(activeSessionKey.value) : null;
    sess?.xterm.terminal.clear();
  }

  async function newSession(): Promise<void> {
    return startAgent(false);
  }

  function setSelectedProvider(providerId: string): void {
    selectedProviderId.value = providerId;
    syncProviderRuntimeStatus(providers.value);
    void checkMcpStatus();
  }

  async function setSelectedModel(modelId: string): Promise<void> {
    const provider = providers.value.find((p) => p.id === selectedProviderId.value);
    if (!provider?.activeProviderId) {
      throw new Error('当前 CLI 没有可切换的活跃 API 渠道');
    }
    const option = activeModelOptions.value.find((item) => item.id === modelId);
    if (!option) {
      throw new Error('模型档案不存在');
    }
    if (option.active) return;

    const res = await fetch(`/api/agent/providers/${encodeURIComponent(selectedProviderId.value)}/${encodeURIComponent(provider.activeProviderId)}/activate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
      body: JSON.stringify({ modelId }),
    });
    const json = await res.json() as { ok?: boolean; error?: string };
    if (!json.ok) throw new Error(json.error || '模型切换失败');

    await loadProviders(true);
    const next = providers.value.find((p) => p.id === selectedProviderId.value);
    const active = (next?.models || []).find((model) => model.id === modelId);
    const label = active?.displayName || active?.apiModel || option.label;
    appendSystemLine(`[1Shell] 模型已切换: ${label}`);
    const activeSess = activeSessionKey.value ? sessions.value.get(activeSessionKey.value) : null;
    if (activeSess?.status === 'ready' || activeSess?.status === 'starting') {
      setStatus(`运行中 · ${next?.activeProviderName || next?.label || selectedProviderId.value}`);
    } else {
      syncProviderRuntimeStatus(providers.value);
    }
  }

  async function setupMcp(): Promise<void> {
    const meta = providers.value.find((p) => p.id === selectedProviderId.value);
    const label = meta?.label || selectedProviderId.value;
    appendSystemLine(`[Setup] 正在为 ${label} 创建沙箱…`);

    const res = await fetch(`/api/agent/sandbox/ensure/${encodeURIComponent(selectedProviderId.value)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
      body: JSON.stringify({}),
    });
    const json = await res.json() as { ok?: boolean; error?: string; sandboxDir?: string };

    if (!json.ok) {
      appendSystemLine(`[Setup] 沙箱创建失败：${json.error || '未知错误'}`);
      throw new Error(json.error || '沙箱创建失败');
    }

    appendSystemLine(`[Setup] 沙箱已就绪：${json.sandboxDir || ''}`);
    appendSystemLine('[Setup] 下次启动该 CLI 时将自动接入 1Shell MCP');
    mcpConfigured.value = true;
  }

  function handleSocketLifecycle(type: string): void {
    if (type === 'socket-connect') {
      // 不重置 socketBound：socket.io 重连复用同一 Socket 实例，监听器跨重连保留。
      // 重置后再 bindSocketEvents 会重复注册 agent:status/agent:output，导致输出重复 + 泄漏。
      bindSocketEvents();
      void loadProviders();
    }
    if (type === 'socket-disconnect') {
      for (const sess of sessions.value.values()) sess.status = 'stopped';
      setStatus('未连接');
    }
  }

  let initialized = false;
  function initialize(parentEl: HTMLElement): void {
    // singleton 跨 MainConsole unmount/remount 存活，每次都要重新绑定 parentEl，
    // 否则旧 parentElement 指向已销毁的 DOM，新建/切换会话渲染到游离节点。
    parentElement = parentEl;

    for (const sess of sessions.value.values()) {
      if (sess.xterm.containerEl.parentElement !== parentEl) {
        parentEl.appendChild(sess.xterm.containerEl);
      }
    }

    if (activeSessionKey.value && sessions.value.has(activeSessionKey.value)) {
      const key = activeSessionKey.value;
      setTimeout(() => xtermManager.switchToInstance(key), 0);
    }

    if (initialized) return;
    initialized = true;

    sessionTerminal.onLifecycle?.(({ type }: { type: string }) => handleSocketLifecycle(type));
    bindSocketEvents();
    void loadProviders();
    setStatus('未启动');
  }

  return {
    sessions,
    activeSessionKey,
    statusText,
    providers,
    selectedProviderId,
    activeModelOptions,
    mcpConfigured,
    hasSessions,
    initialize,
    startAgent,
    stopAgent,
    clearTerminal,
    switchToSession,
    closeSession,
    newSession,
    setSelectedProvider,
    setSelectedModel,
    setupMcp,
  };
}
