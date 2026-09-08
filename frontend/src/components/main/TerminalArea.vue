<script setup lang="ts">
// TerminalArea.vue — MainConsole 终端区
// 严格 1:1 对照老 [public/index.html](public/index.html) row 326-426 + [public/layout.js](public/layout.js) renderTabs。
// 结构（自上而下）：terminal-tabs → CmdInlinePanel → terminal-main（含 terminal-hint / terminal-container / fab）
// 4.7.5：顶栏探针条（CPU/内存/负载/硬盘）与 AI 行内补全（补全条/ghost 浮层）退役
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import AnalyzeFab from '@/components/main/AnalyzeFab.vue';
import AnalyzePanel from '@/components/main/AnalyzePanel.vue';
import CmdInlinePanel from '@/components/main/CmdInlinePanel.vue';
import ScriptInjectPanel from '@/components/main/ScriptInjectPanel.vue';
import { useCommandSuggestion } from '@/composables/useCommandSuggestion';
import { useScriptInject } from '@/composables/useScriptInject';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useTerminalAnalyze } from '@/composables/useTerminalAnalyze';
import { useHostsStore } from '@/stores/hosts';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { SessionInfo } from '@/utils/terminal';

const emit = defineEmits<{
  'host-change': [hostId: string];
  'host-close': [hostId: string];
  'fullscreen-toggle': [value: boolean];
  'open-host-selector': [];
}>();

const hosts = useHostsStore();
const sessionTerminal = useSessionTerminal();
const commandSuggestion = useCommandSuggestion();
const scriptInject = useScriptInject();
const terminalAnalyze = useTerminalAnalyze();

const terminalEl = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);

const sessionsList = computed(() => [...sessionTerminal.sessions.value.values()].filter((s) => s.status !== 'closed'));

function tabName(session: SessionInfo): string {
  return hosts.hostMap.get(session.hostId)?.name || session.hostName || session.hostId;
}

function tabMeta(session: SessionInfo): string {
  const host = hosts.hostMap.get(session.hostId);
  if (!host) return '';
  return host.type === 'local' ? '本地' : (host.host || '');
}

function switchSession(session: SessionInfo): void {
  emit('host-change', session.hostId);
}

function closeSession(session: SessionInfo, event: MouseEvent): void {
  event.stopPropagation();
  sessionTerminal.closeHostSession(session.hostId);
  emit('host-close', session.hostId);
}

function reconnect(): void {
  const hostId = sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  sessionTerminal.connectToHost(hostId, true).catch(() => { /* 静默 */ });
}

function clearTerminal(): void {
  sessionTerminal.clearTerminal();
}

function toggleCommandPanel(): void {
  if (commandSuggestion.isOpen.value) commandSuggestion.closeCmdModal();
  else commandSuggestion.openCmdModal();
}

function toggleFullscreen(): void {
  isFullscreen.value = !isFullscreen.value;
  emit('fullscreen-toggle', isFullscreen.value);
  setTimeout(() => sessionTerminal.focusTerminal(), 60);
}

function refitTerminalSoon(): void {
  [40, 140, 360].forEach((delay) => {
    window.setTimeout(() => sessionTerminal.focusTerminal(), delay);
  });
}

watch(
  () => isFullscreen.value,
  () => refitTerminalSoon(),
  { flush: 'post' },
);

onMounted(() => {
  sessionTerminal.resumeUserInput(0);
  if (terminalEl.value) sessionTerminal.mount(terminalEl.value);
  commandSuggestion.initialize();
  scriptInject.initialize();
  terminalAnalyze.initialize();
  refitTerminalSoon();
});

onActivated(() => {
  sessionTerminal.resumeUserInput();
  if (terminalEl.value) sessionTerminal.mount(terminalEl.value);
  refitTerminalSoon();
});

onDeactivated(() => {
  sessionTerminal.pauseUserInput();
});

onBeforeUnmount(() => {
  sessionTerminal.unmount();
  emit('fullscreen-toggle', false);
});
</script>

