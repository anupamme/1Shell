<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import SecretRefPicker from '@/components/SecretRefPicker.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useIdeChat } from '@/composables/useIdeChat';
import { useNotifyStore } from '@/stores/notify';
import {
  type AiTaskInfo,
  type AiTaskInput,
  type AiTaskRun,
  type AiTaskRunPrepareResponse,
  type AiTaskRunsResponse,
  type AiTasksListResponse,
} from '@/utils/aiTasks';
import type { HostInfo, HostsListResponse } from '@/utils/scripts';
import ScriptsView from '@/views/ScriptsView.vue';

type FeatureTab = 'tasks' | 'programs';
type RunValue = string | number | boolean;

const route = useRoute();
const router = useRouter();
const { requestJson } = useApiClient();
const notify = useNotifyStore();
const { confirm } = useConfirm();

const tabs: Array<{ key: FeatureTab; label: string; icon: string; title: string }> = [
  { key: 'tasks', label: 'AI 任务', icon: 'spark', title: '由 1Shell AI 执行的可复用任务入口' },
  { key: 'programs', label: '程序', icon: 'terminal', title: '纯代码脚本与工具' },
];

const activeTab = ref<FeatureTab>(route.query.tab === 'programs' ? 'programs' : 'tasks');
const tasks = shallowRef<AiTaskInfo[]>([]);
const hosts = ref<HostInfo[]>([]);
const runs = shallowRef<AiTaskRun[]>([]);
const keyword = ref('');
const currentId = ref<string | null>(null);
const loading = ref(false);
const deleting = ref(false);
const preparingRun = ref(false);
const runValues = ref<Record<string, RunValue>>({});
const activeRun = ref<AiTaskRun | null>(null);
const definitionOpen = ref(false);
const taskRepairAuthorization = ref<{ taskId: string; runId: number | string } | null>(null);

const currentTask = computed(() => {
  if (!currentId.value) return null;
  return tasks.value.find((task) => task.id === currentId.value) || null;
});

const hostInput = computed<AiTaskInput | null>(() => {
  const inputs = currentTask.value?.inputs || [];
  return inputs.find((input) => String(input.type || '').toLowerCase() === 'host')
    || inputs.find((input) => /(^|[_-])host($|[_-])|目标主机|主机/i.test(`${input.key} ${input.label}`))
    || null;
});

const businessInputs = computed(() => {
  const hostKey = hostInput.value?.key;
  return (currentTask.value?.inputs || []).filter((input) => input.key !== hostKey);
});

const selectedHostLabel = computed(() => {
  const input = hostInput.value;
  if (!input) return '';
  const value = String(runValues.value[input.key] || '');
  if (!value) return '';
  if (value === 'local') return '本机';
  const host = hosts.value.find((item) => item.id === value);
  return host?.name || value;
});

const filteredTasks = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return tasks.value;
  return tasks.value.filter((task) => {
    const hay = `${task.name || ''} ${task.description || ''} ${(task.inputs || []).map((i) => `${i.key} ${i.label}`).join(' ')} ${(task.steps || []).map((s) => `${s.title} ${s.instruction}`).join(' ')}`.toLowerCase();
    return hay.includes(kw);
  });
});

const canExecute = computed(() => Boolean(currentTask.value && !preparingRun.value && !taskAi.isRunning.value));

const taskAi = useIdeChat({
  sessionPrefix: 'task-run',
  approvalMode: 'delegated',
  context: () => ({
    module: '功能 / AI 任务',
    moduleHint: '当前在 AI 任务执行面板。任务只是 1Shell AI 的下级工具和数据，执行仍由纯 1Shell AI agent 完成。',
    taskRun: true,
    taskId: currentTask.value?.id || '',
    taskName: currentTask.value?.name || '',
    taskRunId: activeRun.value?.id || null,
    taskRepairAuthorized: Boolean(taskRepairAuthorization.value),
    taskRepairTaskId: taskRepairAuthorization.value?.taskId || '',
    taskRepairRunId: taskRepairAuthorization.value?.runId || '',
  }),
  messagePayload: () => ({
    entry: 'task_run',
    approvalMode: 'delegated',
    taskRepairAuthorized: Boolean(taskRepairAuthorization.value),
    taskRepairTaskId: taskRepairAuthorization.value?.taskId || '',
  }),
});

