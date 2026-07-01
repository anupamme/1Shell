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
} from '@/utils/cliSetup';

// ── tab definitions ──
interface TabDef {
  id: string;
  label: string;
  desc: string;
  supportedUpstream: UpstreamProtocol[];
}

const TABS: TabDef[] = [
  { id: SKILLS_SLOT_ID, label: '1Shell AI',   desc: 'Agent · Skill 引擎',         supportedUpstream: ['anthropic', 'openai'] },
  { id: 'claude-code',   label: 'Claude Code', desc: 'Anthropic 官方 CLI',          supportedUpstream: ['anthropic'] },
  { id: 'codex',          label: 'Codex',       desc: 'OpenAI 官方 CLI',             supportedUpstream: ['openai'] },
  { id: 'opencode',       label: 'OpenCode',   desc: '开源终端 AI 助手',             supportedUpstream: ['openai'] },
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
  <div class="h-full flex bg-stone-50 dark:bg-[#0b0f19]">
    <!-- ═══ 左侧：竖排 tab 导航 ═══ -->
    <nav class="w-48 shrink-0 flex flex-col border-r border-slate-200 dark:border-white/[0.05] bg-white dark:bg-[#0f1321] select-none">
      <div class="px-4 py-3">
        <h3 class="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3">模型接入</h3>
      </div>
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="group w-full text-left px-4 py-3 transition-colors cursor-pointer border-l-[3px]"
        :class="activeTabId === tab.id
          ? 'border-sky-500 dark:border-sky-400 bg-sky-50/50 dark:bg-sky-500/[0.04] text-sky-700 dark:text-sky-300'
          : 'border-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.03] hover:text-slate-800 dark:hover:text-slate-200'"
        @click="switchTab(tab.id)"
      >
        <div class="text-sm font-medium">{{ tab.label }}</div>
        <div class="text-[11px] mt-0.5 opacity-60">{{ tab.desc }}</div>
      </button>
    </nav>

    <!-- ═══ 右侧：内容区 ═══ -->
    <main class="flex-1 min-w-0 flex flex-col overflow-hidden">

      <!-- ══════ 1Shell AI tab ══════ -->
      <template v-if="isSkillsTab">
        <header class="shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-white/[0.05] bg-white dark:bg-[#0f1321]">
          <div>
            <h2 class="text-base font-semibold text-slate-800 dark:text-slate-200">1Shell AI 引擎</h2>
            <p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
              Agent 与 Skill 执行的模型接入 · 已启用 <span class="font-semibold text-sky-600 dark:text-sky-400">{{ enabledCount }}</span> 个
            </p>
          </div>
          <button
            type="button"
            class="h-8 px-3 rounded-lg border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/10 text-xs font-medium text-sky-600 dark:text-sky-400 hover:border-sky-400 hover:bg-sky-100 dark:hover:bg-sky-500/20 transition-all cursor-pointer flex items-center gap-1.5"
            @click="openAddModal"
          >
            <AppIcon name="plus" :size="14" />
            添加接入
          </button>
        </header>

        <div class="flex-1 overflow-y-auto p-6">
          <div v-if="loadingProviders" class="flex items-center justify-center py-20">
            <span class="inline-block w-4 h-4 rounded-full bg-sky-400 animate-pulse"></span>
            <span class="ml-3 text-sm text-slate-400 dark:text-slate-500">加载中...</span>
          </div>

          <div v-else-if="!providers.length" class="flex flex-col items-center justify-center py-20 text-center">
            <div class="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.06] flex items-center justify-center mb-4">
              <AppIcon name="spark" :size="24" class="text-slate-300 dark:text-slate-600" />
            </div>
            <h3 class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">暂无配置的模型接入</h3>
            <p class="text-xs text-slate-400 dark:text-slate-600 mb-5">添加模型接入后，在 Agent 页面使用 /model 即可切换</p>
            <button
              type="button"
              class="h-8 px-4 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-xs font-medium transition-colors cursor-pointer"
              @click="openAddModal"
            >添加接入</button>
          </div>

          <!-- provider cards -->
          <div v-else class="space-y-3">
            <div
              v-for="p in providers"
              :key="p.id"
              class="flex items-center gap-4 px-5 py-4 rounded-xl border bg-white dark:bg-[#101827] shadow-sm transition-all group cursor-pointer"
              :class="p.id === activeProviderId
                ? 'border-emerald-300 dark:border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-500/[0.06] ring-1 ring-emerald-200/70 dark:ring-emerald-500/20 shadow-[0_10px_24px_rgba(15,118,110,0.08)]'
                : (p.enabled !== false
                  ? 'border-slate-200 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/[0.14] hover:shadow-md'
                  : 'border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-white/[0.025] hover:border-slate-300 dark:hover:border-white/[0.12]')"
              @click="setActive(p.id)"
            >
              <!-- enable toggle -->
              <button
                type="button"
                class="shrink-0 w-9 h-5 rounded-full transition-colors relative cursor-pointer"
                :class="p.enabled !== false ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600'"
                @click.stop="toggleEnabled(p)"
                :title="p.enabled !== false ? '已启用，点击禁用' : '未启用，点击启用'"
              >
                <span class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform" :class="p.enabled !== false ? 'left-[18px]' : 'left-[2px]'"></span>
              </button>

              <!-- active dot -->
              <span
                class="shrink-0 w-2.5 h-2.5 rounded-full transition-colors"
                :class="p.id === activeProviderId ? 'bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.4)]' : 'bg-slate-300 dark:bg-slate-600'"
              ></span>

              <!-- info -->
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{{ p.name || '未命名' }}</span>
                  <span v-if="p.id === activeProviderId" class="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">活跃</span>
                  <span v-if="p.enabled === false" class="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/[0.04] text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-white/[0.05]">已禁用</span>
                </div>
                <div class="flex items-center gap-2 mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                  <span class="truncate">{{ p.model || '未指定模型' }}</span>
                  <span class="text-slate-300 dark:text-slate-700">·</span>
                  <span class="truncate">{{ fmtBase(p.apiBase || '') }}</span>
                  <span v-if="!p.apiKeySet" class="text-amber-500 dark:text-amber-400 shrink-0">· 未设 Key</span>
                </div>
              </div>

              <!-- actions -->
              <div class="shrink-0 flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-slate-50/80 dark:bg-white/[0.035] p-1 shadow-sm">
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                  :disabled="testingProviderIds.has(p.id)"
                  title="测试配置方案"
                  @click.stop="testProvider(p)"
                >
                  <AppIcon name="radio" :size="13" />
                  {{ testingProviderIds.has(p.id) ? '测试中' : '测试' }}
                </button>
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                  :disabled="copyingProviderIds.has(p.id)"
                  title="复制配置方案"
                  @click.stop="copyProvider(p)"
                >
                  <AppIcon name="copy" :size="13" />
                  {{ copyingProviderIds.has(p.id) ? '复制中' : '复制' }}
                </button>
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer"
                  title="编辑配置方案"
                  @click.stop="openEditModal(p.id)"
                >
                  <AppIcon name="cog" :size="13" />
                  设置
                </button>
                <button
                  type="button"
                  class="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                  title="删除配置方案"
                  @click.stop="deleteProvider(p.id)"
                >
                  <AppIcon name="close" :size="13" />
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ══════ CLI tab (Claude Code / Codex / OpenCode) ══════ -->
      <template v-else>
        <header class="shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-white/[0.05] bg-white dark:bg-[#0f1321]">
          <div class="flex items-center gap-3">
            <h2 class="text-base font-semibold text-slate-800 dark:text-slate-200">{{ activeTab.label }}</h2>
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full border" :class="toolStatus.cls">{{ toolStatus.label }}</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.02] text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/[0.15] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              :disabled="scanning"
              @click="onScan"
            >
              <AppIcon name="radio" :size="13" />
              {{ scanning ? '扫描中...' : '扫描' }}
            </button>
            <button
              v-if="currentTool?.status === 'missing'"
              type="button"
              class="h-8 px-3 rounded-lg border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/10 text-xs font-medium text-sky-600 dark:text-sky-400 hover:border-sky-400 hover:bg-sky-100 dark:hover:bg-sky-500/20 transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              :disabled="installingIds.has(activeTabId)"
              @click="onInstall"
            >
              <AppIcon name="download" :size="13" />
              {{ installingIds.has(activeTabId) ? '安装中...' : '安装' }}
            </button>
            <button
              v-if="currentTool?.status !== 'missing'"
              type="button"
              class="h-8 px-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-xs font-medium text-amber-600 dark:text-amber-400 hover:border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-all cursor-pointer flex items-center gap-1.5"
              @click="onUpdate"
            >
              <AppIcon name="arrow-up" :size="13" />
              更新
            </button>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          <!-- CLI info card -->
          <div class="rounded-xl border border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#0f1321] p-4">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3">CLI 状态</h3>

            <div v-if="!currentTool" class="text-xs text-slate-400 dark:text-slate-500 py-4 text-center">
              {{ scanning ? '正在扫描...' : '点击"扫描"检测 CLI 安装状态' }}
            </div>

            <div v-else class="space-y-2 text-xs">
              <div class="flex justify-between">
                <span class="text-slate-400 dark:text-slate-500">名称</span>
                <span class="text-slate-700 dark:text-slate-200 font-medium">{{ currentTool.name }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate-400 dark:text-slate-500">状态</span>
                <span :class="toolStatus.cls.split(' ').filter(c => c.startsWith('text-')).join(' ')">{{ toolStatus.label }}</span>
              </div>
              <div v-if="currentTool.binary?.path" class="flex justify-between">
                <span class="text-slate-400 dark:text-slate-500">路径</span>
                <span class="text-slate-700 dark:text-slate-200 font-mono truncate max-w-[300px]">{{ currentTool.binary.path }}</span>
              </div>
              <div v-if="currentTool.binary?.version" class="flex justify-between">
                <span class="text-slate-400 dark:text-slate-500">版本</span>
                <span class="text-slate-700 dark:text-slate-200">{{ currentTool.binary.version }}</span>
              </div>
              <div v-if="currentTool.nativeConfig?.configDir" class="flex justify-between">
                <span class="text-slate-400 dark:text-slate-500">配置目录</span>
                <span class="text-slate-700 dark:text-slate-200 font-mono truncate max-w-[300px]">{{ currentTool.nativeConfig.configDir }}</span>
              </div>
            </div>

            <!-- CLI action buttons -->
            <div v-if="currentTool" class="flex flex-wrap gap-2 mt-4 pt-3 border-t border-slate-100 dark:border-white/[0.04]">
              <button
                type="button"
                class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-white/[0.08] text-[11px] text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-white/[0.15] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
                :disabled="ensuringIds.has(activeTabId)"
                @click="onEnsureNativeConfig"
              >{{ ensuringIds.has(activeTabId) ? '启用中...' : '启用配置' }}</button>
              <button
                v-if="currentTool.nativeConfig?.configDir"
                type="button"
                class="h-7 px-2.5 rounded-lg border border-red-200 dark:border-red-500/20 text-[11px] text-red-400 hover:border-red-300 dark:hover:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/5 transition-all cursor-pointer"
                @click="onResetNativeConfig"
              >重置配置状态</button>
              <button
                type="button"
                class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-white/[0.08] text-[11px] text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-white/[0.15] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
                @click="onSetBinary"
              >指定路径</button>
              <button
                v-if="currentTool.binary?.override"
                type="button"
                class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-white/[0.08] text-[11px] text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-white/[0.15] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
                @click="onClearBinary"
              >清除路径</button>
              <button
                type="button"
                class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-white/[0.08] text-[11px] text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-white/[0.15] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
                @click="onDiagnose"
              >诊断</button>
            </div>
          </div>

          <!-- Native config profiles for this CLI -->
          <div class="rounded-xl border border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#0f1321] p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">原生配置方案</h3>
              <button
                type="button"
                class="h-7 px-2.5 rounded-lg border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/10 text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:border-sky-400 hover:bg-sky-100 dark:hover:bg-sky-500/20 transition-all cursor-pointer flex items-center gap-1"
                @click="openAddModal"
              >
                <AppIcon name="plus" :size="11" />
                添加
              </button>
            </div>

            <div v-if="loadingProviders" class="text-xs text-slate-400 text-center py-6">加载中...</div>

            <div v-else-if="!providers.length" class="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
              暂无原生配置方案，点击"添加"配置
            </div>

            <div v-else class="space-y-2">
              <div
                v-for="p in providers"
                :key="p.id"
                class="flex items-center gap-3 px-3.5 py-3 rounded-xl border bg-white dark:bg-[#101827] shadow-sm transition-all group cursor-pointer"
                :class="p.id === activeProviderId
                  ? 'border-emerald-300 dark:border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-500/[0.06] ring-1 ring-emerald-200/60 dark:ring-emerald-500/20'
                  : 'border-slate-200 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/[0.14] hover:shadow-md'"
                @click="setActive(p.id)"
              >
                <span class="w-2 h-2 rounded-full shrink-0" :class="p.id === activeProviderId ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"></span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{{ p.name || '未命名' }}</span>
                    <span v-if="p.id === activeProviderId" class="text-[9px] px-1 rounded bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">活跃</span>
                  </div>
                  <div class="text-[11px] text-slate-400 dark:text-slate-500 truncate">
                    {{ p.model || '未指定模型' }} · {{ fmtBase(p.apiBase || '') }}
                  </div>
                </div>
                <div class="shrink-0 flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-slate-50/80 dark:bg-white/[0.035] p-1 shadow-sm">
                  <button
                    type="button"
                    class="h-7 px-2 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                    :disabled="enablingProviderIds.has(p.id)"
                    title="启用该配置方案到原生配置文件"
                    @click.stop="enableProviderConfig(p)"
                  >
                    <AppIcon name="check" :size="12" />
                    {{ enablingProviderIds.has(p.id) ? '启用中' : (isProviderNativeEnabled(p) ? '已启用' : '启用') }}
                  </button>
                  <button
                    type="button"
                    class="h-7 px-2 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                    :disabled="testingProviderIds.has(p.id)"
                    title="测试配置方案"
                    @click.stop="testProvider(p)"
                  >
                    <AppIcon name="radio" :size="12" />
                    {{ testingProviderIds.has(p.id) ? '测试中' : '测试' }}
                  </button>
                  <button
                    type="button"
                    class="h-7 px-2 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60"
                    :disabled="copyingProviderIds.has(p.id)"
                    title="复制配置方案"
                    @click.stop="copyProvider(p)"
                  >
                    <AppIcon name="copy" :size="12" />
                    {{ copyingProviderIds.has(p.id) ? '复制中' : '复制' }}
                  </button>
                  <button
                    type="button"
                    class="h-7 px-2 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors cursor-pointer"
                    title="设置"
                    @click.stop="openEditModal(p.id)"
                  >
                    <AppIcon name="cog" :size="12" />
                    设置
                  </button>
                  <button
                    type="button"
                    class="h-7 px-2 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                    title="删除"
                    @click.stop="deleteProvider(p.id)"
                  >
                    <AppIcon name="close" :size="12" />
                    删除
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </main>

    <!-- Provider Modal (shared) -->
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
