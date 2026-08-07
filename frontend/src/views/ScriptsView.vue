<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import ScriptDetail from '@/components/scripts/ScriptDetail.vue';
import ScriptList from '@/components/scripts/ScriptList.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import { useNotifyStore } from '@/stores/notify';
import { deepClone, makeDraftScript, type ScriptInfo, type ScriptsListResponse } from '@/utils/scripts';

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const { confirm } = useConfirm();

interface ScriptsPrefs {
  currentId: string | null;
  keyword: string;
  activeTag: string;
}

const SCRIPTS_PREFS_KEY = '1shell.scripts.prefs.v2';
const SCRIPTS_CACHE_KEY = 'scripts.page.cache.v2';
const SCRIPTS_CACHE_TTL_MS = 45_000;
const savedPrefs = readStorageState<ScriptsPrefs>(SCRIPTS_PREFS_KEY, {
  currentId: null,
  keyword: '',
  activeTag: '',
});

const scripts = shallowRef<ScriptInfo[]>([]);
const currentId = ref<string | null>(savedPrefs.currentId);
const currentDraft = ref<ScriptInfo | null>(null);
const isNew = ref(false);
const keyword = ref(savedPrefs.keyword);
const activeTag = ref(savedPrefs.activeTag);
const saving = ref(false);

function savePrefs(): void {
  writeStorageState<ScriptsPrefs>(SCRIPTS_PREFS_KEY, {
    currentId: currentId.value,
    keyword: keyword.value,
    activeTag: activeTag.value,
  });
}

function saveCache(): void {
  setCachedPageState<ScriptInfo[]>(SCRIPTS_CACHE_KEY, scripts.value);
}

function syncCurrentDraft(): void {
  if (!currentId.value || isNew.value) return;
  const current = scripts.value.find((s) => s.id === currentId.value);
  currentDraft.value = current ? deepClone(current) : null;
  if (!current) currentId.value = null;
}

function restoreCache(): boolean {
  const entry = getCachedPageState<ScriptInfo[]>(SCRIPTS_CACHE_KEY);
  if (!entry) return false;
  scripts.value = entry.value || [];
  syncCurrentDraft();
  return true;
}

