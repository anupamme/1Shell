<script setup lang="ts">

import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';

import CliCard from '@/components/CliCard.vue';

import EndpointsPanel from '@/components/EndpointsPanel.vue';

import ProviderModal from '@/components/ProviderModal.vue';

import AppIcon from '@/components/AppIcon.vue';

import { useApiClient } from '@/composables/useApiClient';

import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';

import { useNotifyStore } from '@/stores/notify';

import {

  FILTER_OPTIONS,

  SKILLS_SLOT_ID,

  detectShell,

  type BinaryOverrideResponse,

  type CliDiagnosticsResponse,

  type CliStatus,

  type DiagnosticsResponse,

  type EndpointsResponse,

  type InstallCliResponse,

  type LaunchCommandResponse,

  type ProvidersResponse,

  type ScanCounts,

  type ScanResponse,

  type ToolInfo,

  type UpstreamProtocol,

} from '@/utils/cliSetup';



const { requestJson } = useApiClient();

const notify = useNotifyStore();



interface CliPrefs {

  filter: 'all' | CliStatus;

  keyword: string;

}



interface CliCache {

  tools: ToolInfo[];

  counts: ScanCounts | null;

  endpoints: EndpointsResponse | null;

  diagnostics: DiagnosticsResponse['checks'];

  launchCommands: Record<string, string>;

  skillApiReady: boolean;

  skillApiInfo: string;

}



const CLI_PREFS_KEY = '1shell.cli-setup.prefs.v1';

const CLI_CACHE_KEY = 'cli-setup.page.cache.v1';

const CLI_CACHE_TTL_MS = 45_000;

const savedPrefs = readStorageState<CliPrefs>(CLI_PREFS_KEY, { filter: 'all', keyword: '' });



const tools = shallowRef<ToolInfo[]>([]);

const counts = ref<ScanCounts | null>(null);

const endpoints = ref<EndpointsResponse | null>(null);

const endpointsError = ref<string | null>(null);

const endpointsLoading = ref(true);

const diagnostics = ref<DiagnosticsResponse['checks']>([]);

const scanError = ref<string | null>(null);

const rescanning = ref(false);

const installingCliIds = ref<Set<string>>(new Set());



const filter = ref<'all' | CliStatus>(savedPrefs.filter);

const keyword = ref(savedPrefs.keyword);



const launchCommands = reactive<Record<string, string>>({});

const skillApiReady = ref(false);

const skillApiInfo = ref('');



const modalOpen = ref(false);

const modalCliId = ref<string | null>(null);



function saveCliPrefs(): void {

  writeStorageState<CliPrefs>(CLI_PREFS_KEY, { filter: filter.value, keyword: keyword.value });

}



function saveCliCache(): void {

  setCachedPageState<CliCache>(CLI_CACHE_KEY, {

    tools: tools.value,

    counts: counts.value,

    endpoints: endpoints.value,

    diagnostics: diagnostics.value,

    launchCommands: { ...launchCommands },

    skillApiReady: skillApiReady.value,

    skillApiInfo: skillApiInfo.value,

  });

}



function restoreCliCache(): boolean {

  const entry = getCachedPageState<CliCache>(CLI_CACHE_KEY);

  if (!entry) return false;

  tools.value = entry.value.tools || [];

  counts.value = entry.value.counts || null;

  endpoints.value = entry.value.endpoints || null;

  diagnostics.value = entry.value.diagnostics || [];

  Object.assign(launchCommands, entry.value.launchCommands || {});

  skillApiReady.value = Boolean(entry.value.skillApiReady);

  skillApiInfo.value = entry.value.skillApiInfo || '';

  endpointsLoading.value = false;

  return true;

}



const showEngineCard = computed(() => filter.value === 'all' || filter.value === 'sandboxed');



const filteredTools = computed<ToolInfo[]>(() => {

  const kw = keyword.value.trim().toLowerCase();

  return tools.value.filter((t) => {

    if (filter.value !== 'all' && t.status !== filter.value) return false;

    if (!kw) return true;

    const hay = `${t.name} ${t.description} ${t.repo}`.toLowerCase();

    return hay.includes(kw);

  });

});



const filterCount = (f: 'all' | CliStatus): number => {

  const c = counts.value;

  if (!c) return 0;

  if (f === 'all') return c.total;

  return c[f] ?? 0;

};



const modalProps = computed(() => {

  const id = modalCliId.value;

  if (!id) return { cliId: null, cliName: '', supportedUpstream: [] as UpstreamProtocol[], launchCommand: '' };

  if (id === SKILLS_SLOT_ID) {

    return {

      cliId: id,

      cliName: '1Shell AI 引擎',

      supportedUpstream: ['anthropic', 'openai'] as UpstreamProtocol[],

      launchCommand: '',

    };

  }

  const tool = tools.value.find((t) => t.id === id);

  return {

    cliId: id,

    cliName: tool?.name || id,

    supportedUpstream: tool?.supportedUpstream || (['openai'] as UpstreamProtocol[]),

    launchCommand: launchCommands[id] || '',

  };

});



