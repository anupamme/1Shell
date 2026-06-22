<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import AgentToolsRail from '@/components/AgentToolsRail.vue';
import { useFileBrowser, type DirItem } from '@/composables/useFileBrowser';
import type { HostInfo } from '@/utils/scripts';

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
}>(), {
  loading: false,
  activeTab: 'chat',
  selectedHostId: '',
  fileFocus: null,
});

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'new-session'): void;
  (e: 'rename', id: string, title: string): void;
  (e: 'copy', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'update:activeTab', tab: RailTab): void;
  (e: 'select-host', id: string): void;
}>();

const keyword = ref('');
const renamingId = ref<string | null>(null);
const renameText = ref('');
const fileHostId = ref('local');

const fb = useFileBrowser({ hostId: fileHostId, singleton: false });

const tabs: Array<{ key: RailTab; label: string }> = [
  { key: 'chat', label: '对话' },
  { key: 'files', label: '文件' },
  { key: 'tools', label: '工具' },
];

const hostList = computed(() => props.hosts || []);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return props.sessions;
  return props.sessions.filter((s) => `${s.title} ${s.preview}`.toLowerCase().includes(kw));
});

const chatSessions = computed(() => filtered.value.slice().sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt)));

interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionMeta[];
  updatedAt: string;
}

