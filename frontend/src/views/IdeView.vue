<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import { useIdeChat } from '@/composables/useIdeChat';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';

const ide = useIdeChat();
const chatEl = ref<HTMLElement | null>(null);
let followOutput = true;

watch(() => ide.timeline.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => ide.timeline.value, () => { void nextTick(() => scrollToBottom()); }, { deep: true });

onBeforeUnmount(() => {
  ide.dispose();
});

function onChatScroll(): void {
  const el = chatEl.value;
  followOutput = !el || isNearScrollBottom(el);
}

function scrollToBottom(force = false): void {
  scrollToBottomIfPinned(chatEl.value, force || followOutput);
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
  <section class="ide-page">
    <header class="ide-page-header">
      <div class="ide-page-title">
        <span class="ide-page-title-icon">
          <AppIcon name="robot" :size="18" />
        </span>
        <div>
          <h1>IDE</h1>
          <p>1Shell AI</p>
        </div>
      </div>
      <div class="ide-page-actions">
        <span class="ide-page-status">{{ ide.statusText.value }}</span>
        <button
          type="button"
          class="ide-page-ghost-btn"
          :disabled="ide.isRunning.value || !ide.hasMessages.value"
          @click="ide.resetChat"
        >
          清空
        </button>
      </div>
    </header>

    <main class="ide-chat-shell">
      <div ref="chatEl" class="ide-chat-scroll" @scroll="onChatScroll">
        <div v-if="!ide.hasMessages.value" class="ide-chat-empty">
          <AppIcon name="robot" :size="34" />
          <div>
            <strong>开始一次 1Shell AI 对话</strong>
            <span>输入目标后，这里会按时间线显示模型回复和工具事件。</span>
          </div>
        </div>

        <IdeAgentTimeline v-if="ide.hasMessages.value" :items="ide.timeline.value" density="full" />
      </div>

      <div class="ide-chat-composer">
        <IdeApprovalCard
          :request="ide.approveRequest.value"
          :custom-text="ide.approveCustomText.value"
          density="full"
          @update:custom-text="(value) => { ide.approveCustomText.value = value; }"
          @allow="ide.approveAllow"
          @deny="ide.approveDeny"
          @custom="ide.approveCustom"
          @secret-submit="onSecretRefSubmit"
        />
        <label class="sr-only" for="ide-chat-input">输入给 1Shell AI 的消息</label>
        <textarea
          id="ide-chat-input"
          v-model="ide.inputText.value"
          rows="3"
          class="ide-chat-input"
          placeholder="输入你的目标..."
          :disabled="ide.isRunning.value"
          spellcheck="false"
          @keydown="onInputKeydown"
        />
        <div class="ide-chat-composer-actions">
          <span class="ide-chat-hint">{{ ide.isRunning.value ? ide.statusText.value : '待命' }}</span>
          <button
            v-if="ide.isRunning.value"
            type="button"
            class="ide-chat-stop-btn"
            @click="ide.stop"
          >
            停止
          </button>
          <button
            v-else
            type="button"
            class="ide-chat-send-btn"
            :disabled="!ide.inputText.value.trim()"
            @click="ide.sendMessage"
          >
            <AppIcon name="arrow-up" :size="16" :stroke-width="2" />
            <span>发送</span>
          </button>
        </div>
      </div>
    </main>
  </section>
</template>

<style scoped>
.ide-page {
  height: 100vh;
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: rgba(248, 250, 252, 0.88);
  color: #0f172a;
}

:global(html.dark) .ide-page {
  background: rgba(2, 6, 23, 0.86);
  color: #e2e8f0;
}

.ide-page-header {
  min-height: 68px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 22px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(255, 255, 255, 0.72);
}

:global(html.dark) .ide-page-header {
  background: rgba(15, 23, 42, 0.72);
  border-bottom-color: rgba(51, 65, 85, 0.7);
}

.ide-page-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.ide-page-title-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: #e0f2fe;
  border: 1px solid #bae6fd;
}

:global(html.dark) .ide-page-title-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.24);
}

.ide-page-title h1 {
  margin: 0;
  font-size: 18px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: 0;
}