async function loadEndpoints(): Promise<void> {

  endpointsLoading.value = true;

  endpointsError.value = null;

  try {

    endpoints.value = await requestJson<EndpointsResponse>('/api/agent/endpoints');

    saveCliCache();

  } catch (err) {

    endpointsError.value = err instanceof Error ? err.message : String(err);

    endpoints.value = null;

  } finally {

    endpointsLoading.value = false;

  }

}



async function loadDiagnostics(): Promise<void> {

  try {

    const resp = await requestJson<DiagnosticsResponse>('/api/agent/diagnostics');

    diagnostics.value = resp.checks || [];

    saveCliCache();

  } catch {

    /* silent */

  }

}



async function loadLaunchCommand(cliId: string): Promise<void> {

  try {

    const shell = detectShell();

    const resp = await requestJson<LaunchCommandResponse>(

      `/api/agent/launch-command/${encodeURIComponent(cliId)}?shell=${shell}`,

    );

    if (resp.ok) {

      launchCommands[cliId] = resp.command;

      saveCliCache();

    }

  } catch {

    /* silent */

  }

}



async function loadScan(): Promise<void> {

  scanError.value = null;

  try {

    const resp = await requestJson<ScanResponse>('/api/agent/scan');

    tools.value = resp.tools || [];

    counts.value = resp.counts || { total: 0, sandboxed: 0, detected: 0, missing: 0 };

    saveCliCache();

    // 拉取已具备启动价值的 CLI 命令，避免未安装卡片误显示复制入口。

    for (const t of tools.value) {

      if (t.readiness?.launchReady || t.status !== 'missing') {
        void loadLaunchCommand(t.id);
      } else {
        delete launchCommands[t.id];
      }

    }

  } catch (err) {

    scanError.value = err instanceof Error ? err.message : String(err);

    tools.value = [];

  }

}



async function loadSkillApiStatus(): Promise<void> {

  try {

    const resp = await requestJson<ProvidersResponse>(`/api/agent/providers/${SKILLS_SLOT_ID}`);

    const providers = resp.providers || [];

    const active = providers.find((p) => p.id === resp.activeProviderId) || providers[0];

    if (active && active.apiKeySet) {

      skillApiReady.value = true;

      skillApiInfo.value = `${active.name || 'default'} · ${active.model || ''}`;

    } else if (providers.length > 0) {

      skillApiReady.value = false;

      skillApiInfo.value = 'API Key 未设置';

    } else {

      skillApiReady.value = false;

      skillApiInfo.value = '';

    }

    saveCliCache();

  } catch {

    skillApiReady.value = false;

    skillApiInfo.value = '';

  }

}



async function rescan(): Promise<void> {

  rescanning.value = true;

  try {

    await Promise.all([loadEndpoints(), loadScan(), loadDiagnostics(), loadSkillApiStatus()]);

    notify.success('扫描完成');

  } finally {

    rescanning.value = false;

  }

}



async function onEnsureSandbox(cliId: string): Promise<void> {

  notify.info(`正在创建 ${cliId} 沙箱...`);

  try {

    const resp = await requestJson<{ ok: boolean; error?: string }>(

      `/api/agent/sandbox/ensure/${encodeURIComponent(cliId)}`,

      { method: 'POST', body: JSON.stringify({}) },

    );

    if (resp.ok) {

      notify.success(`${cliId} 沙箱已就绪`);

      await loadScan();

      await loadLaunchCommand(cliId);

      void onDiagnoseCli(cliId, true);

    } else {

      notify.error(resp.error || '创建失败', 5000);

    }

  } catch (err) {

    notify.error(err instanceof Error ? err.message : String(err), 5000);

  }

}



async function onResetSandbox(cliId: string): Promise<void> {

  if (!window.confirm(`确定要重置 ${cliId} 的沙箱吗？沙箱配置文件将被清除，下次启动时会自动重建。`)) return;

  try {

    const resp = await requestJson<{ ok: boolean; error?: string }>(

      `/api/agent/sandbox/reset/${encodeURIComponent(cliId)}`,

      { method: 'POST' },

    );

    if (resp.ok) {

      notify.success(`${cliId} 沙箱已重置`);

      delete launchCommands[cliId];

      await loadScan();

    } else {

      notify.error(resp.error || '重置失败', 5000);

    }

  } catch (err) {

    notify.error(err instanceof Error ? err.message : String(err), 5000);

  }

}



