<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import { useIdeChat } from '@/composables/useIdeChat';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';

const props = defineProps<{ active?: boolean }>();

const hosts = useHostsStore();
const sessionTerminal = useSessionTerminal();
const claudeCodeEnabled = ref(false);
const chatAreaEl = ref<HTMLElement | null>(null);
let followOutput = true;

const activeHostName = computed(() => {
  const host = hosts.hostMap.get(sessionTerminal.activeHostId.value || LOCAL_HOST_ID);
  return host?.name || '本机';
});

const ide = useIdeChat({
  sessionPrefix: 'console-ide',
  context: () => {
    const hostId = sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
    const host = hosts.hostMap.get(hostId);
    return {
      module: '主控',
      moduleHint: '当前在主控页面。可结合主机和终端上下文处理运维目标。',
      activeSessionId: sessionTerminal.activeSessionId.value,
      terminalStatus: sessionTerminal.statusText.value,
      hosts: host ? [{
        id: host.id || 'local',
        name: host.name,
        username: (host as { username?: string }).username,
        host: (host as { host?: string }).host,
        port: (host as { port?: number }).port,
      }] : [{ id: 'local', name: '本机' }],
    };
  },
  messagePayload: () => ({
    entry: 'console',
    claudeCodeEnabled: claudeCodeEnabled.value,
  }),
});

watch(() => ide.timeline.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => ide.timeline.value, () => { void nextTick(() => scrollToBottom()); }, { deep: true });
watch(() => props.active, (active) => {
  if (active) void nextTick(() => scrollToBottom(true));
});

onBeforeUnmount(() => {
  ide.dispose();
});

function onChatScroll(): void {
  const el = chatAreaEl.value;
  followOutput = !el || isNearScrollBottom(el);
}

function scrollToBottom(force = false): void {
  scrollToBottomIfPinned(chatAreaEl.value, force || followOutput);
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ide.sendMessage();
  }
}

function onSecretRefSubmit(secretRef: string): void {
  ide.approveCustomText.value = secretRef;
  ide.approveCustom();
}
</script>

<template>
  <section class="console-ide-panel">
    <header class="console-ide-header">
      <div class="console-ide-title-block">
        <span class="console-ide-title-icon">
          <AppIcon name="robot" :size="17" />
        </span>
        <div class="console-ide-title-text">
          <strong>1Shell AI</strong>
          <span>{{ activeHostName }}</span>
        </div>
        <span class="console-ide-badge">IDE</span>
      </div>

      <div class="console-ide-actions">
        <label
          class="console-ide-toggle"
          :class="{ 'console-ide-toggle--active': claudeCodeEnabled }"
          title="Claude Code 协作"
        >
          <input v-model="claudeCodeEnabled" type="checkbox" />
          <span>CC</span>
        </label>
        <button
          type="button"
          class="console-ide-ghost-btn"
          :disabled="ide.isRunning.value || !ide.hasMessages.value"
          @click="ide.resetChat"
        >
          清空
        </button>
      </div>
    </header>

    <div ref="chatAreaEl" class="console-ide-scroll" @scroll="onChatScroll">
      <div v-if="!ide.hasMessages.value" class="console-ide-empty">
        <span class="console-ide-empty-icon">
          <AppIcon name="robot" :size="30" :stroke-width="1.6" />
        </span>
        <strong>1Shell AI</strong>
        <span>输入目标后，这里会显示工作笔记、工具调用和最终回复。</span>
      </div>

      <IdeAgentTimeline v-else :items="ide.timeline.value" density="compact" />
    </div>

    <div class="console-ide-composer">
      <IdeApprovalCard
        :request="ide.approveRequest.value"
        :custom-text="ide.approveCustomText.value"
        density="compact"
        @update:custom-text="(value) => { ide.approveCustomText.value = value; }"
        @allow="ide.approveAllow"
        @deny="ide.approveDeny"
        @custom="ide.approveCustom"
        @secret-submit="onSecretRefSubmit"
      />
      <label class="sr-only" for="console-ide-input">输入给 1Shell AI 的消息</label>
      <textarea
        id="console-ide-input"
        v-model="ide.inputText.value"
        rows="3"
        class="console-ide-input"
        placeholder="输入你的目标..."
        :disabled="ide.isRunning.value"
        spellcheck="false"
        @keydown="onInputKeydown"
      />
      <div class="console-ide-composer-row">
        <span class="console-ide-status">{{ ide.statusText.value }}</span>
        <button
          v-if="ide.isRunning.value"
          type="button"
          class="console-ide-stop-btn"
          @click="ide.stop"
        >
          停止
        </button>
        <button
          v-else
          type="button"
          class="console-ide-send-btn"
          :disabled="!ide.inputText.value.trim()"
          @click="ide.sendMessage"
        >
          <AppIcon name="arrow-up" :size="14" :stroke-width="2" />
          <span>发送</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.console-ide-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  color: #0f172a;
  background: rgba(248, 250, 252, 0.74);
}

