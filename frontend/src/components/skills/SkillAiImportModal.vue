<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { ApiError, useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';

interface Props { open: boolean }
interface ImportedSkill {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}
interface SkillAiImportResponse {
  ok: boolean;
  skill?: ImportedSkill;
  proposal?: {
    targetId?: string;
    compatibility?: string;
    recommended?: boolean;
    warnings?: string[];
    report?: string;
  };
  error?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const phase = ref<'input' | 'done'>('input');
const repoUrl = ref('');
const statusText = ref('');
const importedSkill = ref<ImportedSkill | null>(null);
const warnings = ref<string[]>([]);
const importing = ref(false);

const busy = computed(() => importing.value);

watch(() => props.open, (now) => {
  if (!now) return;
  reset();
});

function reset(): void {
  phase.value = 'input';
  repoUrl.value = '';
  statusText.value = '';
  importedSkill.value = null;
  warnings.value = [];
  importing.value = false;
}

function close(): void {
  if (busy.value) return;
  emit('update:open', false);
}

function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

async function importSkill(): Promise<void> {
  const url = repoUrl.value.trim();
  if (!url) {
    notify.error('请粘贴 GitHub 链接');
    return;
  }

  importing.value = true;
  statusText.value = '正在拉取仓库、读取 SKILL.md，并由 AI 适配为 1Shell Skill...';
  warnings.value = [];
  importedSkill.value = null;
  try {
    const data = await requestJson<SkillAiImportResponse>('/api/skills/ai-import', {
      method: 'POST',
      body: JSON.stringify({ repoUrl: url }),
    });
    if (!data.ok) throw new Error(data.error || 'AI 导入失败');

    importedSkill.value = data.skill || null;
    warnings.value = data.proposal?.warnings || [];
    const name = data.skill?.name || data.skill?.id || data.proposal?.targetId || 'Skill';
    const compatibility = data.proposal?.compatibility ? `\n兼容性：${data.proposal.compatibility}` : '';
    const report = data.proposal?.report ? `\n${data.proposal.report}` : '';
    statusText.value = `导入成功：${name}${compatibility}${report}`;
    notify.success('Skill 已由 AI 导入');
    emit('saved');
    phase.value = 'done';
  } catch (err) {
    const msg = errorMessage(err, 'AI 导入失败');
    statusText.value = msg;
    notify.error(msg, 6000);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    @click="onBackdrop"
  >
    <div class="bg-white dark:bg-[#0f172a] rounded-2xl border border-slate-200 dark:border-[#1e293b] w-[560px] max-h-[82vh] overflow-hidden shadow-2xl flex flex-col text-slate-700 dark:text-slate-200">
      <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center">
        <span class="text-sm font-semibold flex-1 inline-flex items-center gap-1.5">
          <AppIcon name="robot" :size="14" />
          <span>AI 导入 Skill</span>
        </span>
        <button class="text-xl text-slate-400 hover:text-red-500 disabled:opacity-50" :disabled="busy" @click="close">✕</button>
      </div>

      <div class="p-5 flex flex-col gap-3 overflow-auto">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-500">GitHub 仓库链接</span>
          <input
            v-model="repoUrl"
            class="fld"
            :disabled="phase === 'done' || busy"
            placeholder="https://github.com/owner/skill-repo"
            @keydown.enter.prevent="importSkill"
          />
        </label>

        <div v-if="importedSkill" class="text-[11px] p-3 rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <div class="font-semibold">{{ importedSkill.name || importedSkill.id }}</div>
          <div v-if="importedSkill.description" class="mt-1 text-[10px] opacity-80">{{ importedSkill.description }}</div>
        </div>

        <div v-if="warnings.length" class="text-[11px] p-3 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          <div v-for="warning in warnings" :key="warning">{{ warning }}</div>
        </div>

        <div
          v-if="statusText"
          class="text-[11px] p-3 rounded-lg bg-slate-50 dark:bg-[#1e293b] text-slate-700 dark:text-slate-200 font-mono whitespace-pre-wrap max-h-[180px] overflow-auto"
        >{{ statusText }}</div>
      </div>

      <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex gap-2">
        <button class="flex-1 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#1e293b] disabled:opacity-50" :disabled="busy" @click="close">
          {{ phase === 'done' ? '完成' : '取消' }}
        </button>
        <button
          v-if="phase === 'input'"
          class="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-60"
          :disabled="busy"
          @click="importSkill"
        >{{ importing ? '导入中...' : 'AI 导入' }}</button>
      </div>
    </div>
  </div>
</template>
