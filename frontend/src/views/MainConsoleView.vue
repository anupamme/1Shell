<script setup lang="ts">
// MainConsole 主控台 — 老 [public/index.html](public/index.html) 入口
// 刀 1：登录 + 壳 + 顶栏 + Settings + Host 管理（其它三栏为 placeholder，留给刀 2-5）
import { ref, computed, onMounted, onActivated, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useAuthStore } from '@/stores/auth';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { useConfirm } from '@/composables/useConfirm';
import { useTopbarProbe } from '@/composables/useTopbarProbe';
import { readStorageState, writeStorageState } from '@/composables/usePageState';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { MainHost, HostFormPayload, HostLink } from '@/utils/mainConsole';

import AppIcon from '@/components/AppIcon.vue';
import HostListSidebar from '@/components/main/HostListSidebar.vue';
import TerminalArea from '@/components/main/TerminalArea.vue';
import HostModal from '@/components/main/HostModal.vue';
import AnalyzeContextMenu from '@/components/main/AnalyzeContextMenu.vue';
import FileBrowserPanel from '@/components/main/FileBrowserPanel.vue';
import AiChatPanel from '@/components/main/AiChatPanel.vue';
import IdePanel from '@/components/main/IdePanel.vue';
import AgentPanel from '@/components/main/AgentPanel.vue';

const { requestJson } = useApiClient();
const auth = useAuthStore();
const hosts = useHostsStore();
const notify = useNotifyStore();
const { confirm } = useConfirm();
const sessionTerminal = useSessionTerminal();
try { hosts.setFilterKeyword(localStorage.getItem('1shell.console.host-filter') || ''); } catch { /* ignore */ }

const activeHostId = sessionTerminal.activeHostId;
const probe = useTopbarProbe(activeHostId);
const route = useRoute();
const CONSOLE_PREFS_KEY = '1shell.console.page.prefs.v1';
const consolePrefs = readStorageState(CONSOLE_PREFS_KEY, {
  sidebarCollapsed: false,
  aiPanelCollapsed: false,
  terminalFullscreen: false,
  rightTab: 'chat' as 'chat' | 'ide' | 'agent',
});

const sidebarCollapsed = ref(consolePrefs.sidebarCollapsed);
const aiPanelCollapsed = ref(consolePrefs.aiPanelCollapsed);
const terminalFullscreen = ref(consolePrefs.terminalFullscreen);
const leftRailTab = ref<'hosts' | 'files'>('hosts');

function saveConsolePrefs(): void {
  writeStorageState(CONSOLE_PREFS_KEY, {
    sidebarCollapsed: sidebarCollapsed.value,
    aiPanelCollapsed: aiPanelCollapsed.value,
    terminalFullscreen: terminalFullscreen.value,
    rightTab: rightTab.value,
  });
}

// Host modal
const hostModalOpen = ref(false);
const hostEditing = ref<MainHost | null>(null);
const hostModalRef = ref<InstanceType<typeof HostModal> | null>(null);

const sshHosts = computed(() => hosts.items.filter((h: MainHost) => h.type === 'ssh' || h.id !== LOCAL_HOST_ID));

interface HostsListResponse {
  hosts?: MainHost[];
  warnings?: { usingFallbackSecret?: boolean };
}

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<HostsListResponse>('/api/hosts/console');
    hosts.setHosts(data.hosts || []);
    hosts.setSecretWarning(Boolean(data.warnings?.usingFallbackSecret));

    // ?host=<id> 优先 (来自地图主页「立即连接」)
    // socket connect handler 会基于 activeHostId.value 自动连接
    const queryHost = typeof route.query.host === 'string' ? route.query.host : null;
    if (queryHost && hosts.hostMap.has(queryHost)) {
      activeHostId.value = queryHost;
      hosts.select(queryHost);
      return;
    }

    if (!hosts.hostMap.has(activeHostId.value)) {
      activeHostId.value = LOCAL_HOST_ID;
    }
    hosts.select(activeHostId.value);
  } catch (err) {
    notify.error((err as Error).message || '加载主机列表失败');
  }
}

// auth gate 由 App.vue 顶层负责；进到这里说明已登录或 auth 关闭。
async function bootstrapConsole(): Promise<void> {
  try {
    await loadHosts();
    sessionTerminal.connectSocket();
  } catch (err) {
    notify.error((err as ApiError | Error).message || '主控初始化失败');
  }
}

onMounted(() => { void bootstrapConsole(); });
onBeforeUnmount(() => { sessionTerminal.disconnectSocket(); });

