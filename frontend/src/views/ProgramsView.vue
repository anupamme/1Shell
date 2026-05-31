<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useSocket, bindHandlers, type SocketHandler } from '@/composables/useSocket';
import { useNotifyStore } from '@/stores/notify';
import { useConfirm } from '@/composables/useConfirm';

interface InputDef {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'password' | 'text';
  required?: boolean;
  default?: string | number | boolean | null;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}

interface SecretInfo {
  id: string;
  name: string;
  type: string;
  created_at?: string;
  updated_at?: string;
}

interface SecretInputRef {
  secretRef: string;
}

type InputValue = string | boolean | SecretInputRef;

interface ActionDef {
  name: string;
  label?: string;
  inputs?: InputDef[];
  steps?: Array<{ id: string; type: string; label?: string; goal?: string }>;
}

interface ProgramInfo {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  hosts: string | string[];
  inputs?: InputDef[];
  triggers?: Array<{ id: string; type: 'manual' | 'cron'; action: string; schedule?: string }>;
  actions?: Record<string, ActionDef>;
}

interface HostInfo {
  id: string;
  name: string;
}

interface RunRecord {
  id: number;
  program_id: string;
  host_id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  steps_total?: number;
  steps_completed?: number;
  error?: string | null;
}

interface RenderEntry {
  runId: number;
  programId: string;
  hostId: string;
  stepId: string;
  ts: number;
  payload: Record<string, unknown>;
}

interface PhaseEvent {
  runId: number;
  programId: string;
  hostId: string;
  phase: string;
  stepId: string | null;
  status?: string;
  reason?: string;
  ts: number;
}

const { requestJson } = useApiClient();
const socket = useSocket();
const notify = useNotifyStore();
const { confirm } = useConfirm();

const programs = shallowRef<ProgramInfo[]>([]);
const hosts = shallowRef<HostInfo[]>([]);
const activeId = ref<string | null>(null);
const selectedHostId = ref<string>('');
const inputValues = ref<Record<string, InputValue>>({});
const triggering = ref(false);
const currentRunId = ref<number | null>(null);

const recentRuns = shallowRef<RunRecord[]>([]);
const renderEntries = shallowRef<RenderEntry[]>([]);
const phaseEvents = shallowRef<PhaseEvent[]>([]);
const secrets = shallowRef<SecretInfo[]>([]);

const activeProgram = computed<ProgramInfo | null>(() => programs.value.find((p) => p.id === activeId.value) || null);
const allowedHosts = computed<HostInfo[]>(() => {
  const p = activeProgram.value;
  if (!p) return [];
  if (p.hosts === 'all') return hosts.value;
  const allow = new Set(Array.isArray(p.hosts) ? p.hosts : [p.hosts]);
  return hosts.value.filter((h) => allow.has(h.id));
});
const inputDefs = computed<InputDef[]>(() => {
  const p = activeProgram.value;
  if (!p) return [];
  const root = Array.isArray(p.inputs) ? p.inputs : [];
  const firstAction = p.triggers?.find((t) => t.type === 'manual')?.action;
  const action = firstAction ? p.actions?.[firstAction] : undefined;
  const actionInputs = Array.isArray(action?.inputs) ? action.inputs : [];
  return [...root, ...actionInputs];
});
const firstActionName = computed<string>(() => {
  const p = activeProgram.value;
  if (!p) return '';
  return p.triggers?.find((t) => t.type === 'manual')?.action || Object.keys(p.actions || {})[0] || '';
});

const currentRenderEntries = computed<RenderEntry[]>(() => {
  if (!activeId.value || currentRunId.value == null) return [];
  return renderEntries.value.filter((e) => e.programId === activeId.value && e.runId === currentRunId.value);
});

const lastResult = computed<RenderEntry | null>(() => {
  const list = currentRenderEntries.value;
  if (list.length === 0) return null;
  return list[list.length - 1];
});

const currentPhases = computed<PhaseEvent[]>(() => {
  if (!activeId.value || currentRunId.value == null) return [];
  const latest = new Map<string, PhaseEvent>();
  for (const event of phaseEvents.value) {
    if (event.programId !== activeId.value || event.runId !== currentRunId.value) continue;
    latest.set(`${event.stepId || ''}:${event.phase}`, event);
  }
  return [...latest.values()].slice(-12);
});

async function loadPrograms(): Promise<void> {
  try {
    const data = await requestJson<{ programs: ProgramInfo[] }>('/api/programs');
    programs.value = data.programs || [];
    if (!activeId.value && programs.value.length > 0) selectProgram(programs.value[0].id);
  } catch (err) {
    notify.error((err as Error).message || '加载 program 列表失败');
  }
}

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<{ hosts?: HostInfo[] }>('/api/hosts');
    hosts.value = data.hosts || [];
  } catch (err) {
    notify.error((err as Error).message || '加载主机列表失败');
  }
}

