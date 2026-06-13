<script setup lang="ts">
// IdePanel.vue — MainConsole 刀 5a · 1Shell AI 右栏（与 AiChatPanel 在右栏 tab 切换）
// 1:1 复刻 [public/ide-panel.js](public/ide-panel.js) UI + [public/index.html:495-532](public/index.html#L495-L532)
//
// feedback-right-aside-tabs：右栏用 tab 切换不是 toggle，故 close 按钮不渲染（关闭=切回 AI Chat tab）
// feedback-migration-no-improvements：tool picker 不做（老版 DOM 缺失，行为对齐）
import { nextTick, onMounted, ref, watch } from 'vue';

import { useIdePanel } from '@/composables/useIdePanel';
import ToolProgressBar from '@/components/ToolProgressBar.vue';
import { renderMarkdown } from '@/utils/markdown';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';

const props = defineProps<{ active?: boolean }>();
const ide = useIdePanel();
const chatAreaEl = ref<HTMLElement | null>(null);
let followOutput = true;

onMounted(() => { ide.initialize(); });

watch(() => ide.turns.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => ide.turns.value, () => { void nextTick(() => scrollToBottom()); }, { deep: true });
watch(() => props.active, (active) => {
  if (active) void nextTick(() => scrollToBottom(true));
});

function onChatScroll(): void {
  const el = chatAreaEl.value;
  followOutput = !el || isNearScrollBottom(el);
}

function scrollToBottom(force = false): void {
  const el = chatAreaEl.value;
  scrollToBottomIfPinned(el, force || followOutput);
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ide.sendMessage();
  }
}

function lineClass(kind: string): string {
  return {
    stdout: 'ide-line-stdout',
    stderr: 'ide-line-stderr',
    info: 'ide-line-info',
    error: 'ide-line-error',
    success: 'ide-line-success',
    stream: 'ide-line-stdout',
  }[kind] || 'ide-line-stdout';
}
</script>

