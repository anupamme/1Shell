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
  (e: 'delete', id: string): void;
  (e: 'update:activeTab', tab: RailTab): void;
  (e: 'select-host', id: string): void;
}>();

const keyword = ref('');
const renamingId = ref<string | null>(null);
const renameText = ref('');
const fileHostId = ref('local');

const fb = useFileBrowser({ hostId: fileHostId, singleton: false });

const tabs: Array<{ key: RailTab; label: string; icon: string }> = [
  { key: 'chat', label: '对话', icon: 'terminal' },
  { key: 'files', label: '文件', icon: 'folder' },
  { key: 'tools', label: 'Tools', icon: 'wrench' },
];

const hostList = computed(() => props.hosts || []);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return props.sessions;
  return props.sessions.filter((s) => `${s.title} ${s.preview}`.toLowerCase().includes(kw));
});

const chatSessions = computed(() => filtered.value.slice().sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt)));

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
    case 'running': return 'border-emerald-300 dark:border-emerald-400/25 text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-400/10';
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
  <aside class="w-1/5 min-w-[300px] max-w-[460px] shrink-0 h-full flex flex-col border-r border-slate-200 dark:border-white/[0.05] bg-stone-100/60 dark:bg-[#0c1019]">
    <div class="shrink-0 p-2 border-b border-slate-200 dark:border-white/[0.05]">
      <div class="grid grid-cols-3 gap-1 rounded-lg bg-white dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.06] p-1">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="h-8 rounded-md flex items-center justify-center gap-1.5 text-[11px] font-semibold transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          :class="props.activeTab === tab.key ? 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.04]'"
          @click="setTab(tab.key)"
        >
          <AppIcon :name="tab.icon" :size="13" />
          <span>{{ tab.label }}</span>
        </button>
      </div>
    </div>

    <template v-if="props.activeTab === 'chat'">
      <div class="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-slate-200 dark:border-white/[0.05]">
        <span class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">对话</span>
        <button
          class="ml-auto flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-400/15 hover:bg-emerald-100 dark:hover:bg-emerald-400/15 cursor-pointer transition-colors"
          title="新对话"
          @click="emit('new-session')"
        >
          <AppIcon name="plus" :size="13" />
          新对话
        </button>
      </div>

      <div class="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-white/[0.04]">
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索对话..."
          class="w-full px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 bg-white dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.06] rounded-lg focus:outline-none focus:border-emerald-400/30 placeholder:text-slate-400 dark:placeholder:text-slate-600 transition-colors"
        />
      </div>

      <div class="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        <div v-if="props.loading && !props.sessions.length" class="px-2 py-6 text-center text-xs text-slate-400 dark:text-slate-600">加载中...</div>
        <div v-else-if="!filtered.length" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">
          {{ keyword ? '没有匹配的对话' : '暂无历史对话' }}
        </div>

        <div
          v-for="s in chatSessions"
          :key="s.id"
          class="group relative mb-0.5 rounded-lg cursor-pointer transition-colors"
          :class="s.id === props.activeId ? 'bg-emerald-50 dark:bg-emerald-400/10 border border-emerald-200 dark:border-emerald-400/15' : 'border border-transparent hover:bg-slate-100 dark:hover:bg-white/[0.04]'"
          @click="renamingId === s.id ? null : emit('select', s.id)"
        >
          <div class="px-2.5 py-2">
            <input
              v-if="renamingId === s.id"
              :ref="(el) => focusRename(el, s.id)"
              v-model="renameText"
              type="text"
              class="w-full px-1.5 py-0.5 text-xs text-slate-700 dark:text-slate-200 bg-white dark:bg-[#0b0f19] border border-emerald-300 dark:border-emerald-400/30 rounded focus:outline-none"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="renamingId = null"
              @blur="commitRename"
            />
            <div v-else class="flex items-center gap-1.5">
              <span v-if="s.entry === 'task'" class="shrink-0 text-amber-500 dark:text-amber-400" title="任务会话"><AppIcon name="save" :size="11" /></span>
              <span class="text-xs font-medium truncate" :class="s.id === props.activeId ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-200'">{{ s.title || '新对话' }}</span>
              <span v-if="s.awaitingApproval" class="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">待确认</span>
              <span v-if="s.running" class="shrink-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 animate-pulse">运行中</span>
            </div>

            <div v-if="renamingId !== s.id" class="flex items-center gap-1.5 mt-0.5">
              <span class="text-[10px] text-slate-400 dark:text-slate-600 shrink-0">{{ relTime(s.updatedAt) }}</span>
              <span v-if="s.preview" class="text-[10px] text-slate-400 dark:text-slate-600 truncate">· {{ s.preview }}</span>
            </div>
          </div>

          <div v-if="renamingId !== s.id" class="absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5">
            <button class="w-6 h-6 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-white dark:hover:bg-white/[0.06] transition-colors cursor-pointer" title="重命名" @click.stop="startRename(s)">
              <AppIcon name="pen" :size="12" />
            </button>
            <button class="w-6 h-6 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-white dark:hover:bg-white/[0.06] transition-colors cursor-pointer" title="删除" @click.stop="emit('delete', s.id)">
              <AppIcon name="close" :size="12" />
            </button>
          </div>
        </div>
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
        <div v-if="activeFileFocus" class="mt-2 rounded-lg border border-emerald-200 dark:border-emerald-400/15 bg-emerald-50/70 dark:bg-emerald-400/8 px-2.5 py-2">
          <div class="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            <AppIcon name="wrench" :size="12" />
            <span class="truncate">{{ activeFileFocus.action || activeFileFocus.toolName || 'Agent 文件操作' }}</span>
            <span
              v-if="focusStatusLabel"
              class="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none"
              :class="focusStatusClass"
            >{{ focusStatusLabel }}</span>
          </div>
          <div class="mt-1 text-[10px] text-emerald-700/70 dark:text-emerald-300/70 truncate" :title="focusDetail">{{ focusDetail }}</div>
        </div>
      </div>

      <div class="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-white/[0.04]">
        <div class="flex gap-1.5 overflow-x-auto pb-0.5">
          <button
            class="h-7 px-2 rounded-md text-[11px] border transition-colors cursor-pointer whitespace-nowrap"
            :class="fileHostId === 'local' ? 'border-emerald-300 dark:border-emerald-400/25 bg-emerald-50 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-white/[0.04]'"
            @click="selectHost('local')"
          >本机</button>
          <button
            v-for="host in hostList"
            :key="host.id"
            class="h-7 px-2 rounded-md text-[11px] border transition-colors cursor-pointer whitespace-nowrap max-w-28 truncate"
            :class="fileHostId === host.id ? 'border-emerald-300 dark:border-emerald-400/25 bg-emerald-50 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300' : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-white/[0.04]'"
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
            :class="isFocusedItem(item) ? 'border-emerald-300 dark:border-emerald-400/25 bg-emerald-50 dark:bg-emerald-400/10' : 'border-transparent hover:bg-white dark:hover:bg-white/[0.04]'"
            @click="onFileClick(item)"
          >
            <AppIcon :name="item.isDir || item.isDrive ? 'folder' : 'file'" :size="14" :class="item.isDir || item.isDrive ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'" />
            <span class="min-w-0 flex-1 truncate text-xs" :class="isFocusedItem(item) ? 'text-emerald-700 dark:text-emerald-300 font-semibold' : 'text-slate-700 dark:text-slate-200'">{{ item.name }}</span>
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