async function onCopyCmd(cliId: string): Promise<void> {

  const command = launchCommands[cliId];

  if (!command) {

    notify.error('启动命令尚未加载，请稍后重试');

    return;

  }

  try {

    await navigator.clipboard.writeText(command);

    notify.success(`已复制 ${cliId} 启动命令`);

  } catch {

    notify.error('复制失败');

  }

}

function setInstalling(cliId: string, installing: boolean): void {

  const next = new Set(installingCliIds.value);

  if (installing) next.add(cliId);
  else next.delete(cliId);

  installingCliIds.value = next;

}

async function onInstallCli(cliId: string): Promise<void> {

  const tool = tools.value.find((t) => t.id === cliId);

  if (tool?.binary?.installed) {

    notify.info(`${tool.name || cliId} 已检测到，无需安装`);

    return;

  }

  if (!tool?.install?.command) {

    if (tool?.install?.docsUrl) window.open(tool.install.docsUrl, '_blank', 'noopener,noreferrer');

    notify.error('暂无自动安装命令，请查看官方文档');

    return;

  }

  if (installingCliIds.value.has(cliId)) return;

  if (!window.confirm(`1Shell 将自动执行安装命令：\n\n${tool.install.command}\n\n是否继续？`)) return;

  setInstalling(cliId, true);

  notify.info(`正在安装 ${tool.name || cliId}，这可能需要几分钟...`, 0);

  try {

    const resp = await requestJson<InstallCliResponse>(

      `/api/agent/install/${encodeURIComponent(cliId)}`,

      { method: 'POST', body: JSON.stringify({}) },

    );

    await loadScan();

    if (resp.ok && resp.installed) {

      notify.success(`${tool.name || cliId} 安装完成，已重新扫描`);

      await loadLaunchCommand(cliId);

    } else if (resp.ok) {

      notify.warn(`${tool.name || cliId} 安装命令已执行，但仍未在 PATH 中检测到，请尝试重新扫描或手动指定路径`, 8000);

    } else {

      notify.error(resp.error || '安装失败', 8000);

    }

  } catch (err) {

    notify.error(err instanceof Error ? err.message : String(err), 8000);

    await loadScan();

  } finally {

    setInstalling(cliId, false);

  }

}

async function onSetBinary(cliId: string): Promise<void> {

  const tool = tools.value.find((t) => t.id === cliId);

  const current = tool?.binary?.override ? tool.binary.path || '' : '';

  const input = window.prompt(`请输入 ${tool?.name || cliId} 可执行文件完整路径`, current);

  if (input === null) return;

  const binaryPath = input.trim();

  if (!binaryPath) {

    notify.error('可执行文件路径不能为空');

    return;

  }

  try {

    const resp = await requestJson<BinaryOverrideResponse>(

      `/api/agent/binary/${encodeURIComponent(cliId)}`,

      { method: 'PUT', body: JSON.stringify({ path: binaryPath }) },

    );

    if (resp.ok) {

      notify.success(`${tool?.name || cliId} 路径已保存`);

      await loadScan();

      await loadLaunchCommand(cliId);

    } else {

      notify.error(resp.error || '保存路径失败', 5000);

    }

  } catch (err) {

    notify.error(err instanceof Error ? err.message : String(err), 5000);

  }

}

async function onClearBinary(cliId: string): Promise<void> {

  const tool = tools.value.find((t) => t.id === cliId);

  if (!window.confirm(`确定要清除 ${tool?.name || cliId} 的手动路径吗？`)) return;

  try {

    const resp = await requestJson<BinaryOverrideResponse>(

      `/api/agent/binary/${encodeURIComponent(cliId)}`,

      { method: 'DELETE' },

    );

    if (resp.ok) {

      notify.success(`${tool?.name || cliId} 已恢复 PATH 自动扫描`);

      delete launchCommands[cliId];

      await loadScan();

    } else {

      notify.error(resp.error || '清除路径失败', 5000);

    }

  } catch (err) {

    notify.error(err instanceof Error ? err.message : String(err), 5000);

  }

}

async function onDiagnoseCli(cliId: string, silent = false): Promise<void> {

  try {

    const resp = await requestJson<CliDiagnosticsResponse>(`/api/agent/diagnostics/${encodeURIComponent(cliId)}`);

    const failed = (resp.checks || []).filter((check) => !check.ok);

    if (!silent) {

      if (failed.length === 0) {

        notify.success(`${resp.tool?.name || cliId} 接入诊断通过`);

      } else {

        const first = failed[0];

        notify.error(`${resp.tool?.name || cliId} 仍有 ${failed.length} 项待处理：${first.error || first.name}`, 7000);

      }

    }

  } catch (err) {

    if (!silent) notify.error(err instanceof Error ? err.message : String(err), 5000);

  }

}