function setTab(tab: FeatureTab): void {
  activeTab.value = tab;
  void router.replace({ query: { ...route.query, tab } });
}

watch(
  () => route.query.tab,
  (tab) => {
    activeTab.value = tab === 'programs' ? 'programs' : 'tasks';
  },
);

watch(
  () => route.query.task,
  (taskId) => {
    if (typeof taskId !== 'string' || !taskId) return;
    if (tasks.value.some((task) => task.id === taskId)) selectTask(taskId, { syncRoute: false });
  },
);

async function loadTasks(): Promise<void> {
  loading.value = true;
  try {
    const resp = await requestJson<AiTasksListResponse>('/api/ai-tasks');
    tasks.value = Array.isArray(resp.tasks) ? resp.tasks : [];
    const requestedTaskId = typeof route.query.task === 'string' ? route.query.task : '';
    if (requestedTaskId && tasks.value.some((task) => task.id === requestedTaskId)) {
      selectTask(requestedTaskId, { syncRoute: false });
    } else if (!currentId.value && tasks.value.length > 0) {
      selectTask(tasks.value[0].id);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    loading.value = false;
  }
}

async function loadHosts(): Promise<void> {
  try {
    const resp = await requestJson<HostsListResponse>('/api/hosts');
    hosts.value = Array.isArray(resp.hosts) ? resp.hosts : [];
  } catch {
    hosts.value = [];
  }
}

async function loadRuns(taskId = currentId.value): Promise<void> {
  if (!taskId) {
    runs.value = [];
    return;
  }
  try {
    const resp = await requestJson<AiTaskRunsResponse>(`/api/ai-tasks/${encodeURIComponent(taskId)}/runs?limit=12`);
    runs.value = Array.isArray(resp.runs) ? resp.runs : [];
  } catch {
    runs.value = [];
  }
}

function selectTask(id: string, { syncRoute = true } = {}): void {
  const task = tasks.value.find((item) => item.id === id);
  if (!task) return;
  currentId.value = id;
  definitionOpen.value = false;
  resetRunValues(task);
  void loadRuns(id);
  if (syncRoute) void router.replace({ query: { ...route.query, tab: 'tasks', task: id } });
}

function resetRunValues(task = currentTask.value): void {
  const values: Record<string, RunValue> = {};
  for (const input of task?.inputs || []) {
    values[input.key] = defaultRunValue(input);
  }
  runValues.value = values;
}

function defaultRunValue(input: AiTaskInput): RunValue {
  if (input.default !== undefined && input.default !== null && input.default !== '') return input.default as RunValue;
  if (input.type === 'boolean') return false;
  return '';
}

function startTaskAuthoring(): void {
  void router.push({ path: '/ide', query: { taskAuthoring: '1' } });
}

async function deleteCurrentTask(): Promise<void> {
  const task = currentTask.value;
  if (!task) return;

  const ok = await confirm({
    title: '确认删除 AI 任务',
    message: `此操作会同时删除任务运行记录，确定要删除"${task.name}"吗？`,
    okText: '确认删除',
  });
  if (!ok) return;

  deleting.value = true;
  try {
    await requestJson(`/api/ai-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
    tasks.value = tasks.value.filter((item) => item.id !== task.id);
    currentId.value = tasks.value[0]?.id || null;
    if (currentId.value) {
      selectTask(currentId.value);
    } else {
      runs.value = [];
      runValues.value = {};
    }
    notify.success('任务已删除');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    deleting.value = false;
  }
}

function runTextValue(key: string): string {
  const value = runValues.value[key];
  return value == null ? '' : String(value);
}

function setRunTextValue(key: string, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  runValues.value = { ...runValues.value, [key]: target.value };
}

function runBooleanValue(key: string): boolean {
  const value = runValues.value[key];
  return value === true || value === 'true' || value === '1' || value === 1;
}

function setRunBooleanValue(key: string, event: Event): void {
  const target = event.target as HTMLInputElement;
  runValues.value = { ...runValues.value, [key]: target.checked };
}

function setSecretRef(input: AiTaskInput, secretRef: string): void {
  runValues.value = { ...runValues.value, [input.key]: secretRef };
}

function displaySecretValue(input: AiTaskInput): string {
  const value = String(runValues.value[input.key] || '').trim();
  if (!value) return '未选择凭据';
  return value.startsWith('sec_') ? value : '已填写临时凭据';
}

function isMissingInput(input: AiTaskInput): boolean {
  if (!input.required) return false;
  const value = runValues.value[input.key];
  if (input.type === 'boolean') return value === undefined || value === null;
  return value === undefined || value === null || String(value).trim() === '';
}

function validateRunInputs(): boolean {
  const task = currentTask.value;
  if (!task) {
    notify.warn('请先选择一个任务');
    return false;
  }
  for (const input of task.inputs || []) {
    if (isMissingInput(input)) {
      notify.warn(`请填写：${input.label || input.key}`);
      return false;
    }
  }
  return true;
}

async function executeTask(): Promise<void> {
  const task = currentTask.value;
  if (!task || !validateRunInputs()) return;

  taskRepairAuthorization.value = null;
  preparingRun.value = true;
  try {
    const resp = await requestJson<AiTaskRunPrepareResponse>(`/api/ai-tasks/${encodeURIComponent(task.id)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ inputValues: runValues.value }),
    });
    activeRun.value = resp.run;
    tasks.value = tasks.value.map((item) => item.id === task.id
      ? { ...item, runCount: (item.runCount || 0) + 1 }
      : item);
    void loadRuns(task.id);
    taskAi.prefillAndSend(resp.preparedPrompt);
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    preparingRun.value = false;
  }
}

