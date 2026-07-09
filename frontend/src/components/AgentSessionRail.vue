<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import AgentToolsRail from '@/components/AgentToolsRail.vue';
import { useFileBrowser, type DirItem } from '@/composables/useFileBrowser';
import type { HostInfo } from '@/utils/scripts';
import { formatOsInfo, isLocalHost } from '@/utils/mainConsole';
import type { MainHost } from '@/utils/mainConsole';

type RailTab = 'chat' | 'files' | 'tools';

interface SessionMeta {
  id: string;
  title: string;
  entry: string;
  hostId: string;
  workspaceHostIds?: string[];
  modelLabel: string;
  messageCount: number;
  preview: string;
  agentId?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
  awaitingApproval?: boolean;
}

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

const props = withDefaults(defineProps<{
  sessions: SessionMeta[];
  activeId: string;
  loading?: boolean;
  activeTab?: RailTab;
  hosts?: HostInfo[];
  selectedHostId?: string;
  fileFocus?: FileFocus | null;
  /* 对话 tab 顶部的主机区（对话本就绑定主机，合并管理） */
  consoleHosts?: MainHost[];
  activeConsoleHostId?: string | null;
  secretWarning?: boolean;
}>(), {
  loading: false,
  activeTab: 'chat',
  selectedHostId: '',
  fileFocus: null,
  consoleHosts: () => [],
  activeConsoleHostId: null,
  secretWarning: false,
});

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'new-session'): void;
  (e: 'new-session-at', path: string): void;
  (e: 'rename', id: string, title: string): void;
  (e: 'copy', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'update:activeTab', tab: RailTab): void;
  (e: 'select-host', id: string): void;
  (e: 'host-connect', id: string): void;
  (e: 'host-edit', id: string): void;
  (e: 'host-delete', id: string): void;
  (e: 'host-add'): void;
  (e: 'host-new-session', key: string): void;
}>();

const keyword = ref('');
const renamingId = ref<string | null>(null);
const renameText = ref('');
const fileHostId = ref('local');
// 主机卡片展开状态（展开后显示绑定在该主机上的对话）
const expandedHostKeys = ref<Set<string>>(new Set());

const fb = useFileBrowser({ hostId: fileHostId, singleton: false });

const tabs: Array<{ key: RailTab; label: string }> = [
  { key: 'chat', label: '主机' },
  { key: 'files', label: '文件' },
  { key: 'tools', label: '工具' },
];

function hostMeta(h: MainHost): string {
  if (isLocalHost(h)) return '本地 Shell';
  return `${h.username || 'root'}@${h.host}:${h.port || 22}`;
}

function hostOsText(h: MainHost): string {
  return formatOsInfo(h.osInfo);
}

const hostList = computed(() => props.hosts || []);

const chatSessions = computed(() => props.sessions.slice().sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt)));

// ── 主机树：主机卡片为主体，对话挂在其绑定的主机下 ──
interface HostGroup {
  /** hostId 或 '__global__'（不绑定主机的对话）/ 已删除主机的残留 id */
  key: string;
  host: MainHost | null;
  label: string;
  sessions: SessionMeta[];
}

// 协议 agent 会话（Claude Code / Codex…）运行在本机，挂在本机卡片下
function isProtocolSession(session: SessionMeta): boolean {
  const id = String(session.agentId || '').trim();
  return Boolean(id) && id !== 'oneshell';
}

function cwdBasename(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) return '';
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? (normalized.slice(idx + 1) || normalized) : normalized;
}

function sessionHostKey(session: SessionMeta): string {
  if (isProtocolSession(session)) return 'local';
  const ids = sessionWorkspaceIds(session);
  return ids[0] || '__global__';
}

// 条目附加信息：协议会话的工作目录 / 多主机工作区
function sessionExtraMeta(session: SessionMeta): string {
  if (isProtocolSession(session)) {
    const base = cwdBasename(String(session.cwd || ''));
    return base ? `· ${base}` : '';
  }
  const ids = sessionWorkspaceIds(session);
  return ids.length > 1 ? `· +${ids.length - 1} 主机` : '';
}

function matchText(text: string, kw: string): boolean {
  return text.toLowerCase().includes(kw);
}

const searchActive = computed(() => keyword.value.trim().length > 0);