<template>
  <div class="ide-panel">
    <!-- header -->
    <div class="ide-panel-header">
      <div class="ide-panel-title-block">
        <span class="ide-panel-title">1Shell AI</span>
        <span class="ide-panel-badge">IDE</span>
      </div>
      <div class="ide-panel-toggles">
        <label
          class="ide-toggle ide-toggle-cc"
          :class="{ 'ide-toggle--active': ide.claudeCodeEnabled.value }"
          title="Claude Code 协作：允许调用 Claude Code 处理复杂创作任务"
        >
          <input
            type="checkbox"
            :checked="ide.claudeCodeEnabled.value"
            @change="(e) => ide.setClaudeCodeEnabled((e.target as HTMLInputElement).checked)"
          />
          <span>✦ CC</span>
        </label>
        <button
          type="button"
          class="ide-panel-clear-btn"
          :disabled="!ide.canPackageLastRun.value || ide.packageDraft.value.loading || ide.packageDraft.value.saving"
          title="从最近完成的 AgentRun 生成自动化任务草稿"
          @click="ide.packageLastRun"
        >打包任务</button>
        <button
          type="button"
          class="ide-panel-clear-btn"
          :disabled="ide.isRunning.value"
          title="清空对话"
          @click="ide.resetChat"
        >清空</button>
      </div>
    </div>

    <!-- chat area -->
    <div ref="chatAreaEl" class="ide-panel-chat" @scroll="onChatScroll">
      <div v-if="!ide.hasMessages.value" class="ide-panel-placeholder">
        <span class="ide-panel-placeholder-icon">💻</span>
        <span>1Shell AI 助手<br />输入需求，AI 会在你的主机上执行操作</span>
      </div>
      <template v-for="(turn, i) in ide.turns.value" :key="i">
        <div v-if="turn.role === 'user'" class="ide-turn ide-turn-user">
          <div class="ide-bubble-user">{{ turn.text }}</div>
        </div>
        <div v-else class="ide-turn ide-turn-assistant">
          <div class="ide-turn-meta"><span>🤖</span><span>1Shell AI</span></div>
          <div class="ide-bubble-assistant">
            <div
              v-for="(line, j) in turn.lines || []"
              :key="j"
              :class="['ide-line', 'markdown-body', lineClass(line.kind)]"
              v-html="renderMarkdown(line.text)"
            ></div>
            <ToolProgressBar v-if="turn.toolCalls?.length" :calls="turn.toolCalls" class="mt-2" />
          </div>
        </div>
      </template>
    </div>

    <div v-if="ide.packageDraft.value.visible" class="ide-package-draft-panel">
      <div class="ide-package-draft-header">
        <div>
          <strong>自动化任务草稿</strong>
          <span v-if="ide.packageDraft.value.result" class="ide-package-draft-badge">
            {{ ide.packageDraft.value.result.trustLevel || 'draft' }}
          </span>
        </div>
        <button type="button" class="ide-package-draft-close" @click="ide.closePackageDraft">×</button>
      </div>
      <div class="ide-package-draft-body">
        <label class="ide-package-draft-label">
          任务 ID
          <input
            v-model="ide.packageDraft.value.programId"
            class="ide-package-draft-input"
            placeholder="留空则自动生成"
            :disabled="ide.packageDraft.value.loading || ide.packageDraft.value.saving"
          />
        </label>
        <div v-if="ide.packageDraft.value.error" class="ide-package-draft-error">
          {{ ide.packageDraft.value.error }}
        </div>
        <div v-if="ide.packageDraft.value.result" class="ide-package-draft-meta">
          <span>source: {{ ide.packageDraft.value.result.sourceTrustLevel || '-' }}</span>
          <span>written: {{ ide.packageDraft.value.result.written ? 'true' : 'false' }}</span>
          <span>path: {{ ide.packageDraft.value.result.path || '-' }}</span>
        </div>
        <ul v-if="ide.packageDraft.value.result?.warnings?.length" class="ide-package-draft-warnings">
          <li v-for="(warning, idx) in ide.packageDraft.value.result.warnings" :key="idx">{{ warning }}</li>
        </ul>
        <textarea
          v-if="ide.packageDraft.value.result?.yaml"
          class="ide-package-draft-yaml"
          readonly
          :value="ide.packageDraft.value.result.yaml"
        ></textarea>
        <div class="ide-package-draft-actions">
          <button
            type="button"
            class="ide-panel-clear-btn"
            :disabled="ide.packageDraft.value.loading || ide.packageDraft.value.saving"
            @click="ide.packageLastRun"
          >重新预览</button>
          <button
            type="button"
            class="ide-panel-send-btn"
            :disabled="!ide.packageDraft.value.result || ide.packageDraft.value.loading || ide.packageDraft.value.saving"
            @click="ide.savePackageDraft"
          >{{ ide.packageDraft.value.saving ? '保存中...' : '保存草稿' }}</button>
        </div>
        <p class="ide-package-draft-note">
          注意：当前只是 draft_from_trace 草稿，不是 proven；后续需要 replay 验证后才能升级可信等级。
        </p>
      </div>
    </div>

    <!-- input -->
    <div class="ide-panel-input-area">
      <textarea
        v-model="ide.inputText.value"
        rows="2"
        placeholder="描述你的需求，如：查看所有容器状态、检查磁盘占用..."
        class="ide-panel-input"
        spellcheck="false"
        @keydown="onInputKeydown"
      />
      <div class="ide-panel-input-row">
        <span class="ide-panel-status">{{ ide.statusText.value }}</span>
        <button
          v-if="!ide.isRunning.value"
          type="button"
          class="ide-panel-send-btn"
          :disabled="!ide.inputText.value.trim()"
          @click="ide.sendMessage"
        >发送 →</button>
        <button
          v-else
          type="button"
          class="ide-panel-stop-btn"
          @click="ide.stop"
        >停止</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ide-package-draft-panel {
  border-top: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.92);
  padding: 10px 12px;
}

.ide-package-draft-header,
.ide-package-draft-actions,
.ide-package-draft-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ide-package-draft-header {
  justify-content: space-between;
  margin-bottom: 8px;
}

.ide-package-draft-badge {
  margin-left: 8px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.14);
  color: #86efac;
  font-size: 11px;
}

.ide-package-draft-close {
  border: 0;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  font-size: 18px;
}

.ide-package-draft-body {
  display: grid;
  gap: 8px;
}

.ide-package-draft-label {
  display: grid;
  gap: 4px;
  color: #cbd5e1;
  font-size: 12px;
}

.ide-package-draft-input,
.ide-package-draft-yaml {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.7);
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.ide-package-draft-input {
  padding: 7px 9px;
}

.ide-package-draft-yaml {
  min-height: 180px;
  max-height: 280px;
  padding: 10px;
  resize: vertical;
  font-size: 12px;
}

.ide-package-draft-meta {
  flex-wrap: wrap;
  color: #94a3b8;
  font-size: 11px;
}

.ide-package-draft-error,
.ide-package-draft-warnings {
  color: #fca5a5;
  font-size: 12px;
}

.ide-package-draft-warnings {
  margin: 0;
  padding-left: 18px;
}

.ide-package-draft-actions {
  justify-content: flex-end;
}

.ide-package-draft-note {
  margin: 0;
  color: #94a3b8;
  font-size: 11px;
}
</style>
