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

.ide-chat-message {
  display: grid;
  gap: 6px;
  max-width: min(860px, 100%);
}

.ide-chat-message--user {
  margin-left: auto;
  justify-items: end;
}

.ide-chat-message--assistant {
  margin-right: auto;
  justify-items: start;
}

.ide-chat-message-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #64748b;
}

:global(html.dark) .ide-chat-message-meta {
  color: #94a3b8;
}

.ide-chat-bubble {
  max-width: 100%;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 8px;
  padding: 11px 13px;
  background: rgba(255, 255, 255, 0.86);
  color: #0f172a;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
}

.ide-chat-message--user .ide-chat-bubble {
  background: #0f172a;
  color: #f8fafc;
  border-color: #0f172a;
}

:global(html.dark) .ide-chat-bubble {
  background: rgba(15, 23, 42, 0.86);
  color: #e2e8f0;
  border-color: rgba(51, 65, 85, 0.85);
  box-shadow: none;
}

:global(html.dark) .ide-chat-message--user .ide-chat-bubble {
  background: #e2e8f0;
  color: #0f172a;
  border-color: #e2e8f0;
}

.ide-chat-markdown {
  font-size: 13px;
  line-height: 1.62;
  word-break: break-word;
}

.ide-thinking-event {
  max-width: min(860px, 100%);
  margin-right: auto;
  color: #334155;
}

:global(html.dark) .ide-thinking-event {
  color: #cbd5e1;
}

.ide-thinking-card {
  border: 1px solid rgba(148, 163, 184, 0.38);
  border-radius: 8px;
  background: rgba(248, 250, 252, 0.72);
  overflow: hidden;
}

:global(html.dark) .ide-thinking-card {
  background: rgba(15, 23, 42, 0.62);
  border-color: rgba(71, 85, 105, 0.72);
}

.ide-thinking-summary {
  min-height: 38px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  cursor: pointer;
  list-style: none;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.ide-thinking-summary::-webkit-details-marker {
  display: none;
}

.ide-thinking-summary:focus-visible {
  outline: 2px solid rgba(14, 165, 233, 0.58);
  outline-offset: -2px;
}

:global(html.dark) .ide-thinking-summary {
  color: #94a3b8;
}

.ide-thinking-icon {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: rgba(224, 242, 254, 0.86);
  border: 1px solid #bae6fd;
}

:global(html.dark) .ide-thinking-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.22);
}

.ide-thinking-chevron {
  color: #94a3b8;
  transition: transform 160ms ease;
}

.ide-thinking-card[open] .ide-thinking-chevron {
  transform: rotate(90deg);
}

.ide-thinking-markdown {
  border-top: 1px solid rgba(226, 232, 240, 0.82);
  padding: 9px 12px 11px;
  font-size: 12.5px;
  line-height: 1.62;
  color: #475569;
  word-break: break-word;
}

:global(html.dark) .ide-thinking-markdown {
  border-top-color: rgba(51, 65, 85, 0.72);
  color: #cbd5e1;
}

.ide-tool-event {
  max-width: min(900px, 100%);
  margin-right: auto;
  color: #0f172a;
}

:global(html.dark) .ide-tool-event {
  color: #e2e8f0;
}

.ide-tool-card {
  border: 1px solid rgba(148, 163, 184, 0.52);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

:global(html.dark) .ide-tool-card {
  background: rgba(15, 23, 42, 0.82);
  border-color: rgba(71, 85, 105, 0.84);
  box-shadow: none;
}

.ide-tool-event--running .ide-tool-card,
.ide-tool-event--preparing .ide-tool-card {
  border-color: rgba(14, 165, 233, 0.42);
}

.ide-tool-event--done .ide-tool-card {
  border-color: rgba(16, 185, 129, 0.34);
}

.ide-tool-event--error .ide-tool-card {
  border-color: rgba(220, 38, 38, 0.44);
}

.ide-tool-summary {
  min-height: 46px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  list-style: none;
}

.ide-tool-summary::-webkit-details-marker {
  display: none;
}

.ide-tool-summary:focus-visible {
  outline: 2px solid rgba(14, 165, 233, 0.62);
  outline-offset: -2px;
}

.ide-tool-summary-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: #e0f2fe;
  border: 1px solid #bae6fd;
}

