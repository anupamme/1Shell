<script setup lang="ts">
import { useNotifyStore } from '@/stores/notify';
const notify = useNotifyStore();

const kindClass: Record<string, string> = {
  info:    'bg-blue-50 text-blue-900 border-blue-200 shadow-blue-950/10 dark:bg-blue-500/15 dark:text-blue-100 dark:border-blue-400/30 dark:shadow-black/30',
  success: 'bg-emerald-50 text-emerald-900 border-emerald-200 shadow-emerald-950/10 dark:bg-emerald-500/15 dark:text-emerald-100 dark:border-emerald-400/30 dark:shadow-black/30',
  warn:    'bg-amber-50 text-amber-950 border-amber-200 shadow-amber-950/10 dark:bg-amber-500/15 dark:text-amber-100 dark:border-amber-400/30 dark:shadow-black/30',
  error:   'bg-rose-50 text-rose-900 border-rose-200 shadow-rose-950/10 dark:bg-rose-500/15 dark:text-rose-100 dark:border-rose-400/30 dark:shadow-black/30',
};
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
    <div
      v-for="t in notify.toasts"
      :key="t.id"
      class="pointer-events-auto cursor-pointer px-3 py-2 rounded-lg border text-sm font-medium leading-5 shadow-lg ring-1 ring-black/5 backdrop-blur break-words dark:ring-white/10"
      :class="kindClass[t.kind]"
      :role="t.kind === 'error' ? 'alert' : 'status'"
      @click="notify.dismiss(t.id)"
    >
      {{ t.text }}
    </div>
  </div>
</template>