async function onLogout(): Promise<void> {
  const ok = await confirm({ title: '退出登录', message: '确认退出当前账号？', okText: '退出' });
  if (!ok) return;
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
  } catch { /* 静默 */ }
  sessionTerminal.disconnectSocket();
  auth.logout();
  hosts.setHosts([]);
}

// Topbar actions
function openAddHost(): void {
  hostEditing.value = null;
  hostModalOpen.value = true;
}

function onSidebarToggle(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  saveConsolePrefs();
}

function onAiPanelToggle(): void {
  aiPanelCollapsed.value = !aiPanelCollapsed.value;
  saveConsolePrefs();
}

// Host list actions
function onHostConnect(hostId: string): void {
  activeHostId.value = hostId;
  hosts.select(hostId);
  // 记住最近连接主机，供主页"最近主机"卡使用
  if (hostId && hostId !== LOCAL_HOST_ID) {
    try { localStorage.setItem('1shell-last-host', hostId); } catch { /* ignore */ }
  }
  sessionTerminal.connectToHost(hostId, false).catch((err) => {
    notify.error((err as Error).message || '连接主机失败');
  });
}

function activateQueryHost(): void {
  const queryHost = typeof route.query.host === 'string' ? route.query.host : null;
  if (!queryHost || !hosts.hostMap.has(queryHost) || activeHostId.value === queryHost) return;
  onHostConnect(queryHost);
}

onActivated(() => {
  void loadHosts().then(() => activateQueryHost());
});

watch(() => route.query.host, () => {
  activateQueryHost();
});

function onHostEdit(hostId: string): void {
  const h = hosts.hostMap.get(hostId);
  if (!h) return;
  hostEditing.value = h;
  hostModalOpen.value = true;
}

async function onHostDelete(hostId: string): Promise<void> {
  const h = hosts.hostMap.get(hostId);
  if (!h) return;
  const ok = await confirm({ title: '删除主机', message: `确认删除主机"${h.name}"吗？`, okText: '删除' });
  if (!ok) return;
  try {
    await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });
    if (activeHostId.value === hostId) {
      sessionTerminal.closeHostSession(hostId);
      activeHostId.value = LOCAL_HOST_ID;
    }
    await loadHosts();
    notify.success('主机已删除');
  } catch (err) {
    notify.error((err as Error).message);
  }
}