.ide-tool-event--done .ide-tool-summary-icon {
  color: #047857;
  background: #d1fae5;
  border-color: #a7f3d0;
}

.ide-tool-event--error .ide-tool-summary-icon {
  color: #b91c1c;
  background: #fee2e2;
  border-color: #fecaca;
}

:global(html.dark) .ide-tool-summary-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.25);
}

:global(html.dark) .ide-tool-event--done .ide-tool-summary-icon {
  color: #6ee7b7;
  background: rgba(16, 185, 129, 0.14);
  border-color: rgba(52, 211, 153, 0.24);
}

:global(html.dark) .ide-tool-event--error .ide-tool-summary-icon {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.24);
  border-color: rgba(248, 113, 113, 0.3);
}

.ide-tool-summary-main {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.ide-tool-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}

.ide-tool-subtitle {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #64748b;
}

:global(html.dark) .ide-tool-subtitle {
  color: #94a3b8;
}

.ide-tool-status {
  font-weight: 650;
}

.ide-tool-duration {
  color: #475569;
}

:global(html.dark) .ide-tool-duration {
  color: #cbd5e1;
}

.ide-tool-chevron {
  color: #64748b;
  transition: transform 160ms ease;
}

.ide-tool-card[open] .ide-tool-chevron {
  transform: rotate(90deg);
}

.ide-tool-body {
  display: grid;
  gap: 10px;
  padding: 0 12px 12px;
}

.ide-tool-section {
  border-top: 1px solid rgba(226, 232, 240, 0.92);
  padding-top: 10px;
}

:global(html.dark) .ide-tool-section {
  border-top-color: rgba(51, 65, 85, 0.82);
}

.ide-tool-section summary,
.ide-tool-section-title {
  margin-bottom: 7px;
  color: #475569;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
}

.ide-tool-section summary {
  cursor: pointer;
}

:global(html.dark) .ide-tool-section summary,
:global(html.dark) .ide-tool-section-title {
  color: #cbd5e1;
}

.ide-tool-section pre,
.ide-tool-log pre {
  margin: 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 8px;
  border: 1px solid rgba(203, 213, 225, 0.86);
  background: rgba(248, 250, 252, 0.92);
  color: #0f172a;
  padding: 9px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
}

:global(html.dark) .ide-tool-section pre,
:global(html.dark) .ide-tool-log pre {
  border-color: rgba(71, 85, 105, 0.86);
  background: rgba(2, 6, 23, 0.66);
  color: #e2e8f0;
}

.ide-tool-log-list {
  display: grid;
  gap: 8px;
}

.ide-tool-log {
  display: grid;
  gap: 5px;
}

.ide-tool-log-stream {
  width: fit-content;
  border-radius: 6px;
  padding: 2px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 10px;
  font-weight: 700;
  color: #0369a1;
  background: rgba(14, 165, 233, 0.1);
}

.ide-tool-log--stderr .ide-tool-log-stream {
  color: #b91c1c;
  background: rgba(220, 38, 38, 0.1);
}

:global(html.dark) .ide-tool-log-stream {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.14);
}

:global(html.dark) .ide-tool-log--stderr .ide-tool-log-stream {
  color: #fecaca;
  background: rgba(220, 38, 38, 0.18);
}

.ide-chat-pending {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 42px;
  min-height: 20px;
}

.ide-chat-pending span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #38bdf8;
  animation: ide-dot 900ms ease-in-out infinite;
}

.ide-chat-pending span:nth-child(2) {
  animation-delay: 120ms;
}

.ide-chat-pending span:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes ide-dot {
  0%, 80%, 100% { opacity: 0.35; }
  40% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .ide-chat-pending span {
    animation: none;
  }
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

  .ide-chat-message {
    max-width: 100%;
  }
}
</style>
