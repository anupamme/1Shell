<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import {
  SKILLS_SLOT_ID,
  UPSTREAM_LABELS,
  PRESET_CATEGORY_LABELS,
  REASONING_EFFORT_OPTIONS,
  type ProviderInfo,
  type ProvidersResponse,
  type ProviderPreset,
  type PresetCategory,
  type ReasoningEffort,
  type UpstreamProtocol,
} from '@/utils/cliSetup';

interface Props {
  open: boolean;
  cliId: string | null;
  cliName?: string;
  supportedUpstream: UpstreamProtocol[];
  launchCommand?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  changed: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const providers = ref<ProviderInfo[]>([]);
const activeProviderId = ref<string | undefined>(undefined);
const loadingList = ref(false);
const listError = ref<string | null>(null);

const editingPid = ref<string | null>(null);
const fName = ref('');
const fUpstream = ref<UpstreamProtocol>('openai');
const fApiBase = ref('');
const fApiKey = ref('');
const fApiKeyPlaceholder = ref('sk-...');
const fModel = ref('');
const fReasoningEffort = ref<ReasoningEffort>('auto');
const fPresetId = ref('');
const statusText = ref('');
const statusOk = ref<boolean | null>(null);
const saving = ref(false);

// Provider preset 库(添加模式下用)
const presetsAll = ref<ProviderPreset[]>([]);
const presetsLoaded = ref(false);
const presetsCollapsed = ref(false);

async function loadPresetsIfNeeded(): Promise<void> {
  if (presetsLoaded.value) return;
  try {
    const resp = await requestJson<{ ok: boolean; presets: ProviderPreset[] }>('/api/agent/provider-presets');
    presetsAll.value = resp.presets || [];
    presetsLoaded.value = true;
  } catch {
    // 静默失败:用户仍能用手填模式
  }
}

const presetsByCategory = computed<Record<PresetCategory, ProviderPreset[]>>(() => {
  const out: Record<PresetCategory, ProviderPreset[]> = { domestic: [], overseas: [], relay: [] };
  for (const p of presetsAll.value) {
    if (!allowedUpstreams.value.includes(p.protocol)) continue;
    out[p.category]?.push(p);
  }
  return out;
});

const presetCategoryEntries = computed<Array<{ id: PresetCategory; label: string; items: ProviderPreset[] }>>(() => (
  (Object.keys(PRESET_CATEGORY_LABELS) as PresetCategory[]).map(id => ({
    id,
    label: PRESET_CATEGORY_LABELS[id],
    items: presetsByCategory.value[id] || [],
  })).filter(group => group.items.length > 0)
));

// 是否在添加模式(编辑现有 provider 时不显示 preset 选择器)
const showPresetPicker = computed(() => !editingPid.value && presetCategoryEntries.value.length > 0);

const activePreset = computed<ProviderPreset | null>(() => {
  if (!fPresetId.value) return null;
  return presetsAll.value.find(p => p.id === fPresetId.value) || null;
});

// 当前 model 是否被识别为 reasoning model(用于 reasoning select 的提示)
const modelLooksReasoning = computed<boolean>(() => {
  const m = (fModel.value || '').toLowerCase();
  if (!m) return false;
  // 复用 reasoning.js 白名单的同名前缀(前端简化版,只用于 UX 提示,后端再次校验)
  const builtinPrefixes = [
    'gpt-5', 'o1', 'o3', 'o4-mini',
    'deepseek-reasoner', 'qwq', 'glm-z1', 'glm-zero',
    'claude-3-7-sonnet', 'claude-3.7-sonnet',
    'claude-opus-4', 'claude-sonnet-4', 'claude-fable-5',
  ];
  const extra = activePreset.value?.reasoningModels || [];
  return [...builtinPrefixes, ...extra].some(p => m.startsWith(p.toLowerCase()));
});

function pickPreset(preset: ProviderPreset): void {
  fPresetId.value = preset.id;
  // 模板类(One-API/New-API)不填 apiBase,让用户自填
  if (!preset.isTemplate) fApiBase.value = preset.apiBase;
  fUpstream.value = preset.protocol;
  if (!fName.value.trim()) fName.value = preset.name;
  fApiKeyPlaceholder.value = preset.apiKeyField ? `请填 ${preset.apiKeyField}` : 'sk-...';
  if (preset.models.length > 0 && !fModel.value.trim()) fModel.value = preset.models[0];
  presetsCollapsed.value = true;
}

function clearPreset(): void {
  fPresetId.value = '';
  presetsCollapsed.value = false;
}

const isSkillsSlot = computed(() => props.cliId === SKILLS_SLOT_ID);
const isCodex = computed(() => props.cliId === 'codex');
const title = computed(() => {
  if (!props.cliId) return '配置 API 代理';
  if (isSkillsSlot.value) return '配置 1Shell AI 引擎';
  return `配置 ${props.cliName || props.cliId} API 渠道`;
});
const subtitle = computed(() => {
  if (isSkillsSlot.value) return '驱动主控台 AI / IDE AgentRun / Skill 执行（支持 OpenAI 兼容 / Anthropic）';
  const labels = (props.supportedUpstream.length ? props.supportedUpstream : (['openai'] as UpstreamProtocol[]))
    .map((u) => UPSTREAM_LABELS[u] || u).join(' / ');
  return `支持上游协议: ${labels}`;
});

const allowedUpstreams = computed<UpstreamProtocol[]>(() => {
  if (isSkillsSlot.value) return ['anthropic', 'openai'];
  return props.supportedUpstream.length ? props.supportedUpstream : ['openai'];
});

const showEnvHint = computed(() => !isSkillsSlot.value && !!props.launchCommand);

const saveBtnText = computed(() => {
  if (saving.value) return '保存中...';
  return editingPid.value ? '保存修改' : '添加渠道';
});

const formLabel = computed(() => {
  if (!editingPid.value) return '添加新渠道';
  const p = providers.value.find((x) => x.id === editingPid.value);
  return `编辑: ${p?.name || '未命名'}`;
});

function close(): void {
  emit('update:open', false);
}

function resetFormToAdd(): void {
  editingPid.value = null;
  fName.value = '';
  fUpstream.value = allowedUpstreams.value[0];
  fApiBase.value = '';
  fApiKey.value = '';
  fApiKeyPlaceholder.value = 'sk-...';
  fModel.value = '';
  fReasoningEffort.value = 'auto';
  fPresetId.value = '';
  presetsCollapsed.value = false;
  statusText.value = '';
  statusOk.value = null;
}

function startEdit(p: ProviderInfo): void {
  editingPid.value = p.id;
  fName.value = p.name || '';
  fUpstream.value = p.upstreamProtocol || 'openai';
  fApiBase.value = p.apiBase || '';
  fApiKey.value = '';
  fApiKeyPlaceholder.value = p.apiKeySet ? (p.apiKey || '已设置') : 'sk-...';
  fModel.value = p.model || '';
  fReasoningEffort.value = (p.reasoningEffort as ReasoningEffort) || 'auto';
  fPresetId.value = p.presetId || '';
  presetsCollapsed.value = true;
  statusText.value = '';
  statusOk.value = null;
}

async function loadProviders(): Promise<void> {
  if (!props.cliId) return;
  loadingList.value = true;
  listError.value = null;
  try {
    const resp = await requestJson<ProvidersResponse>(`/api/agent/providers/${encodeURIComponent(props.cliId)}`);
    providers.value = resp.providers || [];
    activeProviderId.value = resp.activeProviderId;
  } catch (err) {
    listError.value = err instanceof Error ? err.message : String(err);
    providers.value = [];
  } finally {
    loadingList.value = false;
  }
}

async function onSave(): Promise<void> {
  if (!props.cliId) return;
  const body: Record<string, string | boolean | undefined> = {
    name: fName.value.trim() || undefined,
    upstreamProtocol: fUpstream.value,
    apiBase: fApiBase.value.trim(),
    apiKey: fApiKey.value.trim() || undefined,
    model: fModel.value.trim() || undefined,
    reasoningEffort: fReasoningEffort.value,
    presetId: fPresetId.value || '',
    enabled: (editingPid.value ? providers.value.find(p => p.id === editingPid.value) : null)?.enabled,
  };

  if (!body.apiBase) {
    statusText.value = '✗ API 基础地址不能为空';
    statusOk.value = false;
    return;
  }
  if (!editingPid.value && !body.apiKey) {
    statusText.value = '✗ 新渠道必须填写 API Key';
    statusOk.value = false;
    return;
  }

  saving.value = true;
  try {
    if (editingPid.value) {
      await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${editingPid.value}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      statusText.value = '✓ 渠道已更新';
      notify.success('渠道已更新');
    } else {
      await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      statusText.value = '✓ 渠道已添加';
      notify.success('渠道已添加');
    }
    statusOk.value = true;
    await loadProviders();
    emit('changed');
    resetFormToAdd();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusText.value = `✗ 保存失败: ${msg}`;
    statusOk.value = false;
    notify.error(msg, 5000);
  } finally {
    saving.value = false;
  }
}

async function onActivate(pid: string): Promise<void> {
  if (!props.cliId) return;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${pid}/activate`, { method: 'PUT' });
    notify.success('已切换活跃渠道');
    await loadProviders();
    emit('changed');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

async function onDelete(pid: string): Promise<void> {
  if (!props.cliId) return;
  const p = providers.value.find((x) => x.id === pid);
  if (!window.confirm(`确定删除渠道「${p?.name || pid}」？`)) return;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${pid}`, { method: 'DELETE' });
    notify.success('已删除');
    await loadProviders();
    emit('changed');
    if (editingPid.value === pid) resetFormToAdd();
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

async function copyLaunchCmd(): Promise<void> {
  if (!props.launchCommand) return;
  try {
    await navigator.clipboard.writeText(props.launchCommand);
    notify.success('已复制启动命令');
  } catch {
    notify.error('复制失败');
  }
}

watch(() => props.open, async (v) => {
  if (v && props.cliId) {
    providers.value = [];
    activeProviderId.value = undefined;
    listError.value = null;
    resetFormToAdd();
    await Promise.all([loadProviders(), loadPresetsIfNeeded()]);
  }
});

watch(() => props.cliId, async (newId, oldId) => {
  if (props.open && newId && newId !== oldId) {
    providers.value = [];
    activeProviderId.value = undefined;
    listError.value = null;
    resetFormToAdd();
    await Promise.all([loadProviders(), loadPresetsIfNeeded()]);
  }
});
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    @click="onBackdropClick"
  >
    <div class="w-[580px] max-h-[90vh] overflow-y-auto bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700">
      <!-- 头 -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
        <div>
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200">{{ title }}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">{{ subtitle }}</div>
        </div>
        <button type="button" class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 text-sm" @click="close">✕</button>
      </div>

