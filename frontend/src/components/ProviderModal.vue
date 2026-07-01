<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import {
  SKILLS_SLOT_ID,
  UPSTREAM_LABELS,
  PRESET_CATEGORY_LABELS,
  REASONING_EFFORT_OPTIONS,
  type AgentConfigFileInfo,
  type AgentConfigFilesResponse,
  type NativeProviderImportInfo,
  type ProviderInfo,
  type ProviderRouteInfo,
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
  editProviderId?: string | null;
}

type ClaudeRole = 'sonnet' | 'opus' | 'fable' | 'haiku';

interface ClaudeRoleModelForm {
  model: string;
  displayName: string;
  oneMillion: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  changed: [];
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const providers = ref<ProviderInfo[]>([]);
const activeRoute = ref<ProviderRouteInfo | null>(null);
const loadingList = ref(false);
const listError = ref<string | null>(null);
const nativeImportInfo = ref<NativeProviderImportInfo | null>(null);
const syncingNativeImport = ref(false);

const editingPid = ref<string | null>(null);
const fName = ref('');
const fUpstream = ref<UpstreamProtocol>('openai');
const fApiBase = ref('');
const fApiKey = ref('');
const fApiKeyPlaceholder = ref('sk-...');
const fPrimaryModel = ref('');
const fActiveModelId = ref<string | null>(null);
const fReasoningEffort = ref<ReasoningEffort>('auto');
const fClaudeModels = ref<Record<ClaudeRole, ClaudeRoleModelForm>>(createEmptyClaudeModels());
const fPresetId = ref('');
const statusText = ref('');
const statusOk = ref<boolean | null>(null);
const saving = ref(false);
const configFiles = ref<AgentConfigFileInfo[]>([]);
const activeConfigFileName = ref('');
const configDraft = ref('');
const loadingConfigFiles = ref(false);
const previewingConfigFiles = ref(false);
const savingConfigFile = ref(false);
const configFileError = ref<string | null>(null);
const configDraftDirty = ref(false);
let configPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let configPreviewSeq = 0;

const CLAUDE_ONE_M_MARKER = '[1M]';
const CLAUDE_MODEL_ROLES: Array<{ id: ClaudeRole; label: string; supportsOneM: boolean }> = [
  { id: 'sonnet', label: 'Sonnet', supportsOneM: true },
  { id: 'opus', label: 'Opus', supportsOneM: true },
  { id: 'fable', label: 'Fable', supportsOneM: true },
  { id: 'haiku', label: 'Haiku', supportsOneM: false },
];

function stripClaudeOneMMarker(value: string): string {
  const trimmed = String(value || '').trimEnd();
  return trimmed.toLowerCase().endsWith('[1m]') ? trimmed.slice(0, -CLAUDE_ONE_M_MARKER.length).trimEnd() : trimmed;
}

function setClaudeOneMMarker(value: string, enabled: boolean): string {
  const base = stripClaudeOneMMarker(value).trim();
  if (!base) return '';
  return enabled ? `${base}${CLAUDE_ONE_M_MARKER}` : base;
}

function createEmptyClaudeRole(): ClaudeRoleModelForm {
  return { model: '', displayName: '', oneMillion: false };
}

function createEmptyClaudeModels(): Record<ClaudeRole, ClaudeRoleModelForm> {
  return {
    sonnet: createEmptyClaudeRole(),
    opus: createEmptyClaudeRole(),
    fable: createEmptyClaudeRole(),
    haiku: createEmptyClaudeRole(),
  };
}

function createClaudeRoleForm(source?: { model?: string; displayName?: string } | null): ClaudeRoleModelForm {
  const model = String(source?.model || source?.displayName || '').trim();
  return {
    model: stripClaudeOneMMarker(model),
    displayName: String(source?.displayName || stripClaudeOneMMarker(model)).trim(),
    oneMillion: model.toLowerCase().endsWith('[1m]'),
  };
}

function serializeClaudeModels(): Record<ClaudeRole, { model: string; displayName: string }> {
  const out = {} as Record<ClaudeRole, { model: string; displayName: string }>;
  for (const role of CLAUDE_MODEL_ROLES) {
    const item = fClaudeModels.value[role.id] || createEmptyClaudeRole();
    const model = setClaudeOneMMarker(item.model, role.supportsOneM && item.oneMillion);
    out[role.id] = {
      model,
      displayName: stripClaudeOneMMarker(model),
    };
  }
  return out;
}

// Provider preset 库(添加模式下用)
const presetsAll = ref<ProviderPreset[]>([]);
const presetsLoaded = ref(false);
const presetsLoadedFor = ref<string | null>(null);
const presetsCollapsed = ref(false);

async function loadPresetsIfNeeded(): Promise<void> {
  const cliId = props.cliId || '';
  if (cliId === 'codex') {
    presetsAll.value = [];
    presetsLoaded.value = true;
    presetsLoadedFor.value = cliId;
    return;
  }
  if (presetsLoaded.value && presetsLoadedFor.value === cliId) return;
  presetsAll.value = [];
  presetsLoaded.value = false;
  presetsLoadedFor.value = null;
  try {
    const qs = cliId ? `?cliId=${encodeURIComponent(cliId)}` : '';
    const resp = await requestJson<{ ok: boolean; presets: ProviderPreset[] }>(`/api/agent/provider-presets${qs}`);
    presetsAll.value = resp.presets || [];
    presetsLoaded.value = true;
    presetsLoadedFor.value = cliId;
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
const showPresetPicker = computed(() => !editingPid.value && !isCodex.value && presetCategoryEntries.value.length > 0);

const activePreset = computed<ProviderPreset | null>(() => {
  if (isCodex.value) return null;
  if (!fPresetId.value) return null;
  return presetsAll.value.find(p => p.id === fPresetId.value) || null;
});

// 当前 model 是否被识别为 reasoning model(用于 reasoning select 的提示)
const modelLooksReasoning = computed<boolean>(() => {
  const m = resolvePrimaryModelFromForm().toLowerCase();
  if (!m) return false;
  // 复用 reasoning.js 白名单的同名前缀(前端简化版,只用于 UX 提示,后端再次校验)
  const builtinPrefixes = isCodex.value
    ? ['gpt-5']
    : [
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
  fApiBase.value = preset.isTemplate ? '' : preset.apiBase;
  fUpstream.value = normalizeUpstreamForCli(preset.protocol);
  fName.value = preset.name;
  fApiKeyPlaceholder.value = preset.apiKeyField ? `请填 ${preset.apiKeyField}` : 'sk-...';
  const first = preset.models[0] || '';
  fPrimaryModel.value = first;
  fActiveModelId.value = first ? makeModelProfileId(first) : null;
  fReasoningEffort.value = normalizeEffortForCli(preset.reasoningEffort || 'auto');
  if (isClaudeCode.value) {
    fClaudeModels.value = {
      sonnet: createClaudeRoleForm(preset.claudeModels?.sonnet || { model: first }),
      opus: createClaudeRoleForm(preset.claudeModels?.opus || { model: first }),
      fable: createClaudeRoleForm(preset.claudeModels?.fable || preset.claudeModels?.opus || { model: first }),
      haiku: createClaudeRoleForm(preset.claudeModels?.haiku || { model: first }),
    };
  }
  presetsCollapsed.value = true;
  configDraftDirty.value = false;
  configFileError.value = null;
  if (configPreviewTimer) {
    clearTimeout(configPreviewTimer);
    configPreviewTimer = null;
  }
  void refreshConfigPreview({ force: true });
}

function clearPreset(): void {
  fPresetId.value = '';
  presetsCollapsed.value = false;
  configDraftDirty.value = false;
  void refreshConfigPreview({ force: true });
}

function makeModelProfileId(model: string): string {
  const clean = String(model || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `model-${clean || 'default'}`;
}

function resolvePrimaryModelFromForm(): string {
  if (isClaudeCode.value) {
    return String(
      fClaudeModels.value.sonnet?.model
      || fClaudeModels.value.opus?.model
      || fClaudeModels.value.fable?.model
      || fClaudeModels.value.haiku?.model
      || fPrimaryModel.value
      || '',
    ).trim();
  }
  return fPrimaryModel.value.trim();
}

function serializeModelForms() {
  const model = resolvePrimaryModelFromForm();
  if (!model) return [];
  const id = fActiveModelId.value || makeModelProfileId(model);
  return [
    {
      id,
      apiModel: model,
      displayName: model,
      enabled: true,
      reasoningEffort: normalizeEffortForCli(fReasoningEffort.value || 'auto'),
    },
  ];
}

const activeConfigFile = computed<AgentConfigFileInfo | null>(() => (
  configFiles.value.find((file) => file.name === activeConfigFileName.value) || configFiles.value[0] || null
));

const showConfigEditor = computed(() => Boolean(props.cliId && props.cliId !== SKILLS_SLOT_ID));

function syncConfigDraft(file: AgentConfigFileInfo | null): void {
  activeConfigFileName.value = file?.name || '';
  configDraft.value = file?.content || '';
  configDraftDirty.value = false;
}

async function loadConfigFiles(): Promise<void> {
  if (!props.cliId || props.cliId === SKILLS_SLOT_ID) {
    configFiles.value = [];
    syncConfigDraft(null);
    return;
  }
  loadingConfigFiles.value = true;
  configFileError.value = null;
  try {
    const resp = await requestJson<AgentConfigFilesResponse>(`/api/agent/config-files/${encodeURIComponent(props.cliId)}`);
    configFiles.value = resp.files || [];
    const current = configFiles.value.find((file) => file.name === activeConfigFileName.value) || configFiles.value[0] || null;
    syncConfigDraft(current);
  } catch (err) {
    configFiles.value = [];
    syncConfigDraft(null);
    configFileError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingConfigFiles.value = false;
  }
}

async function reloadConfigFilesAndPreview(): Promise<void> {
  await loadConfigFiles();
  await refreshConfigPreview({ force: true });
}

function selectConfigFile(name: string): void {
  const file = configFiles.value.find((item) => item.name === name) || null;
  syncConfigDraft(file);
}

function markConfigDraftDirty(event?: Event): void {
  const target = event?.target as HTMLTextAreaElement | null;
  if (target) configDraft.value = target.value;
  configDraftDirty.value = true;
  const activeName = activeConfigFileName.value;
  if (!activeName) return;
  configFiles.value = configFiles.value.map((file) => (
    file.name === activeName ? { ...file, content: configDraft.value } : file
  ));
}

async function saveConfigFile(options: { silent?: boolean } = {}): Promise<boolean> {
  if (!props.cliId || !activeConfigFile.value) return false;
  savingConfigFile.value = true;
  configFileError.value = null;
  try {
    const resp = await requestJson<AgentConfigFilesResponse>(
      `/api/agent/config-files/${encodeURIComponent(props.cliId)}/${encodeURIComponent(activeConfigFile.value.name)}`,
      { method: 'PUT', body: JSON.stringify({ content: configDraft.value }) },
    );
    configFiles.value = resp.files || [];
    const saved = configFiles.value.find((file) => file.name === activeConfigFileName.value) || activeConfigFile.value;
    syncConfigDraft(saved);
    if (!options.silent) notify.success('配置草稿已保存');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    configFileError.value = msg;
    notify.error(msg, 5000);
    return false;
  } finally {
    savingConfigFile.value = false;
  }
}

async function resetConfigFileOverride(): Promise<void> {
  if (!props.cliId || !activeConfigFile.value) return;
  savingConfigFile.value = true;
  configFileError.value = null;
  try {
    const resp = await requestJson<AgentConfigFilesResponse>(
      `/api/agent/config-files/${encodeURIComponent(props.cliId)}/${encodeURIComponent(activeConfigFile.value.name)}/override`,
      { method: 'DELETE', body: JSON.stringify({}) },
    );
    configFiles.value = resp.files || [];
    const regenerated = configFiles.value.find((file) => file.name === activeConfigFileName.value) || configFiles.value[0] || null;
    syncConfigDraft(regenerated);
    await refreshConfigPreview({ force: true });
    notify.success('配置草稿已按表单重新生成');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    configFileError.value = msg;
    notify.error(msg, 5000);
  } finally {
    savingConfigFile.value = false;
  }
}

const isSkillsSlot = computed(() => props.cliId === SKILLS_SLOT_ID);
const isClaudeCode = computed(() => props.cliId === 'claude-code');
const isCodex = computed(() => props.cliId === 'codex');
const isNativeCli = computed(() => Boolean(props.cliId && props.cliId !== SKILLS_SLOT_ID));
const nativeConfigFileNames = computed(() => configFiles.value.map((file) => file.name).join(' / '));
const title = computed(() => {
  if (!props.cliId) return '配置模型接入';
  if (isSkillsSlot.value) return '配置 1Shell AI 引擎';
  return `${props.cliName || props.cliId} 原生配置`;
});
const subtitle = computed(() => {
  if (isSkillsSlot.value) return '驱动主控台 AI / IDE AgentRun / Skill 执行（支持 OpenAI 兼容 / Anthropic）';
  const files = nativeConfigFileNames.value || 'settings.json / config.toml / opencode.json';
  return `编辑 1Shell 内的配置文件草稿: ${files}；在配置方案列表点击“启用”才会替换 CLI 原生配置`;
});

const nativeImportText = computed(() => {
  if (!isNativeCli.value || !nativeImportInfo.value) return '';
  if (nativeImportInfo.value.error) return `读取失败: ${nativeImportInfo.value.error}`;
  if (nativeImportInfo.value.reason) return nativeImportInfo.value.reason;
  if (nativeImportInfo.value.found && nativeImportInfo.value.imported) {
    return nativeImportInfo.value.created ? '已从本机配置导入' : '已从本机配置同步';
  }
  if (nativeImportInfo.value.found) return '发现本机配置，但未能导入到表单';
  return '未发现本机 API 配置';
});

const nativeImportOk = computed(() => Boolean(nativeImportInfo.value?.found && nativeImportInfo.value?.imported && !nativeImportInfo.value?.error));

const allowedUpstreams = computed<UpstreamProtocol[]>(() => {
  if (isSkillsSlot.value) return ['anthropic', 'openai'];
  return props.supportedUpstream.length ? props.supportedUpstream : ['openai'];
});

const showEnvHint = computed(() => !isSkillsSlot.value && !!props.launchCommand);
const reasoningEffortOptions = computed(() => {
  if (isClaudeCode.value) return REASONING_EFFORT_OPTIONS.filter((opt) => opt.value !== 'xhigh');
  if (isCodex.value) return REASONING_EFFORT_OPTIONS.filter((opt) => opt.value !== 'max');
  return REASONING_EFFORT_OPTIONS.filter((opt) => opt.value !== 'max' && opt.value !== 'xhigh');
});

function normalizeEffortForCli(value: ReasoningEffort): ReasoningEffort {
  if (isClaudeCode.value && value === 'xhigh') return 'max';
  if (isCodex.value && value === 'max') return 'xhigh';
  if (!isClaudeCode.value && !isCodex.value && (value === 'max' || value === 'xhigh')) return 'high';
  return value;
}

function normalizeUpstreamForCli(value?: UpstreamProtocol): UpstreamProtocol {
  const allowed = allowedUpstreams.value;
  return value && allowed.includes(value) ? value : allowed[0];
}

const saveBtnText = computed(() => {
  if (saving.value) return '保存中...';
  if (isSkillsSlot.value) return editingPid.value ? '保存修改' : '添加引擎';
  return editingPid.value ? '保存配置方案' : '添加配置方案';
});

const formLabel = computed(() => {
  if (!editingPid.value) return isSkillsSlot.value ? '添加新引擎' : '添加新配置方案';
  const p = providers.value.find((x) => x.id === editingPid.value);
  return `编辑: ${p?.name || '未命名配置'}`;
});

function close(): void {
  emit('update:open', false);
}

function resetFormToAdd(): void {
  editingPid.value = null;
  fName.value = isCodex.value ? 'OpenAI' : '';
  fUpstream.value = normalizeUpstreamForCli();
  fApiBase.value = isCodex.value ? 'https://api.openai.com' : '';
  fApiKey.value = '';
  fApiKeyPlaceholder.value = isCodex.value ? '请填 OPENAI_API_KEY' : 'sk-...';
  fPrimaryModel.value = '';
  fClaudeModels.value = createEmptyClaudeModels();
  fActiveModelId.value = null;
  fReasoningEffort.value = 'auto';
  fPresetId.value = '';
  presetsCollapsed.value = false;
  statusText.value = '';
  statusOk.value = null;
  if (!editingPid.value) {
    configFileError.value = null;
  }
}

function startEdit(p: ProviderInfo): void {
  editingPid.value = p.id;
  fName.value = p.name || '';
  fUpstream.value = normalizeUpstreamForCli(p.upstreamProtocol || 'openai');
  fApiBase.value = p.apiBase || '';
  fApiKey.value = '';
  fApiKeyPlaceholder.value = p.apiKeySet ? (p.apiKey || '已设置') : 'sk-...';
  const activeModel = p.models?.find((model) => model.id === (p.routeModelId || p.activeModelId)) || p.models?.[0] || null;
  const fallback = p.model || activeModel?.apiModel || '';
  fPrimaryModel.value = fallback;
  fReasoningEffort.value = normalizeEffortForCli((activeModel?.reasoningEffort || p.reasoningEffort || 'auto') as ReasoningEffort);
  fClaudeModels.value = {
    sonnet: createClaudeRoleForm(p.claudeModels?.sonnet || { model: fallback }),
    opus: createClaudeRoleForm(p.claudeModels?.opus || { model: fallback }),
    fable: createClaudeRoleForm(p.claudeModels?.fable || p.claudeModels?.opus || { model: fallback }),
    haiku: createClaudeRoleForm(p.claudeModels?.haiku || { model: fallback }),
  };
  fActiveModelId.value = p.activeModelId || activeModel?.id || (fallback ? makeModelProfileId(fallback) : null);
  fPresetId.value = p.presetId || '';
  presetsCollapsed.value = true;
  statusText.value = '';
  statusOk.value = null;
}

async function loadProviders(): Promise<ProviderInfo[]> {
  if (!props.cliId) return [];
  loadingList.value = true;
  listError.value = null;
  try {
    const resp = await requestJson<ProvidersResponse>(`/api/agent/providers/${encodeURIComponent(props.cliId)}`);
    providers.value = resp.providers || [];
    activeRoute.value = resp.activeRoute || null;
    nativeImportInfo.value = resp.nativeImport || null;
    return providers.value;
  } catch (err) {
    listError.value = err instanceof Error ? err.message : String(err);
    providers.value = [];
    activeRoute.value = null;
    nativeImportInfo.value = null;
    return [];
  } finally {
    loadingList.value = false;
  }
}

function applyRequestedMode(providerId = props.editProviderId || null): void {
  if (!providerId) {
    resetFormToAdd();
    return;
  }
  const provider = providers.value.find((item) => item.id === providerId);
  if (provider) {
    startEdit(provider);
    return;
  }
  resetFormToAdd();
  statusText.value = '✗ 未找到要编辑的配置方案，可能已经被删除';
  statusOk.value = false;
}

function getPreferredProviderId(explicitProviderId = props.editProviderId || null): string | null {
  if (explicitProviderId) return explicitProviderId;
  if (!isNativeCli.value) return null;
  const importedId = typeof nativeImportInfo.value?.id === 'string' ? nativeImportInfo.value.id : '';
  const routedId = typeof activeRoute.value?.providerId === 'string' ? activeRoute.value.providerId : '';
  return importedId || routedId || providers.value[0]?.id || null;
}

async function prepareModal(): Promise<void> {
  providers.value = [];
  activeRoute.value = null;
  nativeImportInfo.value = null;
  listError.value = null;
  resetFormToAdd();
  await Promise.all([loadProviders(), loadPresetsIfNeeded()]);
  applyRequestedMode(getPreferredProviderId());
  await loadConfigFiles();
  await refreshConfigPreview({ force: true });
}

async function syncNativeProviderFromFiles(): Promise<void> {
  if (!props.cliId || !isNativeCli.value) return;
  syncingNativeImport.value = true;
  try {
    const resp = await requestJson<ProvidersResponse>(
      `/api/agent/providers/${encodeURIComponent(props.cliId)}/import-native`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    providers.value = resp.providers || [];
    activeRoute.value = resp.activeRoute || null;
    nativeImportInfo.value = resp.nativeImport || null;
    applyRequestedMode(getPreferredProviderId());
    await loadConfigFiles();
    await refreshConfigPreview({ force: true });
    if (nativeImportInfo.value?.error) {
      notify.error(nativeImportInfo.value.error, 5000);
    } else if (nativeImportInfo.value?.found) {
      notify.success('已重新读取本机配置');
    } else if (nativeImportInfo.value?.reason) {
      notify.error(nativeImportInfo.value.reason, 5000);
    } else {
      notify.error('没有发现本机 API 配置');
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    syncingNativeImport.value = false;
  }
}

function buildProviderPayload(): Record<string, unknown> {
  const modelProfiles = serializeModelForms();
  const primaryModel = resolvePrimaryModelFromForm();
  const activeModelId = modelProfiles[0]?.id || null;

  const body: Record<string, unknown> = {
    name: fName.value.trim() || undefined,
    upstreamProtocol: fUpstream.value,
    apiBase: fApiBase.value.trim(),
    apiKey: fApiKey.value.trim() || undefined,
    model: primaryModel || undefined,
    reasoningEffort: normalizeEffortForCli(fReasoningEffort.value || 'auto'),
    models: modelProfiles,
    activeModelId,
    presetId: fPresetId.value || '',
    enabled: (editingPid.value ? providers.value.find(p => p.id === editingPid.value) : null)?.enabled,
  };
  if (isClaudeCode.value) {
    body.claudeModels = serializeClaudeModels();
    body.includeCoAuthoredBy = false;
  }
  return body;
}

function mergePreviewConfigFiles(previewFiles: AgentConfigFileInfo[]): void {
  const selectedName = activeConfigFileName.value;
  const draftIsDirty = configDraftDirty.value;
  configFiles.value = previewFiles;

  const selected = configFiles.value.find((file) => file.name === selectedName) || configFiles.value[0] || null;
  if (!selected) {
    syncConfigDraft(null);
    return;
  }
  activeConfigFileName.value = selected.name;
  if (!draftIsDirty) syncConfigDraft(selected);
}

async function refreshConfigPreview({ force = false } = {}): Promise<void> {
  if (!props.open || !props.cliId || props.cliId === SKILLS_SLOT_ID) return;

  let provider: Record<string, unknown>;
  try {
    provider = buildProviderPayload();
  } catch (err) {
    if (force) configFileError.value = err instanceof Error ? err.message : String(err);
    return;
  }

  const seq = ++configPreviewSeq;
  previewingConfigFiles.value = true;
  try {
    const resp = await requestJson<AgentConfigFilesResponse>(
      `/api/agent/config-preview/${encodeURIComponent(props.cliId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          providerId: editingPid.value || undefined,
          provider,
        }),
      },
    );
    if (seq !== configPreviewSeq) return;
    configFileError.value = null;
    mergePreviewConfigFiles(resp.files || []);
  } catch (err) {
    if (seq !== configPreviewSeq) return;
    configFileError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === configPreviewSeq) previewingConfigFiles.value = false;
  }
}

function scheduleConfigPreview({ fromForm = false } = {}): void {
  if (!props.open || !props.cliId || props.cliId === SKILLS_SLOT_ID) return;
  if (fromForm) {
    configDraftDirty.value = false;
  }
  if (configPreviewTimer) clearTimeout(configPreviewTimer);
  configPreviewTimer = setTimeout(() => {
    configPreviewTimer = null;
    void refreshConfigPreview();
  }, 250);
}

async function onSave(): Promise<void> {
  if (!props.cliId) return;
  let body: Record<string, unknown>;
  try {
    body = buildProviderPayload();
  } catch (err) {
    statusText.value = `✗ ${err instanceof Error ? err.message : String(err)}`;
    statusOk.value = false;
    return;
  }

  if (!body.apiBase) {
    statusText.value = '✗ API 基础地址不能为空';
    statusOk.value = false;
    return;
  }
  if (!editingPid.value && !body.apiKey) {
    statusText.value = '✗ 新配置方案必须填写 API Key';
    statusOk.value = false;
    return;
  }

  saving.value = true;
  let savedProviderId = editingPid.value;
  try {
    if (editingPid.value) {
      await requestJson(`/api/agent/providers/${encodeURIComponent(props.cliId)}/${editingPid.value}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      statusText.value = isSkillsSlot.value ? '✓ 引擎已更新' : '✓ 配置方案已保存';
      notify.success(isSkillsSlot.value ? '引擎已更新' : '配置方案已更新');
    } else {
      const created = await requestJson<{ ok?: boolean; id?: string }>(`/api/agent/providers/${encodeURIComponent(props.cliId)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      savedProviderId = created.id || null;
      statusText.value = isSkillsSlot.value ? '✓ 引擎已添加' : '✓ 配置方案已添加';
      notify.success(isSkillsSlot.value ? '引擎已添加' : '配置方案已添加');
    }
    statusOk.value = true;
    await loadProviders();
    if (savedProviderId) {
      const saved = providers.value.find((provider) => provider.id === savedProviderId);
      if (saved) startEdit(saved);
    }
    await loadConfigFiles();
    await refreshConfigPreview({ force: true });
    emit('changed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusText.value = `✗ 保存失败: ${msg}`;
    statusOk.value = false;
    notify.error(msg, 5000);
  } finally {
    saving.value = false;
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
    await prepareModal();
  }
});

watch(() => props.cliId, async (newId, oldId) => {
  if (props.open && newId && newId !== oldId) {
    await prepareModal();
  }
});

watch(() => props.editProviderId, (newId, oldId) => {
  if (props.open && newId !== oldId) {
    applyRequestedMode(getPreferredProviderId(newId || null));
  }
});

watch([
  fName,
  fUpstream,
  fApiBase,
  fApiKey,
  fClaudeModels,
  fPrimaryModel,
  fReasoningEffort,
  fPresetId,
], () => {
  scheduleConfigPreview({ fromForm: true });
}, { deep: true });

const presetHint = computed(() => (
  isSkillsSlot.value
    ? '已选模板会自动填地址 / 协议，可继续手动编辑下方字段'
    : '已选模板会自动填地址 / API 格式，可继续手动编辑下方字段'
));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    @click="onBackdropClick"
  >
    <div class="w-[640px] max-h-[90vh] overflow-y-auto bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700">
      <!-- 头 -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
        <div>
          <div class="text-sm font-bold text-slate-700 dark:text-slate-200">{{ title }}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">{{ subtitle }}</div>
        </div>
        <button type="button" class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 text-sm" @click="close">✕</button>
      </div>

      <!-- 表单 -->
      <div class="px-5 py-4 flex flex-col gap-3">
        <div v-if="loadingList" class="text-[10px] text-slate-400">正在加载配置方案...</div>
        <div v-else-if="listError" class="text-[10px] text-red-500">加载失败: {{ listError }}</div>

        <div class="flex items-center gap-2">
          <span class="text-[11px] font-bold text-slate-600 dark:text-slate-300">{{ formLabel }}</span>
          <span v-if="editingPid" class="text-[9px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-300 font-semibold">编辑中</span>
          <span v-if="activePreset" class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300 font-semibold">
            模板 {{ activePreset.name }}
          </span>
        </div>
        <div v-if="isNativeCli" class="rounded-lg border border-sky-200 dark:border-sky-500/30 bg-sky-50/70 dark:bg-sky-500/5 px-3 py-2 text-[10px] text-sky-700 dark:text-sky-200">
          当前窗口只编辑 1Shell 的配置草稿；回到配置方案列表点击“启用”才会替换 Claude Code / Codex / OpenCode 的原生配置文件。
        </div>
        <div v-if="isNativeCli" class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] px-3 py-2">
          <span
            class="text-[10px]"
            :class="nativeImportOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'"
          >
            {{ nativeImportText || '正在读取本机配置' }}
          </span>
          <button
            type="button"
            class="h-6 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] text-slate-500 hover:text-cyan-500 hover:border-cyan-300 disabled:opacity-50"
            :disabled="syncingNativeImport || loadingList"
            @click="syncNativeProviderFromFiles"
          >
            重新读取
          </button>
        </div>

        <!-- Provider Preset 快速选择(仅添加模式 + 有可用 preset) -->
        <div v-if="showPresetPicker" class="rounded-lg border border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/50 dark:bg-cyan-500/5 p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[10px] font-semibold text-cyan-700 dark:text-cyan-300 uppercase">快速模板(可选)</div>
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
              <span class="text-[10px] text-slate-500 dark:text-slate-400">{{ presetHint }}</span>
              <button type="button" class="text-[10px] text-slate-400 hover:text-red-400 underline" @click="clearPreset">清除选择</button>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">{{ isSkillsSlot ? '引擎名称' : '配置方案名称' }}</label>
          <input v-model="fName" type="text" placeholder="例：DeepSeek / 官方 Anthropic" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">{{ isSkillsSlot ? '上游协议类型' : 'API 格式' }}</label>
          <select v-model="fUpstream" class="h-8 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400">
            <option v-for="u in allowedUpstreams" :key="u" :value="u">{{ UPSTREAM_LABELS[u] }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">API Base URL</label>
          <input v-model="fApiBase" type="text" placeholder="https://api.openai.com" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold text-slate-400 uppercase">API Key</label>
          <input v-model="fApiKey" type="password" :placeholder="fApiKeyPlaceholder" class="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] text-xs font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400" />
        </div>

        <!-- Claude Code role mapping -->
        <div v-if="isClaudeCode" class="flex flex-col gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] p-3">
          <div class="flex items-center justify-between">
            <label class="text-[10px] font-semibold text-slate-400 uppercase">Claude Code 模型映射</label>
            <span class="text-[9px] text-slate-400">settings.json</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            <div v-for="role in CLAUDE_MODEL_ROLES" :key="role.id" class="grid grid-cols-1 sm:grid-cols-[72px_1fr_auto] gap-1.5 items-center">
              <div class="text-[10px] font-semibold text-slate-500 dark:text-slate-300">{{ role.label }}</div>
              <input
                v-model="fClaudeModels[role.id].model"
                type="text"
                :placeholder="`${role.label} model`"
                class="h-8 px-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-[11px] font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400"
              />
              <label v-if="role.supportsOneM" class="h-8 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] flex items-center justify-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-300">
                <input v-model="fClaudeModels[role.id].oneMillion" type="checkbox" class="w-3.5 h-3.5" />
                <span>1M</span>
              </label>
              <span v-else class="hidden sm:block"></span>
            </div>
          </div>
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
              v-for="opt in reasoningEffortOptions"
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
            <span v-if="isClaudeCode">Claude Code 写入 settings.json；最大强度使用 max。</span>
            <span v-else-if="isCodex">Codex 写入 config.toml；最高档为 xhigh。</span>
            <span v-else>仅对支持思考的模型生效。</span>
          </div>
        </div>

        <!-- Native config files -->
        <div v-if="showConfigEditor" class="flex flex-col gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1324] p-3">
          <div class="flex items-center justify-between gap-2">
            <label class="text-[10px] font-semibold text-slate-400 uppercase">配置文件草稿</label>
            <button
              type="button"
              class="h-6 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] text-slate-500 hover:text-cyan-500 hover:border-cyan-300 disabled:opacity-50"
              :disabled="loadingConfigFiles || previewingConfigFiles"
              @click="reloadConfigFilesAndPreview"
            >
              刷新
            </button>
          </div>
          <div v-if="loadingConfigFiles" class="text-[10px] text-slate-400">正在读取配置文件...</div>
          <div v-else-if="configFileError" class="text-[10px] text-red-500">{{ configFileError }}</div>
          <template v-else-if="configFiles.length > 0 && activeConfigFile">
            <div class="flex flex-wrap gap-1.5">
              <div
                v-for="file in configFiles"
                :key="file.name"
                class="inline-flex items-center rounded-md border overflow-hidden border-slate-200 dark:border-slate-700"
              >
                <button
                  type="button"
                  class="h-7 px-2.5 text-[10px] border transition-colors"
                  :class="file.name === activeConfigFileName
                    ? 'bg-cyan-500 border-cyan-500 text-white'
                    : 'bg-white dark:bg-[#111827] border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 hover:border-cyan-400'"
                  @click="selectConfigFile(file.name)"
                >
                  {{ file.name }}<span v-if="file.overridden"> *</span>
                </button>
              </div>
            </div>
            <div class="text-[10px] font-mono text-slate-400 break-all">{{ activeConfigFile.path }}</div>
            <textarea
              v-model="configDraft"
              spellcheck="false"
              @input="markConfigDraftDirty"
              class="min-h-48 max-h-80 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-[11px] font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-cyan-400 resize-y"
            ></textarea>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="h-7 px-3 rounded-md bg-cyan-500 text-white text-[10px] font-semibold hover:bg-cyan-600 disabled:opacity-50"
                :disabled="savingConfigFile"
                @click="saveConfigFile()"
              >
                保存草稿
              </button>
              <button
                type="button"
                class="h-7 px-3 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-300 text-[10px] hover:border-cyan-300 disabled:opacity-50"
                :disabled="savingConfigFile || !activeConfigFile.overridden"
                @click="resetConfigFileOverride"
              >
                按表单重生成
              </button>
              <span v-if="activeConfigFile.overridden" class="text-[10px] text-amber-600 dark:text-amber-400">手动覆盖</span>
              <span v-else-if="previewingConfigFiles" class="text-[10px] text-slate-400">同步预览中...</span>
              <span v-else class="text-[10px] text-slate-400">跟随上方表单同步</span>
            </div>
          </template>
          <div v-else class="text-[10px] text-slate-400">暂无配置文件</div>
        </div>

        <!-- 启动命令提示（CLI 原生配置模式） -->
        <div v-if="showEnvHint" class="rounded-lg bg-slate-50 dark:bg-[#0b1324] border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center justify-between mb-1.5">
            <div class="text-[10px] font-semibold text-slate-400 uppercase">启动命令</div>
            <button type="button" class="h-6 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-[10px] text-slate-500 hover:text-cyan-500 hover:border-cyan-300" title="复制启动命令" @click="copyLaunchCmd">📋 复制</button>
          </div>
          <pre class="text-[11px] font-mono text-cyan-600 dark:text-cyan-400 whitespace-pre-wrap break-all select-all">{{ launchCommand }}</pre>
          <div class="mt-1.5 text-[10px] text-slate-400">CLI 只读取已经启用到主机路径的原生配置文件</div>
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