async function onHostSubmit(
  payload: HostFormPayload | { isLocal: true; name: string; links: HostLink[] },
  hostId: string | null
): Promise<void> {
  try {
    if ('isLocal' in payload && payload.isLocal) {
      await requestJson('/api/hosts/local-config', {
        method: 'PUT',
        body: JSON.stringify({ name: payload.name, links: payload.links }),
      });
    } else if (hostId) {
      await requestJson(`/api/hosts/${encodeURIComponent(hostId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await requestJson('/api/hosts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    await loadHosts();
    hostModalOpen.value = false;
    notify.success(hostId === LOCAL_HOST_ID ? '本机配置已更新' : (hostId ? '主机已更新' : '主机已添加'));
  } catch (err) {
    hostModalRef.value?.setError((err as Error).message);
  }
}

// 刀 5a/5b 拍板：右栏 tab 切换（feedback-right-aside-tabs）
const rightTab = ref<'chat' | 'ide' | 'agent'>(consolePrefs.rightTab);
function onTerminalFullscreen(value: boolean): void {
  terminalFullscreen.value = value;
  saveConsolePrefs();
}

// 右栏 tab 切换时也要 refit（IDE↔Chat↔Agent 宽度从 40%↔20%↔40% 切换）
watch(rightTab, () => {
  saveConsolePrefs();
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
});

watch(() => hosts.filterKeyword, () => {
  try { localStorage.setItem('1shell.console.host-filter', hosts.filterKeyword); } catch { /* ignore */ }
});

</script>

<template>
  <!-- auth gate 由 App.vue 顶层负责；这里假定已登录。 -->
  <!-- 主壳。吃满 AppHeader 下方的父容器高度,杜绝内部内容撑大整页 -->
  <div class="console-page flex flex-col min-w-0 p-2 h-full min-h-0 overflow-hidden">
    <!-- 三栏主内容 -->
    <div class="console-workspace flex flex-1 gap-2 min-h-0">

      <!-- 左栏：主机 / 文件 tab 切换 -->
      <aside
        class="console-paper-panel console-side-panel console-left-panel w-[20%] shrink-0 flex flex-col min-h-0 rounded-2xl overflow-hidden transition-all duration-300 ease-in-out"
        :class="{ hidden: sidebarCollapsed || terminalFullscreen }"
      >
        <div class="ai-side-tabs">
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': leftRailTab === 'hosts' }"
            @click="leftRailTab = 'hosts'"
          >主机</button>
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': leftRailTab === 'files' }"
            @click="leftRailTab = 'files'"
          >文件</button>
          <button
            type="button"
            class="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white/75 text-slate-500 transition-all hover:border-blue-300 hover:text-blue-600 dark:border-[#1e293b] dark:bg-[#111827]/70 dark:text-slate-300 dark:hover:border-blue-400/60 dark:hover:text-blue-300"
            title="添加主机"
            aria-label="添加主机"
            @click="openAddHost"
          >
            <AppIcon name="plus" :size="14" />
          </button>
        </div>
        <div class="ai-side-tab-content p-2 min-h-0">
          <HostListSidebar
            v-show="leftRailTab === 'hosts'"
            :hosts="hosts.filteredItems"
            :active-host-id="activeHostId"
            :search-keyword="hosts.filterKeyword"
            :show-secret-warning="hosts.secretWarning"
            :flex="1"
            @update:search-keyword="hosts.setFilterKeyword"
            @connect="onHostConnect"
            @edit="onHostEdit"
            @delete="onHostDelete"
            @refresh="loadHosts"
            @toggle-collapsed="() => { /* folded into terminal toolbar */ }"
          />
          <div v-show="leftRailTab === 'files'" class="flex-1 min-h-0 rounded-2xl overflow-hidden">
            <FileBrowserPanel />
          </div>
        </div>
      </aside>

      <!-- 中栏：终端（刀 2 填充） -->
      <main class="console-paper-panel console-terminal-panel flex-1 flex flex-col min-w-0 min-h-0 rounded-2xl overflow-hidden">
        <TerminalArea
          :host-name="probe.displayName.value"
          :cpu="probe.cpuText.value"
          :memory="probe.memoryText.value"
          :load="probe.loadText.value"
          :disk="probe.diskText.value"
          :sidebar-collapsed="sidebarCollapsed"
          :ai-panel-collapsed="aiPanelCollapsed"
          @host-change="onHostConnect"
          @fullscreen-toggle="onTerminalFullscreen"
          @toggle-sidebar="onSidebarToggle"
          @toggle-ai-panel="onAiPanelToggle"
        />
      </main>

      <!-- 右栏：AI Chat / 1Shell AI / AI Agent tab 切换（刀 4 + 刀 5a + 刀 5b） -->
      <!-- 宽度跟随 tab：IDE/Agent 激活时 w-[40%]（整体 2:4:4 同老版 setIdePanelOpen/setAgentPanelOpen）；AI Chat 时 w-[20%] -->
      <aside
        v-if="!aiPanelCollapsed && !terminalFullscreen"
        class="console-paper-panel console-side-panel console-right-panel shrink-0 flex flex-col min-h-0 rounded-2xl overflow-hidden transition-all duration-300 ease-in-out"
        :class="rightTab === 'ide' || rightTab === 'agent' ? 'w-[40%]' : 'w-[20%]'"
      >
        <!-- tab 头：feedback-right-aside-tabs 拍板 -->
        <div class="ai-side-tabs">
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': rightTab === 'chat' }"
            @click="rightTab = 'chat'"
          >AI Chat</button>
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': rightTab === 'ide' }"
            @click="rightTab = 'ide'"
          >1Shell AI</button>
          <button
            type="button"
            class="ai-side-tab"
            :class="{ 'ai-side-tab--active': rightTab === 'agent' }"
            @click="rightTab = 'agent'"
          >AI Agent</button>
        </div>
        <div class="ai-side-tab-content">
          <AiChatPanel v-show="rightTab === 'chat'" />
          <IdePanel v-show="rightTab === 'ide'" :active="rightTab === 'ide'" />
          <AgentPanel v-show="rightTab === 'agent'" />
        </div>
      </aside>
    </div>

    <!-- Host 编辑 modal -->
    <HostModal
      ref="hostModalRef"
      :open="hostModalOpen"
      :editing="hostEditing"
      :ssh-hosts="sshHosts"
      @close="hostModalOpen = false"
      @submit="onHostSubmit"
    />

    <!-- 选区分析右键菜单（position:fixed 全局,挂在 terminal-area 外；分析面板已 dock 到 TerminalArea 内底部） -->
    <AnalyzeContextMenu />

    <!-- 左侧栏退出按钮（占位：AppSidebar 已有，这里仅作 listener — 刀 1 后期由 AppSidebar 触发 onLogout） -->
    <!-- TODO 刀 1 完工后：AppSidebar 内"退出"按钮 emit 触发本组件 onLogout -->
  </div>
</template>