async function loadSecrets(): Promise<void> {
  try {
    const data = await requestJson<{ secrets?: SecretInfo[] }>('/api/secrets');
    secrets.value = data.secrets || [];
  } catch (err) {
    notify.error((err as Error).message || '加载凭据失败');
  }
}

async function reload(): Promise<void> {
  try {
    await requestJson('/api/programs/reload', { method: 'POST' });
    await loadPrograms();
    notify.success('已重扫 data/programs/');
  } catch (err) {
    notify.error((err as Error).message || '重扫失败');
  }
}

function selectProgram(id: string): void {
  activeId.value = id;
  currentRunId.value = null;
  inputValues.value = {};
  for (const def of inputDefs.value) {
    if (def.type === 'boolean') inputValues.value[def.name] = typeof def.default === 'boolean' ? def.default : false;
    else if (def.default != null) inputValues.value[def.name] = String(def.default);
    else inputValues.value[def.name] = '';
  }
  const allow = allowedHosts.value;
  selectedHostId.value = allow[0]?.id || '';
  void loadRuns(id);
}

function isEffectivelyRequired(def: InputDef): boolean {
  if (!def.required) return false;
  if (def.type === 'boolean' || def.type === 'select') return def.default == null;
  if (def.default != null) return false;
  return true;
}

function isSecretRefValue(value: unknown): value is SecretInputRef {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as SecretInputRef).secretRef === 'string';
}

function isMissingInput(def: InputDef): boolean {
  const value = inputValues.value[def.name];
  if (!isEffectivelyRequired(def)) return false;
  if (isSecretRefValue(value)) return !value.secretRef;
  if (def.type === 'boolean') return value === undefined || value === null;
  return value === undefined || value === null || String(value).trim() === '';
}

function secretsForInput(def: InputDef): SecretInfo[] {
  return secrets.value.filter((secret) => secret.type === def.name);
}

function selectedSecretId(def: InputDef): string {
  const value = inputValues.value[def.name];
  return isSecretRefValue(value) ? value.secretRef : '';
}

function passwordManualValue(def: InputDef): string {
  const value = inputValues.value[def.name];
  return typeof value === 'string' ? value : '';
}

function setPasswordSecret(def: InputDef, secretId: string): void {
  inputValues.value[def.name] = secretId ? { secretRef: secretId } : '';
}

async function savePasswordSecret(def: InputDef): Promise<void> {
  const value = passwordManualValue(def).trim();
  if (!value) {
    notify.error('请先输入要保存的凭据内容');
    return;
  }
  const defaultName = `${def.label || def.name}`;
  const name = window.prompt('保存为凭据名称', defaultName);
  if (!name) return;
  try {
    const data = await requestJson<{ secret?: SecretInfo }>('/api/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, type: def.name, value }),
    });
    await loadSecrets();
    if (data.secret?.id) inputValues.value[def.name] = { secretRef: data.secret.id };
    notify.success('凭据已保存');
  } catch (err) {
    notify.error((err as Error).message || '保存凭据失败');
  }
}

async function loadRuns(programId: string): Promise<void> {
  try {
    const data = await requestJson<{ runs?: RunRecord[] }>(`/api/programs/${encodeURIComponent(programId)}/runs?limit=10`);
    recentRuns.value = data.runs || [];
  } catch {
    recentRuns.value = [];
  }
}

function resetRunOutput(programId: string): void {
  phaseEvents.value = phaseEvents.value.filter((e) => e.programId !== programId);
  renderEntries.value = renderEntries.value.filter((e) => e.programId !== programId);
}

async function trigger(): Promise<void> {
  const p = activeProgram.value;
  const action = firstActionName.value;
  if (!p || !action) return;
  if (!selectedHostId.value) {
    notify.error('请先选择目标主机');
    return;
  }
  for (const def of inputDefs.value) {
    if (isMissingInput(def)) {
      notify.error(`请填写：${def.label || def.name}`);
      return;
    }
  }
  triggering.value = true;
  currentRunId.value = null;
  resetRunOutput(p.id);
  try {
    const resp = await requestJson<{ runIds?: number[] }>(`/api/programs/${encodeURIComponent(p.id)}/actions/${encodeURIComponent(action)}/run`, {
      method: 'POST',
      body: JSON.stringify({ hostId: selectedHostId.value, inputs: inputValues.value }),
    });
    currentRunId.value = resp.runIds?.[0] ?? currentRunId.value;
    notify.success('已触发');
    await loadRuns(p.id);
  } catch (err) {
    notify.error((err as Error).message || '触发失败');
  } finally {
    triggering.value = false;
  }
}