.ide-page-title p {
  margin: 2px 0 0;
  font-size: 12px;
  color: #64748b;
}

:global(html.dark) .ide-page-title p {
  color: #94a3b8;
}

.ide-page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ide-page-status {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #475569;
}

:global(html.dark) .ide-page-status {
  color: #cbd5e1;
}

.ide-page-ghost-btn,
.ide-chat-stop-btn,
.ide-chat-send-btn {
  min-height: 44px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  cursor: pointer;
  transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease;
}

.ide-page-ghost-btn {
  min-width: 64px;
  padding: 0 12px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #334155;
  background: rgba(255, 255, 255, 0.76);
}

.ide-page-ghost-btn:hover:not(:disabled) {
  background: #f8fafc;
  border-color: rgba(14, 165, 233, 0.45);
  color: #0369a1;
}

.ide-page-ghost-btn:disabled,
.ide-chat-send-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

:global(html.dark) .ide-page-ghost-btn {
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
}

:global(html.dark) .ide-page-ghost-btn:hover:not(:disabled) {
  background: rgba(30, 41, 59, 0.86);
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.34);
}

.ide-chat-shell {
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
}

.ide-chat-scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 22px;
}

.ide-chat-scroll > * + * {
  margin-top: 16px;
}

.ide-chat-empty {
  height: 100%;
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #64748b;
}

.ide-chat-empty svg {
  color: #0284c7;
}

.ide-chat-empty strong,
.ide-chat-empty span {
  display: block;
}

.ide-chat-empty strong {
  color: #0f172a;
  font-size: 15px;
}

.ide-chat-empty span {
  margin-top: 4px;
  font-size: 13px;
}

:global(html.dark) .ide-chat-empty {
  color: #94a3b8;
}

:global(html.dark) .ide-chat-empty strong {
  color: #e2e8f0;
}

.ide-chat-composer {
  border-top: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(255, 255, 255, 0.78);
  padding: 14px 22px 18px;
  display: grid;
  gap: 10px;
}

:global(html.dark) .ide-chat-composer {
  background: rgba(15, 23, 42, 0.78);
  border-top-color: rgba(51, 65, 85, 0.7);
}

.ide-chat-input {
  width: 100%;
  min-height: 92px;
  max-height: 180px;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: rgba(255, 255, 255, 0.92);
  color: #0f172a;
  padding: 12px 13px;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
}

.ide-chat-input:focus {
  border-color: #0284c7;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.18);
}

.ide-chat-input:disabled {
  opacity: 0.68;
  cursor: not-allowed;
}

:global(html.dark) .ide-chat-input {
  background: rgba(2, 6, 23, 0.72);
  border-color: rgba(71, 85, 105, 0.9);
  color: #e2e8f0;
}

.ide-chat-composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ide-chat-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #64748b;
}

:global(html.dark) .ide-chat-hint {
  color: #94a3b8;
}

.ide-chat-send-btn {
  min-width: 92px;
  padding: 0 16px;
  border: 1px solid #0284c7;
  color: #ffffff;
  background: #0284c7;
  font-weight: 650;
}

.ide-chat-send-btn:hover:not(:disabled) {
  background: #0369a1;
  border-color: #0369a1;
}

.ide-chat-stop-btn {
  min-width: 82px;
  padding: 0 14px;
  border: 1px solid rgba(220, 38, 38, 0.38);
  color: #b91c1c;
  background: #fef2f2;
  font-weight: 650;
}

.ide-chat-stop-btn:hover {
  background: #fee2e2;
  border-color: rgba(185, 28, 28, 0.54);
}

:global(html.dark) .ide-chat-stop-btn {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.24);
  border-color: rgba(248, 113, 113, 0.35);
}

:global(html.dark) .ide-chat-stop-btn:hover {
  background: rgba(127, 29, 29, 0.38);
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

@media (max-width: 720px) {
  .ide-page-header,
  .ide-chat-scroll,
  .ide-chat-composer {
    padding-left: 14px;
    padding-right: 14px;
  }

  .ide-page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .ide-page-actions {
    width: 100%;
    justify-content: space-between;
  }

}
</style>
