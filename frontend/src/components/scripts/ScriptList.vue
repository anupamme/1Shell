<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { ScriptInfo } from '@/utils/scripts';

interface Props {
  scripts: ScriptInfo[];
  currentId: string | null;
  keyword: string;
  activeTag: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  select: [id: string];
  new: [];
}>();

const filtered = computed<ScriptInfo[]>(() => {
  const kw = props.keyword.trim().toLowerCase();
  return props.scripts.filter((s) => {
    if (props.activeTag && !(s.tags || []).includes(props.activeTag)) return false;
    if (!kw) return true;
    const hay = `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
    return hay.includes(kw);
  });
});
</script>

<template>
  <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
    <div
      v-if="filtered.length === 0"
      class="flex flex-col items-center justify-center py-10 px-4 text-center gap-2"
    >
      <span class="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500 flex items-center justify-center">
        <AppIcon name="terminal" :size="22" />
      </span>
      <div class="text-xs font-medium text-slate-500 dark:text-slate-400">
        {{ scripts.length === 0 ? '还没有脚本' : '没有匹配的脚本' }}
      </div>
      <div class="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed">
        {{ scripts.length === 0 ? '把常用运维命令存成脚本，终端一键注入' : '换个关键词或清除标签筛选试试' }}
      </div>
      <button
        v-if="scripts.length === 0"
        type="button"
        class="mt-1 h-7 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium transition-colors"
        @click="emit('new')"
      >新建第一个脚本</button>
    </div>
    <div
      v-for="s in filtered"
      :key="s.id"
      class="script-card cursor-pointer p-3 rounded-xl border transition-all"
      :class="s.id === currentId
        ? 'border-blue-400 bg-blue-50/70 dark:bg-blue-500/10 dark:border-blue-500/40 shadow-[0_1px_3px_rgba(37,99,235,0.08)]'
        : 'border-slate-200/90 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] hover:border-blue-300 hover:shadow-[0_1px_3px_rgba(15,23,42,0.06)]'"
      @click="emit('select', s.id)"
    >
      <div class="flex items-center gap-2">
        <span class="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
          :class="s.id === currentId
            ? 'bg-blue-600/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300'
            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'"
        >
          <AppIcon name="terminal" :size="13" />
        </span>
        <span class="flex-1 text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">{{ s.name }}</span>
      </div>
      <div v-if="s.description" class="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">{{ s.description }}</div>
      <div class="mt-2 flex items-center gap-1 text-[10px] flex-wrap">
        <span
          v-for="tag in (s.tags || []).slice(0, 3)"
          :key="tag"
          class="px-1.5 py-[3px] rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
        >{{ tag }}</span>
        <span v-if="(s.placeholders || []).length > 0" class="px-1.5 py-[3px] rounded-md bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-300">
          {{ (s.placeholders || []).length }} 个参数
        </span>
      </div>
    </div>
  </div>
</template>