// 所有脚本用过的标签，带出现次数，供左侧筛选
const allTags = computed(() => {
  const counts = new Map<string, number>();
  for (const s of scripts.value) {
    for (const tag of s.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
});

const visibleCount = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return scripts.value.filter((s) => {
    if (activeTag.value && !(s.tags || []).includes(activeTag.value)) return false;
    if (!kw) return true;
    const hay = `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
    return hay.includes(kw);
  }).length;
});

async function loadScripts(): Promise<void> {
  try {
    const resp = await requestJson<ScriptsListResponse>('/api/scripts');
    scripts.value = Array.isArray(resp.scripts) ? resp.scripts : [];
    syncCurrentDraft();
    saveCache();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
    scripts.value = [];
  }
}

function selectScript(id: string): void {
  const s = scripts.value.find((x) => x.id === id);
  if (!s) return;
  currentId.value = id;
  isNew.value = false;
  currentDraft.value = deepClone(s);
  savePrefs();
}

function newScript(): void {
  currentId.value = null;
  isNew.value = true;
  currentDraft.value = makeDraftScript();
  savePrefs();
}

async function onSave(draft: ScriptInfo): Promise<void> {
  if (!draft.name.trim()) { notify.warn('请填写脚本名称'); return; }
  if (!draft.content.trim()) { notify.warn('请填写脚本内容'); return; }

  const body = JSON.stringify({
    name: draft.name,
    description: draft.description || '',
    tags: draft.tags || [],
    content: draft.content,
  });

  saving.value = true;
  try {
    if (isNew.value) {
      const resp = await requestJson<{ ok: boolean; script: ScriptInfo }>('/api/scripts', { method: 'POST', body });
      const saved = resp.script;
      scripts.value = [saved, ...scripts.value];
      isNew.value = false;
      currentId.value = saved.id;
      currentDraft.value = deepClone(saved);
      notify.success('脚本已创建');
    } else if (currentId.value) {
      const resp = await requestJson<{ ok: boolean; script: ScriptInfo }>(
        `/api/scripts/${encodeURIComponent(currentId.value)}`,
        { method: 'PUT', body },
      );
      const saved = resp.script;
      const idx = scripts.value.findIndex((s) => s.id === currentId.value);
      if (idx !== -1) {
        const next = scripts.value.slice();
        next[idx] = saved;
        scripts.value = next;
      }
      currentDraft.value = deepClone(saved);
      notify.success('脚本已保存');
    }
    savePrefs();
    saveCache();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    saving.value = false;
  }
}

async function onDelete(): Promise<void> {
  if (isNew.value || !currentId.value) {
    isNew.value = false;
    currentId.value = null;
    currentDraft.value = null;
    return;
  }
  const target = scripts.value.find((s) => s.id === currentId.value);
  const ok = await confirm({
    title: '确认删除脚本',
    message: `此操作不可撤销，确定要删除脚本"${target?.name || currentId.value}"吗？`,
    okText: '确认删除',
  });
  if (!ok) return;

  try {
    await requestJson(`/api/scripts/${encodeURIComponent(currentId.value)}`, { method: 'DELETE' });
    scripts.value = scripts.value.filter((s) => s.id !== currentId.value);
    currentId.value = null;
    currentDraft.value = null;
    savePrefs();
    saveCache();
    notify.success('脚本已删除');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

async function onCopy(content: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(content);
    notify.success('脚本内容已复制');
  } catch {
    notify.warn('复制失败，请手动选中复制');
  }
}

function toggleTag(tag: string): void {
  activeTag.value = activeTag.value === tag ? '' : tag;
  savePrefs();
}

watch(keyword, savePrefs);

onMounted(() => {
  const restored = restoreCache();
  if (!restored || !isPageStateFresh(SCRIPTS_CACHE_KEY, SCRIPTS_CACHE_TTL_MS)) {
    void loadScripts();
  }
});
</script>

<template>
  <div class="flex flex-col flex-1 min-w-0 h-full p-3 gap-3">
    <header class="shrink-0 h-[52px] flex items-center px-4 bg-shell-panel dark:bg-[#111827] rounded-xl border border-slate-200/80 dark:border-[#1e293b] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-8 h-8 rounded-lg bg-blue-600/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">
          <AppIcon name="terminal" :size="17" />
        </span>
        <div>
          <div class="text-[15px] font-semibold text-slate-800 dark:text-slate-100 leading-tight">脚本库</div>
          <div class="text-[11px] text-slate-500 dark:text-slate-400 leading-tight mt-0.5">存常用脚本，在终端里一键注入；1Shell AI 也能读写和运行它们</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <button
        type="button"
        class="h-8 px-3.5 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-medium shadow-sm transition-colors shrink-0 flex items-center gap-1.5"
        @click="newScript"
      >
        <span class="text-sm leading-none">＋</span>新建脚本
      </button>
    </header>

    <div class="flex-1 min-h-0 flex gap-3">
      <aside class="w-72 shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-xl border border-slate-200/80 dark:border-[#1e293b] shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
        <div class="shrink-0 p-2.5 border-b border-slate-100 dark:border-[#1e293b]">
          <input
            v-model="keyword"
            type="text"
            placeholder="搜索名称、描述、标签…"
            class="w-full h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 transition-shadow"
          />
        </div>

        <div v-if="allTags.length > 0" class="shrink-0 px-2.5 py-2 border-b border-slate-100 dark:border-[#1e293b] flex items-center gap-1 flex-wrap">
          <button
            v-for="[tag, count] in allTags"
            :key="tag"
            type="button"
            class="h-6 px-2.5 rounded-full border text-[10px] font-medium transition-colors"
            :class="activeTag === tag
              ? 'border-blue-300 bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:border-blue-500/30 dark:text-blue-300'
              : 'border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-400 hover:border-blue-300 hover:text-blue-500'"
            @click="toggleTag(tag)"
          >{{ tag }} <span class="opacity-60">{{ count }}</span></button>
        </div>

        <ScriptList
          :scripts="scripts"
          :current-id="currentId"
          :keyword="keyword"
          :active-tag="activeTag"
          @select="selectScript"
          @new="newScript"
        />

        <div class="shrink-0 px-3.5 py-2.5 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
          <span>共 <b class="text-slate-700 dark:text-slate-300">{{ visibleCount }}</b> 个脚本</span>
          <span>按更新时间排序</span>
        </div>
      </aside>

      <main class="flex-1 flex flex-col min-w-0 bg-shell-panel dark:bg-[#111827] rounded-xl border border-slate-200/80 dark:border-[#1e293b] shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
        <ScriptDetail
          :script="currentDraft"
          :is-new="isNew"
          :saving="saving"
          @save="onSave"
          @delete="onDelete"
          @copy="onCopy"
          @new="newScript"
        />
      </main>
    </div>
  </div>
</template>
