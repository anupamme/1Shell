// useStudioRunner.ts — IDE 工作台核心 composable
// 与任务运行器同套路：集中 state + socket on/emit + cleanup
// 迭代 1 范围：7 socket on + 5 emit + 全部 state + API + deploy_mcp/refine 入口
// 迭代 2：补 ide:mcp-status / ide:approve-request 监听 + ide:mcp-start/stop / ide:approve-response emit + ApproveBar

import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useSocket } from '@/composables/useSocket';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';
import { readStorageState, writeStorageState } from '@/composables/usePageState';
import { bindAiAgentStreamHandlers, createAiAgentStreamController } from '@/composables/useAiAgentStream';
import { createStreamDeltaBuffer } from '@/utils/streaming';
import { appendAiToolLog, appendAiToolNote, finishAiToolCall, startAiToolCall, type AiAssistantTurn, type AiToolCallState } from '@/utils/aiMessages';
import {
  type HostInfo, type SelectedPath, type SelectedContainer,
  type SkillInfo, type McpInfo, type LocalMcpStatus,
  type ToolFilter, type ToolItem,
  type ContainerScanResult, type ContainerScanItem,
  type FpItem,
  type ChatSession, type SessionMessage, type AiMessage, type AiLineKind,
  type SendContext,
  type AuthoringArtifact, type AuthoringInteraction, type AuthoringStage, type AuthoringSessionSnapshot,
  type ApprovePayload, type ApproveAction,
  HISTORY_KEY, ERROR_CONTEXT_KEY, SESSIONS_MAX, APPROVE_TIMEOUT_SEC,
  truncate60, newSessionId, collectAuthoringResidualPaths,
  DOCKER_SCAN_CMD, parseDockerScan,
} from '@/utils/studio';

type RunStatusKind = 'idle' | 'starting' | 'running' | 'done' | 'error' | 'cancelled';

interface AckResponse { ok?: boolean; error?: string }
interface ExecResponse { stdout?: string; stderr?: string }
interface FpListResponse { path: string; parent: string | null; items: FpItem[] }
interface CleanupResidualsResponse { ok?: boolean; deleted?: string[]; missing?: string[]; rejected?: Array<{ path: string; reason: string }> }

interface StudioPrefs {
  selectedHostIds: string[];
  selectedPaths: SelectedPath[];
  selectedContainers: SelectedContainer[];
  selectedTools: string[];
  scanHostId: string;
  toolFilter: ToolFilter;
  currentSessionId: string | null;
  taskInput: string;
  ccCollab: boolean;
  historyDrawerOpen: boolean;
}

const STUDIO_PREFS_KEY = '1shell.skill-studio.prefs.v4.0.0';

