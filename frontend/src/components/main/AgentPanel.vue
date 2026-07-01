<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useAgentPanel } from '@/composables/useAgentPanel';
import { useNotifyStore } from '@/stores/notify';

const agent = useAgentPanel();
const notify = useNotifyStore();
const terminalWrapEl = ref<HTMLElement | null>(null);

onMounted(() => {
  if (terminalWrapEl.value) {
    agent.initialize(terminalWrapEl.value);
  }
});

async function handleStart(): Promise<void> {
  try {
    await agent.startAgent();
  } catch (err) {
    notify.error((err as Error).message || '启动 Agent 失败');
  }
}

function getSessionDotColor(status: string): string {
  if (status === 'ready') return 'bg-purple-400';
  if (status === 'starting') return 'bg-amber-400';
  return 'bg-red-400';
}
</script>

<template>
  <div class="agent-panel">
    <!-- 会话标签页（类似终端 tabs） -->
    <div v-if="agent.hasSessions.value" class="agent-tabs">
      <div
        v-for="[sessionKey, sess] in agent.sessions.value"
        :key="sessionKey"
        class="agent-tab"
        :class="{ 'agent-tab--active': agent.activeSessionKey.value === sessionKey }"
        @click="agent.switchToSession(sessionKey)"
      >
        <span class="agent-tab-dot" :class="getSessionDotColor(sess.status)" />
        <span class="agent-tab-label">{{ sess.label }}</span>
        <button
          type="button"
          class="agent-tab-close"
          title="停止并关闭"
          @click.stop="agent.closeSession(sessionKey)"
        >×</button>
      </div>
    </div>

    <!-- 标题栏 -->
    <div class="agent-panel-header">
      <div class="agent-panel-title-block">
        <span class="agent-panel-title">AI Agent</span>
      </div>
    </div>

    <!-- Provider 选择 + 状态 -->
    <div class="agent-toolbar">
      <select
        :value="agent.selectedProviderId.value"
        class="agent-provider-select"
        @change="(e) => agent.setSelectedProvider((e.target as HTMLSelectElement).value)"
      >
        <option
          v-for="p in agent.providers.value"
          :key="p.id"
          :value="p.id"
        >
          {{ p.label }}{{ p.binaryPath ? ` · ${p.binaryPath}` : '' }}
        </option>
      </select>
      <span class="agent-status-text">{{ agent.statusText.value }}</span>
    </div>

    <!-- 终端区（多会话，useAgentXterm 动态渲染） -->
    <div ref="terminalWrapEl" class="agent-terminal-wrap" />

    <!-- 操作按钮 -->
    <div class="agent-panel-footer">
      <button
        type="button"
        class="agent-btn agent-btn-start"
        @click="handleStart"
      >启动</button>
      <button
        type="button"
        class="agent-btn agent-btn-stop"
        :disabled="!agent.activeSessionKey.value"
        @click="agent.stopAgent"
      >停止</button>
      <button
        type="button"
        class="agent-btn agent-btn-clear"
        :disabled="!agent.activeSessionKey.value"
        @click="agent.clearTerminal"
      >清屏</button>
    </div>
  </div>
</template>
