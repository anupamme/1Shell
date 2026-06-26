import { computed, ref, type ComputedRef, type Ref, type WritableComputedRef } from 'vue';
import { useRouter } from 'vue-router';

import { useHostsStore } from '@/stores/hosts';
import { useAuthStore } from '@/stores/auth';
import { useNotifyStore } from '@/stores/notify';
import { escapeHtml, renderMarkdown } from '@/utils/markdown';
import { createStreamDeltaBuffer } from '@/utils/streaming';

const SYSTEM_PROMPT = '你是 1Shell AI，一个面向真实服务器运维与自动化的受控 agent。回答要安全、可执行、简洁；涉及真实主机操作时先说明目标范围和风险。';
const INTRO_MESSAGE = '新对话默认使用全局范围。你也可以在左上角切换到某一台 VPS，让后续问题固定围绕那台主机。';

const AI_CONFIG_KEY = '1shell-ai-config';
const AI_CHAT_SESSIONS_KEY = '1shell-ai-chat-sessions-v1';
const MAX_STORED_SESSIONS = 40;
const MAX_TITLE_LENGTH = 36;

export interface AiConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  displayContent?: string;
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  html: string;
  pending?: boolean;
}

export interface AiChatScope {
  type: 'global' | 'host';
  hostId?: string;
}

export interface AiChatSession {
  id: string;
  title: string;
  scope: AiChatScope;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AiScopeOption {
  key: string;
  label: string;
  description: string;
}

export interface AiChatApi {
  readonly displayMessages: ComputedRef<DisplayMessage[]>;
  readonly sessionsList: ComputedRef<AiChatSession[]>;
  readonly scopeOptions: ComputedRef<AiScopeOption[]>;
  readonly activeSession: ComputedRef<AiChatSession>;
  readonly activeSessionId: Ref<string>;
  readonly activeScopeKey: WritableComputedRef<string>;
  readonly activeScopeLabel: ComputedRef<string>;
  readonly isStreaming: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly config: Ref<AiConfig>;
  readonly configModalOpen: Ref<boolean>;

  initialize(): void;
  sendMessage(): Promise<void>;
  stopStreaming(): void;
  resetCurrentChat(): void;
  startNewChat(scopeKey?: string): void;
  deleteCurrentChat(): void;
  openConfigModal(): void;
  closeConfigModal(): void;
  saveConfig(next: AiConfig): void;
  fetchModels(apiBase: string, apiKey: string): Promise<string[]>;
  scopeLabel(scope: AiChatScope): string;
}

let _instance: AiChatApi | null = null;

export function useAiChat(): AiChatApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetAiChatSingleton(): void {
  _instance = null;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() || `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultMessages(): ChatMessage[] {
  return [{ role: 'system', content: SYSTEM_PROMPT }];
}

function cleanTitle(value: string): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH)}...` : text;
}

function scopeFromKey(key: string): AiChatScope {
  if (!key || key === 'global') return { type: 'global' };
  return { type: 'host', hostId: key.replace(/^host:/, '') };
}

function scopeKey(scope: AiChatScope): string {
  return scope.type === 'host' && scope.hostId ? `host:${scope.hostId}` : 'global';
}

function safeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return defaultMessages();
  const messages = value
    .filter((item): item is ChatMessage => {
      if (!item || typeof item !== 'object') return false;
      const msg = item as ChatMessage;
      return ['user', 'assistant', 'system'].includes(msg.role) && typeof msg.content === 'string';
    })
    .map((item) => ({
      role: item.role,
      content: item.content,
      ...(typeof item.displayContent === 'string' ? { displayContent: item.displayContent } : {}),
    }));
  return messages.some((item) => item.role === 'system') ? messages : [...defaultMessages(), ...messages];
}

function createSession(scope: AiChatScope = { type: 'global' }): AiChatSession {
  const ts = nowIso();
  return {
    id: createId(),
    title: '新对话',
    scope,
    messages: defaultMessages(),
    createdAt: ts,
    updatedAt: ts,
  };
}