export function useStudioRunner() {
  const socket = useSocket();
  const { requestJson } = useApiClient();
  const { confirm } = useConfirm();
  const notify = useNotifyStore();
  const savedPrefs = readStorageState<StudioPrefs>(STUDIO_PREFS_KEY, {
    selectedHostIds: [],
    selectedPaths: [],
    selectedContainers: [],
    selectedTools: [],
    scanHostId: 'local',
    toolFilter: 'all',
    currentSessionId: null,
    taskInput: '',
    ccCollab: false,
    historyDrawerOpen: false,
  });

  /* ─── state ───────────────────────────────────────── */
  const hosts = shallowRef<HostInfo[]>([]);
  const skillList = shallowRef<SkillInfo[]>([]);
  const mcpList = shallowRef<McpInfo[]>([]);

  const selectedHosts = ref<Map<string, HostInfo>>(new Map());
  const selectedPaths = ref<SelectedPath[]>(savedPrefs.selectedPaths);
  const selectedContainers = ref<Map<string, SelectedContainer>>(new Map((savedPrefs.selectedContainers || []).map((c) => [`${c.hostId}::${c.name}`, c])));
  const selectedTools = ref<Set<string>>(new Set(savedPrefs.selectedTools)); // 'skill:<id>' | 'mcp:<id>'
  const localMcpStatus = ref<Map<string, LocalMcpStatus>>(new Map()); // 迭代 2 才填

  // 容器扫描
  const scanHostId = ref<string>(savedPrefs.scanHostId);
  const containerScan = shallowRef<ContainerScanResult | null>(null);
  const scanning = ref(false);
  const toolFilter = ref<ToolFilter>(savedPrefs.toolFilter);

  // chat / sessions
  const sessions = ref<ChatSession[]>([]);
  const currentSessionId = ref<string | null>(savedPrefs.currentSessionId);
  const currentMessages = computed<SessionMessage[]>(() => {
    const s = sessions.value.find((x) => x.id === currentSessionId.value);
    return s ? s.messages : [];
  });

  // run state
  const isRunning = ref(false);
  const runStatusKind = ref<RunStatusKind>('idle');
  const runStatusText = ref('待命');
  const authoringSession = ref<AuthoringSessionSnapshot | null>(null);

  // 当前 turn 的工具调用列表（每 run 重置；ToolProgressBar 渲染用）
  const currentToolCalls = ref<AiToolCallState[]>([]);

  // 输入区
  const taskInput = ref(savedPrefs.taskInput);
  const ccCollab = ref(savedPrefs.ccCollab);

  // 历史抽屉
  const historyDrawerOpen = ref(savedPrefs.historyDrawerOpen);

  // Agent 审批条（迭代 2）
  const pendingApprove = ref<ApprovePayload | null>(null);
  const approveCountdown = ref<number>(APPROVE_TIMEOUT_SEC);
  let approveTickHandle: ReturnType<typeof setInterval> | null = null;
  let approveDeadlineMs = 0;
  let stopFallbackHandle: ReturnType<typeof setTimeout> | null = null;
  let sendAckHandle: ReturnType<typeof setTimeout> | null = null;
  let sendConnectHandle: ReturnType<typeof setTimeout> | null = null;
  let pendingConnectSend: (() => void) | null = null;
  const streamController = createAiAgentStreamController(() => currentSessionId.value);

  interface IdeSocketMessage {
    sessionId?: string;
    runId?: string;
  }

  /* ─── computed ────────────────────────────────────── */

  // 主机列表合并（local 永远在顶，且去掉 hosts 里 id==='local' 防重）
  const allHosts = computed<HostInfo[]>(() => [
    { id: 'local', name: '本机', host: '127.0.0.1' },
    ...hosts.value.filter((h) => h.id !== 'local'),
  ]);

  const toolItems = computed<ToolItem[]>(() => {
    const items: ToolItem[] = [];
    for (const s of skillList.value) {
      items.push({ kind: 'skill', id: s.id, name: s.name, icon: s.icon || '🔧', meta: truncate60(s.description), isLocal: false, statusDot: '' });
    }
    for (const m of mcpList.value) {
      const isLocal = m.type === 'local' || Boolean(m.command);
      const status = localMcpStatus.value.get(m.id);
      const runtimeStatus = status?.status || m.runtimeStatus;
      const statusDot = isLocal ? (runtimeStatus === 'running' ? ' 🟢' : runtimeStatus === 'starting' ? ' 🟡' : '') : '';
      items.push({
        kind: isLocal ? 'local' : 'mcp',
        id: m.id, name: m.name,
        icon: isLocal ? '📦' : '🔌',
        meta: truncate60(m.description || m.url || m.command),
        isLocal, statusDot,
      });
    }
    return items;
  });

  const filteredToolItems = computed<ToolItem[]>(() =>
    toolItems.value.filter((it) => toolFilter.value === 'all' || it.kind === toolFilter.value)
  );

  const toolItemKey = (it: ToolItem): string => (it.isLocal ? `mcp:${it.id}` : `${it.kind}:${it.id}`);

  const summaryText = computed(() =>
    `主机: ${selectedHosts.value.size} · 路径: ${selectedPaths.value.length} · 容器: ${selectedContainers.value.size} · 工具: ${selectedTools.value.size}`
  );

  interface AuthoringStageDisplay {
    stage: string;
    label: string;
    stages: AuthoringStage[];
  }

  const authoringStageOrder: AuthoringStage[] = ['discovery', 'options', 'spec', 'plan', 'draft', 'review', 'commit', 'verify'];
  const authoringStageLabels: Record<AuthoringStage, string> = {
    discovery: 'Discovery',
    options: 'Options',
    spec: 'Spec',
    plan: 'Plan',
    draft: 'Draft',
    review: 'Review',
    commit: 'Commit',
    verify: 'Verify',
    done: 'Done',
    blocked: 'Blocked',
  };
  const programAuthoringStageDefs: AuthoringStageDisplay[] = [
    { stage: 'program-type', label: '类型判断', stages: ['discovery'] },
    { stage: 'program-definition', label: '任务定义', stages: ['options', 'spec', 'plan'] },
    { stage: 'program-draft', label: 'Draft', stages: ['draft'] },
    { stage: 'program-review', label: 'Review', stages: ['review'] },
    { stage: 'program-commit', label: 'Commit', stages: ['commit'] },
    { stage: 'program-verify', label: 'Verify', stages: ['verify'] },
  ];
  const defaultAuthoringStageDefs: AuthoringStageDisplay[] = authoringStageOrder.map((stage) => ({
    stage,
    label: authoringStageLabels[stage],
    stages: [stage],
  }));

  function isProgramAuthoringIntent(intent?: string): boolean {
    return intent === 'create_program' || intent === 'edit_program';
  }

  function authoringStageDefs(session: AuthoringSessionSnapshot | null): AuthoringStageDisplay[] {
    return isProgramAuthoringIntent(session?.intent) ? programAuthoringStageDefs : defaultAuthoringStageDefs;
  }

  function authoringStageIndex(stage: AuthoringStage, defs: AuthoringStageDisplay[]): number {
    if (stage === 'done') return defs.length;
    return defs.findIndex((item) => item.stages.includes(stage));
  }

  function labelForAuthoringStage(stage: AuthoringStage, session: AuthoringSessionSnapshot | null): string {
    const defs = authoringStageDefs(session);
    const item = defs.find((entry) => entry.stages.includes(stage));
    return item?.label || authoringStageLabels[stage] || stage;
  }

  const authoringStages = computed(() => {
    const session = authoringSession.value;
    const defs = authoringStageDefs(session);
    const currentIndex = session ? authoringStageIndex(session.stage, defs) : -1;
    return defs.map((item, index) => ({
      stage: item.stage,
      label: item.label,
      active: !!session && item.stages.includes(session.stage),
      done: !!session && (session.stage === 'done' || (currentIndex >= 0 && index < currentIndex)),
    }));
  });
  const authoringStageText = computed(() => authoringSession.value ? labelForAuthoringStage(authoringSession.value.stage, authoringSession.value) : '');

  function hostName(hostId: string): string {
    if (hostId === 'local') return '本机';
    const h = hosts.value.find((x) => x.id === hostId);
    return h ? h.name : hostId;
  }

  function saveStudioPrefs(): void {
    writeStorageState<StudioPrefs>(STUDIO_PREFS_KEY, {
      selectedHostIds: [...selectedHosts.value.keys()],
      selectedPaths: selectedPaths.value,
      selectedContainers: [...selectedContainers.value.values()],
      selectedTools: [...selectedTools.value],
      scanHostId: scanHostId.value,
      toolFilter: toolFilter.value,
      currentSessionId: currentSessionId.value,
      taskInput: taskInput.value,
      ccCollab: ccCollab.value,
      historyDrawerOpen: historyDrawerOpen.value,
    });
  }

  function restoreSelectedHosts(): void {
    if (!savedPrefs.selectedHostIds.length) return;
    const next = new Map<string, HostInfo>();
    for (const id of savedPrefs.selectedHostIds) {
      const h = allHosts.value.find((item) => item.id === id);
      if (h) next.set(id, h);
    }
    selectedHosts.value = next;
  }

  /* ─── chat helpers ────────────────────────────────── */

  function getSession(id: string | null): ChatSession | null {
    if (!id) return null;
    return sessions.value.find((x) => x.id === id) || null;
  }

  function sanitizeLoadedSessions(items: ChatSession[]): ChatSession[] {
    const staleAckText = 'ide:message 未收到确认，请检查 Socket 连接';
    let changed = false;
    const cleaned = items.map((session) => {
      const messages = (session.messages || []).filter((msg) => {
        const keep = !(msg.role === 'ai' && String(msg.content || '').includes(staleAckText));
        if (!keep) changed = true;
        return keep;
      });
      return messages === session.messages ? session : { ...session, messages };
    });
    if (changed) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(cleaned.slice(0, SESSIONS_MAX))); } catch { /* ignore */ }
    }
    return cleaned;
  }

  function loadSessionsFromStorage(): void {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      sessions.value = Array.isArray(parsed) ? sanitizeLoadedSessions(parsed) : [];
    } catch {
      sessions.value = [];
    }
  }

  function saveSessionsToStorage(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.value.slice(0, SESSIONS_MAX)));
    } catch { /* quota — ignore */ }
  }

  function newSession(title: string): ChatSession {
    const id = newSessionId();
    const s: ChatSession = { id, title: (title || '未命名').slice(0, 60), createdAt: Date.now(), messages: [] };
    sessions.value = [s, ...sessions.value];
    currentSessionId.value = id;
    saveSessionsToStorage();
    return s;
  }

  function saveMessageToCurrent(msg: SessionMessage): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    s.messages = [...s.messages, msg];
    // 首条用户消息更新 session 标题
    if (msg.role === 'user' && (!s.title || s.title === '未命名')
        && s.messages.filter((m) => m.role === 'user').length === 1) {
      s.title = msg.content.slice(0, 40);
    }
    sessions.value = [...sessions.value]; // 触发响应式
    saveSessionsToStorage();
  }

  function touchCurrentSession(): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    s.messages = [...s.messages];
    sessions.value = [...sessions.value];
  }

  function findToolHostMessage(toolUseId?: string): AiMessage | null {
    const s = getSession(currentSessionId.value);
    if (!s) return null;
    for (let i = s.messages.length - 1; i >= 0; i -= 1) {
      const msg = s.messages[i];
      if (msg.role !== 'ai') continue;
      if (!toolUseId || msg.toolCalls?.some((call) => call.toolUseId === toolUseId)) return msg;
    }
    return null;
  }

  function ensureToolHostMessage(toolUseId?: string): AiMessage | null {
    const existing = findToolHostMessage(toolUseId);
    if (existing) {
      existing.toolCalls = existing.toolCalls || [];
      return existing;
    }
    const s = getSession(currentSessionId.value);
    if (!s) return null;
    const last = s.messages[s.messages.length - 1];
    if (last?.role === 'ai' && !last.content.trim()) {
      last.toolCalls = last.toolCalls || [];
      return last;
    }
    const msg: AiMessage = { role: 'ai', kind: 'stream', content: '', toolCalls: [] };
    s.messages.push(msg);
    return msg;
  }

  function updateToolCallsFromTurn(msg: AiMessage, turn: AiAssistantTurn): void {
    msg.toolCalls = [...turn.toolCalls];
    currentToolCalls.value = [...turn.toolCalls];
    touchCurrentSession();
  }

  function appendUserMessage(text: string): void {
    if (!currentSessionId.value) newSession(text.slice(0, 40));
    saveMessageToCurrent({ role: 'user', content: text });
  }

  const deltaBuffer = createStreamDeltaBuffer((flushed) => {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last?.role === 'ai' && last.kind === 'stream') {
      last.content += flushed;
    } else {
      s.messages.push({ role: 'ai', kind: 'stream', content: flushed });
    }
    sessions.value = [...sessions.value];
  });

  function appendAiLine(kind: AiLineKind, text: string): void {
    if (kind === 'info' && /^AgentRun\s+已启动/.test(text)) return;
    deltaBuffer.flushNow();
    saveMessageToCurrent({ role: 'ai', kind, content: text });
  }

  function appendAiDelta(text: string): void {
    deltaBuffer.push(text);
  }

  function appendToolLog(toolUseId: string, stream: string | undefined, text: string): void {
    const msg = ensureToolHostMessage(toolUseId);
    if (!msg) return;
    const turn: AiAssistantTurn = { role: 'assistant', status: 'tool_running', lines: [], toolCalls: msg.toolCalls || [] };
    if (appendAiToolLog(turn, toolUseId, stream === 'stderr' ? 'stderr' : 'stdout', text)) {
      updateToolCallsFromTurn(msg, turn);
    }
  }

  function appendToolNote(toolUseId: string, kind: AiLineKind, text: string): void {
    const msg = findToolHostMessage(toolUseId);
    if (!msg) return;
    const turn: AiAssistantTurn = { role: 'assistant', status: 'tool_running', lines: [], toolCalls: msg.toolCalls || [] };
    if (appendAiToolNote(turn, toolUseId, kind, text)) {
      updateToolCallsFromTurn(msg, turn);
    }
  }

  function finalizeStreamPersist(): void {
    deltaBuffer.flushNow();
    const s = getSession(currentSessionId.value);
    if (!s) return;
    s.messages = [...s.messages];
    sessions.value = [...sessions.value];
    saveSessionsToStorage();
  }

  function appendAuthoringInteraction(interaction: AuthoringInteraction): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const exists = s.messages.some((m) => m.role === 'authoring' && m.interaction?.id === interaction.id);
    if (exists) return;
    saveMessageToCurrent({ role: 'authoring', interaction });
  }

  function appendAuthoringArtifact(artifact: AuthoringArtifact): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const existing = s.messages.find((m) => m.role === 'authoring' && m.artifact?.id === artifact.id);
    if (existing?.role === 'authoring') {
      existing.artifact = artifact;
      s.messages = [...s.messages];
      sessions.value = [...sessions.value];
      saveSessionsToStorage();
      return;
    }
    saveMessageToCurrent({ role: 'authoring', artifact });
  }

  function markAuthoringAnswered(interactionId: string): void {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    for (const msg of s.messages) {
      if (msg.role === 'authoring' && msg.interaction?.id === interactionId) {
        msg.interaction = { ...msg.interaction, answered: true };
      }
    }
    s.messages = [...s.messages];
    sessions.value = [...sessions.value];
    saveSessionsToStorage();
  }

  function switchSession(id: string): void {
    if (getSession(id)) {
      currentSessionId.value = id;
      if (!isRunning.value) currentToolCalls.value = [];
    }
  }

  function startNewChat(): void {
    deltaBuffer.clear();
    streamController.resetForNewSession();
    authoringSession.value = null;
    currentToolCalls.value = [];
    currentSessionId.value = null;
  }

  async function clearCurrentChat(): Promise<void> {
    const s = getSession(currentSessionId.value);
    if (!s) return;
    const ok = await confirm({ title: '清空对话', message: '清空当前对话的消息？', okText: '清空' });
    if (!ok) return;
    deltaBuffer.clear();
    currentToolCalls.value = [];
    s.messages = [];
    sessions.value = [...sessions.value];
    saveSessionsToStorage();
  }

  function residualCountForSession(session: ChatSession): number {
    return collectAuthoringResidualPaths(session).paths.length;
  }

  async function cleanupSessionResiduals(id: string, silent = false): Promise<CleanupResidualsResponse | null> {
    const session = getSession(id);
    if (!session) return null;
    const { paths } = collectAuthoringResidualPaths(session);
    if (paths.length === 0) {
      if (!silent) notify.info('这条历史没有可清理的文件残留');
      return { ok: true, deleted: [], missing: [], rejected: [] };
    }
    if (!silent) {
      const ok = await confirm({
        title: '清理文件残留',
        message: `只清理这条历史里未通过验证/未完成验证的落盘文件，共 ${paths.length} 个；不会删除历史记录。`,
        okText: '清理残留',
      });
      if (!ok) return null;
    }
    try {
      const result = await requestJson<CleanupResidualsResponse>('/api/skill-studio/cleanup-residuals', {
        method: 'POST',
        body: JSON.stringify({ sessionId: id, paths }),
      });
      if (!silent) {
        const deleted = result.deleted?.length || 0;
        const missing = result.missing?.length || 0;
        const rejected = result.rejected?.length || 0;
        if (deleted || missing) notify.success(`残留清理完成：删除 ${deleted} 个，已不存在 ${missing} 个${rejected ? `，跳过 ${rejected} 个已加载/受保护文件` : ''}`);
        else if (rejected) notify.warn(`没有删除文件，${rejected} 个文件被跳过`);
        else notify.info('没有发现可删除的残留文件');
      }
      return result;
    } catch (err) {
      if (!silent) notify.error('清理残留失败: ' + (err as Error).message);
      return null;
    }
  }

  async function deleteSession(id: string): Promise<void> {
    const session = getSession(id);
    if (!session) return;
    const residualCount = residualCountForSession(session);
    const ok = await confirm({
      title: '删除历史记录',
      message: residualCount > 0
        ? `删除这条历史记录，并同步清理其中 ${residualCount} 个未通过验证/未完成验证的文件残留？`
        : '删除这条历史记录？',
      okText: '删除',
    });
    if (!ok) return;
    if (residualCount > 0) await cleanupSessionResiduals(id, true);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (currentSessionId.value === id) {
      currentSessionId.value = null;
      authoringSession.value = null;
    }
    socket.emit('ide:clear', { sessionId: id });
    saveSessionsToStorage();
  }

  function toggleHistoryDrawer(): void {
    historyDrawerOpen.value = !historyDrawerOpen.value;
  }

  function setStatus(kind: RunStatusKind, text: string): void {
    runStatusKind.value = kind;
    runStatusText.value = text;
  }

  function completionKind(taskStatus?: string): RunStatusKind {
    return ['blocked', 'failed'].includes(String(taskStatus || '')) ? 'error' : 'done';
  }

  function completionText(taskStatus?: string, round?: number): string {
    const suffix = `(${round ?? 0} 轮)`;
    if (taskStatus === 'blocked') return `已阻塞 ${suffix}`;
    if (taskStatus === 'failed') return `失败 ${suffix}`;
    if (taskStatus === 'unverified' || taskStatus === 'partial') return `未验证 ${suffix}`;
    return `完成 ${suffix}`;
  }

  /* ─── socket on (迭代 1: 7 个) ────────────────────── */

  const handlers: [string, (...args: unknown[]) => void][] = [
    ['connect', () => {
      if (currentSessionId.value && isRunning.value) {
        socket.emit('ide:reattach', { sessionId: currentSessionId.value });
        setStatus('running', 'Socket 已重连，恢复接收...');
      }
    }],
    ['disconnect', () => {
      if (isRunning.value) setStatus('starting', 'Socket 已断开，等待重连...');
    }],
    ['connect_error', () => {
      if (isRunning.value) setStatus('starting', 'Socket 连接异常，等待重连...');
    }],
    ['ide:authoring-session', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { session?: AuthoringSessionSnapshot };
      if (!m || m.sessionId !== currentSessionId.value || !m.session) return;
      deltaBuffer.flushNow();
      authoringSession.value = m.session;
      setStatus('running', `创作流程：${labelForAuthoringStage(m.session.stage, m.session)}`);
    }],
    ['ide:authoring-interaction', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { interaction?: AuthoringInteraction };
      if (!m || m.sessionId !== currentSessionId.value || !m.interaction) return;
      deltaBuffer.flushNow();
      appendAuthoringInteraction(m.interaction);
    }],
    ['ide:authoring-artifact', (msg: unknown) => {
      const m = msg as IdeSocketMessage & { artifact?: AuthoringArtifact };
      if (!m || m.sessionId !== currentSessionId.value || !m.artifact) return;
      deltaBuffer.flushNow();
      appendAuthoringArtifact(m.artifact);
    }],
    ['ide:mcp-status', (msg: unknown) => {
      const m = msg as { mcpId?: string; status?: string; tools?: unknown[] };
      if (!m.mcpId) return;
      const next = new Map(localMcpStatus.value);
      next.set(m.mcpId, {
        status: (m.status as LocalMcpStatus['status']) || 'stopped',
        toolCount: Array.isArray(m.tools) ? m.tools.length : 0,
      });
      localMcpStatus.value = next;
    }],
  ];

  /* ─── API ─────────────────────────────────────────── */

  async function loadContext(): Promise<void> {
    try {
      const data = await requestJson<{ hosts?: HostInfo[] }>('/api/skill-studio/context');
      hosts.value = data.hosts || [];
      restoreSelectedHosts();
    } catch (err) {
      notify.error((err as Error).message || '加载主机列表失败');
    }
  }

  async function loadSkills(): Promise<void> {
    try {
      const [skillRes, mcpRes] = await Promise.all([
        requestJson<{ skills?: SkillInfo[] }>('/api/skills').catch(() => ({ skills: [] as SkillInfo[] })),
        requestJson<{ servers?: McpInfo[] }>('/api/mcp-servers').catch(() => ({ servers: [] as McpInfo[] })),
      ]);
      skillList.value = (skillRes.skills || []).filter((s) => s.id !== 'skill-authoring');
      mcpList.value = (mcpRes.servers || []).filter((m) => m.enabled !== false && m.exposeToIde !== false);
    } catch { /* 静默 */ }
  }

  async function scanContainers(): Promise<void> {
    const hostId = scanHostId.value || 'local';
    scanning.value = true;
    containerScan.value = null; // 让 UI 显"扫描中…"

    const tryExec = (): Promise<ExecResponse> => requestJson<ExecResponse>('/api/exec', {
      method: 'POST',
      body: JSON.stringify({ hostId, command: DOCKER_SCAN_CMD, timeout: 12000 }),
    });

    try {
      const res = await tryExec();
      containerScan.value = parseDockerScan(res.stdout || '');
    } catch (err) {
      // 第一次失败：800ms 后自动重试 1 次
      await new Promise((r) => setTimeout(r, 800));
      try {
        const res2 = await tryExec();
        containerScan.value = parseDockerScan(res2.stdout || '');
      } catch (err2) {
        containerScan.value = { kind: 'error', message: (err2 as Error).message.slice(0, 80) };
      }
    }
    scanning.value = false;
  }

  async function loadFpDir(hostId: string, dirPath: string): Promise<FpListResponse | null> {
    try {
      const url = `/api/files/list?hostId=${encodeURIComponent(hostId)}&path=${encodeURIComponent(dirPath || '')}`;
      const data = await requestJson<FpListResponse>(url);
      return data;
    } catch (err) {
      notify.error('加载目录失败: ' + (err as Error).message);
      return null;
    }
  }

  /* ─── 4 个选择集合的 toggle ────────────────────────── */

  function toggleHost(id: string): void {
    const m = new Map(selectedHosts.value);
    if (m.has(id)) m.delete(id);
    else {
      const h = allHosts.value.find((x) => x.id === id);
      if (h) m.set(id, h);
    }
    selectedHosts.value = m;
  }

  function addPath(path: string): void {
    const p = path.trim();
    if (!p) return;
    if (selectedHosts.value.size === 0) {
      notify.error('请先在左上角选中至少一台主机');
      return;
    }
    const next = selectedPaths.value.slice();
    for (const h of selectedHosts.value.values()) {
      next.push({ hostId: h.id, path: p });
    }
    selectedPaths.value = next;
  }

  function addPickedPath(hostId: string, path: string): void {
    // fp-modal 内的"➕"添加：去重
    if (selectedPaths.value.find((x) => x.hostId === hostId && x.path === path)) return;
    selectedPaths.value = [...selectedPaths.value, { hostId, path }];
  }

  function removePath(index: number): void {
    selectedPaths.value = selectedPaths.value.filter((_, i) => i !== index);
  }

  function toggleContainer(hostId: string, c: ContainerScanItem): void {
    const key = `${hostId}::${c.name}`;
    const m = new Map(selectedContainers.value);
    if (m.has(key)) m.delete(key);
    else m.set(key, { hostId, name: c.name, image: c.image });
    selectedContainers.value = m;
  }

  function unpinContainer(key: string): void {
    const m = new Map(selectedContainers.value);
    m.delete(key);
    selectedContainers.value = m;
  }

  function isContainerSelected(hostId: string, name: string): boolean {
    return selectedContainers.value.has(`${hostId}::${name}`);
  }

  function toggleTool(it: ToolItem): void {
    const key = toolItemKey(it);
    const s = new Set(selectedTools.value);
    if (s.has(key)) {
      s.delete(key);
      if (it.isLocal) stopLocalMcp(it.id);
    } else {
      s.add(key);
      if (it.isLocal) startLocalMcp(it.id);
    }
    selectedTools.value = s;
  }

  /* ─── 本地 MCP 启停（迭代 2） ──────────────────────── */

  function startLocalMcp(mcpId: string): void {
    socket.emit('ide:mcp-start', { mcpId }, (ack: AckResponse) => {
      if (!ack?.ok) {
        notify.error(`MCP 启动失败: ${ack?.error || '未知错误'}`);
      }
    });
  }

  function stopLocalMcp(mcpId: string): void {
    socket.emit('ide:mcp-stop', { mcpId });
  }

  /* ─── Agent 审批条 emit（迭代 2） ────────────────── */

  function clearApproveCountdown(): void {
    if (approveTickHandle !== null) {
      clearInterval(approveTickHandle);
      approveTickHandle = null;
    }
    approveDeadlineMs = 0;
  }

  function startApproveCountdown(): void {
    clearApproveCountdown();
    approveDeadlineMs = Date.now() + APPROVE_TIMEOUT_SEC * 1000;
    approveCountdown.value = APPROVE_TIMEOUT_SEC;
    approveTickHandle = setInterval(() => {
      if (!pendingApprove.value || approveDeadlineMs <= 0) {
        clearApproveCountdown();
        return;
      }
      const remaining = Math.max(0, Math.ceil((approveDeadlineMs - Date.now()) / 1000));
      approveCountdown.value = remaining;
      if (remaining <= 0) {
        clearApproveCountdown();
        pendingApprove.value = null;
        notify.error('审批已超时，请重新发起操作');
      }
    }, 1000);
  }

  function respondApprove(action: ApproveAction, text: string = ''): void {
    const p = pendingApprove.value;
    if (!p) return;
    if (action === 'custom') {
      const t = text.trim();
      if (!t) {
        notify.error('请输入自定义回复');
        return;
      }
      text = t;
    }
    clearApproveCountdown();
    socket.emit(p.responseEvent || 'ide:approve-response', {
      requestId: p.requestId,
      sessionId: p.sessionId,
      action,
      text: text || '',
    });
    pendingApprove.value = null;
  }

  /* ─── Agent options sync ──────────────────────────── */

  function setCcCollab(enabled: boolean): void {
    ccCollab.value = enabled;
    if (currentSessionId.value) {
      socket.emit('ide:claude-code-collab', { sessionId: currentSessionId.value, enabled });
    }
  }

  /* ─── onSend / onStop ─────────────────────────────── */

  function buildSendContext(): SendContext {
    return {
      hosts: [...selectedHosts.value.values()].map((h) => ({
        id: h.id, name: h.name, host: h.host, username: h.username, port: h.port,
      })),
      containers: [...selectedContainers.value.values()],
      files: selectedPaths.value.map((p) => ({ hostId: p.hostId, path: p.path })),
      mcpServers: [...selectedTools.value].filter((k) => k.startsWith('mcp:')).map((k) => {
        const id = k.slice(4);
        const srv = mcpList.value.find((m) => m.id === id);
        return srv ? { id: srv.id, name: srv.name, url: srv.url } : { id };
      }),
    };
  }

  function emitIdeMessage(task: string): void {
    sendAckHandle = setTimeout(() => {
      setStatus('error', '启动超时');
      appendAiLine('error', 'ide:message 已发送但未收到后端确认，请检查后端 Socket handler');
      finalize();
    }, 8000);

    socket.emit('ide:message', {
      sessionId: currentSessionId.value,
      message: task,
      context: buildSendContext(),
      claudeCodeEnabled: ccCollab.value,
      entry: 'studio',
    }, (ack: AckResponse) => {
      if (sendAckHandle !== null) {
        clearTimeout(sendAckHandle);
        sendAckHandle = null;
      }
      if (!ack?.ok) {
        setStatus('error', '启动失败');
        appendAiLine('error', ack?.error || 'ide:message 被拒绝');
        finalize();
        return;
      }
      const sid = currentSessionId.value;
      if (sid) {
        socket.emit('ide:claude-code-collab', { sessionId: sid, enabled: ccCollab.value });
      }
    });
  }

  function sendWhenSocketReady(task: string): void {
    if (socket.connected) {
      emitIdeMessage(task);
      return;
    }
    setStatus('starting', '连接 Socket 中...');
    pendingConnectSend = () => {
      if (sendConnectHandle !== null) {
        clearTimeout(sendConnectHandle);
        sendConnectHandle = null;
      }
      pendingConnectSend = null;
      emitIdeMessage(task);
    };
    socket.once('connect', pendingConnectSend);
    socket.connect();
    sendConnectHandle = setTimeout(() => {
      if (pendingConnectSend) socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
      setStatus('error', 'Socket 未连接');
      appendAiLine('error', 'Socket 尚未连接，ide:message 未发送；请确认后端已启动并刷新页面重试');
      finalize();
    }, 8000);
  }

  async function sendTask(task: string): Promise<void> {
    deltaBuffer.clear();
    streamController.resetForNewRun();
    currentToolCalls.value = [];
    appendUserMessage(task);
    isRunning.value = true;
    setStatus('starting', '启动中...');

    sendWhenSocketReady(task);
  }

  async function onSend(): Promise<void> {
    const task = taskInput.value.trim();
    if (!task) {
      notify.error('请输入自然语言描述');
      return;
    }
    if (isRunning.value) return;
    taskInput.value = '';
    await sendTask(task);
  }

  function respondAuthoring(interaction: AuthoringInteraction, value: string, label: string): void {
    if (isRunning.value) {
      notify.error('请等待当前回复完成后再选择');
      return;
    }
    if (!currentSessionId.value || !authoringSession.value) return;
    const text = interaction.kind === 'commit_approval'
      ? (value === 'approve'
        ? `我确认执行：${label || '写入创作产物文件'}：${interaction.artifactId || ''}`
        : `暂不写入，继续修改草案：${interaction.artifactId || ''}`)
      : interaction.kind === 'options'
        ? `我选择方案 ${value}：${label}`
        : `${interaction.question || '我的回答'}：${label || value}`;
    socket.emit('ide:authoring-reply', {
      sessionId: currentSessionId.value,
      authoringSessionId: authoringSession.value.id,
      interactionId: interaction.id,
      value,
      text,
    }, (ack: AckResponse) => {
      if (!ack?.ok) {
        notify.error(ack?.error || '提交选择失败');
        return;
      }
      markAuthoringAnswered(interaction.id);
      void sendTask(text);
    });
  }

  function onStop(): void {
    if (!currentSessionId.value) return;
    const stoppedSessionId = currentSessionId.value;
    streamController.markStopRequested();
    streamController.rememberStoppedRun();
    socket.emit('ide:stop', { sessionId: stoppedSessionId }, (ack: AckResponse) => {
      if (!ack?.ok && isRunning.value) {
        setStatus('cancelled', '停止请求失败');
        finalize();
      }
    });
    setStatus('cancelled', '正在停止...');
    if (stopFallbackHandle !== null) clearTimeout(stopFallbackHandle);
    stopFallbackHandle = setTimeout(() => {
      if (isRunning.value && currentSessionId.value === stoppedSessionId) {
        setStatus('cancelled', '已停止');
        appendAiLine('error', '已停止');
        finalize();
      }
    }, 2500);
  }

  function finalize(): void {
    deltaBuffer.flushNow();
    isRunning.value = false;
    streamController.clearStopRequested();
    pendingApprove.value = null;
    clearApproveCountdown();
    if (stopFallbackHandle !== null) {
      clearTimeout(stopFallbackHandle);
      stopFallbackHandle = null;
    }
    if (sendAckHandle !== null) {
      clearTimeout(sendAckHandle);
      sendAckHandle = null;
    }
    if (sendConnectHandle !== null) {
      clearTimeout(sendConnectHandle);
      sendConnectHandle = null;
    }
    if (pendingConnectSend) {
      socket.off('connect', pendingConnectSend);
      pendingConnectSend = null;
    }
    // 任务完成后重拉 skill 列表（用户可能新建了 skill）
    void loadSkills();
  }

  /* ─── 跨页入口：deploy_mcp / refine（13.2 = B 补齐） ─── */

  async function handleEntryQuery(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const deployUrl = params.get('deploy_mcp');
    const mode = params.get('mode');
    const target = params.get('target');

    if (deployUrl) {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => {
        taskInput.value = `帮我部署这个 MCP Server 到本地：${deployUrl}\n请 clone 仓库、安装依赖、识别启动命令，然后用 deploy_local_mcp 注册。`;
        void onSend();
      }, 500);
      return;
    }

    if (mode === 'refine' && target) {
      window.history.replaceState({}, '', window.location.pathname);
      const targetItem = skillList.value.find((s) => s.id === target);
      const artifactName = targetItem?.name || target;
      let errorCtx = '';
      try {
        errorCtx = sessionStorage.getItem(ERROR_CONTEXT_KEY) || '';
        sessionStorage.removeItem(ERROR_CONTEXT_KEY);
      } catch { /* quota */ }
      setTimeout(() => {
        const lines: string[] = [`请帮我改进产物「${artifactName}」（id: ${target}）。`];
        if (errorCtx) {
          lines.push('', '上一次运行的错误信息：', '```', errorCtx, '```', '');
          lines.push('请分析以上错误的根因，定位是任务 L1/action、Skill 约束还是执行命令本身的问题，并给出具体修改方案。');
        } else {
          lines.push('', '请分析这个产物当前的不足，并给出改进方案。');
        }
        taskInput.value = lines.join('\n');
        void onSend();
      }, 500);
      return;
    }
  }

  /* ─── 生命周期 ────────────────────────────────────── */

  const cleanup = bindAiAgentStreamHandlers(socket, streamController, {
    setStatus: (text) => setStatus('running', text),
    finalize,
    appendLine: appendAiLine,
    appendDelta: appendAiDelta,
      flushDelta: () => deltaBuffer.flushNow(),
      onToolStart: (m) => {
        deltaBuffer.flushNow();
        const msg = ensureToolHostMessage(m.toolUseId);
        if (!msg) return;
        const turn: AiAssistantTurn = { role: 'assistant', status: 'tool_running', lines: [], toolCalls: msg.toolCalls || [] };
        startAiToolCall(turn, m.toolUseId || `tool-${Date.now()}`, m.name || 'unknown', m.input);
        updateToolCallsFromTurn(msg, turn);
        setStatus('running', m.name ? `调用工具：${m.name}` : '调用工具...');
      },
      onToolDelta: (m) => {
      if (!m.toolUseId || !m.text) return;
      appendToolLog(m.toolUseId, m.stream, m.text);
      setStatus('running', '工具执行中...');
      },
      onToolEnd: (m) => {
        if (m.toolUseId) {
          const msg = findToolHostMessage(m.toolUseId);
          if (msg) {
            const turn: AiAssistantTurn = { role: 'assistant', status: 'tool_running', lines: [], toolCalls: msg.toolCalls || [] };
            if (finishAiToolCall(turn, m.toolUseId, Boolean(m.is_error), m.result)) {
              updateToolCallsFromTurn(msg, turn);
            }
          }
        }
        setStatus('running', m.is_error ? '工具返回错误，继续分析...' : '思考中...');
    },
    onNarration: (m) => {
      if (m.toolUseId && m.message) appendToolNote(m.toolUseId, m.kind || 'thought', m.message);
      else if (m.message) appendAiLine(m.kind || 'thought', m.message);
    },
    onDone: (m) => {
      finalizeStreamPersist();
      setStatus(completionKind(m.taskStatus), completionText(m.taskStatus, m.round));
      finalize();
    },
    onError: (m) => {
      finalizeStreamPersist();
      setStatus('error', '出错');
      appendAiLine('error', `✘ ${m.error || '未知错误'}`);
      finalize();
    },
    onCancelled: (m) => {
      finalizeStreamPersist();
      streamController.rememberStoppedRun(m.runId);
      setStatus('cancelled', '已取消');
      appendAiLine('error', '已取消');
      finalize();
    },
    onApproveRequest: (m) => {
      if (!m.requestId || !m.sessionId) return;
      clearApproveCountdown();
      pendingApprove.value = {
        requestId: m.requestId,
        sessionId: m.sessionId,
        title: m.title,
        toolName: m.toolName,
        detail: m.detail,
        mode: 'approval',
        responseEvent: 'ide:approve-response',
      };
      startApproveCountdown();
    },
    onUserInputRequest: (m) => {
      if (!m.requestId || !m.sessionId) return;
      clearApproveCountdown();
      pendingApprove.value = {
        requestId: m.requestId,
        sessionId: m.sessionId,
        title: m.title || (m.kind === 'request_secret' ? '需要 Secret 引用' : '需要补充信息'),
        toolName: m.toolName || (m.kind === 'request_secret' ? 'request_secret' : 'ask_user'),
        detail: m.detail || m.question || m.reason || '',
        mode: m.kind,
        responseEvent: m.responseEvent,
        secretName: m.secretName || '',
        label: m.label || '',
        provider: m.provider || '',
      };
      startApproveCountdown();
    },
  }, handlers);

  watch([
    selectedHosts,
    selectedPaths,
    selectedContainers,
    selectedTools,
    scanHostId,
    toolFilter,
    currentSessionId,
    taskInput,
    ccCollab,
    historyDrawerOpen,
  ], saveStudioPrefs, { deep: true });

  onMounted(async () => {
    loadSessionsFromStorage();
    if (savedPrefs.currentSessionId && sessions.value.some((s) => s.id === savedPrefs.currentSessionId)) {
      currentSessionId.value = savedPrefs.currentSessionId;
    } else if (savedPrefs.currentSessionId) {
      currentSessionId.value = null;
    }
    await Promise.all([loadContext(), loadSkills()]);
    await handleEntryQuery();
  });

  onBeforeUnmount(() => {
    cleanup();
    clearApproveCountdown();
  });

  return {
    /* state */
    hosts, allHosts, skillList, mcpList,
    selectedHosts, selectedPaths, selectedContainers, selectedTools,
    localMcpStatus,
    scanHostId, containerScan, scanning,
    toolFilter, toolItems, filteredToolItems, toolItemKey,
    sessions, currentSessionId, currentMessages,
    isRunning, runStatusKind, runStatusText,
    currentToolCalls,
    authoringSession, authoringStages, authoringStageText,
    taskInput, ccCollab,
    historyDrawerOpen,
    pendingApprove, approveCountdown,
    summaryText,
    /* helpers */
    hostName,
    isContainerSelected,
    /* methods */
    toggleHost, addPath, addPickedPath, removePath,
    toggleContainer, unpinContainer,
    toggleTool,
    setCcCollab,
    onSend, onStop, respondAuthoring,
    switchSession, startNewChat, clearCurrentChat, deleteSession,
    cleanupSessionResiduals, residualCountForSession,
    toggleHistoryDrawer,
    scanContainers, loadFpDir,
    respondApprove,
  };
}