function openCliModal(cliId: string): void {

  modalCliId.value = cliId;

  modalOpen.value = true;

}



function openSkillApiModal(): void {

  modalCliId.value = SKILLS_SLOT_ID;

  modalOpen.value = true;

}



async function onModalChanged(): Promise<void> {

  await loadScan();

  await loadSkillApiStatus();

}



watch([filter, keyword], () => saveCliPrefs());



onMounted(async () => {

  const restored = restoreCliCache();

  if (!restored || !isPageStateFresh(CLI_CACHE_KEY, CLI_CACHE_TTL_MS)) {

    await Promise.all([loadEndpoints(), loadScan(), loadDiagnostics(), loadSkillApiStatus()]);

  }

});

</script>



<template>

  <div class="h-screen flex flex-col p-2 gap-2">

    <!-- 顶栏 -->

    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">

      <div class="flex items-center gap-3 shrink-0">

        <span class="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">

          <AppIcon name="spark" :size="20" />

        </span>

        <div>

          <div class="text-base font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">

            AI 配置

            <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300 font-semibold">4.2</span>

          </div>

          <div class="text-[11px] text-slate-400">CLI 工具接入 · Skill 专用 API · MCP / Bridge 端点</div>

        </div>

      </div>

      <div class="flex-1"></div>

      <button

        type="button"

        :disabled="rescanning"

        class="h-8 px-3 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:border-blue-400 hover:bg-blue-100 transition-all disabled:opacity-60 disabled:cursor-not-allowed"

        @click="rescan"

      >

        {{ rescanning ? '扫描中...' : '🔄 重新扫描' }}

      </button>

    </header>



    <!-- 主区 -->

    <div class="flex-1 min-h-0 flex gap-2">

      <!-- 左栏：endpoints + diagnostics -->

      <EndpointsPanel

        :endpoints="endpoints"

        :diagnostics="diagnostics"

        :loading="endpointsLoading"

        :error-text="endpointsError"

      />



      <!-- 右栏：filter + 搜索 + CLI 列表 -->

      <main class="flex-1 flex flex-col min-w-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">

        <!-- 筛选栏 -->

        <div class="shrink-0 flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] gap-3">

          <div class="flex items-center gap-1.5 flex-wrap">

            <button

              v-for="opt in FILTER_OPTIONS"

              :key="opt.value"

              type="button"

              class="filter-btn"

              :class="{ active: filter === opt.value }"

              @click="filter = opt.value"

            >{{ opt.label }} {{ filterCount(opt.value) }}</button>

          </div>

          <input

            v-model="keyword"

            type="text"

            placeholder="搜索 CLI 工具…"

            class="w-56 h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"

          />

        </div>



        <!-- CLI 卡片列表 -->

        <div class="flex-1 overflow-y-auto p-5">

          <div v-if="scanError" class="text-red-400 text-xs py-8 text-center">扫描失败: {{ scanError }}</div>

          <div v-else-if="filteredTools.length === 0 && !showEngineCard" class="text-center text-slate-400 text-xs py-12">没有匹配的 CLI 工具</div>

          <template v-else>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

              <CliCard

                v-if="showEngineCard"

                variant="engine"

                :engine-ready="skillApiReady"

                :engine-info="skillApiInfo"

                @config-engine="openSkillApiModal"

              />

              <CliCard

                v-for="t in filteredTools"

                :key="t.id"

                variant="tool"

                :tool="t"

                :launch-command="launchCommands[t.id]"

                :installing="installingCliIds.has(t.id)"

                @ensure-sandbox="onEnsureSandbox"

                @reset-sandbox="onResetSandbox"

                @config="openCliModal"

                @copy-cmd="onCopyCmd"

                @install-cli="onInstallCli"

                @set-binary="onSetBinary"

                @clear-binary="onClearBinary"

                @diagnose="onDiagnoseCli"

              />

            </div>

            <div class="mt-6 p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 text-center">

              <div class="text-sm font-semibold text-slate-600 dark:text-slate-300">+ 没找到你使用的 AI CLI？</div>

              <div class="mt-1 text-[11px] text-slate-400">1Shell 提供标准的 MCP / Bridge 接入协议，任意支持 HTTP 或 MCP 的 CLI 都可手动接入</div>

            </div>

          </template>

        </div>

      </main>

    </div>



    <!-- Provider Modal -->

    <ProviderModal

      v-model:open="modalOpen"

      :cli-id="modalProps.cliId"

      :cli-name="modalProps.cliName"

      :supported-upstream="modalProps.supportedUpstream"

      :launch-command="modalProps.launchCommand"

      @changed="onModalChanged"

    />

  </div>

</template>