function create(): AiChatApi {
  const router = useRouter();
  const hosts = useHostsStore();
  const auth = useAuthStore();
  const notify = useNotifyStore();

  const sessions = ref<AiChatSession[]>([]);
  const activeSessionId = ref('');
  const streamingSessionId = ref('');
  const streamingPartial = ref('');
  const isStreaming = ref(false);
  const inputText = ref('');
  const configModalOpen = ref(false);
  const config = ref<AiConfig>({ apiBase: '', apiKey: '', model: '' });

  let currentAbortController: AbortController | null = null;
  let streamingReply = '';
  let sessionsLoaded = false;
  const deltaBuffer = createStreamDeltaBuffer((delta) => {
    streamingReply += delta;
    streamingPartial.value = streamingReply;
  });

  const scopeOptions = computed<AiScopeOption[]>(() => [
    { key: 'global', label: '全局', description: '不限定单台主机' },
    ...hosts.items.map((host) => ({
      key: `host:${host.id}`,
      label: host.name || host.id,
      description: host.type === 'local' ? '本机' : `${host.username || 'root'}@${host.host || host.id}`,
    })),
  ]);

  function scopeLabel(scope: AiChatScope): string {
    if (scope.type !== 'host' || !scope.hostId) return '全局';
    const host = hosts.hostMap.get(scope.hostId);
    return host?.name || scope.hostId;
  }

  const activeSession = computed<AiChatSession>(() => ensureActiveSession());
  const activeScopeLabel = computed(() => scopeLabel(activeSession.value.scope));
  const activeScopeKey = computed<string>({
    get: () => scopeKey(activeSession.value.scope),
    set: (key) => {
      const session = activeSession.value;
      replaceSession({ ...session, scope: scopeFromKey(key), updatedAt: nowIso() });
    },
  });

  const sessionsList = computed<AiChatSession[]>(() => {
    return [...sessions.value].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  });

  const displayMessages = computed<DisplayMessage[]>(() => {
    const session = activeSession.value;
    const visible = session.messages.filter((m) => m.role !== 'system');
    const list: DisplayMessage[] = [];

    if (!visible.length && !(isStreaming.value && streamingSessionId.value === session.id)) {
      list.push({ role: 'assistant', html: escapeHtml(INTRO_MESSAGE) });
      return list;
    }

    for (const m of visible) {
      if (m.role === 'user') {
        list.push({ role: 'user', html: escapeHtml(m.displayContent || m.content) });
      } else if (m.role === 'assistant') {
        list.push({ role: 'assistant', html: renderMarkdown(m.content) });
      }
    }

    if (isStreaming.value && streamingSessionId.value === session.id) {
      const partial = streamingPartial.value;
      list.push({
        role: 'assistant',
        html: partial ? renderMarkdown(partial) : escapeHtml('思考中...'),
        pending: true,
      });
    }

    return list;
  });

  function persistSessions(): void {
    if (!sessionsLoaded) return;
    try {
      const stored = sessionsList.value.slice(0, MAX_STORED_SESSIONS);
      localStorage.setItem(AI_CHAT_SESSIONS_KEY, JSON.stringify({
        activeSessionId: activeSessionId.value,
        sessions: stored,
      }));
    } catch { /* ignore */ }
  }

  function replaceSession(next: AiChatSession): void {
    const found = sessions.value.some((item) => item.id === next.id);
    sessions.value = found
      ? sessions.value.map((item) => (item.id === next.id ? next : item))
      : [next, ...sessions.value];
    persistSessions();
  }

  function ensureActiveSession(): AiChatSession {
    let current = sessions.value.find((item) => item.id === activeSessionId.value);
    if (!current) {
      current = sessions.value[0] || createSession();
      if (!sessions.value.some((item) => item.id === current!.id)) sessions.value = [current];
      activeSessionId.value = current.id;
      persistSessions();
    }
    return current;
  }

  function updateSessionMessages(sessionId: string, messages: ChatMessage[]): void {
    const current = sessions.value.find((item) => item.id === sessionId);
    if (!current) return;
    const firstUser = messages.find((item) => item.role === 'user');
    replaceSession({
      ...current,
      title: firstUser ? cleanTitle(firstUser.displayContent || firstUser.content) : current.title,
      messages,
      updatedAt: nowIso(),
    });
  }

  function resetCurrentChat(): void {
    const session = activeSession.value;
    deltaBuffer.clear();
    streamingReply = '';
    replaceSession({
      ...session,
      title: '新对话',
      messages: defaultMessages(),
      updatedAt: nowIso(),
    });
  }

  function startNewChat(scopeKeyValue = 'global'): void {
    if (isStreaming.value) return;
    const session = createSession(scopeFromKey(scopeKeyValue));
    sessions.value = [session, ...sessions.value].slice(0, MAX_STORED_SESSIONS);
    activeSessionId.value = session.id;
    persistSessions();
  }

  function deleteCurrentChat(): void {
    if (isStreaming.value) return;
    const currentId = activeSession.value.id;
    const next = sessions.value.filter((item) => item.id !== currentId);
    sessions.value = next.length ? next : [createSession()];
    activeSessionId.value = sessions.value[0].id;
    persistSessions();
  }

  function scopePrompt(scope: AiChatScope): string {
    if (scope.type !== 'host' || !scope.hostId) return '[AI 范围: 全局，不限定单台主机]';
    const host = hosts.hostMap.get(scope.hostId);
    const label = host?.name || scope.hostId;
    const endpoint = host && host.type !== 'local' ? `${host.username || 'root'}@${host.host}:${host.port || 22}` : '本机';
    return `[AI 范围: ${label} / ${endpoint} / hostId=${scope.hostId}]`;
  }

  function handleAuthExpired(message: string): void {
    auth.setAuthenticated(false);
    notify.error(message || '登录已失效，请重新登录');
    router.push('/').catch(() => { /* ignore */ });
  }

  async function sendMessage(): Promise<void> {
    const userContent = inputText.value.trim();
    if (!userContent || isStreaming.value) return;

    const session = activeSession.value;
    const sessionId = session.id;
    const userMessage: ChatMessage = {
      role: 'user',
      content: `${scopePrompt(session.scope)}\n${userContent}`,
      displayContent: userContent,
    };
    const requestMessages = [...session.messages, userMessage];
    updateSessionMessages(sessionId, requestMessages);
    inputText.value = '';

    streamingSessionId.value = sessionId;
    streamingPartial.value = '';
    streamingReply = '';
    deltaBuffer.clear();
    isStreaming.value = true;
    currentAbortController = new AbortController();

    try {
      const requestBody: Record<string, unknown> = {
        messages: requestMessages.map(({ role, content }) => ({ role, content })),
      };
      const customConfig = window.__aiApiConfig || config.value;
      if (customConfig.apiBase) requestBody.apiBase = customConfig.apiBase;
      if (customConfig.apiKey) requestBody.apiKey = customConfig.apiKey;
      if (customConfig.model) requestBody.model = customConfig.model;

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify(requestBody),
        signal: currentAbortController!.signal,
      });

      if (response.status === 401) {
        const data = await response.json().catch(() => ({}));
        const msg = (data as { error?: string }).error || '登录已失效，请重新登录';
        handleAuthExpired(msg);
        throw new Error(msg);
      }
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || '聊天请求失败');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let parsed: { error?: string; choices?: Array<{ delta?: { content?: string } }> };
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (parsed.error) throw new Error(parsed.error);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) deltaBuffer.push(delta);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const raw = buffer.trim().startsWith('data:') ? buffer.trim().slice(5).trim() : '';
        if (raw && raw !== '[DONE]') {
          const parsed = JSON.parse(raw) as { error?: string; choices?: Array<{ delta?: { content?: string } }> };
          if (parsed.error) throw new Error(parsed.error);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) deltaBuffer.push(delta);
        }
      }
      deltaBuffer.flushNow();
      updateSessionMessages(sessionId, [
        ...requestMessages,
        { role: 'assistant', content: streamingReply || '(无文字回复)' },
      ]);
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      deltaBuffer.flushNow();
      updateSessionMessages(sessionId, [
        ...requestMessages,
        { role: 'assistant', content: isAbort ? (streamingReply || '(已停止)') : `请求失败：${(err as Error).message || '请求失败'}` },
      ]);
    } finally {
      currentAbortController = null;
      streamingSessionId.value = '';
      streamingPartial.value = '';
      streamingReply = '';
      deltaBuffer.clear();
      isStreaming.value = false;
    }
  }

  function stopStreaming(): void {
    currentAbortController?.abort();
  }

  function loadConfig(): void {
    try {
      const saved = localStorage.getItem(AI_CONFIG_KEY);
      if (!saved) return;
      const obj = JSON.parse(saved) as Partial<AiConfig>;
      const merged: AiConfig = {
        apiBase: obj.apiBase || '',
        apiKey: obj.apiKey || '',
        model: obj.model || '',
      };
      config.value = merged;
      if (merged.apiBase || merged.apiKey || merged.model) {
        window.__aiApiConfig = merged;
      }
    } catch { /* ignore */ }
  }

  function loadSessions(): void {
    try {
      const saved = localStorage.getItem(AI_CHAT_SESSIONS_KEY);
      if (!saved) throw new Error('empty');
      const parsed = JSON.parse(saved) as { activeSessionId?: string; sessions?: unknown[] };
      const restored = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((item) => {
          const raw = item as Partial<AiChatSession>;
          return {
            id: raw.id || createId(),
            title: cleanTitle(raw.title || ''),
            scope: raw.scope?.type === 'host' ? { type: 'host', hostId: raw.scope.hostId } : { type: 'global' },
            messages: safeMessages(raw.messages),
            createdAt: raw.createdAt || nowIso(),
            updatedAt: raw.updatedAt || raw.createdAt || nowIso(),
          } satisfies AiChatSession;
        })
        : [];
      sessions.value = restored.length ? restored.slice(0, MAX_STORED_SESSIONS) : [createSession()];
      activeSessionId.value = restored.some((item) => item.id === parsed.activeSessionId)
        ? String(parsed.activeSessionId)
        : sessions.value[0].id;
    } catch {
      const session = createSession();
      sessions.value = [session];
      activeSessionId.value = session.id;
    }
    sessionsLoaded = true;
    persistSessions();
  }

  function saveConfig(next: AiConfig): void {
    config.value = { ...next };
    window.__aiApiConfig = { ...next };
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(next));
  }

  async function fetchModels(apiBase: string, apiKey: string): Promise<string[]> {
    const cleanBase = apiBase.trim().replace(/\/$/, '');
    if (!cleanBase || !apiKey.trim()) throw new Error('请先填写 API 地址和 Key');
    const res = await fetch('/api/ai/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
      body: JSON.stringify({ apiBase: cleanBase, apiKey: apiKey.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || `请求失败 (${res.status})`);
    }
    const data = await res.json().catch(() => ({})) as { models?: string[] };
    return data.models || [];
  }

  function openConfigModal(): void { configModalOpen.value = true; }
  function closeConfigModal(): void { configModalOpen.value = false; }

  let initialized = false;
  function initialize(): void {
    if (initialized) return;
    initialized = true;
    loadConfig();
    loadSessions();
  }

  return {
    displayMessages,
    sessionsList,
    scopeOptions,
    activeSession,
    activeSessionId,
    activeScopeKey,
    activeScopeLabel,
    isStreaming,
    inputText,
    config,
    configModalOpen,
    initialize,
    sendMessage,
    stopStreaming,
    resetCurrentChat,
    startNewChat,
    deleteCurrentChat,
    openConfigModal,
    closeConfigModal,
    saveConfig,
    fetchModels,
    scopeLabel,
  };
}
