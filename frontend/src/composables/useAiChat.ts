import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { escapeHtml, renderMarkdown } from '@/utils/markdown';

const INTRO_MESSAGE = '旧版 AI Chat 的直连聊天入口已移除。请切换到 1Shell AI 使用新的 VPS 探查和自动化能力。';
const RETIRED_MESSAGE = '旧版 AI Chat 的直连聊天入口已移除。请切换到右侧的 1Shell AI 继续对话。';

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
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string;
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  html: string;
  pending?: boolean;
}

export interface AiChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AiChatApi {
  readonly displayMessages: ComputedRef<DisplayMessage[]>;
  readonly sessionsList: ComputedRef<AiChatSession[]>;
  readonly activeSession: ComputedRef<AiChatSession>;
  readonly activeSessionId: Ref<string>;
  readonly isStreaming: Ref<boolean>;
  readonly inputText: Ref<string>;
  readonly config: Ref<AiConfig>;
  readonly configModalOpen: Ref<boolean>;

  initialize(): void;
  sendMessage(): Promise<void>;
  stopStreaming(): void;
  resetCurrentChat(): void;
  startNewChat(): void;
  deleteCurrentChat(): void;
  openConfigModal(): void;
  closeConfigModal(): void;
  saveConfig(next: AiConfig): void;
  fetchModels(apiBase: string, apiKey: string): Promise<string[]>;
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

function cleanTitle(value: string): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH)}...` : text;
}

function safeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is ChatMessage => {
      if (!item || typeof item !== 'object') return false;
      const msg = item as ChatMessage;
      return ['user', 'assistant'].includes(msg.role) && typeof msg.content === 'string';
    })
    .map((item) => ({
      role: item.role,
      content: item.content,
      ...(typeof item.displayContent === 'string' ? { displayContent: item.displayContent } : {}),
    }));
}

function createSession(): AiChatSession {
  const ts = nowIso();
  return {
    id: createId(),
    title: '新对话',
    messages: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function create(): AiChatApi {
  const sessions = ref<AiChatSession[]>([]);
  const activeSessionId = ref('');
  const isStreaming = ref(false);
  const inputText = ref('');
  const configModalOpen = ref(false);
  const config = ref<AiConfig>({ apiBase: '', apiKey: '', model: '' });

  const activeSession = computed<AiChatSession>(() => ensureActiveSession());

  const sessionsList = computed<AiChatSession[]>(() => {
    return [...sessions.value].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  });

  const displayMessages = computed<DisplayMessage[]>(() => {
    const session = activeSession.value;
    const list: DisplayMessage[] = [];

    if (!session.messages.length) {
      list.push({ role: 'assistant', html: escapeHtml(INTRO_MESSAGE) });
      return list;
    }

    for (const m of session.messages) {
      if (m.role === 'user') {
        list.push({ role: 'user', html: escapeHtml(m.displayContent || m.content) });
      } else if (m.role === 'assistant') {
        list.push({ role: 'assistant', html: renderMarkdown(m.content) });
      }
    }

    return list;
  });

  let sessionsLoaded = false;

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
    replaceSession({
      ...session,
      title: '新对话',
      messages: [],
      updatedAt: nowIso(),
    });
  }

  function startNewChat(): void {
    if (isStreaming.value) return;
    const session = createSession();
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

  async function sendMessage(): Promise<void> {
    const userContent = inputText.value.trim();
    if (!userContent || isStreaming.value) return;

    const session = activeSession.value;
    const userMessage: ChatMessage = { role: 'user', content: userContent, displayContent: userContent };
    updateSessionMessages(session.id, [
      ...session.messages,
      userMessage,
      { role: 'assistant', content: RETIRED_MESSAGE },
    ]);
    inputText.value = '';
  }

  function stopStreaming(): void {}

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
    activeSession,
    activeSessionId,
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
  };
}
