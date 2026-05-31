<script setup lang="ts">
// 工具调用进度条 — Claude Code 风格的低调进度卡
// 每个 tool call 一行：● 工具名  状态/耗时
import { computed } from 'vue';

export interface ToolCallItem {
  toolUseId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  durationMs?: number;
}

const props = defineProps<{
  calls: ToolCallItem[];
  compact?: boolean;
}>();

const visible = computed(() => Array.isArray(props.calls) && props.calls.length > 0);

function fmtDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}
</script>

<template>
  <div v-if="visible" class="tool-progress-bar grid gap-1">
    <div
      v-for="call in calls"
      :key="call.toolUseId"
      class="flex items-center gap-2 text-[11px] font-mono leading-none"
    >
      <span
        class="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        :class="{
          'bg-blue-500 animate-pulse': call.status === 'running',
          'bg-emerald-500': call.status === 'done',
          'bg-red-500': call.status === 'error',
        }"
      ></span>
      <span class="text-slate-600 dark:text-slate-300 truncate">{{ call.name }}</span>
      <span
        v-if="call.status === 'running'"
        class="text-slate-400 dark:text-slate-500 italic"
      >…</span>
      <span
        v-else-if="call.status === 'done'"
        class="text-slate-400 dark:text-slate-500"
      >{{ fmtDuration(call.durationMs) }}</span>
      <span
        v-else
        class="text-red-500"
      >失败</span>
    </div>
  </div>
</template>
