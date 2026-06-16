<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import AgentSessionRail from '@/components/AgentSessionRail.vue';
import AgentToolsRail from '@/components/AgentToolsRail.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useIdeChat, type IdeApprovalMode, type IdeTimelineItem, type IdeChatApi, type IdeChatMessage, type IdeThinkingTimelineItem, type IdeToolTimelineItem, type IdeSystemTimelineItem, type IdeRewindPoint } from '@/composables/useIdeChat';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import { renderMarkdown } from '@/utils/markdown';
import type { HostInfo, HostsListResponse } from '@/utils/scripts';

// ── provider model ──
interface AgentProvider {
  id: string;
  name: string;
  apiBase: string;
  apiKeySet: boolean;
  model: string;
  upstreamProtocol: string;
  enabled?: boolean;
}

// ── type guards unused in template — discriminator checked directly for TS narrowing ──

function toolIcon(tool: IdeToolTimelineItem): string {
  const n = tool.name.toLowerCase();
  if (tool.isError) return 'alert';
  if (n.includes('execute') || n.includes('command') || n.includes('host_exec') || n === 'shell') return 'terminal';
  if (n.includes('probe') || n.includes('metric')) return 'radio';
  if (n.includes('host') || n.includes('server')) return 'server';
  if (n.includes('download')) return 'download';
  if (n.includes('upload')) return 'cloud';
  if (n.includes('delete') || n.includes('remove') || n.includes('rm')) return 'trash';
  if (n.includes('write') || n.includes('create') || n.includes('mkdir')) return 'file-plus';
  if (n.includes('read') || n.includes('list') || n.includes('dir') || n.includes('file')) return 'folder';
  if (n.includes('approval') || n.includes('permission')) return 'shield';
  if (n.includes('secret')) return 'lock';
  if (n.includes('verify')) return 'check';
  if (n.includes('ask')) return 'message-circle';
  return 'wrench';
}

function toolLabel(tool: IdeToolTimelineItem): string {
  if (tool.status === 'preparing') return '准备中';
  if (tool.status === 'running') return '执行中';
  if (tool.status === 'error') return '失败';
  return '完成';
}

function toolDuration(d: number | undefined): string {
  if (d === undefined) return '';
  return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
}

function fmtVal(v: unknown, max = 4000): string {
  if (v === undefined || v === null) return '';
  const t = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return t.length > max ? t.slice(0, max) + '\n…[truncated]' : t;
}

// ── state ──
const { requestJson } = useApiClient();
const { confirm } = useConfirm();
const notify = useNotifyStore();

const scrollEl = ref<HTMLElement | null>(null);
const hosts = ref<HostInfo[]>([]);
const providers = ref<AgentProvider[]>([]);
const activeProviderId = ref<string | null>(null);
const agentGoal = ref('');
const selectedHostId = ref('');
const modelPreference = ref('默认模型');
const approvalMode = ref<IdeApprovalMode>('manual');
const composerInput = ref('');
const showHostDropdown = ref(false);
const showModeDropdown = ref(false);
const showModelDropdown = ref(false);
const showTools = ref(false);
const expandingToolId = ref<string | null>(null);
let follow = true;

type RailTab = 'chat' | 'files' | 'hosts';

interface FileFocus {
  hostId: string;
  path: string;
  directory: string;
  fileName?: string;
  toolName?: string;
  action?: string;
  status?: string;
  updatedAt?: number;
}

const railTab = ref<RailTab>('chat');
const fileFocus = ref<FileFocus | null>(null);
let lastToolFocusKey = '';

type AttachmentKind = 'image' | 'text' | 'document' | 'file';

interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  base64?: string;
  text?: string;
  error?: string;
}

const ATTACHMENT_MAX_COUNT = 8;
const ATTACHMENT_MAX_BINARY_BYTES = 6 * 1024 * 1024;
const ATTACHMENT_MAX_TEXT_BYTES = 800 * 1024;
const ATTACHMENT_TEXT_PREVIEW_CHARS = 80_000;

const attachmentInput = ref<HTMLInputElement | null>(null);
const composerAttachments = ref<ComposerAttachment[]>([]);
const attachmentError = ref('');
let pastedImageSeq = 0;

const rewindModalOpen = ref(false);
const rewindLoading = ref(false);
const rewindError = ref('');
const rewindPoints = ref<IdeRewindPoint[]>([]);
const rewindHighlight = ref(0);
const rewindModalRef = ref<HTMLElement | null>(null);

// ── slash commands ──
interface SlashCmd {
  cmd: string; label: string; desc: string; icon: string;
}

const SLASH_COMMANDS: SlashCmd[] = [
  { cmd: '/model', label: '选择模型', desc: '切换 AI 模型与渠道', icon: 'spark' },
  { cmd: '/task',  label: '任务模式', desc: '描述目标，AI 只读探索推演出需要的输入并打包任务', icon: 'save' },
  { cmd: '/goal',  label: '设置目标', desc: '设定 Agent 工作目标', icon: 'target' },
  { cmd: '/host',  label: '选择主机', desc: '限定目标主机范围', icon: 'server' },
  { cmd: '/mode',  label: '审批模式', desc: '手动审批 / 委托 / 完全访问', icon: 'shield' },
  { cmd: '/remind', label: '回溯', desc: '列出或回到某次输入，并撤销之后的文件改动', icon: 'history' },
  { cmd: '/clear', label: '清空时间线', desc: '重置当前会话', icon: 'close' },
];

const slashHighlight = ref(0);
const slashSubView = ref<string | null>(null);
const slashSubHighlight = ref(0);

// task mode — stored per Agent runtime so multiple host conversations can run
// at the same time without sharing entry state.
const taskGoalInput = ref('');
const taskGoalEl = ref<HTMLTextAreaElement | null>(null);

interface AgentRuntime {
  ide: IdeChatApi;
  hostId: Ref<string>;
  taskMode: Ref<boolean>;
  createdAt: string;
  touchedAt: Ref<string>;
  stopWatchers: Array<() => void>;
}

interface CreateAgentRuntimeOptions {
  hostId?: string;
  taskMode?: boolean;
  session?: IdeLoadableAgentSession;
}

interface IdeLoadableAgentSession {
  id: string;
  timeline: IdeTimelineItem[];
}

const runtimes = shallowRef<AgentRuntime[]>([]);
const activeRuntimeId = ref('');
const activeRuntime = computed(() => {
  return runtimes.value.find((runtime) => runtime.ide.currentSessionId.value === activeRuntimeId.value)
    || runtimes.value[0]
    || null;
});

const taskMode = computed({
  get: () => activeRuntime.value?.taskMode.value || false,
  set: (value: boolean) => {
    const runtime = activeRuntime.value;
    if (runtime) runtime.taskMode.value = value;
  },
});

const enabledProviders = computed(() => providers.value.filter(p => p.enabled !== false));

const slashCmds = computed<SlashCmd[]>(() => {
  if (slashSubView.value) return [];
  const v = composerInput.value;
  if (!v.startsWith('/')) return [];
  const prefix = v.slice(1).toLowerCase();
  if (!prefix) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(c => c.cmd.slice(1).toLowerCase().includes(prefix));
});

const showSlashMenu = computed(() => !rewindModalOpen.value && !showModelDropdown.value && !showModeDropdown.value && (slashCmds.value.length > 0 || slashSubView.value !== null));

function openSlashModel(): void {
  void loadProviders();
  slashSubView.value = 'model';
  slashSubHighlight.value = 0;
  showModelDropdown.value = false;
  composerInput.value = '';
}

function openSlashTask(): void {
  slashSubView.value = 'task';
  slashHighlight.value = 0;
  composerInput.value = '';
  taskGoalInput.value = '';
  void nextTick(() => taskGoalEl.value?.focus());
}

function submitTaskGoal(): void {
  const goal = taskGoalInput.value.trim();
  if (!goal || isBusy.value) return;
  taskMode.value = true;
  slashSubView.value = null;
  composerInput.value = '';
  ide.inputText.value = goal;
  ide.sendMessage();
  taskGoalInput.value = '';
  follow = true;
}

function closeSlashMenu(): void {
  composerInput.value = '';
  slashSubView.value = null;
}

function selectSlashCmd(cmd: SlashCmd): void {
  if (cmd.cmd === '/model') { openSlashModel(); return; }
  if (cmd.cmd === '/task') { openSlashTask(); return; }
  if (cmd.cmd === '/goal') { composerInput.value = ''; setGoal(); return; }
  if (cmd.cmd === '/host') { composerInput.value = ''; showHostDropdown.value = true; return; }
  if (cmd.cmd === '/mode') { composerInput.value = ''; showModeDropdown.value = true; return; }
  if (cmd.cmd === '/remind') { composerInput.value = ''; void openRewindModal(); return; }
  if (cmd.cmd === '/clear') { composerInput.value = ''; void clearChat(); return; }
  composerInput.value = cmd.cmd + ' ';
}

