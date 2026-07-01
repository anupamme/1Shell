<script setup lang="ts">
import { ref, computed, onMounted, type Ref } from 'vue';
import ProviderModal from '@/components/ProviderModal.vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';
import {
  SKILLS_SLOT_ID,
  type ProviderInfo,
  type ProvidersResponse,
  type UpstreamProtocol,
  type ToolInfo,
  type ScanResponse,
  type InstallCliResponse,
  type BinaryOverrideResponse,
  type CliDiagnosticsResponse,
  UPSTREAM_LABELS,
} from '@/utils/cliSetup';

// ── tab definitions ──
interface TabDef {
  id: string;
  label: string;
  desc: string;
  supportedUpstream: UpstreamProtocol[];
  icon: string;
}

const TABS: TabDef[] = [
  { id: SKILLS_SLOT_ID, label: '1Shell AI',   desc: 'Agent · Skill 引擎', supportedUpstream: ['anthropic', 'openai'], icon: 'spark' },
  { id: 'claude-code',   label: 'Claude Code', desc: 'Anthropic 官方 CLI', supportedUpstream: ['anthropic'], icon: 'terminal' },
  { id: 'codex',          label: 'Codex',       desc: 'OpenAI 官方 CLI',    supportedUpstream: ['openai'], icon: 'robot' },
  { id: 'opencode',       label: 'OpenCode',   desc: '开源终端 AI 助手',    supportedUpstream: ['openai'], icon: 'console' },
];

// ── state ──
const { requestJson } = useApiClient();
const { confirm } = useConfirm();
const notify = useNotifyStore();

const activeTabId = ref<string>(SKILLS_SLOT_ID);

// skills tab
const providers = ref<ProviderInfo[]>([]);
const activeProviderId = ref<string | null>(null);
const loadingProviders = ref(false);
const testingProviderIds = ref<Set<string>>(new Set());
const copyingProviderIds = ref<Set<string>>(new Set());
const enablingProviderIds = ref<Set<string>>(new Set());

// CLI tabs
const tools = ref<ToolInfo[]>([]);
const scanning = ref(false);
const installingIds = ref<Set<string>>(new Set());
const ensuringIds = ref<Set<string>>(new Set());

// modal
const modalOpen = ref(false);
const modalCliId = ref<string | null>(null);
const modalEditProviderId = ref<string | null>(null);

// ── computed ──
const activeTab = computed(() => TABS.find(t => t.id === activeTabId.value) || TABS[0]);
const isSkillsTab = computed(() => activeTabId.value === SKILLS_SLOT_ID);

const currentTool = computed(() => tools.value.find(t => t.id === activeTabId.value) || null);
const cliTabs = computed(() => TABS.filter(t => t.id !== SKILLS_SLOT_ID));
const configuredCliCount = computed(() => tools.value.filter(t => t.status === 'configured').length);
const detectedCliCount = computed(() => tools.value.filter(t => t.status === 'detected').length);
const missingCliCount = computed(() => tools.value.filter(t => t.status === 'missing').length);
const activeProvider = computed(() => providers.value.find(p => p.id === activeProviderId.value) || null);
const enabledProviderCount = computed(() => providers.value.filter(p => p.enabled !== false).length);
const readyProviderCount = computed(() => providers.value.filter(p => p.enabled !== false && p.apiKeySet).length);
const nativeConfigFiles = computed(() => currentTool.value?.nativeConfig?.files || []);
const nativeEnabledProviderId = computed(() => currentTool.value?.nativeConfig?.meta?.providerId || null);

const toolStatus = computed(() => {
  const t = currentTool.value;
  if (!t) return { label: '未知', cls: 'text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.06]' };
  switch (t.status) {
    case 'configured': return { label: '配置就绪', cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20' };
    case 'detected':  return { label: '已检测到', cls: 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-500/10 border-sky-200 dark:border-sky-500/20' };
    default:          return { label: '未安装',   cls: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20' };
  }
});

const modalProps = computed(() => {
  const id = modalCliId.value;
  if (!id) return { cliId: null, cliName: '', supportedUpstream: [] as UpstreamProtocol[], launchCommand: '' };
  const tab = TABS.find(t => t.id === id);
  return {
    cliId: id,
    cliName: tab?.label || id,
    supportedUpstream: tab?.supportedUpstream || (['openai'] as UpstreamProtocol[]),
    launchCommand: '',
  };
});

const enabledCount = computed(() => providers.value.filter(p => p.enabled !== false).length);

const activeProviderSummary = computed(() => {
  const p = activeProvider.value;
  if (!p) return '尚未选择默认方案';
  return `${providerModelLabel(p)} · ${providerBaseLabel(p)}`;
});

interface ProviderCopyResponse {
  ok: boolean;
  id: string;
}

interface ProviderTestResponse {
  ok: boolean;
  status?: number;
  ms?: number;
  probe?: string;
  model?: string;
  upstreamProtocol?: UpstreamProtocol;
  error?: string;
}

// ── skills: providers ──
async function loadProviders(cliId: string): Promise<void> {
  loadingProviders.value = true;
  try {
    const resp = await requestJson<ProvidersResponse>(`/api/agent/providers/${encodeURIComponent(cliId)}`);
    providers.value = resp.providers || [];
    activeProviderId.value = resp.activeProviderId || null;
  } catch {
    providers.value = [];
  } finally {
    loadingProviders.value = false;
  }
}

async function toggleEnabled(p: ProviderInfo): Promise<void> {
  const next = !(p.enabled !== false);
  // optimistic: update UI immediately
  p.enabled = next;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(activeTabId.value)}/${encodeURIComponent(p.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: next }),
    });
    await loadProviders(activeTabId.value);
  } catch {
    // revert on failure + reload truth from backend
    p.enabled = !next;
    await loadProviders(activeTabId.value);
    notify.error('切换失败，已恢复');
  }
}