      <!-- Provider 列表 -->
      <div class="px-5 pt-4 pb-2">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">API 渠道列表</span>
          <button type="button" class="h-6 px-2.5 rounded-md bg-cyan-50 border border-cyan-200 text-cyan-600 text-[10px] font-semibold hover:bg-cyan-100 dark:bg-cyan-500/10 dark:border-cyan-500/30 dark:text-cyan-400" @click="resetFormToAdd">+ 添加渠道</button>
        </div>
        <div class="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
          <div v-if="loadingList" class="text-[10px] text-slate-400 text-center py-3">加载中...</div>
          <div v-else-if="listError" class="text-[10px] text-red-500 py-2">加载失败: {{ listError }}</div>
          <div v-else-if="providers.length === 0" class="text-[10px] text-slate-400 text-center py-3">尚未添加任何 API 渠道</div>
          <div
            v-for="p in providers"
            v-else
            :key="p.id"
            class="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs"
            :class="p.id === activeProviderId
              ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0b1324]'"
          >
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-slate-700 dark:text-slate-200 truncate">
                <span v-if="p.id === activeProviderId" class="text-emerald-500 mr-1">●</span>
                <span v-else class="text-slate-300 mr-1">○</span>
                {{ p.name || '未命名' }}
              </div>
              <div class="text-[10px] text-slate-400 truncate">
                {{ UPSTREAM_LABELS[p.upstreamProtocol] || p.upstreamProtocol || 'openai' }}
                · {{ p.model || '默认模型' }}
                · {{ p.apiKeySet ? 'Key ✓' : 'Key ✗' }}
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button v-if="p.id !== activeProviderId" type="button" class="h-6 px-1.5 rounded text-[10px] border border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10" title="设为活跃" @click="onActivate(p.id)">启用</button>
              <button type="button" class="h-6 px-1.5 rounded text-[10px] border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800" title="编辑" @click="startEdit(p)">编辑</button>
              <button type="button" class="h-6 px-1.5 rounded text-[10px] border border-red-200 dark:border-red-500/30 text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10" title="删除" @click="onDelete(p.id)">✕</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 分割线 -->
      <div class="mx-5 h-px bg-slate-100 dark:bg-slate-700"></div>

      <!-- 表单 -->
      <div class="px-5 py-4 flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">{{ formLabel }}</span>
          <span v-if="editingPid" class="text-[9px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-300 font-semibold">编辑中</span>
          <span v-if="activePreset" class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300 font-semibold">
            来自 {{ activePreset.name }}
          </span>
        </div>

        <!-- Provider Preset 快速选择(仅添加模式 + 有可用 preset) -->
        <div v-if="showPresetPicker" class="rounded-lg border border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/50 dark:bg-cyan-500/5 p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[10px] font-semibold text-cyan-700 dark:text-cyan-300 uppercase">⚡ 快速选择(可选)</div>
            <button v-if="presetsCollapsed" type="button" class="text-[10px] text-cyan-600 dark:text-cyan-400 hover:underline" @click="presetsCollapsed = false">展开 ▾</button>
            <button v-else type="button" class="text-[10px] text-slate-400 hover:underline" @click="presetsCollapsed = true">收起 ▴</button>
          </div>
          <div v-if="!presetsCollapsed" class="flex flex-col gap-2">
            <div v-for="group in presetCategoryEntries" :key="group.id">
              <div class="text-[9px] font-semibold text-slate-500 dark:text-slate-400 uppercase mb-1">{{ group.label }}</div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="preset in group.items"
                  :key="preset.id"
                  type="button"
                  class="h-7 px-2.5 rounded-md text-[11px] border transition-colors"
                  :class="fPresetId === preset.id
                    ? 'bg-cyan-500 border-cyan-500 text-white'
                    : 'bg-white dark:bg-[#0b1324] border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-400'"
                  :title="preset.docsUrl || preset.name"
                  @click="pickPreset(preset)"
                >
                  {{ preset.name }}
                </button>
              </div>
            </div>
            <div v-if="fPresetId" class="flex items-center gap-2 mt-1">
              <span class="text-[10px] text-slate-500 dark:text-slate-400">已选 preset 会自动填地址 / 协议,可继续手动编辑下方字段</span>
              <button type="button" class="text-[10px] text-slate-400 hover:text-red-400 underline" @click="clearPreset">清除选择</button>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">渠道名称</label>
          <input v-model="fName" type="text" placeholder="例：DeepSeek / 官方 API" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">上游协议类型</label>
          <select v-model="fUpstream" class="h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400">
            <option v-for="u in allowedUpstreams" :key="u" :value="u">{{ UPSTREAM_LABELS[u] }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">上游 API 基础地址</label>
          <input v-model="fApiBase" type="text" placeholder="https://api.openai.com" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">API Key</label>
          <input v-model="fApiKey" type="password" :placeholder="fApiKeyPlaceholder" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">目标模型</label>
          <input
            v-model="fModel"
            type="text"
            placeholder="gpt-4o / deepseek-chat"
            list="provider-modal-model-suggestions"
            class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400"
          />
          <datalist v-if="activePreset && activePreset.models.length > 0" id="provider-modal-model-suggestions">
            <option v-for="m in activePreset.models" :key="m" :value="m" />
          </datalist>
        </div>

        <!-- Reasoning 档位 -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase">Reasoning 档位</label>
            <span
              v-if="fReasoningEffort !== 'auto' && !modelLooksReasoning"
              class="text-[9px] text-amber-600 dark:text-amber-400"
              title="当前模型未被识别为 reasoning 模型,1Shell 会跳过 thinking/reasoning_effort 注入"
            >
              ⚠ 当前模型可能不支持
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              v-for="opt in REASONING_EFFORT_OPTIONS"
              :key="opt.value"
              type="button"
              class="flex-1 h-8 rounded-md text-[11px] border transition-colors"
              :class="fReasoningEffort === opt.value
                ? 'bg-cyan-500 border-cyan-500 text-white font-semibold'
                : 'bg-white dark:bg-[#0b1324] border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-cyan-400 hover:text-cyan-600'"
              :title="opt.hint"
              @click="fReasoningEffort = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <div class="text-[10px] text-slate-400">
            仅对支持思考的 reasoning 模型生效(如 gpt-5 / o3 / claude-opus-4 / deepseek-reasoner)。
            <span v-if="isCodex">codex 通过 config.toml 配置;</span>
            <span v-else>请求时由 1Shell proxy 注入。</span>
          </div>
        </div>

        <!-- 启动命令提示（仅 CLI 沙箱模式） -->
        <div v-if="showEnvHint" class="rounded-lg bg-slate-50 dark:bg-[#0b1324] border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center justify-between mb-1.5">
            <div class="text-[10px] font-semibold text-slate-400 uppercase">启动命令（不修改本地配置）</div>
            <button type="button" class="h-6 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] text-slate-500 hover:text-cyan-500 hover:border-cyan-300" title="复制启动命令" @click="copyLaunchCmd">📋 复制</button>
          </div>
          <pre class="text-[11px] font-mono text-cyan-600 dark:text-cyan-400 whitespace-pre-wrap break-all select-all">{{ launchCommand }}</pre>
          <div class="mt-1.5 text-[10px] text-slate-400">通过环境变量与沙箱目录启动，不修改本地配置</div>
        </div>

        <div v-if="statusText" class="text-[10px]" :class="statusOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">{{ statusText }}</div>
      </div>

      <!-- 按钮 -->
      <div class="px-5 py-3.5 border-t border-slate-100 dark:border-slate-700 flex items-center gap-2">
        <button type="button" :disabled="saving" class="flex-1 h-9 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-xs font-semibold shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed" @click="onSave">{{ saveBtnText }}</button>
        <button type="button" class="h-9 px-4 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 text-xs hover:bg-slate-50 dark:hover:bg-slate-800" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>