<template>
  <section class="terminal-area" :class="{ fullscreen: isFullscreen }">
    <!-- 单行工具条：左=会话 tabs+连接状态 / 右=操作 -->
    <div id="terminal-tabs" class="terminal-tabs">
      <div class="terminal-tabs-left">
        <div class="terminal-tab-strip">
          <div
            v-for="session in sessionsList"
            :key="session.id"
            :data-tab-host="session.hostId"
            class="terminal-tab"
            :class="{ active: session.id === sessionTerminal.activeSessionId.value }"
            @click="switchSession(session)"
          >
            <span class="terminal-tab-status" :class="`status-${session.status}`"></span>
            <span class="terminal-tab-name">{{ tabName(session) }}</span>
            <span v-if="tabMeta(session)" class="terminal-tab-meta">{{ tabMeta(session) }}</span>
            <button
              type="button"
              class="terminal-tab-close"
              :data-tab-close="session.hostId"
              title="关闭终端标签"
              @click="closeSession(session, $event)"
            >
              <AppIcon name="close" :size="10" />
            </button>
          </div>
          <button
            type="button"
            class="terminal-tab-add"
            title="选择或连接新主机"
            @click="emit('open-host-selector')"
          >
            <AppIcon name="plus" :size="12" />
          </button>
        </div>
        <div class="terminal-status-mini" :title="sessionTerminal.statusText.value">
          <span class="status-dot" :class="sessionTerminal.statusKind.value"></span>
          <span class="terminal-status-mini-text">{{ sessionTerminal.statusText.value }}</span>
        </div>
      </div>
      <div class="terminal-actions">
        <button
          id="cmd-suggest-btn"
          type="button"
          class="terminal-action-btn terminal-btn-accent"
          :class="{ active: commandSuggestion.isOpen.value }"
          title="打开 AI 命令建议面板"
          @click="toggleCommandPanel"
        >
          <AppIcon name="spark" :size="12" />
          <span>AI 命令</span>
        </button>
        <button
          id="inject-script-btn"
          type="button"
          class="terminal-action-btn"
          :class="{ active: scriptInject.scriptOpen.value }"
          title="快捷执行脚本库中的脚本"
          @click="scriptInject.scriptOpen.value ? scriptInject.closeScriptPanel() : scriptInject.openScriptPanel()"
        >
          <AppIcon name="code" :size="12" />
          <span>脚本</span>
        </button>
        <button
          id="reconnect-btn"
          type="button"
          class="terminal-action-btn"
          title="重新连接终端"
          @click="reconnect"
        >
          <AppIcon name="refresh" :size="12" />
          <span>重连</span>
        </button>
        <button
          id="clear-term-btn"
          type="button"
          class="terminal-action-btn"
          title="清空终端屏幕缓冲区"
          @click="clearTerminal"
        >
          <AppIcon name="broom" :size="12" />
          <span>清屏</span>
        </button>
        <button
          id="fullscreen-btn"
          type="button"
          class="terminal-action-btn"
          :title="isFullscreen ? '退出全屏' : '全屏终端'"
          @click="toggleFullscreen"
        >
          <AppIcon :name="isFullscreen ? 'minimize' : 'maximize'" :size="12" />
          <span>{{ isFullscreen ? '还原' : '全屏' }}</span>
        </button>
      </div>
    </div>

    <!-- AI 命令面板（老 #cmd-inline-panel，hidden 时不占空间） -->
    <CmdInlinePanel />

    <!-- 脚本注入面板 -->
    <ScriptInjectPanel />

    <!-- 终端主体（老 row 417-425：flex-1 min-h-0 relative；hint / container / overlay / fab 全部 absolute 在此） -->
    <div class="terminal-main">
      <div
        id="terminal-hint"
        class="terminal-hint"
        :class="{ hidden: !sessionTerminal.terminalHint.value }"
      >{{ sessionTerminal.terminalHint.value }}</div>
      <div id="terminal-container" ref="terminalEl" class="terminal-container"></div>
      <!-- 选区分析 FAB（terminal-main 内 absolute） -->
      <AnalyzeFab />
    </div>

    <!-- AI 选区分析底部 docked 横向条（与 terminal-main 同列,不挡左右栏） -->
    <AnalyzePanel />
  </section>
</template>