async function setActive(providerId: string): Promise<void> {
  if (providerId === activeProviderId.value) return;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(activeTabId.value)}/${encodeURIComponent(providerId)}/activate`, { method: 'PUT' } as any);
    activeProviderId.value = providerId;
    notify.success('已切换当前配置方案');
  } catch {
    notify.error('切换失败');
  }
}

function isProviderNativeEnabled(p: ProviderInfo): boolean {
  if (isSkillsTab.value) return false;
  const nativeConfig = currentTool.value?.nativeConfig;
  return Boolean(nativeConfig?.configured && nativeConfig?.meta?.providerId === p.id);
}

async function enableProviderConfig(p: ProviderInfo): Promise<void> {
  if (isSkillsTab.value || enablingProviderIds.value.has(p.id)) return;
  const cliId = activeTabId.value;
  setBusyFlag(enablingProviderIds, p.id, true);
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(cliId)}/${encodeURIComponent(p.id)}/activate`, {
      method: 'PUT',
      body: JSON.stringify({ modelId: p.activeModelId || p.routeModelId || null }),
    } as any);
    activeProviderId.value = p.id;
    const resp = await requestJson<{ ok: boolean; error?: string }>(
      `/api/agent/native-config/enable/${encodeURIComponent(cliId)}`,
      { method: 'POST', body: JSON.stringify({}) } as any,
    );
    if (!resp.ok) throw new Error(resp.error || '启用失败');
    notify.success(`${p.name || '配置方案'} 已启用`);
    await Promise.all([loadProviders(cliId), loadScan()]);
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    setBusyFlag(enablingProviderIds, p.id, false);
  }
}

async function deleteProvider(providerId: string): Promise<void> {
  const p = providers.value.find(x => x.id === providerId);
  const ok = await confirm({
    title: '删除配置方案',
    message: `确定删除 ${activeTab.value.label} 的配置方案"${p?.name || providerId}"吗？此操作不会影响其他入口。`,
  });
  if (!ok) return;
  try {
    await requestJson(`/api/agent/providers/${encodeURIComponent(activeTabId.value)}/${encodeURIComponent(providerId)}`, { method: 'DELETE' } as any);
    notify.success('配置方案已删除');
    await loadProviders(activeTabId.value);
  } catch {
    notify.error('删除失败');
  }
}

