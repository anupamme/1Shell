<script setup lang="ts">
import { computed } from 'vue';
import type { AiToolCallState } from '@/utils/aiMessages';
import { summarizeToolInput, summarizeToolResult, summarizeToolValue, toolDisplayName } from '@/utils/aiMessages';

export type ToolCallItem = AiToolCallState;

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

function statusLabel(call: ToolCallItem): string {
  if (call.status === 'running') return '运行中';
  if (call.status === 'error') return '失败';
  return fmtDuration(call.durationMs) || '完成';
}

function detailText(value: unknown): string {
  return summarizeToolValue(value, 1600);
}

function inputSummary(call: ToolCallItem): string {
  return summarizeToolInput(call);
}

function resultSummary(call: ToolCallItem): string {
  return summarizeToolResult(call);
}

function hasLogs(call: ToolCallItem): boolean {
  return Boolean(call.logs?.some((item) => item.text));
}

function hasNotes(call: ToolCallItem): boolean {
  return Boolean(call.notes?.some((item) => item.text));
}

function visibleLogs(call: ToolCallItem) {
  return (call.logs || []).filter((item) => item.text).slice(-40);
}

function visibleNotes(call: ToolCallItem) {
  return (call.notes || []).filter((item) => item.text).slice(-12);
}

function latestLogSummary(call: ToolCallItem): string {
  const log = [...(call.logs || [])].reverse().find((item) => item.text.trim());
  if (!log) return '';
  const line = log.text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop() || log.text.trim();
  const text = line.length > 120 ? `${line.slice(0, 120)}…` : line;
  return `${log.stream}: ${text}`;
}

function hasDetail(call: ToolCallItem): boolean {
  return Boolean(hasLogs(call) || detailText(call.input) || detailText(call.result) || call.error);
}
</script>

<template>
  <div v-if="visible" class="tool-progress-bar grid gap-2">
    <div
      v-for="call in calls"
      :key="call.toolUseId"
      class="grid gap-1"
    >
      <details
        :open="call.status === 'running' && hasLogs(call)"
        class="rounded-xl border bg-white/70 text-[11px] shadow-sm transition-colors dark:bg-slate-950/40"
        :class="{
          'border-blue-200 dark:border-blue-500/30': call.status === 'running',
          'border-emerald-200 dark:border-emerald-500/30': call.status === 'done',
          'border-red-200 dark:border-red-500/30': call.status === 'error',
        }"
      >
        <summary class="flex cursor-pointer list-none items-start gap-2 px-3 py-2 font-mono leading-none">
          <span
            class="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
            :class="{
              'bg-blue-500 animate-pulse': call.status === 'running',
              'bg-emerald-500': call.status === 'done',
              'bg-red-500': call.status === 'error',
            }"
          ></span>
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate text-slate-800 dark:text-slate-100">{{ toolDisplayName(call.name) }}</span>
              <span v-if="toolDisplayName(call.name) !== call.name" class="truncate text-[10px] text-slate-400">{{ call.name }}</span>
            </span>
            <span class="mt-1 block truncate text-[10px] leading-snug text-slate-500 dark:text-slate-400">{{ inputSummary(call) }}</span>
            <span v-if="call.status === 'running' && latestLogSummary(call)" class="mt-0.5 block truncate text-[10px] leading-snug text-blue-500 dark:text-blue-300">{{ latestLogSummary(call) }}</span>
            <span v-else-if="call.status !== 'running'" class="mt-0.5 block truncate text-[10px] leading-snug text-slate-400 dark:text-slate-500">{{ resultSummary(call) }}</span>
          </span>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
            :class="{
              'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200': call.status === 'running',
              'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200': call.status === 'done',
              'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200': call.status === 'error',
            }"
          >{{ statusLabel(call) }}</span>
        </summary>

        <div v-if="hasDetail(call)" class="grid gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
        <div v-if="hasLogs(call)">
          <div class="mb-1 flex items-center justify-between font-semibold text-slate-500 dark:text-slate-400">
            <span>Live output</span>
            <span class="text-[10px] font-normal text-slate-400">{{ visibleLogs(call).length }} chunks</span>
          </div>
          <pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100"><template v-for="(log, idx) in visibleLogs(call)" :key="idx"><span :class="log.stream === 'stderr' ? 'text-red-300' : 'text-slate-100'">{{ log.text }}</span></template></pre>
        </div>
        <div v-if="detailText(call.input)">
          <div class="mb-1 font-semibold text-slate-500 dark:text-slate-400">Input</div>
          <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2 font-mono text-[10px] leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-200">{{ detailText(call.input) }}</pre>
        </div>
        <div v-if="detailText(call.result) || call.error">
          <div class="mb-1 font-semibold text-slate-500 dark:text-slate-400">Result</div>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 font-mono text-[10px] leading-relaxed" :class="call.status === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200' : 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200'">{{ call.error || detailText(call.result) }}</pre>
        </div>
      </div>
      </details>
      <div v-if="hasNotes(call)" class="grid gap-1 pl-4">
        <div
          v-for="(note, idx) in visibleNotes(call)"
          :key="idx"
          class="rounded-lg px-2 py-1 text-[10px] leading-relaxed"
          :class="{
            'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200': note.kind === 'error',
            'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200': note.kind === 'success',
            'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200': note.kind === 'info',
            'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-200': note.kind === 'thought',
          }"
        >{{ note.text }}</div>
      </div>
    </div>
  </div>
</template>