async function deleteProgram(id: string, name: string): Promise<void> {
  const ok = await confirm({ title: '删除 Program', message: `确认删除「${name}」？\n会删除 data/programs/${id}/ 目录。`, okText: '删除' });
  if (!ok) return;
  try {
    await requestJson(`/api/programs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notify.success('已删除');
    if (activeId.value === id) activeId.value = null;
    await loadPrograms();
  } catch (err) {
    notify.error((err as Error).message || '删除失败');
  }
}

function pushPhase(payload: PhaseEvent): void {
  phaseEvents.value = [...phaseEvents.value, payload].slice(-200);
}

function pushRender(payload: RenderEntry): void {
  if (payload.programId !== activeId.value) return;
  renderEntries.value = [...renderEntries.value, payload].slice(-50);
}

function formatTs(value: string | number | null | undefined): string {
  if (!value) return '—';
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return String(value);
  return new Date(ts).toLocaleString();
}

function statusDot(status: string | null | undefined): string {
  switch (status) {
    case 'success':   return 'bg-emerald-500';
    case 'failed':    return 'bg-red-500';
    case 'cancelled': return 'bg-slate-400';
    case 'running':   return 'bg-blue-500 animate-pulse';
    default:          return 'bg-slate-300';
  }
}

function payloadAsString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const handlers: SocketHandler[] = [
  ['program:run-started', (...args: unknown[]) => {
    const e = args[0] as { runId?: number; programId?: string };
    if (e?.programId === activeId.value) {
      currentRunId.value = typeof e.runId === 'number' ? e.runId : currentRunId.value;
      resetRunOutput(e.programId);
      void loadRuns(activeId.value);
    }
  }],
  ['program:run-ended', (...args: unknown[]) => {
    const e = args[0] as { programId?: string };
    if (e?.programId === activeId.value) void loadRuns(activeId.value);
  }],
  ['program:phase', (...args: unknown[]) => {
    const e = args[0] as PhaseEvent;
    if (!e) return;
    if (e.programId === activeId.value && currentRunId.value == null) currentRunId.value = e.runId;
    pushPhase({ ...e, ts: Date.now() });
  }],
  ['program:render', (...args: unknown[]) => {
    const e = args[0] as { runId: number; programId: string; hostId: string; stepId: string; payload: Record<string, unknown> };
    if (!e) return;
    if (e.programId === activeId.value && currentRunId.value == null) currentRunId.value = e.runId;
    pushRender({ runId: e.runId, programId: e.programId, hostId: e.hostId, stepId: e.stepId, payload: e.payload, ts: Date.now() });
  }],
];

let unbind: (() => void) | null = null;

onMounted(() => {
  unbind = bindHandlers(socket, handlers);
  void Promise.all([loadPrograms(), loadHosts(), loadSecrets()]);
});

onBeforeUnmount(() => {
  if (unbind) unbind();
});
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <!-- Header bar -->
    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">
          <AppIcon name="play-square" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            程序
            <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300 font-semibold">BETA</span>
          </div>
          <div class="text-[11px] text-slate-400">把对智能体的指令打包成可复用模板</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all"
          @click="reload"
        >↻ 重扫</button>
      </div>
    </header>

    <!-- Three-column body -->
    <div class="flex-1 min-h-0 flex gap-2">
      <!-- Left: Program list 20% -->
      <aside class="w-1/5 min-w-[14rem] shrink-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div class="shrink-0 px-4 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
          <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Programs</span>
          <span class="text-[10px] text-slate-400">{{ programs.length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
          <div v-if="programs.length === 0" class="flex flex-col items-center justify-center py-12 text-slate-400 text-xs gap-2">
            <AppIcon name="play-square" :size="32" class="opacity-40" />
            <div>还没有程序</div>
            <div class="text-[10px] opacity-70 text-center px-2">放到 <code class="text-blue-500">data/programs/&lt;id&gt;</code> 后点重扫</div>
          </div>
          <div
            v-for="p in programs"
            :key="p.id"
            class="cursor-pointer rounded-xl border p-3 transition group"
            :class="p.id === activeId
              ? 'border-blue-300 bg-blue-50/60 dark:bg-blue-500/10 dark:border-blue-500/40'
              : 'border-slate-200 bg-white hover:border-blue-200 dark:border-[#1e293b] dark:bg-[#0b1324] dark:hover:border-blue-500/30'"
            @click="selectProgram(p.id)"
          >
            <div class="flex items-center gap-2">
              <div class="text-sm font-bold text-slate-700 dark:text-slate-200 flex-1 min-w-0 truncate">{{ p.name }}</div>
              <button
                class="shrink-0 opacity-0 group-hover:opacity-100 text-[11px] font-medium px-2 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600 dark:border-red-800 dark:text-red-400 transition-all"
                title="删除"
                @click.stop="deleteProgram(p.id, p.name)"
              >删除</button>
            </div>
            <div v-if="p.description" class="text-[11px] text-slate-400 mt-1 line-clamp-2">{{ p.description }}</div>
          </div>
        </div>
        <div class="shrink-0 px-3 py-2 border-t border-slate-100 dark:border-[#1e293b] text-[10px] text-slate-400">
          共 <b class="text-slate-600 dark:text-slate-300">{{ programs.length }}</b> 个程序
        </div>
      </aside>

      <!-- Middle: Detail + inputs 40% -->
      <main class="w-2/5 shrink-0 flex flex-col min-w-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div v-if="!activeProgram" class="flex-1 flex flex-col items-center justify-center text-sm text-slate-400 gap-3">
          <AppIcon name="play-square" :size="40" class="opacity-30" />
          <div>从左侧选择一个程序</div>
        </div>
        <template v-else>
          <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
            <div class="text-base font-bold text-slate-800 dark:text-slate-100">{{ activeProgram.name }}</div>
            <div v-if="activeProgram.description" class="text-xs text-slate-500 dark:text-slate-400 mt-1">{{ activeProgram.description }}</div>
            <div class="text-[10px] text-slate-400 mt-2 font-mono">{{ activeProgram.id }}</div>
          </div>

          <div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
            <!-- Host -->
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3">
              <label class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">目标主机</label>
              <select
                :value="selectedHostId"
                class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                @change="selectedHostId = ($event.target as HTMLSelectElement).value"
              >
                <option v-if="allowedHosts.length === 0" value="">无可选主机</option>
                <option v-for="h in allowedHosts" :key="h.id" :value="h.id">{{ h.name || h.id }}</option>
              </select>
            </div>

            <!-- Input cards -->
            <div v-if="inputDefs.length > 0" class="flex flex-col gap-3">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">输入</div>
              <div
                v-for="def in inputDefs"
                :key="def.name"
                class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-3"
              >
                <label class="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {{ def.label || def.name }}
                  <span v-if="isEffectivelyRequired(def)" class="text-red-500 ml-0.5">*</span>
                </label>
                <div v-if="def.description" class="text-[11px] text-slate-400 mt-0.5">{{ def.description }}</div>

                <select
                  v-if="def.type === 'select'"
                  :value="inputValues[def.name] as string"
                  class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                  @change="inputValues[def.name] = ($event.target as HTMLSelectElement).value"
                >
                  <option v-for="opt in (def.options || [])" :key="opt.value" :value="opt.value">{{ opt.label || opt.value }}</option>
                </select>
                <textarea
                  v-else-if="def.type === 'text'"
                  :value="inputValues[def.name] as string"
                  :placeholder="def.placeholder || ''"
                  class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                  rows="3"
                  @input="inputValues[def.name] = ($event.target as HTMLTextAreaElement).value"
                />
                <label v-else-if="def.type === 'boolean'" class="mt-2 flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    :checked="!!inputValues[def.name]"
                    class="w-4 h-4 rounded border-slate-300 text-blue-500 focus:ring-blue-200"
                    @change="inputValues[def.name] = ($event.target as HTMLInputElement).checked"
                  />
                  <span class="text-xs text-slate-600 dark:text-slate-300">启用</span>
                </label>
                <div v-else-if="def.type === 'password'" class="mt-2 flex flex-col gap-2">
                  <select
                    v-if="secretsForInput(def).length > 0"
                    :value="selectedSecretId(def)"
                    class="w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                    @change="setPasswordSecret(def, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">手动输入</option>
                    <option v-for="secret in secretsForInput(def)" :key="secret.id" :value="secret.id">使用已保存：{{ secret.name }}</option>
                  </select>
                  <div class="flex gap-2">
                    <input
                      :value="passwordManualValue(def)"
                      type="password"
                      :placeholder="selectedSecretId(def) ? '已选择保存的凭据' : (def.placeholder || '')"
                      :disabled="!!selectedSecretId(def)"
                      class="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:opacity-60"
                      @input="inputValues[def.name] = ($event.target as HTMLInputElement).value"
                    />
                    <button
                      type="button"
                      class="shrink-0 px-3 rounded-lg border border-blue-200 text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:border-blue-500/40 dark:text-blue-300 dark:hover:bg-blue-500/10 disabled:opacity-50"
                      :disabled="!!selectedSecretId(def) || !passwordManualValue(def).trim()"
                      @click="savePasswordSecret(def)"
                    >保存</button>
                  </div>
                  <div v-if="selectedSecretId(def)" class="text-[11px] text-emerald-500">运行时将使用已保存凭据，明文不会回显到输入框。</div>
                </div>
                <input
                  v-else
                  :value="inputValues[def.name] as string"
                  :type="def.type === 'number' ? 'number' : 'text'"
                  :placeholder="def.placeholder || ''"
                  class="mt-2 w-full rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#111827] px-3 py-2 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                  @input="inputValues[def.name] = ($event.target as HTMLInputElement).value"
                />
              </div>
            </div>

            <!-- Run button -->
            <button
              class="h-10 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="triggering || !firstActionName || !selectedHostId"
              @click="trigger"
            >{{ triggering ? '触发中...' : '▶ 运行' }}</button>

            <!-- Recent runs -->
            <div v-if="recentRuns.length > 0" class="flex flex-col gap-2">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">最近运行</div>
              <div
                v-for="r in recentRuns"
                :key="r.id"
                class="rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] px-3 py-2 text-[11px]"
              >
                <div class="flex items-center gap-2">
                  <span class="w-1.5 h-1.5 rounded-full" :class="statusDot(r.status)"></span>
                  <span class="font-mono text-slate-600 dark:text-slate-300">#{{ r.id }}</span>
                  <span class="text-slate-400">{{ r.host_id }}</span>
                  <span class="flex-1"></span>
                  <span class="text-slate-400">{{ formatTs(r.started_at) }}</span>
                </div>
                <div v-if="r.error" class="text-red-500 mt-1 truncate">{{ r.error }}</div>
              </div>
            </div>
          </div>
        </template>
      </main>

      <!-- Right: Results 40% -->
      <main class="flex-1 min-w-0 flex flex-col bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
        <div class="shrink-0 px-5 py-4 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200">结果</div>
          <div class="text-[11px] text-slate-400 mt-0.5">实时阶段推进 与 AI 输出</div>
        </div>
        <div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          <div v-if="!activeProgram" class="flex-1 flex flex-col items-center justify-center text-sm text-slate-400 gap-3">
            <AppIcon name="terminal" :size="40" class="opacity-30" />
            <div>先选一个程序</div>
          </div>

          <template v-else>
            <!-- Phases -->
            <div v-if="currentPhases.length > 0" class="flex flex-col gap-2">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">阶段</div>
              <div
                v-for="(e, idx) in currentPhases"
                :key="idx"
                class="rounded-xl border px-3 py-2.5 text-xs"
                :class="e.status === 'failed'
                  ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
                  : e.status === 'done'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
                  : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300'"
              >
                <div class="font-semibold flex items-center gap-2">
                  <span class="w-1.5 h-1.5 rounded-full" :class="e.status === 'failed' ? 'bg-red-500' : e.status === 'done' ? 'bg-emerald-500' : 'bg-blue-500 animate-pulse'"></span>
                  {{ e.phase }}
                  <span v-if="e.stepId" class="ml-auto opacity-60 text-[10px] font-mono">{{ e.stepId }}</span>
                </div>
                <div v-if="e.reason" class="opacity-80 mt-1">{{ e.reason }}</div>
              </div>
            </div>

            <!-- Output -->
            <div v-if="lastResult" class="flex flex-col gap-2">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">最新输出</div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-4">
                <div v-if="lastResult.payload.title" class="text-sm font-bold text-slate-700 dark:text-slate-200">{{ lastResult.payload.title }}</div>
                <div v-if="lastResult.payload.subtitle" class="text-[11px] text-slate-400 mt-0.5">{{ lastResult.payload.subtitle }}</div>
                <pre class="mt-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-700 dark:text-slate-200 font-mono">{{ payloadAsString(lastResult.payload.content || lastResult.payload.output || lastResult.payload.result || lastResult.payload) }}</pre>
              </div>
            </div>

            <div v-if="currentPhases.length === 0 && !lastResult" class="flex-1 flex flex-col items-center justify-center text-sm text-slate-400 gap-3 py-12">
              <AppIcon name="terminal" :size="40" class="opacity-30" />
              <div>运行后这里会出现进度和结果</div>
            </div>
          </template>
        </div>
      </main>
    </div>
  </div>
</template>