const chatGroups = computed<SessionGroup[]>(() => {
  const groups = new Map<string, SessionGroup>();
  for (const session of chatSessions.value) {
    const ids = sessionWorkspaceIds(session);
    const key = workspaceKey(ids);
    const group = groups.get(key) || {
      key,
      label: workspaceLabel(ids),
      sessions: [],
      updatedAt: session.updatedAt || '',
    };
    group.sessions.push(session);
    if (parseTime(session.updatedAt) > parseTime(group.updatedAt)) group.updatedAt = session.updatedAt;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt));
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

function workspaceKey(ids: string[]): string {
  const normalized = normalizeWorkspaceHostIds(ids).slice().sort();
  return normalized.length ? normalized.join('|') : '__global__';
}

function workspaceLabel(ids: string[]): string {
  const normalized = normalizeWorkspaceHostIds(ids);
  if (!normalized.length) return '全局';
  const names = normalized.map((id) => hostName(id));
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} +${names.length - 2}`;
}

function hostName(id: string): string {
  if (!id || id === 'local') return '本机';
  const host = hostList.value.find((item) => item.id === id);
  return host?.name || id;
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
  <aside class="w-[328px] min-w-[292px] max-w-[360px] shrink-0 h-full flex flex-col border-r border-slate-200/80 dark:border-white/[0.06] bg-white dark:bg-[#0d111b]">
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
      <div class="shrink-0 flex items-center gap-2 px-3.5 h-12 border-b border-slate-200/70 dark:border-white/[0.05]">
        <span class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">对话</span>
        <button
          class="ml-auto h-7 flex items-center gap-1.5 px-2.5 text-xs font-medium rounded-lg bg-slate-900 dark:bg-sky-500 text-white border border-slate-900 dark:border-sky-400 hover:bg-slate-800 dark:hover:bg-sky-400 cursor-pointer transition-colors shadow-sm"
          title="新对话"
          @click="emit('new-session')"
        >
          <AppIcon name="plus" :size="13" />
          新对话
        </button>
      </div>

      <div class="shrink-0 px-3.5 py-2.5 border-b border-slate-200/70 dark:border-white/[0.04]">
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索对话..."
          class="w-full h-8 px-2.5 text-xs text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-[#090d15] border border-slate-200/90 dark:border-white/[0.07] rounded-lg focus:outline-none focus:border-sky-400/40 placeholder:text-slate-400 dark:placeholder:text-slate-600 transition-colors"
        />
      </div>

      <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
        <div v-if="props.loading && !props.sessions.length" class="px-2 py-6 text-center text-xs text-slate-400 dark:text-slate-600">加载中...</div>
        <div v-else-if="!filtered.length" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">
          {{ keyword ? '没有匹配的对话' : '暂无历史对话' }}
        </div>

        <section v-for="group in chatGroups" :key="group.key" class="agent-chat-group">
          <div class="agent-chat-group-header sticky top-0 z-10">
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-bold text-slate-700 dark:text-slate-200">{{ group.label }}</div>
              <div class="mt-0.5 text-[10px] font-medium tracking-wider text-slate-400 dark:text-slate-600">工作区</div>
            </div>
            <span class="min-w-6 h-5 px-1.5 rounded-full bg-white dark:bg-white/[0.06] border border-slate-200/80 dark:border-white/[0.07] text-center text-[11px] leading-5 font-semibold text-slate-500 dark:text-slate-400">{{ group.sessions.length }}</span>
          </div>

          <div class="agent-chat-group-list">
            <div
              v-for="s in group.sessions"
              :key="s.id"
              class="group relative rounded-xl cursor-pointer transition-all border"
              :class="s.id === props.activeId ? 'bg-sky-50/80 dark:bg-sky-400/10 border-sky-200/90 dark:border-sky-400/20 shadow-sm' : 'bg-white/70 dark:bg-white/[0.02] border-transparent hover:bg-white dark:hover:bg-white/[0.04] hover:border-slate-200/80 dark:hover:border-white/[0.06]'"
              @click="renamingId === s.id ? null : emit('select', s.id)"
            >
              <div class="px-3 py-2.5">
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
                <div v-else class="flex items-center gap-1.5">
                  <span v-if="s.entry === 'task'" class="shrink-0 text-amber-500 dark:text-amber-400" title="任务会话"><AppIcon name="save" :size="11" /></span>
                  <span class="text-[13px] font-semibold truncate" :class="s.id === props.activeId ? 'text-slate-950 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200'">{{ s.title || '新对话' }}</span>
                  <span v-if="s.awaitingApproval" class="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">待确认</span>
                  <span v-if="s.running" class="shrink-0 text-[10px] font-medium text-sky-600 dark:text-sky-400 animate-pulse">运行中</span>
                </div>

                <div v-if="renamingId !== s.id" class="flex items-center gap-1.5 mt-0.5">
                  <span class="text-[10px] text-slate-400 dark:text-slate-600 shrink-0">{{ relTime(s.updatedAt) }}</span>
                  <span v-if="s.preview" class="text-[10px] text-slate-400 dark:text-slate-600 truncate">· {{ s.preview }}</span>
                </div>
              </div>

              <div v-if="renamingId !== s.id" class="absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5 rounded-lg border border-slate-200/80 dark:border-white/[0.06] bg-white/95 dark:bg-[#121826]/95 p-0.5 shadow-sm">
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
.agent-chat-group {
  margin-bottom: 18px;
}

.agent-chat-group + .agent-chat-group {
  padding-top: 8px;
}

.agent-chat-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin: 0 -2px 8px;
  padding: 8px 10px 8px 12px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 12px;
  background:
    linear-gradient(90deg, rgba(14, 165, 233, 0.08), rgba(255, 255, 255, 0) 48%),
    rgba(248, 250, 252, 0.96);
}

.agent-chat-group-header::before {
  content: "";
  width: 3px;
  height: 24px;
  border-radius: 999px;
  background: #38bdf8;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.08);
}

.agent-chat-group-list {
  display: grid;
  gap: 6px;
  padding-left: 10px;
  border-left: 1px solid rgba(203, 213, 225, 0.72);
}

:global(.dark) .agent-chat-group-header {
  border-color: rgba(255, 255, 255, 0.07);
  background:
    linear-gradient(90deg, rgba(56, 189, 248, 0.12), rgba(15, 23, 42, 0) 48%),
    rgba(255, 255, 255, 0.035);
}

:global(.dark) .agent-chat-group-list {
  border-left-color: rgba(255, 255, 255, 0.08);
}
</style>
