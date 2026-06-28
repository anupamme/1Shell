<script setup lang="ts">
// AiChatPanel.vue — MainConsole 刀 4 · AI Chat 右栏
// 1:1 复刻 [public/ai-chat.js](public/ai-chat.js) UI + [public/index.html:428-458](public/index.html#L428-L458)
import { nextTick, onMounted, ref, watch } from 'vue';

import { useAiChat } from '@/composables/useAiChat';
import type { AiChatSession } from '@/composables/useAiChat';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';

const chat = useAiChat();
const messagesEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
let followOutput = true;

onMounted(() => {
  chat.initialize();
  scrollToBottom(true);
});

watch(() => chat.displayMessages.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => chat.displayMessages.value, () => { void nextTick(() => scrollToBottom()); }, { deep: true });

function onMessagesScroll(): void {
  const el = messagesEl.value;
  followOutput = !el || isNearScrollBottom(el);
}

function scrollToBottom(force = false): void {
  scrollToBottomIfPinned(messagesEl.value, force || followOutput);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    void chat.sendMessage();
  }
}

function sessionOptionText(session: AiChatSession): string {
  return session.title || '新对话';
}
</script>

<template>
  <div class="ai-chat-panel">
    <!-- header -->
    <div class="ai-chat-header">
      <div class="ai-chat-header-main">
        <span class="ai-chat-title">AI Chat</span>
        <button
          type="button"
          class="ai-chat-action-btn primary"
          :disabled="chat.isStreaming.value"
          @click="chat.startNewChat()"
        >新对话</button>
      </div>
      <div class="ai-chat-session-controls">
        <label class="ai-chat-control grow">
          <span>历史</span>
          <select
            v-model="chat.activeSessionId.value"
            class="ai-chat-select"
          >
            <option
              v-for="session in chat.sessionsList.value"
              :key="session.id"
              :value="session.id"
            >{{ sessionOptionText(session) }}</option>
          </select>
        </label>
      </div>
      <div class="ai-chat-header-actions">
        <button
          type="button"
          class="ai-chat-action-btn"
          :disabled="chat.isStreaming.value"
          @click="chat.resetCurrentChat"
        >清空</button>
        <button
          type="button"
          class="ai-chat-action-btn danger"
          :disabled="chat.isStreaming.value || chat.sessionsList.value.length <= 1"
          @click="chat.deleteCurrentChat"
        >删除</button>
      </div>
    </div>

    <!-- messages -->
    <div ref="messagesEl" class="ai-chat-messages" @scroll="onMessagesScroll">
      <div
        v-for="(msg, i) in chat.displayMessages.value"
        :key="i"
        class="ai-chat-message"
        :class="[`ai-chat-message-${msg.role}`, { 'ai-chat-message-pending': msg.pending }]"
      >
        <div class="ai-chat-avatar">{{ msg.role === 'user' ? '你' : 'AI' }}</div>
        <!-- html 已 escapeHtml + 安全 Markdown 转换 -->
        <div class="ai-chat-bubble markdown-body" v-html="msg.html" />
      </div>
    </div>

    <!-- input -->
    <div class="ai-chat-input-area">
      <textarea
        ref="inputEl"
        v-model="chat.inputText.value"
        rows="3"
        placeholder="输入问题，Ctrl+Enter 发送"
        autocomplete="off"
        spellcheck="false"
        class="ai-chat-input"
        :disabled="chat.isStreaming.value"
        @keydown="onKeydown"
      />
      <button
        v-if="!chat.isStreaming.value"
        type="button"
        class="ai-chat-send-btn"
        :disabled="!chat.inputText.value.trim()"
        @click="chat.sendMessage"
      >发送</button>
      <button
        v-else
        type="button"
        class="ai-chat-send-btn"
        @click="chat.stopStreaming"
      >停止</button>
    </div>
  </div>
</template>