const hostGroups = computed<HostGroup[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const byKey = new Map<string, SessionMeta[]>();
  for (const session of chatSessions.value) {
    if (kw && !matchText(`${session.title} ${session.preview}`, kw)) continue;
    const key = sessionHostKey(session);
    const list = byKey.get(key) || [];
    list.push(session);
    byKey.set(key, list);
  }

  const groups: HostGroup[] = [];
  const covered = new Set<string>();
  for (const host of props.consoleHosts || []) {
    covered.add(host.id);
    const sessions = byKey.get(host.id) || [];
    if (kw && !matchText(`${host.name} ${host.host || ''} ${host.username || ''}`, kw) && !sessions.length) continue;
    groups.push({ key: host.id, host, label: host.name, sessions });
  }

  // 已删除主机的残留会话 / 全局会话
  for (const [key, sessions] of byKey) {
    if (covered.has(key) || key === '__global__') continue;
    groups.push({ key, host: null, label: hostName(key), sessions });
  }
  const globalSessions = byKey.get('__global__') || [];
  if (globalSessions.length) {
    groups.push({ key: '__global__', host: null, label: '全局', sessions: globalSessions });
  }
  return groups;
});

const visibleItems = computed<DirItem[]>(() => {
  const list = fb.showHidden.value
    ? fb.items.value
    : fb.items.value.filter((i) => !i.name.startsWith('.'));
  return fb.sortItems(list);
});

const dirCount = computed(() => visibleItems.value.filter((i) => i.isDir || i.isDrive).length);
const fileCount = computed(() => visibleItems.value.length - dirCount.value);
const fileHostLabel = computed(() => hostName(fileHostId.value));
// 协议 agent 目前只在本机跑；盘符列表页（此电脑）不是可用工作目录
const canNewSessionHere = computed(() => {
  if (fileHostId.value !== 'local') return false;
  const path = String(fb.currentPath.value || '').trim();
  return Boolean(path) && path !== '此电脑' && path !== '__drives__';
});
const activeFileFocus = computed(() => props.fileFocus || null);
const focusStatusLabel = computed(() => {
  switch (activeFileFocus.value?.status) {
    case 'preparing': return '准备';
    case 'running': return '执行中';
    case 'done': return '完成';
    case 'error': return '失败';
    default: return '';
  }
});
const focusStatusClass = computed(() => {
  switch (activeFileFocus.value?.status) {
    case 'running': return 'border-sky-300 dark:border-sky-400/25 text-sky-700 dark:text-sky-300 bg-sky-100/70 dark:bg-sky-400/10';
    case 'error': return 'border-red-300 dark:border-red-400/25 text-red-700 dark:text-red-300 bg-red-100/70 dark:bg-red-400/10';
    case 'done': return 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 bg-white/70 dark:bg-white/[0.04]';
    default: return 'border-amber-300 dark:border-amber-400/25 text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-400/10';
  }
});
const focusDetail = computed(() => {
  const focus = activeFileFocus.value;
  if (!focus) return '';
  if (focus.path || focus.directory) return focus.path || focus.directory;
  return `${hostName(focus.hostId)} · ${focus.toolName || '主机操作'}`;
});

interface Crumb {
  label: string;
  path: string;
  active: boolean;
}