async function selectModelFromSlash(providerId: string | null, clearComposer = true): Promise<void> {
  const newModel = providerId
    ? providers.value.find(p => p.id === providerId)?.model || '默认模型'
    : '默认模型';
  modelPreference.value = newModel;
  if (providerId && providerId !== activeProviderId.value) {
    try {
      await requestJson(`/api/agent/providers/skills/${providerId}/activate`, { method: 'PUT' } as any);
      activeProviderId.value = providerId;
      notify.info(`模型已切换为 ${newModel}`);
    } catch { /* ignore */ }
  }
  showModelDropdown.value = false;
  if (clearComposer) closeSlashMenu();
  else slashSubView.value = null;
}

function toggleModelDropdown(): void {
  void loadProviders();
  showModelDropdown.value = !showModelDropdown.value;
  showModeDropdown.value = false;
  showHostDropdown.value = false;
  slashSubView.value = null;
}

async function selectComposerModel(providerId: string | null): Promise<void> {
  await selectModelFromSlash(providerId, false);
  showModelDropdown.value = false;
}

function hostForId(id: string): HostInfo | null {
  if (!id) return null;
  return hosts.value.find((host) => host.id === id) || null;
}

function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): AgentRuntime {
  const runtimeHostId = ref(options.hostId || '');
  const runtimeTaskMode = ref(Boolean(options.taskMode));
  const touchedAt = ref(new Date().toISOString());

  const ideApi = useIdeChat({
    sessionPrefix: 'agent',
    approvalMode: () => approvalMode.value,
    context: () => {
      const hostId = runtimeHostId.value;
      const host = hostForId(hostId);
      return {
        surface: 'agent',
        module: 'Agent',
        moduleHint: '当前在 1Shell Agent 专用前端。',
        agentGoal: agentGoal.value || undefined,
        hostScope: hostId || 'all',
        modelPreference: modelPreference.value !== '默认模型' ? modelPreference.value : undefined,
        hosts: host ? [{ id: host.id, name: host.name, host: host.host }] : undefined,
      };
    },
    messagePayload: () => ({
      entry: runtimeTaskMode.value ? 'task' : 'core',
      approvalMode: approvalMode.value,
      goal: agentGoal.value || undefined,
      hostId: runtimeHostId.value || undefined,
      modelPreference: modelPreference.value !== '默认模型' ? modelPreference.value : undefined,
      attachments: attachmentPayload(),
    }),
    onRunComplete: () => {
      touchedAt.value = new Date().toISOString();
      void loadSessions();
    },
  });

  const runtime: AgentRuntime = {
    ide: ideApi,
    hostId: runtimeHostId,
    taskMode: runtimeTaskMode,
    createdAt: touchedAt.value,
    touchedAt,
    stopWatchers: [],
  };

  runtime.stopWatchers.push(watch(() => ideApi.currentSessionId.value, (nextId, previousId) => {
    if (activeRuntimeId.value === previousId) activeRuntimeId.value = nextId;
    touchedAt.value = new Date().toISOString();
  }));
  runtime.stopWatchers.push(watch(() => ideApi.timeline.value.length, () => {
    touchedAt.value = new Date().toISOString();
  }));

  runtimes.value = [...runtimes.value, runtime];
  if (options.session) ideApi.loadSession(options.session);
  activateRuntime(runtime);
  return runtime;
}

function activateRuntime(runtime: AgentRuntime): void {
  activeRuntimeId.value = runtime.ide.currentSessionId.value;
  selectedHostId.value = runtime.hostId.value || '';
  fileFocus.value = null;
  lastToolFocusKey = '';
  follow = true;
  syncRailFromTimeline();
  void nextTick(() => scrollToBottom());
}

function findRuntimeBySessionId(id: string): AgentRuntime | null {
  return runtimes.value.find((runtime) => runtime.ide.currentSessionId.value === id) || null;
}

function disposeRuntime(runtime: AgentRuntime): void {
  runtime.stopWatchers.forEach((stop) => stop());
  runtime.ide.dispose();
}

const ide = new Proxy({} as IdeChatApi, {
  get(_target, key: keyof IdeChatApi) {
    const runtime = activeRuntime.value;
    if (!runtime) throw new Error('Agent runtime 尚未初始化');
    return runtime.ide[key];
  },
});

createAgentRuntime();

// ── session history rail ──
interface SessionMeta {
  id: string;
  title: string;
  entry: string;
  hostId: string;
  modelLabel: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
  awaitingApproval?: boolean;
}
const sessions = ref<SessionMeta[]>([]);
const sessionsLoading = ref(false);
const railSessions = computed<SessionMeta[]>(() => {
  const rows = new Map<string, SessionMeta>();
  for (const session of sessions.value) rows.set(session.id, session);

  for (const runtime of runtimes.value) {
    const id = runtime.ide.currentSessionId.value;
    const timeline = runtime.ide.timeline.value;
    if (!id || (!timeline.length && !runtime.ide.isRunning.value)) continue;
    const existing = rows.get(id);
    rows.set(id, {
      id,
      title: existing?.title || liveSessionTitle(runtime),
      entry: runtime.taskMode.value ? 'task' : (existing?.entry || 'core'),
      hostId: runtime.hostId.value || existing?.hostId || '',
      modelLabel: existing?.modelLabel || modelText.value,
      messageCount: timeline.length || existing?.messageCount || 0,
      preview: liveSessionPreview(runtime) || existing?.preview || '',
      createdAt: existing?.createdAt || runtime.createdAt,
      updatedAt: runtime.touchedAt.value || existing?.updatedAt || runtime.createdAt,
      running: runtime.ide.isRunning.value,
      awaitingApproval: Boolean(runtime.ide.approveRequest.value),
    });
  }

  return [...rows.values()].sort((a, b) => parseSessionTime(b.updatedAt) - parseSessionTime(a.updatedAt));
});

function liveSessionTitle(runtime: AgentRuntime): string {
  const firstUser = runtime.ide.timeline.value.find((item): item is IdeChatMessage => item.kind === 'user');
  const text = firstUser?.text?.split('\n').find(Boolean)?.trim() || '';
  if (text) return text.slice(0, 60);
  return '新对话';
}

function liveSessionPreview(runtime: AgentRuntime): string {
  const latest = runtime.ide.timeline.value.slice().reverse().find((item) => {
    return item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool';
  });
  if (!latest) return runtime.ide.isRunning.value ? '运行中' : '';
  if (latest.kind === 'tool') return `${latest.name} · ${latest.status}`;
  return latest.text?.replace(/\s+/g, ' ').trim().slice(0, 120) || '';
}

function parseSessionTime(value: string): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    const resp = await requestJson<{ ok: boolean; sessions: SessionMeta[] }>('/api/agent/sessions');
    if (resp.ok) sessions.value = resp.sessions || [];
  } catch { /* ignore */ } finally {
    sessionsLoading.value = false;
  }
}

async function onSelectSession(id: string): Promise<void> {
  if (id === ide.currentSessionId.value) return;
  const liveRuntime = findRuntimeBySessionId(id);
  if (liveRuntime) {
    activateRuntime(liveRuntime);
    return;
  }
  try {
    const resp = await requestJson<{ ok: boolean; session: { id: string; entry: string; hostId: string; timeline: IdeTimelineItem[] } }>(`/api/agent/sessions/${id}`);
    if (!resp.ok || !resp.session) return;
    fileFocus.value = null;
    lastToolFocusKey = '';
    composerAttachments.value = [];
    attachmentError.value = '';
    createAgentRuntime({
      hostId: resp.session.hostId || '',
      taskMode: resp.session.entry === 'task',
      session: { id: resp.session.id, timeline: resp.session.timeline || [] },
    });
    follow = true;
    void nextTick(() => scrollToBottom());
  } catch { /* ignore */ }
}

function onNewSession(hostId = selectedHostId.value): void {
  const runtime = activeRuntime.value;
  const normalizedHostId = hostId || '';
  if (runtime && !runtime.ide.isRunning.value && runtime.ide.timeline.value.length === 0) {
    runtime.hostId.value = normalizedHostId;
    runtime.taskMode.value = false;
    selectedHostId.value = normalizedHostId;
  } else {
    createAgentRuntime({ hostId: normalizedHostId });
  }
  fileFocus.value = null;
  lastToolFocusKey = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}