async function testProvider(p: ProviderInfo): Promise<void> {
  if (testingProviderIds.value.has(p.id)) return;
  setBusyFlag(testingProviderIds, p.id, true);
  try {
    const resp = await requestJson<ProviderTestResponse>(`/api/agent/providers/${encodeURIComponent(activeTabId.value)}/${encodeURIComponent(p.id)}/test`, {
      method: 'POST',
      body: JSON.stringify({ modelId: p.activeModelId || p.routeModelId || null }),
    });
    if (resp.ok) {
      const ms = typeof resp.ms === 'number' ? ` · ${resp.ms}ms` : '';
      notify.success(`${p.name || '配置方案'} 测试通过${ms}`);
    } else {
      notify.error(resp.error || '测试失败', 8000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 8000);
  } finally {
    setBusyFlag(testingProviderIds, p.id, false);
  }
}

async function copyProvider(p: ProviderInfo): Promise<void> {
  if (copyingProviderIds.value.has(p.id)) return;
  setBusyFlag(copyingProviderIds, p.id, true);
  try {
    await requestJson<ProviderCopyResponse>(`/api/agent/providers/${encodeURIComponent(activeTabId.value)}/${encodeURIComponent(p.id)}/copy`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    notify.success(`${p.name || '配置方案'} 已复制为 ${p.name || '配置方案'}-copy`);
    await loadProviders(activeTabId.value);
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 8000);
  } finally {
    setBusyFlag(copyingProviderIds, p.id, false);
  }
}

function openAddModal(): void {
  modalCliId.value = activeTabId.value;
  modalEditProviderId.value = null;
  modalOpen.value = true;
}

function openEditModal(providerId: string): void {
  modalCliId.value = activeTabId.value;
  modalEditProviderId.value = providerId;
  modalOpen.value = true;
}

async function onModalChanged(): Promise<void> {
  await loadProviders(activeTabId.value);
  if (!isSkillsTab.value) await loadScan();
}

// ── CLI: scan & actions ──
async function loadScan(): Promise<void> {
  scanning.value = true;
  try {
    const resp = await requestJson<ScanResponse>('/api/agent/scan');
    tools.value = resp.tools || [];
  } catch {
    tools.value = [];
  } finally {
    scanning.value = false;
  }
}

function setBusyFlag(set: Ref<Set<string>>, id: string, busy: boolean): void {
  const next = new Set(set.value);
  if (busy) next.add(id); else next.delete(id);
  set.value = next;
}

async function onScan(): Promise<void> {
  scanning.value = true;
  try {
    await loadScan();
    notify.success('扫描完成');
  } finally {
    scanning.value = false;
  }
}

async function onInstall(): Promise<void> {
  const id = activeTabId.value;
  const tool = currentTool.value;
  if (!tool || installingIds.value.has(id)) return;
  if (tool.binary?.installed) {
    notify.info(`${tool.name || id} 已安装`);
    return;
  }
  if (!tool.install?.command) {
    if (tool.install?.docsUrl) window.open(tool.install.docsUrl, '_blank', 'noopener,noreferrer');
    notify.error('暂无自动安装命令，请查看官方文档');
    return;
  }
  if (!window.confirm(`1Shell 将自动执行安装命令：\n\n${tool.install.command}\n\n是否继续？`)) return;
  setBusyFlag(installingIds, id, true);
  notify.info(`正在安装 ${tool.name || id}...`, 0);
  try {
    const resp = await requestJson<InstallCliResponse>(`/api/agent/install/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({}) } as any);
    await loadScan();
    if (resp.ok && resp.installed) {
      notify.success(`${tool.name || id} 安装完成`);
    } else if (resp.ok) {
      notify.warn(`安装命令已执行，但仍未检测到，请尝试重新扫描`, 8000);
    } else {
      notify.error(resp.error || '安装失败', 8000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 8000);
  } finally {
    setBusyFlag(installingIds, id, false);
  }
}

async function onUpdate(): Promise<void> {
  // Re-run install — most package managers handle update as reinstall
  await onInstall();
}

async function onEnsureNativeConfig(): Promise<void> {
  const id = activeTabId.value;
  const tool = currentTool.value;
  setBusyFlag(ensuringIds, id, true);
  try {
    const resp = await requestJson<{ ok: boolean; error?: string }>(`/api/agent/native-config/enable/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({}) } as any);
    if (resp.ok) {
      notify.success(`${tool?.name || id} 配置已启用`);
      await loadScan();
    } else {
      notify.error(resp.error || '启用失败', 5000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    setBusyFlag(ensuringIds, id, false);
  }
}

async function onResetNativeConfig(): Promise<void> {
  const id = activeTabId.value;
  const tool = currentTool.value;
  if (!window.confirm(`确定要重置 ${tool?.name || id} 的 1Shell 配置状态吗？\n\n这不会删除整个主机配置目录，只会清除 1Shell 的覆盖标记。`)) return;
  try {
    const resp = await requestJson<{ ok: boolean; error?: string }>(`/api/agent/native-config/reset/${encodeURIComponent(id)}`, { method: 'POST' } as any);
    if (resp.ok) {
      notify.success(`${tool?.name || id} 配置状态已重置`);
      await loadScan();
    } else {
      notify.error(resp.error || '重置失败', 5000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

async function onSetBinary(): Promise<void> {
  const id = activeTabId.value;
  const tool = currentTool.value;
  const current = tool?.binary?.override ? tool?.binary?.path || '' : '';
  const input = window.prompt(`请输入 ${tool?.name || id} 可执行文件完整路径`, current);
  if (input === null) return;
  const binaryPath = input.trim();
  if (!binaryPath) { notify.error('路径不能为空'); return; }
  try {
    const resp = await requestJson<BinaryOverrideResponse>(`/api/agent/binary/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ path: binaryPath }) } as any);
    if (resp.ok) {
      notify.success(`${tool?.name || id} 路径已保存`);
      await loadScan();
    } else {
      notify.error(resp.error || '保存失败', 5000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

async function onClearBinary(): Promise<void> {
  const id = activeTabId.value;
  const tool = currentTool.value;
  if (!window.confirm(`确定要清除 ${tool?.name || id} 的手动路径吗？`)) return;
  try {
    const resp = await requestJson<BinaryOverrideResponse>(`/api/agent/binary/${encodeURIComponent(id)}`, { method: 'DELETE' } as any);
    if (resp.ok) {
      notify.success(`${tool?.name || id} 已恢复 PATH 自动扫描`);
      await loadScan();
    } else {
      notify.error(resp.error || '清除失败', 5000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

async function onDiagnose(): Promise<void> {
  const id = activeTabId.value;
  try {
    const resp = await requestJson<CliDiagnosticsResponse>(`/api/agent/diagnostics/${encodeURIComponent(id)}`);
    const failed = (resp.checks || []).filter(c => !c.ok);
    if (failed.length === 0) {
      notify.success(`${resp.tool?.name || id} 接入诊断通过`);
    } else {
      notify.error(`${failed.length} 项待处理：${failed[0]?.error || failed[0]?.name || '未知'}`, 7000);
    }
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  }
}

// ── helpers ──
function fmtBase(url: string): string {
  try { const u = new URL(url); return u.host + (u.pathname !== '/' ? u.pathname : ''); }
  catch { return url.replace(/https?:\/\//, '').replace(/\/+$/, ''); }
}

function getTool(tabId: string): ToolInfo | null {
  return tools.value.find(t => t.id === tabId) || null;
}

function tabStatusText(tab: TabDef): string {
  if (tab.id === SKILLS_SLOT_ID) return `${enabledProviderCount.value} 启用`;
  const tool = getTool(tab.id);
  if (!tool) return scanning.value ? '扫描中' : '待扫描';
  if (tool.status === 'configured') return '就绪';
  if (tool.status === 'detected') return '已检测';
  return '未安装';
}

function tabStatusClass(tab: TabDef): string {
  if (tab.id === SKILLS_SLOT_ID) {
    return enabledProviderCount.value > 0
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25'
      : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/[0.05] dark:text-slate-400 dark:border-white/[0.08]';
  }
  const status = getTool(tab.id)?.status;
  if (status === 'configured') return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25';
  if (status === 'detected') return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/25';
  if (status === 'missing') return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25';
  return 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-white/[0.05] dark:text-slate-400 dark:border-white/[0.08]';
}

function statusDotClass(status?: string): string {
  if (status === 'configured') return 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]';
  if (status === 'detected') return 'bg-sky-500 shadow-[0_0_0_3px_rgba(14,165,233,0.14)]';
  if (status === 'missing') return 'bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.14)]';
  return 'bg-slate-300 dark:bg-slate-600';
}

function toolStatusTextClass(status?: string): string {
  if (status === 'configured') return 'text-emerald-600 dark:text-emerald-300';
  if (status === 'detected') return 'text-sky-600 dark:text-sky-300';
  if (status === 'missing') return 'text-amber-600 dark:text-amber-300';
  return 'text-slate-500 dark:text-slate-400';
}

function providerModelLabel(p: ProviderInfo): string {
  return p.model || p.activeModelId || p.routeModelId || '未指定模型';
}

function providerBaseLabel(p: ProviderInfo): string {
  return p.apiBase ? fmtBase(p.apiBase) : '未设置 API Base';
}

function providerProtocolLabel(p: ProviderInfo): string {
  return UPSTREAM_LABELS[p.upstreamProtocol] || p.upstreamProtocol;
}

function providerKeyText(p: ProviderInfo): string {
  if (p.enabled === false) return '已禁用';
  return p.apiKeySet ? 'Key 就绪' : '缺少 Key';
}

function providerKeyClass(p: ProviderInfo): string {
  if (p.enabled === false) return 'text-slate-500 bg-slate-100 border-slate-200 dark:bg-white/[0.05] dark:text-slate-400 dark:border-white/[0.08]';
  if (p.apiKeySet) return 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25';
  return 'text-amber-700 bg-amber-50 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25';
}

// ── lifecycle ──
function switchTab(cliId: string): void {
  if (activeTabId.value === cliId) return;
  activeTabId.value = cliId;
  void loadProviders(cliId);
  if (cliId !== SKILLS_SLOT_ID) void loadScan();
}

onMounted(() => {
  void loadProviders(activeTabId.value);
  void loadScan();
});
</script>

<template>
  <div class="h-full min-w-0 flex flex-col lg:flex-row overflow-hidden bg-[#eef3f8] text-slate-700 dark:bg-[#050814] dark:text-slate-200">
    <nav class="w-full lg:w-[276px] shrink-0 flex flex-col border-b lg:border-b-0 lg:border-r border-slate-200/80 dark:border-white/[0.07] bg-white/80 dark:bg-[#0a0f1d]/95 backdrop-blur-xl select-none">
      <div class="px-5 pt-5 pb-4 border-b border-slate-200/70 dark:border-white/[0.06]">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-slate-950 text-white dark:bg-white dark:text-slate-950 flex items-center justify-center shadow-sm">
            <AppIcon name="spark" :size="18" />
          </div>
          <div class="min-w-0">
            <h1 class="text-sm font-bold text-slate-950 dark:text-white">模型接入</h1>
            <p class="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">AI 引擎与原生 CLI 配置</p>
          </div>
        </div>

        <div class="hidden sm:grid mt-4 grid-cols-2 gap-2">
          <div class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.04] px-3 py-2">
            <div class="text-[10px] font-semibold text-slate-400 dark:text-slate-500">启用接入</div>
            <div class="mt-1 text-lg font-bold text-slate-950 dark:text-white">{{ enabledProviderCount }}</div>
          </div>
          <div class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.04] px-3 py-2">
            <div class="text-[10px] font-semibold text-slate-400 dark:text-slate-500">CLI 就绪</div>
            <div class="mt-1 text-lg font-bold text-slate-950 dark:text-white">{{ configuredCliCount }}/{{ cliTabs.length }}</div>
          </div>
        </div>
      </div>

      <div class="lg:flex-1 lg:min-h-0 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto px-3 py-3">
        <div class="flex lg:block gap-2 lg:gap-0 min-w-max lg:min-w-0">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="group w-[220px] lg:w-full min-h-[64px] text-left px-3 py-3 lg:mb-2 rounded-lg border transition-all cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
          :class="activeTabId === tab.id
            ? 'border-slate-300 bg-white shadow-sm dark:border-white/[0.14] dark:bg-white/[0.07]'
            : 'border-transparent bg-transparent hover:border-slate-200 hover:bg-white/70 dark:hover:border-white/[0.08] dark:hover:bg-white/[0.04]'"
          @click="switchTab(tab.id)"
        >
          <div class="flex items-start gap-3">
            <div
              class="mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center border transition-colors"
              :class="activeTabId === tab.id
                ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300'
                : 'border-slate-200 bg-white text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-400'"
            >
              <AppIcon :name="tab.icon" :size="17" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{{ tab.label }}</span>
                <span class="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold" :class="tabStatusClass(tab)">
                  {{ tabStatusText(tab) }}
                </span>
              </div>
              <div class="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400 truncate">{{ tab.desc }}</div>
            </div>
          </div>
        </button>
        </div>
      </div>

      <div class="hidden lg:block px-5 py-4 border-t border-slate-200/70 dark:border-white/[0.06]">
        <div class="flex items-center justify-between text-[11px]">
          <span class="text-slate-500 dark:text-slate-400">扫描状态</span>
          <span class="font-semibold text-slate-700 dark:text-slate-200">{{ scanning ? '刷新中' : '已同步' }}</span>
        </div>
        <div class="mt-3 flex gap-1.5">
          <span class="h-1.5 flex-1 rounded-full bg-emerald-400/80" :class="configuredCliCount ? '' : 'opacity-25'"></span>
          <span class="h-1.5 flex-1 rounded-full bg-sky-400/80" :class="detectedCliCount ? '' : 'opacity-25'"></span>
          <span class="h-1.5 flex-1 rounded-full bg-amber-400/80" :class="missingCliCount ? '' : 'opacity-25'"></span>
        </div>
      </div>
    </nav>

    <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
      <template v-if="isSkillsTab">
        <header class="shrink-0 border-b border-slate-200/80 dark:border-white/[0.07] bg-white/78 dark:bg-[#0a0f1d]/90 backdrop-blur-xl">
          <div class="px-4 sm:px-5 lg:px-7 py-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 sm:gap-5">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="inline-flex w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]"></span>
                <span class="text-[11px] font-bold uppercase text-slate-400 dark:text-slate-500">1Shell Runtime</span>
              </div>
              <h2 class="mt-2 text-xl font-bold text-slate-950 dark:text-white">1Shell AI 引擎</h2>
              <p class="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
                Agent、Skill 与 IDE 创作共用这里的模型接入。当前默认：{{ activeProviderSummary }}
              </p>
            </div>
            <button
              type="button"
              class="h-9 px-3.5 rounded-lg bg-slate-950 text-white dark:bg-white dark:text-slate-950 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
              @click="openAddModal"
            >
              <AppIcon name="plus" :size="14" />
              添加接入
            </button>
          </div>

          <div class="px-4 sm:px-5 lg:px-7 pb-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/70 dark:bg-white/[0.04] px-4 py-3">
              <div class="text-[11px] font-semibold text-slate-400 dark:text-slate-500">配置方案</div>
              <div class="mt-1 text-lg font-bold text-slate-950 dark:text-white">{{ providers.length }}</div>
            </div>
            <div class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/70 dark:bg-white/[0.04] px-4 py-3">
              <div class="text-[11px] font-semibold text-slate-400 dark:text-slate-500">启用中</div>
              <div class="mt-1 text-lg font-bold text-emerald-600 dark:text-emerald-300">{{ enabledProviderCount }}</div>
            </div>
            <div class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/70 dark:bg-white/[0.04] px-4 py-3">
              <div class="text-[11px] font-semibold text-slate-400 dark:text-slate-500">Key 就绪</div>
              <div class="mt-1 text-lg font-bold text-slate-950 dark:text-white">{{ readyProviderCount }}</div>
            </div>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto px-4 sm:px-5 lg:px-7 py-5 lg:py-6">
          <div v-if="loadingProviders" class="h-full min-h-[360px] flex items-center justify-center">
            <span class="inline-block w-4 h-4 rounded-full bg-sky-500 animate-pulse"></span>
            <span class="ml-3 text-sm text-slate-500 dark:text-slate-400">正在读取模型接入...</span>
          </div>

          <div v-else-if="!providers.length" class="h-full min-h-[360px] flex items-center justify-center">
            <div class="max-w-sm text-center">
              <div class="mx-auto w-12 h-12 rounded-lg bg-white dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center">
                <AppIcon name="spark" :size="23" class="text-slate-400 dark:text-slate-500" />
              </div>
              <h3 class="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-200">暂无模型接入</h3>
              <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">添加后，Agent 页面和 IDE 的 /model 会读取这些配置。</p>
              <button
                type="button"
                class="mt-5 h-9 px-4 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                @click="openAddModal"
              >
                添加接入
              </button>
            </div>
          </div>

          <div v-else class="space-y-3">
            <div
              v-for="p in providers"
              :key="p.id"
              class="grid grid-cols-1 md:grid-cols-[auto_minmax(0,1fr)_auto] items-start md:items-center gap-4 rounded-lg border bg-white/86 dark:bg-white/[0.045] px-4 py-3 shadow-sm transition-all cursor-pointer"
              :class="p.id === activeProviderId
                ? 'border-emerald-300 dark:border-emerald-500/40 ring-1 ring-emerald-200/80 dark:ring-emerald-500/20'
                : 'border-slate-200/80 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/[0.14] hover:bg-white dark:hover:bg-white/[0.065]'"
              @click="setActive(p.id)"
            >
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  class="relative w-9 h-5 rounded-full transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                  :class="p.enabled !== false ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"
                  :aria-label="p.enabled !== false ? '禁用配置方案' : '启用配置方案'"
                  :title="p.enabled !== false ? '已启用，点击禁用' : '未启用，点击启用'"
                  @click.stop="toggleEnabled(p)"
                >
                  <span class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform" :class="p.enabled !== false ? 'left-[18px]' : 'left-[2px]'"></span>
                </button>
                <span class="w-2.5 h-2.5 rounded-full" :class="p.id === activeProviderId ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
              </div>

              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ p.name || '未命名配置' }}</span>
                  <span v-if="p.id === activeProviderId" class="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">默认</span>
                  <span class="rounded-md border px-1.5 py-0.5 text-[10px] font-semibold" :class="providerKeyClass(p)">{{ providerKeyText(p) }}</span>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <span class="font-mono truncate max-w-[280px]">{{ providerModelLabel(p) }}</span>
                  <span>{{ providerProtocolLabel(p) }}</span>
                  <span class="font-mono truncate max-w-[320px]">{{ providerBaseLabel(p) }}</span>
                </div>
              </div>

              <div class="shrink-0 flex items-center gap-1 rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/80 dark:bg-white/[0.04] p-1 overflow-x-auto max-w-full">
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                  :disabled="testingProviderIds.has(p.id)"
                  title="测试配置方案"
                  @click.stop="testProvider(p)"
                >
                  <AppIcon name="radio" :size="13" />
                  {{ testingProviderIds.has(p.id) ? '测试中' : '测试' }}
                </button>
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                  :disabled="copyingProviderIds.has(p.id)"
                  title="复制配置方案"
                  @click.stop="copyProvider(p)"
                >
                  <AppIcon name="copy" :size="13" />
                  {{ copyingProviderIds.has(p.id) ? '复制中' : '复制' }}
                </button>
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer"
                  title="编辑配置方案"
                  @click.stop="openEditModal(p.id)"
                >
                  <AppIcon name="cog" :size="13" />
                  设置
                </button>
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                  title="删除配置方案"
                  @click.stop="deleteProvider(p.id)"
                >
                  <AppIcon name="trash" :size="13" />
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <header class="shrink-0 border-b border-slate-200/80 dark:border-white/[0.07] bg-white/78 dark:bg-[#0a0f1d]/90 backdrop-blur-xl">
          <div class="px-4 sm:px-5 lg:px-7 py-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 sm:gap-5">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="inline-flex w-2.5 h-2.5 rounded-full" :class="statusDotClass(currentTool?.status)"></span>
                <span class="text-[11px] font-bold uppercase text-slate-400 dark:text-slate-500">Native CLI</span>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-3">
                <h2 class="text-xl font-bold text-slate-950 dark:text-white">{{ activeTab.label }}</h2>
                <span class="rounded-md border px-2 py-1 text-[11px] font-bold" :class="toolStatus.cls">{{ toolStatus.label }}</span>
              </div>
              <p class="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{{ activeTab.desc }} · 配置会写入本机原生配置文件，供 CLI 启动时读取。</p>
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <button
                type="button"
                class="h-9 px-3 rounded-lg border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.04] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.07] transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                :disabled="scanning"
                @click="onScan"
              >
                <AppIcon name="radio" :size="13" />
                {{ scanning ? '扫描中' : '扫描' }}
              </button>
              <button
                v-if="currentTool?.status === 'missing'"
                type="button"
                class="h-9 px-3 rounded-lg bg-slate-950 text-white dark:bg-white dark:text-slate-950 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                :disabled="installingIds.has(activeTabId)"
                @click="onInstall"
              >
                <AppIcon name="download" :size="13" />
                {{ installingIds.has(activeTabId) ? '安装中' : '安装' }}
              </button>
              <button
                v-if="currentTool?.status !== 'missing'"
                type="button"
                class="h-9 px-3 rounded-lg border border-amber-200 bg-amber-50 text-xs font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/15 transition-all cursor-pointer flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
                @click="onUpdate"
              >
                <AppIcon name="arrow-up" :size="13" />
                更新
              </button>
            </div>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto px-4 sm:px-5 lg:px-7 py-5 lg:py-6 space-y-5">
          <section class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white/86 dark:bg-white/[0.045] shadow-sm">
            <div class="grid grid-cols-1 lg:grid-cols-[1.1fr_1.5fr]">
              <div class="p-5 border-b lg:border-b-0 lg:border-r border-slate-200/80 dark:border-white/[0.07]">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-sm font-bold text-slate-900 dark:text-white">CLI 状态</h3>
                  <span v-if="currentTool" class="inline-flex items-center gap-1.5 text-xs font-semibold" :class="toolStatusTextClass(currentTool.status)">
                    <span class="w-2 h-2 rounded-full" :class="statusDotClass(currentTool.status)"></span>
                    {{ toolStatus.label }}
                  </span>
                </div>

                <div v-if="!currentTool" class="mt-5 rounded-lg border border-dashed border-slate-300 dark:border-white/[0.12] px-4 py-8 text-center">
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ scanning ? '正在扫描 CLI...' : '尚未扫描 CLI' }}</div>
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">扫描后会显示安装状态、版本和配置目录。</p>
                </div>

                <div v-else class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div class="rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.07] p-3">
                    <div class="text-slate-400 dark:text-slate-500">名称</div>
                    <div class="mt-1 font-semibold text-slate-900 dark:text-white truncate">{{ currentTool.name }}</div>
                  </div>
                  <div class="rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.07] p-3">
                    <div class="text-slate-400 dark:text-slate-500">版本</div>
                    <div class="mt-1 font-semibold text-slate-900 dark:text-white truncate">{{ currentTool.binary?.version || '待检测' }}</div>
                  </div>
                  <div class="sm:col-span-2 rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.07] p-3">
                    <div class="text-slate-400 dark:text-slate-500">可执行文件</div>
                    <div class="mt-1 font-mono text-[11px] font-semibold text-slate-900 dark:text-white truncate">{{ currentTool.binary?.path || '未找到 PATH 或手动路径' }}</div>
                  </div>
                  <div class="sm:col-span-2 rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.07] p-3">
                    <div class="text-slate-400 dark:text-slate-500">配置目录</div>
                    <div class="mt-1 font-mono text-[11px] font-semibold text-slate-900 dark:text-white truncate">{{ currentTool.nativeConfig?.configDir || '尚未启用原生配置' }}</div>
                  </div>
                </div>
              </div>

              <div class="p-5">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-sm font-bold text-slate-900 dark:text-white">原生配置控制</h3>
                  <span class="text-[11px] text-slate-500 dark:text-slate-400">{{ nativeConfigFiles.length }} 个配置文件</span>
                </div>

                <div v-if="currentTool" class="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="h-8 px-3 rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-950 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:cursor-wait disabled:opacity-60"
                    :disabled="ensuringIds.has(activeTabId)"
                    @click="onEnsureNativeConfig"
                  >
                    {{ ensuringIds.has(activeTabId) ? '启用中' : '启用配置' }}
                  </button>
                  <button
                    v-if="currentTool.nativeConfig?.configDir"
                    type="button"
                    class="h-8 px-3 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-600 hover:bg-red-100 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15 transition-all cursor-pointer"
                    @click="onResetNativeConfig"
                  >
                    重置配置状态
                  </button>
                  <button
                    type="button"
                    class="h-8 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.07] transition-all cursor-pointer"
                    @click="onSetBinary"
                  >
                    指定路径
                  </button>
                  <button
                    v-if="currentTool.binary?.override"
                    type="button"
                    class="h-8 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.07] transition-all cursor-pointer"
                    @click="onClearBinary"
                  >
                    清除路径
                  </button>
                  <button
                    type="button"
                    class="h-8 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.07] transition-all cursor-pointer"
                    @click="onDiagnose"
                  >
                    诊断
                  </button>
                </div>

                <div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div class="rounded-lg border border-slate-200/70 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.04] px-3 py-2">
                    <div class="text-[11px] text-slate-400 dark:text-slate-500">当前原生方案</div>
                    <div class="mt-1 text-xs font-semibold text-slate-900 dark:text-white truncate">{{ nativeEnabledProviderId || '未绑定' }}</div>
                  </div>
                  <div class="rounded-lg border border-slate-200/70 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.04] px-3 py-2">
                    <div class="text-[11px] text-slate-400 dark:text-slate-500">接入方案</div>
                    <div class="mt-1 text-xs font-semibold text-slate-900 dark:text-white">{{ providers.length }} 个</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white/86 dark:bg-white/[0.045] shadow-sm">
            <div class="px-5 py-4 flex items-center justify-between gap-3 border-b border-slate-200/80 dark:border-white/[0.07]">
              <div>
                <h3 class="text-sm font-bold text-slate-900 dark:text-white">原生配置方案</h3>
                <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">编辑 1Shell 草稿，点击启用后写入 {{ activeTab.label }} 原生配置。</p>
              </div>
              <button
                type="button"
                class="h-8 px-3 rounded-lg border border-sky-200 bg-sky-50 text-[11px] font-semibold text-sky-700 hover:bg-sky-100 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/15 transition-all cursor-pointer flex items-center gap-1.5"
                @click="openAddModal"
              >
                <AppIcon name="plus" :size="12" />
                添加
              </button>
            </div>

            <div class="p-5">
              <div v-if="loadingProviders" class="py-12 text-center text-sm text-slate-500 dark:text-slate-400">正在加载配置方案...</div>

              <div v-else-if="!providers.length" class="rounded-lg border border-dashed border-slate-300 dark:border-white/[0.12] px-4 py-12 text-center">
                <div class="mx-auto w-11 h-11 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.04] flex items-center justify-center">
                  <AppIcon name="file-plus" :size="21" class="text-slate-400 dark:text-slate-500" />
                </div>
                <h4 class="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-200">暂无原生配置方案</h4>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">添加后可测试、复制、编辑，并启用到原生配置文件。</p>
              </div>

              <div v-else class="space-y-3">
                <div
                  v-for="p in providers"
                  :key="p.id"
                  class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_auto] items-start xl:items-center gap-4 rounded-lg border bg-white dark:bg-[#0d1424] px-4 py-3 transition-all cursor-pointer"
                  :class="p.id === activeProviderId
                    ? 'border-emerald-300 dark:border-emerald-500/40 ring-1 ring-emerald-200/80 dark:ring-emerald-500/20'
                    : 'border-slate-200/80 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/[0.14]'"
                  @click="setActive(p.id)"
                >
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="w-2.5 h-2.5 rounded-full" :class="p.id === activeProviderId ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
                      <span class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ p.name || '未命名配置' }}</span>
                      <span v-if="p.id === activeProviderId" class="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300">当前</span>
                      <span v-if="isProviderNativeEnabled(p)" class="rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300">已写入原生</span>
                      <span class="rounded-md border px-1.5 py-0.5 text-[10px] font-semibold" :class="providerKeyClass(p)">{{ providerKeyText(p) }}</span>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span class="font-mono truncate max-w-[280px]">{{ providerModelLabel(p) }}</span>
                      <span>{{ providerProtocolLabel(p) }}</span>
                      <span class="font-mono truncate max-w-[360px]">{{ providerBaseLabel(p) }}</span>
                    </div>
                  </div>

                  <div class="shrink-0 flex items-center gap-1 rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/80 dark:bg-white/[0.04] p-1 overflow-x-auto max-w-full">
                    <button
                      type="button"
                      class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                      :disabled="enablingProviderIds.has(p.id)"
                      title="启用该配置方案到原生配置文件"
                      @click.stop="enableProviderConfig(p)"
                    >
                      <AppIcon name="check" :size="12" />
                      {{ enablingProviderIds.has(p.id) ? '启用中' : (isProviderNativeEnabled(p) ? '已启用' : '启用') }}
                    </button>
                    <button
                      type="button"
                      class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                      :disabled="testingProviderIds.has(p.id)"
                      title="测试配置方案"
                      @click.stop="testProvider(p)"
                    >
                      <AppIcon name="radio" :size="12" />
                      {{ testingProviderIds.has(p.id) ? '测试中' : '测试' }}
                    </button>
                    <button
                      type="button"
                      class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                      :disabled="copyingProviderIds.has(p.id)"
                      title="复制配置方案"
                      @click.stop="copyProvider(p)"
                    >
                      <AppIcon name="copy" :size="12" />
                      {{ copyingProviderIds.has(p.id) ? '复制中' : '复制' }}
                    </button>
                    <button
                      type="button"
                      class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer"
                      title="设置"
                      @click.stop="openEditModal(p.id)"
                    >
                      <AppIcon name="cog" :size="12" />
                      设置
                    </button>
                    <button
                      type="button"
                      class="h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                      title="删除"
                      @click.stop="deleteProvider(p.id)"
                    >
                      <AppIcon name="trash" :size="12" />
                      删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </template>
    </main>

    <ProviderModal
      v-model:open="modalOpen"
      :cli-id="modalProps.cliId"
      :cli-name="modalProps.cliName"
      :supported-upstream="modalProps.supportedUpstream"
      :launch-command="modalProps.launchCommand"
      :edit-provider-id="modalEditProviderId"
      @changed="onModalChanged"
    />
  </div>
</template>