const crumbs = computed<Crumb[]>(() => {
  const path = fb.currentPath.value;
  if (!path) return [{ label: '根目录', path: '', active: true }];
  if (path === '此电脑') return [{ label: '此电脑', path: '__drives__', active: true }];
  if (fb.isWindows.value) {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const list: Crumb[] = [{ label: '此电脑', path: '__drives__', active: false }];
    if (!parts.length) return list;
    let acc = parts[0] + '/';
    list.push({ label: parts[0], path: acc.replace(/\//g, '\\'), active: parts.length === 1 });
    for (let i = 1; i < parts.length; i += 1) {
      acc += parts[i] + '/';
      list.push({ label: parts[i], path: acc.replace(/\//g, '\\'), active: i === parts.length - 1 });
    }
    return list;
  }
  const parts = path.split('/').filter(Boolean);
  const list: Crumb[] = [{ label: '/', path: '/', active: parts.length === 0 }];
  let acc = '/';
  for (let i = 0; i < parts.length; i += 1) {
    acc += parts[i] + '/';
    list.push({ label: parts[i], path: acc, active: i === parts.length - 1 });
  }
  return list;
});

onMounted(() => { fb.initialize(); });
onBeforeUnmount(() => { fb.closePreview(); });

watch(() => props.selectedHostId, (id) => {
  if (!props.fileFocus?.hostId) fileHostId.value = id || 'local';
}, { immediate: true });

watch(() => props.fileFocus, async (focus) => {
  if (!focus?.hostId) return;
  fileHostId.value = focus.hostId;
  setTab('files');
  await nextTick();
  const targetDir = focus.directory || parentDirectory(focus.path);
  if (targetDir !== fb.currentPath.value) fb.navigate(targetDir);
}, { deep: true });

// 当前会话所在主机自动展开（手动收起后不强制再展开，除非切换会话）
watch(() => props.activeId, (id) => {
  if (!id) return;
  const session = props.sessions.find((item) => item.id === id);
  if (!session) return;
  const key = sessionHostKey(session);
  if (!expandedHostKeys.value.has(key)) {
    expandedHostKeys.value = new Set([...expandedHostKeys.value, key]);
  }
}, { immediate: true });

function setTab(tab: RailTab): void {
  emit('update:activeTab', tab);
}

function parseTime(s: string): number {
  if (!s) return 0;
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function relTime(s: string): string {
  const t = parseTime(s);
  if (!t) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString();
}

function startRename(s: SessionMeta): void {
  renamingId.value = s.id;
  renameText.value = s.title;
}

function focusRename(el: unknown, id: string): void {
  if (el instanceof HTMLInputElement && renamingId.value === id && document.activeElement !== el) {
    el.focus();
    el.select();
  }
}

function commitRename(): void {
  const id = renamingId.value;
  const title = renameText.value.trim();
  renamingId.value = null;
  if (id && title) emit('rename', id, title);
}

function normalizeWorkspaceHostIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'all' && id !== '*')));
}

function sessionWorkspaceIds(session: SessionMeta): string[] {
  const ids = normalizeWorkspaceHostIds(session.workspaceHostIds);
  if (ids.length) return ids;
  const hostId = String(session.hostId || '').trim();
  return hostId && hostId !== 'all' ? [hostId] : [];
}

function hostName(id: string): string {
  if (!id || id === 'local') return '本机';
  const host = hostList.value.find((item) => item.id === id);
  return host?.name || id;
}

function isHostExpanded(group: HostGroup): boolean {
  if (searchActive.value) return group.sessions.length > 0;
  return expandedHostKeys.value.has(group.key);
}

function toggleHostExpanded(key: string): void {
  const next = new Set(expandedHostKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedHostKeys.value = next;
}

function selectHost(id: string): void {
  const next = id || 'local';
  fileHostId.value = next;
  emit('select-host', id);
}

function onFileClick(item: DirItem): void {
  if (item.isDir || item.isDrive) fb.navigate(item.path);
  else void fb.openPreview(item.path);
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parentDirectory(path: string): string {
  const text = String(path || '').trim();
  if (!text) return '';
  const normalized = text.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized.startsWith('/') ? '/' : '';
  return normalized.slice(0, idx);
}

function normalizePath(path: string): string {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isFocusedItem(item: DirItem): boolean {
  const focus = activeFileFocus.value;
  if (!focus?.path) return false;
  const itemPath = normalizePath(item.path);
  const focusPath = normalizePath(focus.path);
  if (itemPath && itemPath === focusPath) return true;
  return Boolean(focus.fileName && normalizePath(fb.currentPath.value) === normalizePath(focus.directory) && item.name === focus.fileName);
}
</script>

<template>
  <aside class="w-[352px] min-w-[312px] max-w-[380px] shrink-0 h-full flex flex-col bg-white dark:bg-[#0d111b]">
    <div class="shrink-0 p-2.5 border-b border-slate-200/80 dark:border-white/[0.06]">
      <div class="grid grid-cols-3 gap-1 rounded-xl bg-slate-100/70 dark:bg-white/[0.035] border border-slate-200/80 dark:border-white/[0.06] p-1">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="h-8 rounded-lg flex items-center justify-center text-[12px] font-semibold transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-sky-400/25"
          :class="props.activeTab === tab.key ? 'bg-white dark:bg-white/[0.08] text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-white/70 dark:hover:bg-white/[0.05]'"
          @click="setTab(tab.key)"
        >
          <span>{{ tab.label }}</span>
        </button>
      </div>
    </div>

    <template v-if="props.activeTab === 'chat'">
      <!-- 头行：搜索 + 添加主机 + 新对话 -->
      <div class="shrink-0 px-3 py-2.5 border-b border-slate-200/70 dark:border-white/[0.04] flex items-center gap-1.5">
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索主机或对话..."
          class="min-w-0 flex-1 h-8 px-2.5 text-xs text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-[#090d15] border border-slate-200/90 dark:border-white/[0.07] rounded-lg focus:outline-none focus:border-sky-400/40 placeholder:text-slate-400 dark:placeholder:text-slate-600 transition-colors"
        />
        <button
          class="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:border-sky-300 hover:text-sky-600 dark:hover:border-sky-400/40 dark:hover:text-sky-300 cursor-pointer transition-colors"
          title="添加主机"
          @click="emit('host-add')"
        >
          <AppIcon name="server" :size="14" />
        </button>
        <button
          class="shrink-0 h-8 w-8 flex items-center justify-center rounded-lg bg-slate-900 dark:bg-sky-500 text-white border border-slate-900 dark:border-sky-400 hover:bg-slate-800 dark:hover:bg-sky-400 cursor-pointer transition-colors shadow-sm"
          title="新对话"
          @click="emit('new-session')"
        >
          <AppIcon name="plus" :size="14" />
        </button>
      </div>

      <div v-if="props.secretWarning" class="shrink-0 mx-3 mt-2 rounded-lg border border-amber-100 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1.5 text-[10px] leading-4 text-amber-600 dark:text-amber-300">
        当前未设置 APP_SECRET，仍可继续使用；上线前建议配置强随机密钥。
      </div>

      <!-- 主机树：主机卡片（老终端页样式）为主体，点击卡片展开挂在其上的对话 -->
      <div class="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2.5 flex flex-col gap-2">
        <div v-if="props.loading && !props.sessions.length && !(props.consoleHosts || []).length" class="px-2 py-6 text-center text-xs text-slate-400 dark:text-slate-600">加载中...</div>
        <div v-else-if="!hostGroups.length" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">
          {{ keyword ? '没有匹配的主机或对话' : '暂无主机' }}
        </div>

        <section v-for="g in hostGroups" :key="g.key">
          <!-- 主机卡片 -->
          <div
            class="rounded-xl border cursor-pointer transition-all p-3"
            :class="g.host && g.host.id === props.activeConsoleHostId
              ? 'border-sky-300/90 dark:border-sky-400/30 bg-gradient-to-br from-sky-50/90 to-indigo-50/60 dark:from-sky-400/10 dark:to-indigo-400/10 shadow-sm'
              : 'border-slate-200/90 dark:border-white/[0.07] bg-slate-50/70 dark:bg-white/[0.02] hover:border-sky-200 dark:hover:border-sky-400/25 hover:shadow-sm'"
            :title="g.sessions.length ? '点击展开/收起该主机的对话' : ''"
            @click="toggleHostExpanded(g.key)"
          >
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="min-w-0 truncate text-[13px] font-bold" :class="g.host && g.host.id === props.activeConsoleHostId ? 'text-sky-800 dark:text-sky-200' : 'text-slate-800 dark:text-slate-100'">{{ g.label }}</span>
                  <span v-if="g.host?.proxyHostId" class="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-violet-100 dark:bg-violet-400/15 text-violet-600 dark:text-violet-300">经跳板机中继</span>
                </div>
                <div class="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500 truncate">{{ g.host ? hostMeta(g.host) : (g.key === '__global__' ? '不绑定主机的对话' : '主机已删除') }}</div>
                <div v-if="g.host && hostOsText(g.host)" class="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">OS {{ hostOsText(g.host) }}</div>
              </div>
              <div class="shrink-0 flex items-center gap-1.5 pt-0.5">
                <span
                  v-if="g.sessions.length"
                  class="min-w-5 h-5 px-1.5 rounded-full bg-white dark:bg-white/[0.06] border border-slate-200/80 dark:border-white/[0.07] text-center text-[10px] leading-[18px] font-semibold text-slate-500 dark:text-slate-400"
                  title="绑定在该主机上的对话数"
                >{{ g.sessions.length }}</span>
                <AppIcon
                  name="arrow-right"
                  :size="12"
                  class="text-slate-400 dark:text-slate-500 transition-transform"
                  :class="isHostExpanded(g) ? 'rotate-90' : ''"
                />
              </div>
            </div>

            <!-- 网站任意门 -->
            <div v-if="g.host?.links?.length" class="mt-2">
              <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">网站任意门</div>
              <div class="mt-1 flex flex-wrap gap-1">
                <a
                  v-for="(lk, idx) in g.host.links"
                  :key="idx"
                  class="px-2 py-0.5 rounded-full bg-sky-100/80 dark:bg-sky-400/15 text-[10px] text-sky-600 dark:text-sky-300 hover:bg-sky-200/80 dark:hover:bg-sky-400/25 transition-colors"
                  :href="lk.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="lk.description || lk.url"
                  @click.stop
                >{{ lk.name }}</a>
              </div>
            </div>

            <!-- 操作排：切换 / 编辑 / 删除 / 新对话 -->
            <div class="mt-2.5 grid gap-1.5" :class="g.host ? (isLocalHost(g.host) ? 'grid-cols-3' : 'grid-cols-4') : 'grid-cols-1'">
              <template v-if="g.host">
                <button type="button" class="h-7 rounded-md border border-slate-200 dark:border-white/[0.08] bg-white/80 dark:bg-white/[0.03] text-[11px] font-medium text-slate-500 dark:text-slate-300 hover:border-sky-300 hover:text-sky-600 dark:hover:border-sky-400/40 dark:hover:text-sky-300 transition-colors cursor-pointer" title="连接终端" @click.stop="emit('host-connect', g.host!.id)">切换</button>
                <button type="button" class="h-7 rounded-md border border-slate-200 dark:border-white/[0.08] bg-white/80 dark:bg-white/[0.03] text-[11px] font-medium text-slate-500 dark:text-slate-300 hover:border-sky-300 hover:text-sky-600 dark:hover:border-sky-400/40 dark:hover:text-sky-300 transition-colors cursor-pointer" @click.stop="emit('host-edit', g.host!.id)">编辑</button>
                <button v-if="!isLocalHost(g.host)" type="button" class="h-7 rounded-md border border-slate-200 dark:border-white/[0.08] bg-white/80 dark:bg-white/[0.03] text-[11px] font-medium text-slate-500 dark:text-slate-300 hover:border-red-300 hover:text-red-500 dark:hover:border-red-400/40 dark:hover:text-red-400 transition-colors cursor-pointer" @click.stop="emit('host-delete', g.host!.id)">删除</button>
              </template>
              <button type="button" class="h-7 rounded-md border border-sky-200 dark:border-sky-400/25 bg-sky-50/80 dark:bg-sky-400/10 text-[11px] font-semibold text-sky-600 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-400/20 transition-colors cursor-pointer" title="在该主机上新建 Agent 对话" @click.stop="emit('host-new-session', g.key)">新对话</button>
            </div>
          </div>

          <!-- 展开：挂在该主机上的对话 -->
          <div v-if="isHostExpanded(g)" class="mt-1.5 ml-2.5 pl-2 border-l border-slate-200/80 dark:border-white/[0.07] grid gap-1.5">
            <div v-if="!g.sessions.length" class="px-2 py-2.5 text-[11px] text-slate-400 dark:text-slate-600">该主机暂无对话 · 点上方「新对话」开始</div>
            <div
              v-for="s in g.sessions"
              :key="s.id"
              class="group relative rounded-xl cursor-pointer transition-all border overflow-hidden"
              :class="s.id === props.activeId ? 'bg-sky-50/80 dark:bg-sky-400/10 border-sky-200/90 dark:border-sky-400/20 shadow-sm' : 'bg-white/70 dark:bg-white/[0.02] border-transparent hover:bg-white dark:hover:bg-white/[0.04] hover:border-slate-200/80 dark:hover:border-white/[0.06]'"
              @click="renamingId === s.id ? null : emit('select', s.id)"
            >
              <div class="min-w-0 px-3 py-2.5">
                <input
                  v-if="renamingId === s.id"
                  :ref="(el) => focusRename(el, s.id)"
                  v-model="renameText"
                  type="text"
                  class="w-full px-1.5 py-0.5 text-xs text-slate-700 dark:text-slate-200 bg-white dark:bg-[#0b0f19] border border-sky-300 dark:border-sky-400/30 rounded focus:outline-none"
                  @click.stop
                  @keydown.enter.prevent="commitRename"
                  @keydown.esc.prevent="renamingId = null"
                  @blur="commitRename"
                />
                <div v-else class="agent-session-text-guard min-w-0 flex items-center gap-1.5 pr-1 transition-[padding] group-hover:pr-[82px]">
                  <span v-if="s.entry === 'task'" class="shrink-0 text-amber-500 dark:text-amber-400" title="任务会话"><AppIcon name="save" :size="11" /></span>
                  <span v-if="isProtocolSession(s)" class="shrink-0 text-sky-500 dark:text-sky-400" :title="s.modelLabel || '协议 agent 会话'"><AppIcon name="robot" :size="11" /></span>
                  <span
                    class="min-w-0 flex-1 text-[13px] font-semibold truncate"
                    :class="s.id === props.activeId ? 'text-slate-950 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200'"
                    :title="s.title || '新对话'"
                  >{{ s.title || '新对话' }}</span>
                  <span v-if="s.awaitingApproval" class="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">待确认</span>
                  <span v-if="s.running" class="shrink-0 text-[10px] font-medium text-sky-600 dark:text-sky-400 animate-pulse">运行中</span>
                </div>

                <div v-if="renamingId !== s.id" class="agent-session-text-guard min-w-0 mt-1 pr-1 transition-[padding] group-hover:pr-[82px]">
                  <div class="flex items-center gap-1.5 text-[10px] font-medium text-slate-400 dark:text-slate-600">
                    <span class="shrink-0">{{ relTime(s.updatedAt) }}</span>
                    <span v-if="s.messageCount" class="shrink-0">· {{ s.messageCount }} 条</span>
                    <span v-if="s.modelLabel" class="min-w-0 truncate">· {{ s.modelLabel }}</span>
                    <span v-if="sessionExtraMeta(s)" class="min-w-0 truncate">{{ sessionExtraMeta(s) }}</span>
                  </div>
                  <p
                    v-if="s.preview"
                    class="agent-session-preview mt-0.5 text-[11px] leading-4 text-slate-500/75 dark:text-slate-500"
                    :title="s.preview"
                  >{{ s.preview }}</p>
                </div>
              </div>

              <div v-if="renamingId !== s.id" class="agent-session-actions absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5 rounded-lg border border-slate-200/80 dark:border-white/[0.06] bg-white/95 dark:bg-[#121826]/95 p-0.5 shadow-sm">
                <button class="w-6 h-6 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer" title="重命名" @click.stop="startRename(s)">
                  <AppIcon name="pen" :size="12" />
                </button>
                <button class="w-6 h-6 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-sky-600 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer" title="复制" @click.stop="emit('copy', s.id)">
                  <AppIcon name="copy" :size="12" />
                </button>
                <button class="w-6 h-6 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer" title="删除" @click.stop="emit('delete', s.id)">
                  <AppIcon name="close" :size="12" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>

    <template v-else-if="props.activeTab === 'files'">
      <div class="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-white/[0.05]">
        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">文件</div>
            <div class="mt-0.5 text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{{ fileHostLabel }}</div>
          </div>
          <button
            v-if="canNewSessionHere"
            class="h-7 px-2 rounded-md border border-sky-200 dark:border-sky-400/25 text-[11px] text-sky-600 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-400/10 transition-colors cursor-pointer whitespace-nowrap"
            title="以当前目录为工作目录新建 agent 会话"
            @click="emit('new-session-at', fb.currentPath.value)"
          >在此新建会话</button>
          <button class="h-7 px-2 rounded-md border border-slate-200 dark:border-white/[0.08] text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-white dark:hover:bg-white/[0.04] transition-colors cursor-pointer" title="刷新当前目录" @click="fb.refreshCurrent">刷新</button>
        </div>
        <div v-if="activeFileFocus" class="mt-2 rounded-lg border border-sky-200 dark:border-sky-400/15 bg-sky-50/70 dark:bg-sky-400/8 px-2.5 py-2">
          <div class="flex items-center gap-1.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
            <AppIcon name="wrench" :size="12" />
            <span class="truncate">{{ activeFileFocus.action || activeFileFocus.toolName || 'Agent 文件操作' }}</span>
            <span
              v-if="focusStatusLabel"
              class="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none"
              :class="focusStatusClass"
            >{{ focusStatusLabel }}</span>
          </div>
          <div class="mt-1 text-[10px] text-sky-700/70 dark:text-sky-300/70 truncate" :title="focusDetail">{{ focusDetail }}</div>
        </div>
      </div>

      <div class="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-white/[0.04]">
        <div class="flex gap-1.5 overflow-x-auto pb-0.5">
          <button
            class="h-7 px-2 rounded-md text-[11px] border transition-colors cursor-pointer whitespace-nowrap"
            :class="fileHostId === 'local' ? 'border-sky-300 dark:border-sky-400/25 bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-white/[0.04]'"
            @click="selectHost('local')"
          >本机</button>
          <button
            v-for="host in hostList"
            :key="host.id"
            class="h-7 px-2 rounded-md text-[11px] border transition-colors cursor-pointer whitespace-nowrap max-w-28 truncate"
            :class="fileHostId === host.id ? 'border-sky-300 dark:border-sky-400/25 bg-sky-50 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-white/[0.04]'"
            :title="host.name || host.id"
            @click="selectHost(host.id)"
          >{{ host.name || host.id }}</button>
        </div>
        <div v-if="crumbs.length" class="mt-2 flex items-center gap-1 overflow-hidden">
          <template v-for="(crumb, index) in crumbs.slice(-4)" :key="`${crumb.path}-${index}`">
            <button
              type="button"
              class="min-w-0 text-[11px] truncate"
              :class="crumb.active ? 'text-slate-500 dark:text-slate-400 cursor-default' : 'text-sky-600 dark:text-sky-400 hover:underline cursor-pointer'"
              :disabled="crumb.active"
              @click="fb.navigate(crumb.path)"
            >{{ crumb.label }}</button>
            <span v-if="index < crumbs.slice(-4).length - 1" class="text-[10px] text-slate-300 dark:text-slate-700">/</span>
          </template>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        <div v-if="fb.loading.value" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">加载中...</div>
        <div v-else-if="fb.error.value" class="px-2 py-5">
          <div class="rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/8 p-3 text-xs text-red-600 dark:text-red-300">
            <div class="font-semibold">文件加载失败</div>
            <div class="mt-1 leading-5">{{ fb.error.value }}</div>
            <button class="mt-2 h-7 px-2 rounded-md border border-red-200 dark:border-red-500/20 hover:bg-red-100 dark:hover:bg-red-500/10 cursor-pointer" @click="fb.refreshCurrent">重试</button>
          </div>
        </div>
        <template v-else>
          <button
            v-if="fb.parent.value && fb.parent.value !== fb.currentPath.value"
            type="button"
            class="w-full h-8 px-2 rounded-lg flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-white/[0.04] cursor-pointer transition-colors"
            @click="fb.goBack"
          >
            <AppIcon name="arrow-up" :size="13" />
            <span>返回上级</span>
          </button>
          <div v-if="!visibleItems.length && !fb.parent.value" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">空目录</div>
          <button
            v-for="item in visibleItems"
            :key="item.path"
            type="button"
            class="group w-full min-h-9 px-2 rounded-lg flex items-center gap-2 text-left transition-colors cursor-pointer border"
            :class="isFocusedItem(item) ? 'border-sky-300 dark:border-sky-400/25 bg-sky-50 dark:bg-sky-400/10' : 'border-transparent hover:bg-white dark:hover:bg-white/[0.04]'"
            @click="onFileClick(item)"
          >
            <AppIcon :name="item.isDir || item.isDrive ? 'folder' : 'file'" :size="14" :class="item.isDir || item.isDrive ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'" />
            <span class="min-w-0 flex-1 truncate text-xs" :class="isFocusedItem(item) ? 'text-sky-700 dark:text-sky-300 font-semibold' : 'text-slate-700 dark:text-slate-200'">{{ item.name }}</span>
            <span v-if="!item.isDir && !item.isDrive" class="text-[10px] text-slate-400 dark:text-slate-600 shrink-0">{{ formatSize(item.size) }}</span>
          </button>
        </template>
      </div>

      <div class="shrink-0 px-3 py-2 border-t border-slate-200 dark:border-white/[0.05] text-[10px] text-slate-400 dark:text-slate-600">
        {{ dirCount }} 目录 / {{ fileCount }} 文件
      </div>
    </template>

    <template v-else>
      <AgentToolsRail embedded />
    </template>
  </aside>
</template>

<style scoped>
.agent-session-preview {
  display: -webkit-box;
  max-height: 32px;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

@media (hover: none) {
  .agent-session-actions {
    display: flex;
  }

  .agent-session-text-guard {
    padding-right: 82px;
  }
}
</style>