async function onRenameSession(id: string, title: string): Promise<void> {
  const target = sessions.value.find((s) => s.id === id);
  if (target) target.title = title; // optimistic
  try {
    await requestJson(`/api/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
  } catch { void loadSessions(); }
}

async function onDeleteSession(id: string): Promise<void> {
  const runtime = findRuntimeBySessionId(id);
  if (runtime?.ide.isRunning.value) {
    notify.info('这条 Agent 对话仍在运行，请先停止后再删除。');
    return;
  }
  const wasActive = id === ide.currentSessionId.value;
  const ok = await confirm({ message: '删除这个对话？此操作不可恢复。', title: '删除对话' });
  if (!ok) return;
  try {
    await requestJson(`/api/agent/sessions/${id}`, { method: 'DELETE' });
  } catch { /* ignore */ }
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (runtime) {
    disposeRuntime(runtime);
    runtimes.value = runtimes.value.filter((item) => item !== runtime);
  }
  if (wasActive) {
    if (!runtimes.value.length) createAgentRuntime({ hostId: selectedHostId.value });
    else activateRuntime(runtimes.value[0]);
  }
  fileFocus.value = null;
  lastToolFocusKey = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}

const selectedHost = computed(() => hosts.value.find(h => h.id === selectedHostId.value) || null);
const goalText = computed(() => agentGoal.value || '未设置目标');
const hostText = computed(() => {
  if (selectedHostId.value === LOCAL_HOST_ID) return '本机';
  return selectedHost.value?.name || selectedHostId.value || '所有主机';
});
const modelText = computed(() => {
  const active = providers.value.find(p => p.id === activeProviderId.value);
  return active?.model || modelPreference.value;
});
const modelChannel = computed(() => {
  const active = providers.value.find(p => p.id === activeProviderId.value);
  return active?.name || '';
});
const modeBadge = computed(() => {
  switch (approvalMode.value) {
    case 'delegated': return { label: '委托', cls: 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/20' };
    case 'full_access': return { label: '完全', cls: 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400 border-red-300 dark:border-red-500/20' };
    default: return { label: '手动', cls: 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-500/20' };
  }
});
const hasTimeline = computed(() => ide.timeline.value.length > 0);
const isBusy = computed(() => ide.isRunning.value);

const modes: { key: IdeApprovalMode; label: string }[] = [
  { key: 'manual', label: '手动审批' },
  { key: 'delegated', label: '委托审批' },
  { key: 'full_access', label: '完全访问' },
];

const FILE_TOOL_ACTIONS: Record<string, string> = {
  list_remote_dir: '列出目录',
  read_remote_file: '读取文件',
  write_remote_file: '写入文件',
  create_directory: '创建目录',
  delete_path: '删除路径',
  rename_path: '重命名路径',
  upload_file: '上传文件',
  download_file: '下载文件',
};

const HOST_TOOL_NAMES = new Set([
  'execute_command',
  'host_exec',
  'run_script',
  'query_probe',
  'get_probe',
  'get_probe_samples',
  'get_probe_timeseries',
  'get_probe_traffic',
  'install_probe_agent',
  'restart_probe_agent',
  'uninstall_probe_agent',
  'probe_diag_ping',
  'probe_diag_http',
  'probe_diag_dns',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parentDirectory(path: string): string {
  const text = String(path || '').trim();
  if (!text) return '';
  const normalized = text.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized.startsWith('/') ? '/' : '';
  return normalized.slice(0, idx);
}

function basename(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized.split('/').pop() || normalized;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function focusFromTool(tool: IdeToolTimelineItem): FileFocus | null {
  if (!isRecord(tool.input)) return null;
  const hostId = stringField(tool.input, 'hostId') || LOCAL_HOST_ID;
  const toolName = tool.name;

  if (toolName === 'list_remote_dir') {
    const directory = stringField(tool.input, 'path');
    return {
      hostId,
      path: directory,
      directory,
      toolName,
      action: FILE_TOOL_ACTIONS[toolName],
      status: tool.status,
    };
  }

  if (toolName === 'create_directory') {
    const path = stringField(tool.input, 'path');
    return {
      hostId,
      path,
      directory: parentDirectory(path),
      fileName: basename(path),
      toolName,
      action: FILE_TOOL_ACTIONS[toolName],
      status: tool.status,
    };
  }

  if (toolName === 'upload_file') {
    const directory = stringField(tool.input, 'dirPath');
    const filename = stringField(tool.input, 'filename') || basename(stringField(tool.input, 'localPath'));
    const path = filename ? joinPath(directory, filename) : directory;
    return {
      hostId,
      path,
      directory,
      fileName: filename || undefined,
      toolName,
      action: FILE_TOOL_ACTIONS[toolName],
      status: tool.status,
    };
  }

  const path = toolName === 'rename_path'
    ? stringField(tool.input, 'newPath') || stringField(tool.input, 'path')
    : stringField(tool.input, 'path');
  if (!path || !FILE_TOOL_ACTIONS[toolName]) return null;
  const directory = parentDirectory(path);
  return {
    hostId,
    path,
    directory,
    fileName: basename(path),
    toolName,
    action: FILE_TOOL_ACTIONS[toolName],
    status: tool.status,
  };
}

function syncRailFromTimeline(): void {
  const tools = ide.timeline.value.filter((item): item is IdeToolTimelineItem => item.kind === 'tool').slice().reverse();
  const latestHostTool = tools.find((tool) => isRecord(tool.input) && stringField(tool.input, 'hostId'));
  if (latestHostTool && isRecord(latestHostTool.input)) {
    const hostId = stringField(latestHostTool.input, 'hostId');
    if (hostId && hostId !== 'all') selectedHostId.value = hostId;
  }

  const latestFocus = tools.map(focusFromTool).find((focus): focus is FileFocus => Boolean(focus));
  if (latestFocus) {
    const key = `${latestFocus.hostId}:${latestFocus.toolName}:${latestFocus.status}:${latestFocus.path}:${latestFocus.directory}:${latestFocus.fileName || ''}`;
    if (key !== lastToolFocusKey) {
      lastToolFocusKey = key;
      selectedHostId.value = latestFocus.hostId;
      railTab.value = 'files';
      fileFocus.value = { ...latestFocus, updatedAt: Date.now() };
    }
    return;
  }

  if (latestHostTool && isRecord(latestHostTool.input) && HOST_TOOL_NAMES.has(latestHostTool.name)) {
    const hostId = stringField(latestHostTool.input, 'hostId');
    const key = `${hostId}:${latestHostTool.name}:${latestHostTool.status}`;
    if (hostId && hostId !== 'all' && key !== lastToolFocusKey) {
      lastToolFocusKey = key;
      railTab.value = 'files';
      fileFocus.value = {
        hostId,
        path: '',
        directory: '',
        toolName: latestHostTool.name,
        action: latestHostTool.name === 'run_script' ? '运行脚本' : '主机操作',
        status: latestHostTool.status,
        updatedAt: Date.now(),
      };
    }
  }
}

// ── lifecycle ──
watch(() => ide.timeline.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => ide.timeline.value, () => {
  syncRailFromTimeline();
  void nextTick(() => scrollToBottom());
}, { deep: true });
onMounted(() => { void loadHosts(); void loadProviders(); void loadSessions(); });
onBeforeUnmount(() => {
  for (const runtime of runtimes.value) disposeRuntime(runtime);
  runtimes.value = [];
});

async function loadHosts(): Promise<void> {
  try {
    const resp = await requestJson<HostsListResponse>('/api/hosts');
    hosts.value = Array.isArray(resp.hosts) ? resp.hosts : [];
  } catch { /* ignore */ }
}

async function loadProviders(): Promise<void> {
  try {
    const resp = await requestJson<{ ok: boolean; providers: AgentProvider[]; activeProviderId: string | null }>('/api/agent/providers/skills');
    if (resp.ok) {
      providers.value = resp.providers || [];
      activeProviderId.value = resp.activeProviderId;
      const active = providers.value.find(p => p.id === activeProviderId.value);
      if (active) modelPreference.value = active.model;
    }
  } catch { /* ignore */ }
}

// ── scroll ──
function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollToBottom(): void {
  const el = scrollEl.value;
  if (!el || !follow) return;
  el.scrollTop = el.scrollHeight;
}

// ── actions ──
function makeAttachmentId(): string {
  return `att-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isTextAttachment(file: File): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith('text/')) return true;
  return /\.(txt|md|markdown|json|jsonl|yaml|yml|toml|ini|conf|config|env|log|csv|tsv|xml|html|css|scss|js|ts|tsx|jsx|vue|py|sh|bash|ps1|sql|dockerfile|gitignore)$/i.test(name);
}

function attachmentKind(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (isTextAttachment(file)) return 'text';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'document';
  return 'file';
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

function dataUrlBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

async function buildAttachment(file: File): Promise<ComposerAttachment> {
  const kind = attachmentKind(file);
  const base: ComposerAttachment = {
    id: makeAttachmentId(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    kind,
  };

  if (kind === 'text') {
    if (file.size > ATTACHMENT_MAX_TEXT_BYTES) {
      return { ...base, error: '文本文件过大，未展开内容' };
    }
    const text = await readAsText(file);
    return {
      ...base,
      text: text.length > ATTACHMENT_TEXT_PREVIEW_CHARS
        ? `${text.slice(0, ATTACHMENT_TEXT_PREVIEW_CHARS)}\n\n[1Shell: 文档内容已截断]`
        : text,
    };
  }

  if (kind === 'image' || kind === 'document') {
    if (file.size > ATTACHMENT_MAX_BINARY_BYTES) {
      return { ...base, error: '文件过大，仅发送文件名和大小' };
    }
    return { ...base, base64: dataUrlBase64(await readAsDataUrl(file)) };
  }

  return base;
}

function normalizedClipboardFile(file: File): File {
  if (file.name) return file;
  const ext = file.type === 'image/jpeg' ? 'jpg'
    : file.type === 'image/webp' ? 'webp'
      : file.type === 'image/gif' ? 'gif'
        : file.type === 'image/png' ? 'png'
          : 'bin';
  pastedImageSeq += 1;
  return new File([file], `pasted-image-${Date.now()}-${pastedImageSeq}.${ext}`, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
  });
}

async function addAttachmentFiles(rawFiles: File[], source = '选择'): Promise<void> {
  const files = rawFiles.map(normalizedClipboardFile);
  if (!files.length) return;
  attachmentError.value = '';
  const remaining = ATTACHMENT_MAX_COUNT - composerAttachments.value.length;
  if (remaining <= 0) {
    attachmentError.value = `最多附加 ${ATTACHMENT_MAX_COUNT} 个文件`;
    return;
  }

  for (const file of files.slice(0, remaining)) {
    try {
      composerAttachments.value.push(await buildAttachment(file));
    } catch (err) {
      composerAttachments.value.push({
        id: makeAttachmentId(),
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        kind: attachmentKind(file),
        error: (err as Error).message || '读取失败',
      });
    }
  }
  if (files.length > remaining) attachmentError.value = `已达到 ${ATTACHMENT_MAX_COUNT} 个附件上限`;
  else if (source === '粘贴') notify.info(`已粘贴 ${files.length} 个附件`);
}

async function onAttachmentChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  await addAttachmentFiles(files, '选择');
}

function filesFromClipboard(event: ClipboardEvent): File[] {
  const clipboard = event.clipboardData;
  if (!clipboard) return [];
  const directFiles = Array.from(clipboard.files || []);
  const itemFiles = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const all = directFiles.length ? directFiles : itemFiles;
  const seen = new Set<string>();
  return all.filter((file) => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function onComposerPaste(event: ClipboardEvent): Promise<void> {
  const files = filesFromClipboard(event);
  if (!files.length) return;
  event.preventDefault();
  await addAttachmentFiles(files, '粘贴');
}

function removeAttachment(id: string): void {
  composerAttachments.value = composerAttachments.value.filter((item) => item.id !== id);
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentLabel(item: ComposerAttachment): string {
  if (item.kind === 'image') return '图片';
  if (item.kind === 'text') return '文本';
  if (item.kind === 'document') return '文档';
  return '文件';
}

function attachmentSummary(): string {
  if (!composerAttachments.value.length) return '';
  const lines = composerAttachments.value.map((item) => `- ${item.name} (${attachmentLabel(item)}, ${formatAttachmentSize(item.size)})${item.error ? `：${item.error}` : ''}`);
  return `\n\n附件：\n${lines.join('\n')}`;
}

function attachmentPayload(): Record<string, unknown>[] {
  return composerAttachments.value.map((item) => ({
    name: item.name,
    size: item.size,
    mime: item.mime,
    kind: item.kind,
    base64: item.base64,
    text: item.text,
    error: item.error,
  }));
}

function send(): void {
  const t = composerInput.value.trim();
  if (isBusy.value || (!t && !composerAttachments.value.length)) return;
  ide.inputText.value = `${t || '请分析附件。'}${attachmentSummary()}`;
  ide.sendMessage();
  composerInput.value = '';
  composerAttachments.value = [];
  attachmentError.value = '';
  follow = true;
}
function sendSlash(cmd: string): void {
  ide.prefillAndSend(cmd);
  follow = true;
}
function setGoal(): void {
  const v = window.prompt('设置 Agent 目标：', agentGoal.value);
  if (v !== null) { agentGoal.value = v.trim(); sendSlash(`/goal ${agentGoal.value}`); }
}
function pickHost(id: string): void {
  const normalizedHostId = id || '';
  const runtime = activeRuntime.value;
  if (runtime?.ide.isRunning.value && runtime.hostId.value !== normalizedHostId) {
    selectedHostId.value = normalizedHostId;
    railTab.value = 'chat';
    onNewSession(normalizedHostId);
    showHostDropdown.value = false;
    notify.info('已按主机打开新的 Agent 对话，原对话继续运行。');
    return;
  }
  selectedHostId.value = normalizedHostId;
  if (runtime) runtime.hostId.value = normalizedHostId;
  fileFocus.value = null;
  lastToolFocusKey = '';
  showHostDropdown.value = false;
  sendSlash(`/host ${id || 'all'}`);
}
function onRailSelectHost(id: string): void {
  const normalizedHostId = id || '';
  const runtime = activeRuntime.value;
  if (runtime?.ide.isRunning.value && runtime.hostId.value !== normalizedHostId) {
    selectedHostId.value = normalizedHostId;
    railTab.value = 'chat';
    onNewSession(normalizedHostId);
    notify.info('已按主机打开新的 Agent 对话，原对话继续运行。');
    return;
  }
  selectedHostId.value = normalizedHostId;
  if (runtime) runtime.hostId.value = normalizedHostId;
  fileFocus.value = null;
  lastToolFocusKey = '';
  showHostDropdown.value = false;
}
function onNewHostSession(id: string): void {
  selectedHostId.value = id || '';
  railTab.value = 'chat';
  onNewSession(id || '');
}
function pickMode(m: IdeApprovalMode): void {
  approvalMode.value = m;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
}
async function clearChat(): Promise<void> {
  if (isBusy.value) {
    notify.info('当前 Agent 对话仍在运行，请先停止后再清空。');
    return;
  }
  const ok = await confirm({ message: '清空当前会话时间线？', title: '清空' });
  if (!ok) return;
  ide.resetChat();
  taskMode.value = false;
  fileFocus.value = null;
  lastToolFocusKey = '';
  composerAttachments.value = [];
  attachmentError.value = '';
}
function rewindPointTime(point: IdeRewindPoint): string {
  const time = Date.parse(point.createdAt || '');
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m ago`;
  if (diff < day) return `${Math.max(1, Math.round(diff / hour))}h ago`;
  return `${Math.max(1, Math.round(diff / day))}d ago`;
}

function rewindPointHost(point: IdeRewindPoint): string {
  const id = String(point.hostId || '').trim();
  if (!id || id === 'all') return hostText.value;
  if (id === LOCAL_HOST_ID || id === 'local') return '本机';
  const host = hostForId(id);
  return host?.name || id;
}

function rewindPointText(point: IdeRewindPoint): string {
  return String(point.text || '').trim() || '(空输入)';
}

async function openRewindModal(): Promise<void> {
  if (isBusy.value) {
    notify.info('当前 Agent 仍在运行，请先停止或等待完成后再回溯。');
    return;
  }
  showHostDropdown.value = false;
  showModeDropdown.value = false;
  showModelDropdown.value = false;
  slashSubView.value = null;
  rewindModalOpen.value = true;
  rewindLoading.value = true;
  rewindError.value = '';
  rewindPoints.value = [];
  rewindHighlight.value = 0;
  try {
    const points = await ide.listRewindPoints();
    rewindPoints.value = [...points].sort((a, b) => b.ordinal - a.ordinal);
    if (!rewindPoints.value.length) rewindError.value = '当前会话还没有可回溯的输入。发送一次 Agent 消息后，1Shell 会自动建立回溯点。';
  } catch (err) {
    rewindError.value = (err as Error).message || '无法加载回溯点';
  } finally {
    rewindLoading.value = false;
    void nextTick(() => rewindModalRef.value?.focus());
  }
}

function closeRewindModal(): void {
  rewindModalOpen.value = false;
  rewindLoading.value = false;
  rewindError.value = '';
}

function moveRewindHighlight(delta: number): void {
  if (!rewindPoints.value.length) return;
  const max = rewindPoints.value.length - 1;
  rewindHighlight.value = Math.min(max, Math.max(0, rewindHighlight.value + delta));
}

function runRewind(point = rewindPoints.value[rewindHighlight.value]): void {
  if (!point || isBusy.value) return;
  closeRewindModal();
  ide.prefillAndSend(`/remind #${point.ordinal}`);
  follow = true;
}

function onRewindModalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeRewindModal();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveRewindHighlight(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveRewindHighlight(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    runRewind();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (showSlashMenu.value) {
    if (slashSubView.value === 'model') {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashSubHighlight.value = Math.min(slashSubHighlight.value + 1, enabledProviders.value.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashSubHighlight.value = Math.max(slashSubHighlight.value - 1, 0); return; }
      if (e.key === 'Enter') { e.preventDefault(); const idx = slashSubHighlight.value;
        if (idx === 0) { selectModelFromSlash(null); } else { const p = enabledProviders.value[idx - 1]; if (p) selectModelFromSlash(p.id); }
        return; }
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); slashSubView.value = null; slashHighlight.value = 0; return; }
      return;
    }
    if (slashSubView.value === 'task') {
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); slashSubView.value = null; slashHighlight.value = 0; return; }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); slashHighlight.value = Math.min(slashHighlight.value + 1, slashCmds.value.length - 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashHighlight.value = Math.max(slashHighlight.value - 1, 0); return; }
    if (e.key === 'Enter') { e.preventDefault(); selectSlashCmd(slashCmds.value[slashHighlight.value]); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
    if (e.key === 'Tab') { e.preventDefault(); composerInput.value = slashCmds.value[slashHighlight.value].cmd + ' '; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

// ── approval ──
function approveAction(action: 'allow' | 'deny'): void {
  if (action === 'allow') ide.approveAllow();
  else ide.approveDeny();
}
</script>

<template>
  <div class="flex h-full bg-white dark:bg-[#0b0f19] text-slate-800 dark:text-slate-200 transition-colors">
    <AgentSessionRail
      :sessions="railSessions"
      :active-id="ide.currentSessionId.value"
      :loading="sessionsLoading"
      v-model:active-tab="railTab"
      :hosts="hosts"
      :selected-host-id="selectedHostId"
      :file-focus="fileFocus"
      @select="onSelectSession"
      @new-session="onNewSession"
      @rename="onRenameSession"
      @delete="onDeleteSession"
      @select-host="onRailSelectHost"
      @new-host-session="onNewHostSession"
    />
    <div class="flex flex-col flex-1 min-w-0 h-full">
    <!-- ── status bar ── -->
    <header class="shrink-0 flex items-center gap-3 px-5 h-11 border-b border-slate-200 dark:border-white/[0.05] bg-stone-50 dark:bg-[#0f1321] select-none">
      <span class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">Agent</span>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-slate-400 dark:text-slate-500">目标</span>
        <button class="max-w-[180px] truncate text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer" @click="setGoal" :title="goalText">{{ goalText }}</button>
      </div>
      <span class="text-slate-300 dark:text-slate-700">·</span>
      <div class="relative">
        <button class="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer" @click="showHostDropdown = !showHostDropdown">{{ hostText }}</button>
        <div v-if="showHostDropdown" class="absolute top-full left-0 mt-1.5 w-52 bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-30 py-1 overflow-hidden">
          <button class="w-full text-left px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer" @click="pickHost('')">所有主机</button>
          <button v-for="h in hosts" :key="h.id" class="w-full text-left px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer" @click="pickHost(h.id)">{{ h.name }}</button>
        </div>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <span v-if="taskMode" class="text-[11px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-400/10 border border-amber-200 dark:border-amber-400/20 px-2 py-0.5 rounded-full">任务模式</span>
        <span v-if="isBusy" class="text-[11px] text-emerald-600 dark:text-emerald-400/70 animate-pulse">运行中</span>
        <button v-if="hasTimeline" class="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors cursor-pointer" @click="openRewindModal" title="回溯到某次输入">
          <AppIcon name="history" :size="13" />
          回溯
        </button>
        <button v-if="hasTimeline" class="text-xs text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer" @click="clearChat" title="清空时间线">清空</button>
        <button
          class="flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border transition-colors cursor-pointer"
          :class="showTools ? 'border-emerald-300 dark:border-emerald-400/30 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-400/10' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'"
          title="工具（Skill / MCP）"
          @click="showTools = !showTools"
        >
          <AppIcon name="wrench" :size="13" />
          Tools
        </button>
      </div>
    </header>

    <!-- ── body ── -->
    <div class="flex-1 flex min-h-0 overflow-hidden">
      <!-- timeline -->
      <div ref="scrollEl" class="flex-1 overflow-y-auto overflow-x-hidden" @scroll="onScroll">
        <!-- empty state -->
        <div v-if="!hasTimeline" class="flex flex-col items-center justify-center min-h-full py-16 px-6 text-center">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-100 dark:from-emerald-400/20 to-sky-100 dark:to-sky-400/20 border border-emerald-200 dark:border-emerald-400/15 flex items-center justify-center mb-6">
            <AppIcon name="terminal" :size="32" class="text-emerald-500 dark:text-emerald-400" />
          </div>
          <h2 class="text-xl font-semibold text-slate-800 dark:text-slate-200 mb-2">1Shell Agent</h2>
          <p class="text-sm text-slate-500 dark:text-slate-500 mb-8 max-w-sm">输入运维目标或命令，Agent 将自主判断、调用工具、验证结果</p>
          <div class="grid grid-cols-2 gap-3 w-full max-w-md">
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-stone-50 dark:bg-[#111627] border border-slate-200 dark:border-white/[0.05] rounded-xl hover:border-emerald-300 dark:hover:border-emerald-400/20 hover:bg-stone-100 dark:hover:bg-[#141b2d] transition-all duration-200 cursor-pointer group" @click="setGoal">
              <span class="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-400/10 flex items-center justify-center shrink-0 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-400/20 transition-colors"><AppIcon name="target" :size="18" class="text-emerald-500 dark:text-emerald-400" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">设置目标</span>
            </button>
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-stone-50 dark:bg-[#111627] border border-slate-200 dark:border-white/[0.05] rounded-xl hover:border-sky-300 dark:hover:border-sky-400/20 hover:bg-stone-100 dark:hover:bg-[#141b2d] transition-all duration-200 cursor-pointer group" @click="showHostDropdown = true">
              <span class="w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-400/10 flex items-center justify-center shrink-0 group-hover:bg-sky-100 dark:group-hover:bg-sky-400/20 transition-colors"><AppIcon name="server" :size="18" class="text-sky-500 dark:text-sky-400" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">选择主机</span>
            </button>
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-stone-50 dark:bg-[#111627] border border-slate-200 dark:border-white/[0.05] rounded-xl hover:border-violet-300 dark:hover:border-violet-400/20 hover:bg-stone-100 dark:hover:bg-[#141b2d] transition-all duration-200 cursor-pointer group" @click="toggleModelDropdown">
              <span class="w-9 h-9 rounded-lg bg-violet-50 dark:bg-violet-400/10 flex items-center justify-center shrink-0 group-hover:bg-violet-100 dark:group-hover:bg-violet-400/20 transition-colors"><AppIcon name="spark" :size="18" class="text-violet-500 dark:text-violet-400" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">模型偏好</span>
            </button>
            <button class="flex items-center gap-3 px-4 py-3 text-left bg-stone-50 dark:bg-[#111627] border border-slate-200 dark:border-white/[0.05] rounded-xl hover:border-amber-300 dark:hover:border-amber-400/20 hover:bg-stone-100 dark:hover:bg-[#141b2d] transition-all duration-200 cursor-pointer group" @click="showModeDropdown = true; showModelDropdown = false">
              <span class="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-400/10 flex items-center justify-center shrink-0 group-hover:bg-amber-100 dark:group-hover:bg-amber-400/20 transition-colors"><AppIcon name="shield" :size="18" class="text-amber-500 dark:text-amber-400" /></span>
              <span class="text-sm text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">审批模式</span>
            </button>
          </div>
        </div>

        <!-- timeline items -->
        <div v-else class="max-w-[860px] mx-auto px-5 py-6 space-y-5">
          <template v-for="item in ide.timeline.value" :key="item.id">
            <!-- user -->
            <div v-if="item.kind === 'user'" class="flex justify-end">
              <div class="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-sky-50 dark:bg-[#1a2340] border border-sky-200 dark:border-white/[0.06] text-sm leading-relaxed text-slate-700 dark:text-slate-200">{{ (item as IdeChatMessage).text }}</div>
            </div>

            <!-- thinking -->
            <div v-else-if="item.kind === 'thinking'" class="flex items-start gap-3 px-1">
              <span class="w-6 h-6 mt-0.5 rounded-md bg-violet-50 dark:bg-violet-400/10 border border-violet-200 dark:border-violet-400/15 flex items-center justify-center shrink-0"><AppIcon name="spark" :size="12" class="text-violet-500 dark:text-violet-400/80" /></span>
              <p class="text-[13px] text-slate-400 dark:text-slate-500 italic leading-relaxed">{{ (item as IdeThinkingTimelineItem).text }}</p>
            </div>

            <!-- system -->
            <div v-else-if="item.kind === 'system'" class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-stone-50 dark:bg-[#111627] border border-slate-200 dark:border-white/[0.04] text-xs">
              <span class="shrink-0 w-5 h-5 rounded flex items-center justify-center" :class="(item as IdeSystemTimelineItem).tone === 'success' ? 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-400' : (item as IdeSystemTimelineItem).tone === 'warning' ? 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-400' : 'bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-400'"><AppIcon :name="(item as IdeSystemTimelineItem).tone === 'success' ? 'check' : (item as IdeSystemTimelineItem).tone === 'warning' ? 'alert' : 'terminal'" :size="12" /></span>
              <span class="text-slate-500 dark:text-slate-400"><strong class="text-slate-700 dark:text-slate-300">{{ (item as IdeSystemTimelineItem).title }}</strong> · {{ (item as IdeSystemTimelineItem).text }}</span>
            </div>

            <!-- tool -->
            <div v-else-if="item.kind === 'tool'" class="rounded-xl bg-white dark:bg-[#11141f] border cursor-pointer transition-colors"
              :class="[(item as IdeToolTimelineItem).isError ? 'border-red-200 dark:border-red-500/15 hover:border-red-300 dark:hover:border-red-500/25' : (item as IdeToolTimelineItem).status === 'running' || (item as IdeToolTimelineItem).status === 'preparing' ? 'border-sky-200 dark:border-sky-500/15 hover:border-sky-300 dark:hover:border-sky-500/25' : 'border-slate-200 dark:border-white/[0.05] hover:border-slate-300 dark:hover:border-white/[0.08]', expandingToolId === (item as IdeToolTimelineItem).toolUseId ? 'border-slate-300 dark:border-white/[0.1]' : '']"
              @click="expandingToolId = expandingToolId === (item as IdeToolTimelineItem).toolUseId ? null : (item as IdeToolTimelineItem).toolUseId">
              <div class="flex items-center gap-3 px-4 py-3">
                <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  :class="[(item as IdeToolTimelineItem).isError ? 'bg-red-50 dark:bg-red-400/10 text-red-500 dark:text-red-400' : (item as IdeToolTimelineItem).status === 'done' ? 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-500 dark:text-emerald-400' : (item as IdeToolTimelineItem).status === 'running' ? 'bg-sky-50 dark:bg-sky-400/10 text-sky-500 dark:text-sky-400' : 'bg-slate-100 dark:bg-slate-400/10 text-slate-500 dark:text-slate-400']">
                  <AppIcon :name="toolIcon(item as IdeToolTimelineItem)" :size="16" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">{{ (item as IdeToolTimelineItem).name }}</span>
                    <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0"
                      :class="[(item as IdeToolTimelineItem).isError ? 'text-red-600 dark:text-red-400 border-red-200 dark:border-red-400/15 bg-red-50 dark:bg-red-400/5' : (item as IdeToolTimelineItem).status === 'done' ? 'text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-400/15 bg-emerald-50 dark:bg-emerald-400/5' : (item as IdeToolTimelineItem).status === 'running' ? 'text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-400/15 bg-sky-50 dark:bg-sky-400/5' : 'text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-400/15 bg-slate-50 dark:bg-slate-400/5']">
                      {{ toolLabel(item as IdeToolTimelineItem) }}
                    </span>
                  </div>
                  <div class="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                    <span v-if="(item as IdeToolTimelineItem).workNote" class="truncate max-w-[320px]">{{ (item as IdeToolTimelineItem).workNote }}</span>
                    <span v-if="toolDuration((item as IdeToolTimelineItem).durationMs)">{{ toolDuration((item as IdeToolTimelineItem).durationMs) }}</span>
                  </div>
                </div>
                <AppIcon name="arrow-right" :size="14" class="text-slate-400 dark:text-slate-600 shrink-0 transition-transform duration-200" :class="expandingToolId === (item as IdeToolTimelineItem).toolUseId ? 'rotate-90' : ''" />
              </div>
              <div v-if="expandingToolId === (item as IdeToolTimelineItem).toolUseId" class="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-white/[0.04] pt-3">
                <div v-if="(item as IdeToolTimelineItem).workNote" class="text-xs text-slate-500 dark:text-slate-400 bg-stone-50 dark:bg-[#0b0f19] rounded-lg p-3 leading-relaxed">{{ (item as IdeToolTimelineItem).workNote }}</div>
                <div v-if="(item as IdeToolTimelineItem).input !== undefined && (item as IdeToolTimelineItem).input !== null" class="space-y-1">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">参数</div>
                  <pre class="text-xs text-slate-600 dark:text-slate-300 bg-stone-50 dark:bg-[#0b0f19] rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[200px] overflow-y-auto">{{ fmtVal((item as IdeToolTimelineItem).input) }}</pre>
                </div>
                <div v-if="(item as IdeToolTimelineItem).logs.length" class="space-y-1">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">输出</div>
                  <pre v-for="(log, i) in (item as IdeToolTimelineItem).logs" :key="i" class="text-xs rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[260px] overflow-y-auto"
                    :class="log.stream === 'stderr' ? 'text-red-600 dark:text-red-300/80 bg-red-50 dark:bg-red-950/20' : 'text-slate-600 dark:text-slate-300 bg-stone-50 dark:bg-[#0b0f19]'">{{ log.text }}</pre>
                </div>
                <div v-if="(item as IdeToolTimelineItem).result !== undefined && (item as IdeToolTimelineItem).result !== null" class="space-y-1">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">结果</div>
                  <pre class="text-xs text-slate-600 dark:text-slate-300 bg-stone-50 dark:bg-[#0b0f19] rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[240px] overflow-y-auto">{{ fmtVal((item as IdeToolTimelineItem).result) }}</pre>
                </div>
              </div>
            </div>

            <!-- assistant -->
            <div v-else class="flex items-start gap-3">
              <span class="w-7 h-7 mt-0.5 rounded-lg bg-emerald-50 dark:bg-emerald-400/10 border border-emerald-200 dark:border-emerald-400/15 flex items-center justify-center shrink-0"><AppIcon name="robot" :size="14" class="text-emerald-500 dark:text-emerald-400" /></span>
              <div class="min-w-0 flex-1">
                <div v-if="(item as IdeChatMessage).text" class="text-sm leading-relaxed text-slate-700 dark:text-slate-200 space-y-3 markdown-body agent-md" v-html="renderMarkdown((item as IdeChatMessage).text)"></div>
                <div v-else class="flex items-center gap-1.5 py-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400/60 animate-pulse"></span>
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400/60 animate-pulse" style="animation-delay: 0.15s"></span>
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400/60 animate-pulse" style="animation-delay: 0.3s"></span>
                </div>
              </div>
            </div>
          </template>

          <div v-if="isBusy" class="flex justify-center pt-2">
            <button class="px-4 py-1.5 rounded-full border border-red-200 dark:border-red-500/15 text-xs text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/5 transition-colors cursor-pointer" @click="ide.stop()">停止生成</button>
          </div>
        </div>
      </div>

      <!-- approval sidebar -->
      <div v-if="ide.approveRequest.value" class="w-[380px] shrink-0 border-l border-slate-200 dark:border-white/[0.06] bg-stone-50 dark:bg-[#0f1321] flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-amber-600 dark:text-amber-400 border-b border-slate-200 dark:border-white/[0.06]">
          <AppIcon name="clock" :size="18" />
          <span>等待确认</span>
          <span class="ml-auto text-[11px] text-slate-400 dark:text-slate-500">{{ ide.approveRequest.value.countdown }}s</span>
        </div>
        <div class="flex-1 overflow-y-auto p-4 space-y-3">
          <div class="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider font-semibold">{{ ide.approveRequest.value.toolName }}</div>
          <h3 class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ ide.approveRequest.value.title }}</h3>
          <p v-if="ide.approveRequest.value.detail" class="text-[13px] text-slate-500 dark:text-slate-400 leading-relaxed">{{ ide.approveRequest.value.detail }}</p>
          <div v-if="ide.approveRequest.value.workNote" class="rounded-lg bg-white dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.04] p-3 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            <span class="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-600 block mb-1">工作笔记</span>
            {{ ide.approveRequest.value.workNote }}
          </div>
          <pre v-if="ide.approveRequest.value.input" class="text-[11px] text-slate-600 dark:text-slate-300 bg-white dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.04] rounded-lg p-3 overflow-x-auto font-mono leading-relaxed max-h-[200px] overflow-y-auto">{{ fmtVal(ide.approveRequest.value.input, 2000) }}</pre>
        </div>
        <div class="shrink-0 flex gap-2 p-4 border-t border-slate-200 dark:border-white/[0.06]">
          <button class="flex-1 py-2 rounded-lg border border-red-200 dark:border-red-500/15 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/5 transition-colors cursor-pointer" @click="approveAction('deny')">拒绝</button>
          <button class="flex-1 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/20 text-sm text-emerald-600 dark:text-emerald-400 font-medium hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-colors cursor-pointer" @click="approveAction('allow')">允许</button>
        </div>
      </div>

      <!-- tools rail -->
      <AgentToolsRail v-if="showTools" />
    </div>

    <!-- ── composer ── -->
    <footer class="shrink-0 border-t border-slate-200 dark:border-white/[0.05] bg-stone-50 dark:bg-[#0f1321] relative">
      <!-- slash command menu -->
      <div v-if="showSlashMenu" class="absolute bottom-full left-0 right-0 max-w-[860px] mx-auto px-5 pb-1 z-30">
        <div class="bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-xl shadow-2xl overflow-hidden">

          <!-- ── model sub-view ── -->
          <template v-if="slashSubView === 'model'">
            <button class="w-full text-left px-3 py-2 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer border-b border-slate-100 dark:border-white/[0.04]" @click="slashSubView = null; slashHighlight = 0">
              <AppIcon name="arrow-right" :size="12" class="rotate-180" />
              返回命令列表
            </button>
            <button class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer" :class="slashSubHighlight === 0 ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'" @click="selectModelFromSlash(null)">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="!activeProviderId ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
              <div class="min-w-0 flex-1">
                <span class="text-xs font-medium" :class="slashSubHighlight === 0 ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">默认模型</span>
                <span class="text-[10px] text-slate-400 dark:text-slate-600 ml-2">系统默认</span>
              </div>
            </button>
            <div v-if="enabledProviders.length" class="h-px bg-slate-100 dark:bg-white/[0.06] mx-3"></div>
            <button
              v-for="(p, i) in enabledProviders"
              :key="p.id"
              class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
              :class="(slashSubHighlight - 1) === i ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
              @click="selectModelFromSlash(p.id)"
            >
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="p.id === activeProviderId ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]' : 'bg-slate-300 dark:bg-slate-600'"></span>
              <div class="min-w-0 flex-1">
                <span class="text-xs font-medium" :class="(slashSubHighlight - 1) === i ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ p.model || '未指定模型' }}</span>
                <span class="text-[10px] text-slate-400 dark:text-slate-600 ml-2">{{ p.name }}</span>
              </div>
            </button>
            <div v-if="!enabledProviders.length" class="px-3 py-4 text-xs text-slate-400 dark:text-slate-600 text-center">
              暂无启用的渠道 · <RouterLink to="/panel/ai" class="text-sky-500 hover:underline">前往 AI 配置</RouterLink>
            </div>
          </template>

          <!-- ── task sub-view ── -->
          <template v-if="slashSubView === 'task'">
            <button class="w-full text-left px-3 py-2 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer border-b border-slate-100 dark:border-white/[0.04]" @click="slashSubView = null; slashHighlight = 0">
              <AppIcon name="arrow-right" :size="12" class="rotate-180" />
              返回命令列表
            </button>
            <div class="px-3 py-3">
              <div class="flex items-center gap-2 mb-2">
                <span class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <AppIcon name="save" :size="14" />
                </span>
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">任务模式</div>
                  <div class="text-[11px] text-slate-400 dark:text-slate-600">描述目标，AI 只读探索后推演需要哪些输入，并打包成可复用任务</div>
                </div>
              </div>
              <textarea
                ref="taskGoalEl"
                v-model="taskGoalInput"
                class="w-full min-h-[64px] max-h-[160px] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 bg-stone-50 dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.08] rounded-lg resize-none focus:outline-none focus:border-amber-400/40 placeholder:text-slate-400 dark:placeholder:text-slate-600 transition-colors"
                placeholder="例如：在指定主机上部署一个 GitHub 项目并配置 Nginx 反代…"
                rows="2"
                @keydown.enter.exact.prevent="submitTaskGoal"
                @keydown.esc.prevent="slashSubView = null"
              ></textarea>
              <div class="flex items-center justify-between mt-2">
                <span class="text-[10px] text-slate-400 dark:text-slate-600">Enter 开始 · Shift+Enter 换行</span>
                <button
                  type="button"
                  class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
                  :class="taskGoalInput.trim() && !isBusy ? 'bg-amber-500 text-white hover:bg-amber-400 cursor-pointer' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-400 dark:text-slate-600 cursor-not-allowed'"
                  :disabled="!taskGoalInput.trim() || isBusy"
                  @click="submitTaskGoal"
                >开始创作任务</button>
              </div>
            </div>
          </template>

          <!-- ── command list ── -->
          <template v-if="!slashSubView">
            <div class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">命令</div>
            <button
              v-for="(cmd, i) in slashCmds"
              :key="cmd.cmd"
              type="button"
              class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
              :class="i === slashHighlight ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
              @click="selectSlashCmd(cmd)"
            >
              <span class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" :class="i === slashHighlight ? 'bg-sky-100 dark:bg-sky-500/15 text-sky-600 dark:text-sky-400' : 'bg-slate-100 dark:bg-white/[0.05] text-slate-500 dark:text-slate-400'">
                <AppIcon :name="cmd.icon" :size="14" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-mono font-semibold" :class="i === slashHighlight ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'">{{ cmd.cmd }}</span>
                  <span class="text-xs" :class="i === slashHighlight ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'">{{ cmd.label }}</span>
                </div>
                <div class="text-[11px] text-slate-400 dark:text-slate-600 mt-0.5">{{ cmd.desc }}</div>
              </div>
            </button>
          </template>
        </div>
      </div>

      <div class="max-w-[860px] mx-auto px-5 py-3">
        <input
          ref="attachmentInput"
          type="file"
          class="hidden"
          multiple
          accept="image/*,.txt,.md,.markdown,.json,.jsonl,.yaml,.yml,.toml,.ini,.conf,.config,.env,.log,.csv,.tsv,.xml,.html,.css,.scss,.js,.ts,.tsx,.jsx,.vue,.py,.sh,.bash,.ps1,.sql,.pdf"
          @change="onAttachmentChange"
        />
        <div v-if="composerAttachments.length || attachmentError" class="mb-2 flex flex-wrap gap-1.5">
          <span
            v-for="item in composerAttachments"
            :key="item.id"
            class="max-w-[260px] h-7 px-2 rounded-md border flex items-center gap-1.5 text-[11px]"
            :class="item.error ? 'border-amber-200 dark:border-amber-400/20 bg-amber-50 dark:bg-amber-400/8 text-amber-700 dark:text-amber-300' : 'border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#0b0f19] text-slate-600 dark:text-slate-300'"
            :title="`${item.name} · ${formatAttachmentSize(item.size)}${item.error ? ` · ${item.error}` : ''}`"
          >
            <AppIcon :name="item.kind === 'image' ? 'image' : 'file'" :size="13" />
            <span class="truncate">{{ item.name }}</span>
            <span class="shrink-0 text-[10px] text-slate-400 dark:text-slate-600">{{ formatAttachmentSize(item.size) }}</span>
            <button
              type="button"
              class="shrink-0 w-4 h-4 rounded flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
              title="移除附件"
              @click="removeAttachment(item.id)"
            >
              <AppIcon name="close" :size="10" />
            </button>
          </span>
          <span v-if="attachmentError" class="h-7 px-2 rounded-md border border-amber-200 dark:border-amber-400/20 bg-amber-50 dark:bg-amber-400/8 text-[11px] text-amber-700 dark:text-amber-300 flex items-center">{{ attachmentError }}</span>
        </div>
        <div class="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#0b0f19] shadow-sm focus-within:border-emerald-300 dark:focus-within:border-emerald-400/30 transition-colors p-2.5">
          <textarea
            v-model="composerInput"
            class="w-full min-h-[54px] max-h-[180px] px-2 py-1.5 text-sm leading-6 text-slate-700 dark:text-slate-200 bg-transparent border-0 resize-none focus:outline-none placeholder:text-slate-400 dark:placeholder:text-slate-600"
            placeholder="输入目标、命令，或直接粘贴图片/文件后发送…"
            rows="2"
            @keydown="onKeydown"
            @paste="onComposerPaste"
          ></textarea>
          <div class="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              class="shrink-0 w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-400/10 flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              title="添加图片或文档"
              :disabled="isBusy"
              @click="attachmentInput?.click()"
            >
              <AppIcon name="paperclip" :size="16" />
            </button>

            <button
              type="button"
              class="shrink-0 w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-400/10 flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              title="回溯到某次输入"
              :disabled="isBusy || !hasTimeline"
              @click="openRewindModal"
            >
              <AppIcon name="history" :size="16" />
            </button>

            <div class="relative">
              <button
                type="button"
                class="h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                :class="modeBadge.cls"
                @click="showModeDropdown = !showModeDropdown; showModelDropdown = false"
              >
                <AppIcon name="shield" :size="13" />
                <span>{{ modeBadge.label }}</span>
                <AppIcon name="arrow-right" :size="11" class="rotate-90 opacity-70" />
              </button>
              <div v-if="showModeDropdown" class="absolute bottom-full left-0 mb-2 w-36 bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-40 py-1 overflow-hidden">
                <button
                  v-for="m in modes"
                  :key="m.key"
                  class="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer"
                  :class="approvalMode === m.key ? 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="pickMode(m.key)"
                >{{ m.label }}</button>
              </div>
            </div>

            <div class="ml-auto relative min-w-0">
              <button
                type="button"
                class="h-8 max-w-[260px] px-2.5 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-white/[0.04] flex items-center gap-1.5 cursor-pointer transition-colors"
                title="切换模型"
                @click="toggleModelDropdown"
              >
                <AppIcon name="spark" :size="13" />
                <span class="truncate">{{ modelText }}</span>
                <span v-if="modelChannel" class="hidden sm:inline text-[10px] text-slate-400 dark:text-slate-600 truncate">({{ modelChannel }})</span>
                <AppIcon name="arrow-right" :size="11" class="rotate-90 opacity-70 shrink-0" />
              </button>
              <div v-if="showModelDropdown" class="absolute bottom-full right-0 mb-2 w-[300px] max-w-[calc(100vw-48px)] bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-xl shadow-2xl z-40 py-1.5 overflow-hidden">
                <button
                  type="button"
                  class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
                  :class="!activeProviderId ? 'bg-emerald-50 dark:bg-emerald-400/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="selectComposerModel(null)"
                >
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="!activeProviderId ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold" :class="!activeProviderId ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-200'">默认模型</div>
                    <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-600">使用当前系统默认渠道</div>
                  </div>
                </button>
                <div v-if="enabledProviders.length" class="h-px bg-slate-100 dark:bg-white/[0.06] mx-3"></div>
                <button
                  v-for="p in enabledProviders"
                  :key="p.id"
                  type="button"
                  class="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer"
                  :class="p.id === activeProviderId ? 'bg-emerald-50 dark:bg-emerald-400/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                  @click="selectComposerModel(p.id)"
                >
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="p.id === activeProviderId ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]' : 'bg-slate-300 dark:bg-slate-600'"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold truncate" :class="p.id === activeProviderId ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-200'">{{ p.model || '未指定模型' }}</div>
                    <div class="mt-0.5 text-[10px] text-slate-400 dark:text-slate-600 truncate">{{ p.name }}</div>
                  </div>
                </button>
                <div v-if="!enabledProviders.length" class="px-3 py-4 text-xs text-slate-400 dark:text-slate-600 text-center">
                  暂无启用的渠道 · <RouterLink to="/panel/ai" class="text-sky-500 hover:underline">前往 AI 配置</RouterLink>
                </div>
              </div>
            </div>

            <button
              class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer"
              :class="(composerInput.trim() || composerAttachments.length) && !isBusy ? 'bg-slate-900 dark:bg-emerald-500 text-white hover:bg-slate-800 dark:hover:bg-emerald-400 shadow-lg shadow-slate-900/10 dark:shadow-emerald-500/10' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-400 dark:text-slate-600 cursor-not-allowed'"
              :disabled="(!composerInput.trim() && !composerAttachments.length) || isBusy"
              @click="send"
            >
              <AppIcon :name="composerInput.trim() || composerAttachments.length ? 'send' : 'arrow-right'" :size="16" />
            </button>
          </div>
        </div>
      </div>
    </footer>

    <div v-if="showHostDropdown || showModeDropdown || showModelDropdown" class="fixed inset-0 z-20" @click="showHostDropdown = false; showModeDropdown = false; showModelDropdown = false"></div>

    <Teleport to="body">
      <div
        v-if="rewindModalOpen"
        class="fixed inset-0 z-[2200] flex items-center justify-center bg-slate-950/55 backdrop-blur-[2px] p-4"
        @click.self="closeRewindModal"
      >
        <section
          ref="rewindModalRef"
          class="w-full max-w-[640px] max-h-[78vh] overflow-hidden rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#101624] shadow-2xl outline-none flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rewind-modal-title"
          tabindex="-1"
          @keydown="onRewindModalKeydown"
        >
          <header class="shrink-0 flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-white/[0.06]">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                  <AppIcon name="history" :size="16" />
                </span>
                <h2 id="rewind-modal-title" class="text-base font-semibold text-slate-800 dark:text-slate-100">Rewind to...</h2>
              </div>
              <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">选择一次输入，1Shell 会回到当时的对话位置，并撤销之后可逆的主机文件操作。</p>
            </div>
            <button
              type="button"
              class="shrink-0 w-9 h-9 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05] flex items-center justify-center transition-colors cursor-pointer"
              title="关闭"
              @click="closeRewindModal"
            >
              <AppIcon name="close" :size="16" />
            </button>
          </header>

          <div class="min-h-[220px] flex-1 overflow-y-auto py-2">
            <div v-if="rewindLoading" class="h-[220px] flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
              正在读取回溯点...
            </div>
            <div v-else-if="rewindError" class="px-5 py-8 text-sm leading-6 text-slate-500 dark:text-slate-400">
              {{ rewindError }}
            </div>
            <template v-else>
              <button
                v-for="(point, i) in rewindPoints"
                :key="point.id"
                type="button"
                class="w-full min-h-[54px] px-5 py-3 text-left border-b border-slate-100 dark:border-white/[0.04] flex items-center gap-3 transition-colors cursor-pointer"
                :class="i === rewindHighlight ? 'bg-emerald-50 dark:bg-emerald-400/10 outline outline-1 outline-emerald-400/60 outline-offset-[-1px]' : 'hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
                @mouseenter="rewindHighlight = i"
                @click="runRewind(point)"
              >
                <span class="shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center text-xs font-semibold"
                  :class="i === rewindHighlight ? 'border-emerald-300 dark:border-emerald-400/30 text-emerald-700 dark:text-emerald-300 bg-white/70 dark:bg-emerald-400/10' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-white/[0.03]'">
                  #{{ point.ordinal }}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="truncate text-sm font-medium" :class="i === rewindHighlight ? 'text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200'">{{ rewindPointText(point) }}</span>
                    <span class="shrink-0 text-xs text-slate-400 dark:text-slate-500">{{ rewindPointTime(point) }}</span>
                  </div>
                  <div class="mt-1 flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
                    <span class="inline-flex items-center gap-1 min-w-0">
                      <AppIcon name="server" :size="12" />
                      <span class="truncate">{{ rewindPointHost(point) }}</span>
                    </span>
                    <span class="text-slate-300 dark:text-slate-700">/</span>
                    <span>{{ point.undoCount }} 个可撤销文件操作</span>
                  </div>
                </div>
              </button>
            </template>
          </div>

          <footer class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-slate-200 dark:border-white/[0.06] bg-stone-50 dark:bg-[#0b0f19]">
            <div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
              <span class="px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">↑↓</span>
              <span>移动</span>
              <span class="text-slate-300 dark:text-slate-700">·</span>
              <span class="px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">Enter</span>
              <span>回溯</span>
              <span class="text-slate-300 dark:text-slate-700">·</span>
              <span class="px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03]">Esc</span>
              <span>关闭</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <p class="text-[11px] leading-5 text-slate-400 dark:text-slate-500">当前只自动撤销 1Shell 结构化文件工具造成的改动；shell 命令、服务安装、数据库写入会保留在报告里。</p>
              <button
                type="button"
                class="shrink-0 h-8 px-3 rounded-lg text-xs font-medium transition-colors"
                :class="rewindPoints.length && !rewindLoading ? 'bg-slate-900 dark:bg-emerald-500 text-white hover:bg-slate-800 dark:hover:bg-emerald-400 cursor-pointer' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-400 dark:text-slate-600 cursor-not-allowed'"
                :disabled="!rewindPoints.length || rewindLoading"
                @click="runRewind()"
              >
                回溯
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>
    </div>
  </div>
</template>

<style scoped>
.agent-md :deep(pre) {
  background: #f5f5f4;
  border: 1px solid #e7e5e4;
  border-radius: 10px;
  padding: 12px 14px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.6;
}
:global(.dark) .agent-md :deep(pre) {
  background: #0b0f19;
  border-color: rgba(255,255,255,0.04);
  color: #e2e8f0;
}
.agent-md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.agent-md :deep(p) { margin: 0.5em 0; }
.agent-md :deep(p:first-child) { margin-top: 0; }
.agent-md :deep(p:last-child) { margin-bottom: 0; }
.agent-md :deep(ul), .agent-md :deep(ol) { padding-left: 1.5em; margin: 0.4em 0; }
.agent-md :deep(li) { margin: 0.2em 0; }
.agent-md :deep(h1), .agent-md :deep(h2), .agent-md :deep(h3) { font-weight: 600; margin: 0.8em 0 0.3em; }
.agent-md :deep(h1) { font-size: 1.15em; }
.agent-md :deep(h2) { font-size: 1.05em; }
.agent-md :deep(h3) { font-size: 1em; }
.agent-md :deep(blockquote) {
  border-left: 2px solid rgba(52, 211, 153, 0.3);
  padding-left: 12px;
  color: #94a3b8;
  margin: 0.4em 0;
}
.agent-md :deep(a) { color: #38bdf8; text-decoration: underline; }
.dark .agent-md :deep(a) { color: #38bdf8; }
</style>