async function finishActiveRun(): Promise<void> {
  const run = activeRun.value;
  if (!run) return;
  const failed = ['出错', '失败', '已停止'].some((text) => taskAi.statusText.value.includes(text));
  const status = failed ? 'failed' : 'completed';
  const summary = lastAssistantText();
  try {
    await requestJson(`/api/ai-task-runs/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, summary }),
    });
    void loadRuns(run.taskId);
  } catch {
    // 运行记录只是 UI 辅助，失败不影响 AI agent 本身的结果展示。
  } finally {
    activeRun.value = null;
  }

  // 任务模式默认替用户审批、不逐步打扰；只有在任务失败时，才弹框询问是否
  // 让同一个 agent 当场分析失败原因并改进 —— 这就是失败自愈的入口。
  if (failed) void offerFailureRecovery(run, summary);
}

async function offerFailureRecovery(run: AiTaskRun, summary: string): Promise<void> {
  if (taskAi.isRunning.value) return; // 避免在自愈轮次里重复弹框
  const taskName = run.taskName || currentTask.value?.name || '该任务';
  const ok = await confirm({
    title: '任务执行失败',
    message: `"${taskName}"没有顺利完成。是否让 1Shell AI 分析失败原因，并尝试改进任务定义或重试？`,
    okText: '让 AI 改进',
    okClass: 'bg-sky-600 hover:bg-sky-700 text-white',
  });
  if (!ok || taskAi.isRunning.value) return;
  taskRepairAuthorization.value = { taskId: run.taskId, runId: run.id };
  const detail = summary ? `\n\n上一轮的结果摘要：\n${summary.slice(0, 2000)}` : '';
  taskAi.prefillAndSend(
    `刚才这次任务执行没有成功。请基于上面的执行记录，分析失败的根本原因：\n`
    + `1) 如果是现场环境/操作问题，在同一台目标主机上修正后重试，尽量达成任务目标；\n`
    + `2) 如果是任务定义本身的缺陷（输入缺失、步骤顺序错误、说明不准确等），`
    + `请用 update_ai_task 直接修正这个任务定义，并说明改了什么、为什么。${detail}`,
  );
}

function lastAssistantText(): string {
  const item = [...taskAi.timeline.value].reverse().find((entry) => entry.kind === 'assistant' && 'text' in entry);
  return item && 'text' in item ? String(item.text || '').slice(0, 12000) : '';
}

function formatRunStatus(status: string): string {
  if (status === 'completed') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  if (status === 'prepared') return '已准备';
  return status || '未知';
}

function formatDate(value?: string): string {
  if (!value) return '';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString();
}

watch(taskAi.isRunning, (running, wasRunning) => {
  if (!running && wasRunning) {
    if (activeRun.value) void finishActiveRun();
    else taskRepairAuthorization.value = null;
  }
});

onMounted(() => {
  void loadTasks();
  void loadHosts();
});

onBeforeUnmount(() => {
  taskAi.dispose();
});
</script>

<template>
  <div class="h-full flex flex-col p-2 gap-2 bg-slate-100 text-slate-900 dark:bg-[#020617] dark:text-slate-100">
    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300 flex items-center justify-center">
          <AppIcon name="wrench" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200">功能</div>
          <div class="text-[11px] text-slate-400">AI 任务与纯代码程序</div>
        </div>
      </div>

      <div class="ml-6 flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0b1324] border border-slate-200 dark:border-[#1e293b]">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          :class="activeTab === tab.key
            ? 'bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-300 shadow-sm'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'"
          :title="tab.title"
          @click="setTab(tab.key)"
        >
          <AppIcon :name="tab.icon" :size="14" />
          <span>{{ tab.label }}</span>
        </button>
      </div>

      <div class="flex-1"></div>
      <button
        v-if="activeTab === 'tasks'"
        type="button"
        class="h-9 px-4 rounded-lg bg-sky-600 text-white text-xs font-semibold shadow-sm hover:bg-sky-700 transition-colors cursor-pointer flex items-center gap-1.5"
        title="到 Panel 中使用 /task 创作新任务"
        @click="startTaskAuthoring"
      >
        <AppIcon name="spark" :size="14" />
        <span>AI 创作任务</span>
      </button>
    </header>

    <ScriptsView v-if="activeTab === 'programs'" embedded />

    <div v-else class="flex-1 min-h-0 flex gap-2">
      <aside class="w-[23rem] shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div class="shrink-0 px-4 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
          <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">AI Tasks</span>
          <span class="text-[10px] text-slate-400">{{ tasks.length }}</span>
        </div>
        <div class="shrink-0 p-2.5 border-b border-slate-100 dark:border-[#1e293b]">
          <label class="sr-only" for="task-search">搜索任务</label>
          <input
            id="task-search"
            v-model="keyword"
            type="text"
            placeholder="搜索任务..."
            class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-100"
          />
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-2">
          <div v-if="loading" class="p-4 text-xs text-slate-400">加载中...</div>
          <button
            v-for="task in filteredTasks"
            :key="task.id"
            type="button"
            class="w-full text-left p-3 rounded-xl border mb-2 transition-colors cursor-pointer"
            :class="currentId === task.id
              ? 'border-sky-300 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-500/10'
              : 'border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] hover:border-sky-200 dark:hover:border-sky-500/30'"
            @click="selectTask(task.id)"
          >
            <div class="flex items-center gap-2">
              <AppIcon name="spark" :size="15" class="text-sky-500" />
              <span class="min-w-0 flex-1 truncate text-sm font-bold text-slate-700 dark:text-slate-200">{{ task.name }}</span>
            </div>
            <div class="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
              {{ task.description || '无说明' }}
            </div>
            <div class="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
              <span>{{ task.inputs.length }} 个输入</span>
              <span>{{ task.steps.length }} 个步骤</span>
              <span class="ml-auto">{{ task.runCount || 0 }} 次</span>
            </div>
          </button>

          <div v-if="!loading && filteredTasks.length === 0" class="p-6 text-center text-xs text-slate-400">
            暂无 AI 任务
          </div>
        </div>
        <div class="shrink-0 px-3 py-2 border-t border-slate-100 dark:border-[#1e293b] text-[10px] text-slate-400">
          共 <b class="text-slate-600 dark:text-slate-300">{{ filteredTasks.length }}</b> 个任务
        </div>
      </aside>

      <main class="w-[44%] min-w-[31rem] shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div v-if="!currentTask" class="flex-1 grid place-items-center text-center p-8">
          <div>
            <div class="mx-auto w-12 h-12 rounded-xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300 flex items-center justify-center">
              <AppIcon name="spark" :size="24" />
            </div>
            <div class="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">还没有可运行任务</div>
            <button
              type="button"
              class="mt-4 h-9 px-4 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 transition-colors cursor-pointer"
              @click="startTaskAuthoring"
            >
              到 Panel 创作
            </button>
          </div>
        </div>

        <template v-else>
          <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-base font-bold text-slate-800 dark:text-slate-100 truncate">{{ currentTask.name }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                  {{ currentTask.description || '无说明' }}
                </div>
                <div class="text-[10px] text-slate-400 mt-2 font-mono truncate">{{ currentTask.id }}</div>
              </div>
              <button
                type="button"
                class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-sky-300 hover:text-sky-600 transition-colors cursor-pointer"
                @click="definitionOpen = !definitionOpen"
              >
                {{ definitionOpen ? '收起定义' : '查看定义' }}
              </button>
              <button
                type="button"
                class="h-8 px-3 rounded-lg border border-red-200 dark:border-red-500/30 text-xs font-semibold text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50"
                :disabled="deleting"
                @click="deleteCurrentTask"
              >
                删除
              </button>
            </div>
          </div>

          <div class="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
            <section v-if="hostInput" class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3">
              <label :for="`run-${hostInput.key}`" class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                {{ hostInput.label || '目标主机' }}
                <span v-if="hostInput.required" class="text-red-500">*</span>
              </label>
              <select
                :id="`run-${hostInput.key}`"
                :value="runTextValue(hostInput.key)"
                class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-100"
                @change="setRunTextValue(hostInput.key, $event)"
              >
                <option value="">选择主机</option>
                <option value="local">本机</option>
                <option v-for="host in hosts" :key="host.id" :value="host.id">{{ host.name || host.id }}</option>
              </select>
            </section>

            <section v-if="businessInputs.length > 0" class="flex flex-col gap-3">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">输入</div>
              <div
                v-for="input in businessInputs"
                :key="input.key"
                class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3"
              >
                <label :for="`run-${input.key}`" class="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {{ input.label || input.key }}
                  <span v-if="input.required" class="text-red-500 ml-0.5">*</span>
                </label>
                <div v-if="input.help || input.placeholder" class="text-[11px] text-slate-400 mt-0.5">
                  {{ input.help || input.placeholder }}
                </div>

                <select
                  v-if="input.type === 'select'"
                  :id="`run-${input.key}`"
                  :value="runTextValue(input.key)"
                  class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-100"
                  @change="setRunTextValue(input.key, $event)"
                >
                  <option value="">选择</option>
                  <option v-for="option in input.options || []" :key="option.value" :value="option.value">{{ option.label || option.value }}</option>
                </select>

                <label v-else-if="input.type === 'boolean'" class="mt-2 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2 cursor-pointer">
                  <input :checked="runBooleanValue(input.key)" type="checkbox" class="accent-sky-600" @change="setRunBooleanValue(input.key, $event)" />
                  启用
                </label>

                <div v-else-if="input.type === 'secret'" class="mt-2">
                  <div class="h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] text-xs text-slate-500 dark:text-slate-300 flex items-center">
                    {{ displaySecretValue(input) }}
                  </div>
                  <SecretRefPicker :secret-name="input.key" :label="input.label" @submit="(secretRef) => setSecretRef(input, secretRef)" />
                </div>

                <textarea
                  v-else-if="input.type === 'textarea'"
                  :id="`run-${input.key}`"
                  :value="runTextValue(input.key)"
                  rows="3"
                  class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-100 resize-y"
                  :placeholder="input.placeholder || ''"
                  @input="setRunTextValue(input.key, $event)"
                />

                <input
                  v-else
                  :id="`run-${input.key}`"
                  :value="runTextValue(input.key)"
                  :type="input.type === 'number' ? 'number' : 'text'"
                  class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-100"
                  :placeholder="input.placeholder || ''"
                  @input="setRunTextValue(input.key, $event)"
                />
              </div>
            </section>

            <section class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">执行方式</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    由 1Shell AI agent 读取任务定义和输入后执行；任务本身不拥有独立 AI 内核。
                  </div>
                </div>
                <div v-if="selectedHostLabel" class="shrink-0 text-[11px] text-slate-400 max-w-40 truncate" :title="selectedHostLabel">
                  {{ selectedHostLabel }}
                </div>
              </div>
              <button
                type="button"
                class="mt-3 w-full h-10 rounded-xl bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                :disabled="!canExecute"
                @click="executeTask"
              >
                <AppIcon name="play-square" :size="16" />
                <span>{{ preparingRun ? '准备中...' : taskAi.isRunning.value ? '执行中...' : '运行' }}</span>
              </button>
            </section>

            <section class="flex flex-col gap-2">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">流程</div>
              <div v-if="currentTask.steps.length === 0" class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3 text-xs text-slate-400">
                此任务没有固定流程卡片，执行时由 1Shell AI 根据说明拆分步骤。
              </div>
              <div
                v-for="(step, index) in currentTask.steps"
                :key="`${step.title}-${index}`"
                class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3"
              >
                <div class="flex items-center gap-2">
                  <span class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-500 dark:text-slate-300 flex items-center justify-center">{{ index + 1 }}</span>
                  <span class="min-w-0 flex-1 text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">{{ step.title || `步骤 ${index + 1}` }}</span>
                </div>
                <div v-if="step.instruction" class="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {{ step.instruction }}
                </div>
              </div>
            </section>

            <section v-if="definitionOpen" class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] p-3">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">任务定义快照</div>
              <pre class="mt-2 max-h-72 overflow-auto text-[11px] leading-5 text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{{ JSON.stringify(currentTask, null, 2) }}</pre>
            </section>
          </div>
        </template>
      </main>

      <aside class="flex-1 min-w-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b] flex items-start gap-3">
          <AppIcon name="terminal" :size="18" class="mt-0.5 text-sky-500" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-bold text-slate-700 dark:text-slate-200">结果</div>
            <div class="text-[11px] text-slate-400 mt-0.5 truncate">
              {{ taskAi.isRunning.value ? '1Shell AI 正在执行任务' : taskAi.statusText.value || '运行后这里会出现进度和结果' }}
            </div>
          </div>
          <button
            v-if="taskAi.isRunning.value"
            type="button"
            class="h-8 px-3 rounded-lg border border-red-200 dark:border-red-500/30 text-xs font-semibold text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
            @click="taskAi.stop"
          >
            停止
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-4">
          <div v-if="taskAi.hasMessages.value">
            <IdeAgentTimeline :items="taskAi.timeline.value" density="compact" />
          </div>
          <div v-else class="h-full min-h-[360px] grid place-items-center text-center text-xs text-slate-400">
            <div>
              <AppIcon name="robot" :size="34" class="mx-auto mb-2 text-slate-400 opacity-60" />
              <div>等待任务执行</div>
            </div>
          </div>
        </div>

        <div class="shrink-0 border-t border-slate-100 dark:border-[#1e293b] p-3">
          <div class="flex items-center justify-between text-[11px] text-slate-400 mb-2">
            <span>最近运行</span>
            <span>{{ runs.length }} 条</span>
          </div>
          <div class="max-h-28 overflow-y-auto space-y-1">
            <div v-for="run in runs" :key="run.id" class="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span
                class="w-1.5 h-1.5 rounded-full"
                :class="run.status === 'failed' ? 'bg-red-500' : run.status === 'completed' ? 'bg-emerald-500' : 'bg-sky-500'"
              ></span>
              <span class="w-14 truncate">{{ formatRunStatus(run.status) }}</span>
              <span class="min-w-0 flex-1 truncate">{{ formatDate(run.createdAt) }}</span>
            </div>
            <div v-if="runs.length === 0" class="text-[11px] text-slate-400">暂无运行记录</div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