:global(html.dark) .console-ide-panel {
  color: #e2e8f0;
  background: rgba(2, 6, 23, 0.42);
}

.console-ide-header {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.24);
}

:global(html.dark) .console-ide-header {
  border-bottom-color: rgba(51, 65, 85, 0.72);
}

.console-ide-title-block,
.console-ide-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.console-ide-title-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: #e0f2fe;
  border: 1px solid #bae6fd;
}

:global(html.dark) .console-ide-title-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.24);
}

.console-ide-title-text {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.console-ide-title-text strong,
.console-ide-title-text span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-ide-title-text strong {
  font-size: 13px;
  line-height: 1.25;
}

.console-ide-title-text span {
  color: #64748b;
  font-size: 11px;
}

:global(html.dark) .console-ide-title-text span {
  color: #94a3b8;
}

.console-ide-badge {
  border-radius: 999px;
  padding: 2px 7px;
  color: #0369a1;
  background: rgba(14, 165, 233, 0.1);
  font-size: 10px;
  font-weight: 750;
}

.console-ide-toggle,
.console-ide-ghost-btn,
.console-ide-send-btn,
.console-ide-stop-btn {
  min-height: 36px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.console-ide-toggle,
.console-ide-ghost-btn {
  border: 1px solid rgba(148, 163, 184, 0.42);
  background: rgba(255, 255, 255, 0.72);
  color: #475569;
  padding: 0 9px;
  font-size: 12px;
  font-weight: 650;
}

.console-ide-toggle input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: #0284c7;
}

.console-ide-toggle:hover,
.console-ide-ghost-btn:hover:not(:disabled),
.console-ide-toggle--active {
  color: #0369a1;
  border-color: rgba(14, 165, 233, 0.42);
}

.console-ide-ghost-btn:disabled,
.console-ide-send-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

:global(html.dark) .console-ide-toggle,
:global(html.dark) .console-ide-ghost-btn {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
  color: #cbd5e1;
}

.console-ide-scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}

.console-ide-empty {
  height: 100%;
  min-height: 280px;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 8px;
  text-align: center;
  color: #64748b;
}

.console-ide-empty-icon {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: #e0f2fe;
  border: 1px solid #bae6fd;
}

.console-ide-empty strong {
  color: #0f172a;
  font-size: 14px;
}

.console-ide-empty span:last-child {
  max-width: 260px;
  font-size: 12px;
  line-height: 1.5;
}

:global(html.dark) .console-ide-empty {
  color: #94a3b8;
}

:global(html.dark) .console-ide-empty strong {
  color: #e2e8f0;
}

.console-ide-composer {
  display: grid;
  gap: 9px;
  padding: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(255, 255, 255, 0.78);
}

:global(html.dark) .console-ide-composer {
  background: rgba(15, 23, 42, 0.68);
  border-top-color: rgba(51, 65, 85, 0.72);
}

.console-ide-input {
  width: 100%;
  min-height: 82px;
  max-height: 150px;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: rgba(255, 255, 255, 0.92);
  color: #0f172a;
  padding: 10px 11px;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
}

.console-ide-input:focus {
  border-color: #0284c7;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.16);
}

.console-ide-input:disabled {
  opacity: 0.68;
  cursor: not-allowed;
}

:global(html.dark) .console-ide-input {
  background: rgba(2, 6, 23, 0.72);
  border-color: rgba(71, 85, 105, 0.9);
  color: #e2e8f0;
}

.console-ide-composer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.console-ide-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
  font-size: 12px;
}

:global(html.dark) .console-ide-status {
  color: #94a3b8;
}

.console-ide-send-btn {
  min-width: 82px;
  border: 1px solid #0284c7;
  color: #ffffff;
  background: #0284c7;
  padding: 0 13px;
  font-size: 13px;
  font-weight: 750;
}

.console-ide-send-btn:hover:not(:disabled) {
  background: #0369a1;
  border-color: #0369a1;
}

.console-ide-stop-btn {
  min-width: 72px;
  border: 1px solid rgba(220, 38, 38, 0.38);
  color: #b91c1c;
  background: #fef2f2;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 750;
}

.console-ide-stop-btn:hover {
  background: #fee2e2;
  border-color: rgba(185, 28, 28, 0.54);
}

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
</style>
