<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import IdeApprovalModeMenu from '@/components/ide/IdeApprovalModeMenu.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useIdeChat, type IdeApprovalMode } from '@/composables/useIdeChat';
import { useNotifyStore } from '@/stores/notify';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';
import type { AiTaskInfo, AiTaskSaveResponse } from '@/utils/aiTasks';

const router = useRouter();
const route = useRoute();
const { requestJson } = useApiClient();
const { confirm } = useConfirm();
const notify = useNotifyStore();
const chatEl = ref<HTMLElement | null>(null);
const taskModalOpen = ref(false);
const taskMode = ref<'new' | 'pack'>('new');
const taskIntent = ref('');
const savingTaskDraft = ref(false);
const nextEntry = ref<'core' | 'task'>('core');
const approvalMode = ref<IdeApprovalMode>('manual');
const taskAuthoringContext = ref<Record<string, unknown> | null>(null);
const ide = useIdeChat({
  approvalMode: () => outgoingApprovalMode(),
  context: () => ({
    taskAuthoring: taskAuthoringContext.value,
  }),
  messagePayload: () => ({
    entry: nextEntry.value,
    approvalMode: outgoingApprovalMode(),
  }),
  onTaskSaved: handleTaskSaved,
});
let followOutput = true;

const taskSuggestionVisible = computed(() => {
  if (ide.isRunning.value) return false;
  const text = ide.inputText.value.trimStart();
  return /^\/(?:t(?:a(?:s(?:k)?)?)?)?$/i.test(text);
});

watch(() => ide.timeline.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => ide.timeline.value, () => { void nextTick(() => scrollToBottom()); }, { deep: true });

onBeforeUnmount(() => {
  ide.dispose();
});

onMounted(() => {
  if (route.query.taskAuthoring !== '1') return;
  const initialIntent = typeof route.query.taskIntent === 'string' ? route.query.taskIntent : '';
  openTaskModal(initialIntent);
  const nextQuery = { ...route.query };
  delete nextQuery.taskAuthoring;
  delete nextQuery.taskIntent;
  void router.replace({ path: '/ide', query: nextQuery });
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
    if (taskSuggestionVisible.value) {
      selectTaskSuggestion();
      return;
    }
    sendOrOpenTask();
  }
}

function onSecretRefSubmit(secretRef: string): void {
  ide.approveCustomText.value = secretRef;
  ide.approveCustom();
}

function handleTaskSaved(payload: { taskId?: string; task?: unknown; action?: string }): void {
  const task = payload.task && typeof payload.task === 'object' ? payload.task as Partial<AiTaskInfo> : null;
  const taskId = String(payload.taskId || task?.id || '').trim();
  if (!taskId) return;
  notify.success(payload.action === 'updated' ? 'AI 任务已更新到任务界面' : 'AI 任务已写入任务界面');
  void router.push({ path: '/features', query: { tab: 'tasks', task: taskId } });
}

function parseTaskCommand(value: string): string | null {
  const match = String(value || '').match(/^\/task(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return String(match[1] || '').trim();
}

function openTaskModal(initialIntent = ''): void {
  taskIntent.value = initialIntent;
  taskMode.value = looksLikePackRequest(initialIntent) ? 'pack' : 'new';
  taskModalOpen.value = true;
}

function closeTaskModal(): void {
  if (savingTaskDraft.value) return;
  taskModalOpen.value = false;
}

function outgoingApprovalMode(): IdeApprovalMode {
  return nextEntry.value === 'task' ? 'manual' : approvalMode.value;
}

async function setApprovalMode(mode: IdeApprovalMode): Promise<void> {
  if (ide.isRunning.value || approvalMode.value === mode) return;
  if (mode === 'full_access') {
    const ok = await confirm({
      title: '启用完全权限',
      message: '完全权限会对本次 IDE 对话预授权更高风险的文件、命令和网络操作。确定要启用吗？',
      okText: '启用完全权限',
      okClass: 'bg-red-600 hover:bg-red-700 text-white',
    });
    if (!ok) return;
  }
  approvalMode.value = mode;
}

function sendOrOpenTask(): void {
  const commandIntent = parseTaskCommand(ide.inputText.value);
  if (commandIntent === null) {
    nextEntry.value = 'core';
    taskAuthoringContext.value = null;
    ide.sendMessage();
    return;
  }
  ide.inputText.value = '';
  openTaskModal(commandIntent);
}

function selectTaskSuggestion(): void {
  const commandIntent = parseTaskCommand(ide.inputText.value);
  ide.inputText.value = '';
  openTaskModal(commandIntent || '');
}

function looksLikePackRequest(value: string): boolean {
  return /上面|刚才|流程|打包|复用|对话|步骤|过程/.test(value);
}

function buildTaskAuthoringPrompt(): string {
  const modeText = taskMode.value === 'pack' ? '把当前 IDE 对话中的流程打包为 AI 任务' : '从用户目标创建新的 AI 任务';
  const userIntent = taskIntent.value.trim() || '用户还没有补充具体目标，请先询问。';
  return [
    '进入 /task 任务创作模式。',
    '',
    `模式：${modeText}`,
    `用户输入：${userIntent}`,
    '',
    '工作方式：',
    '- 这个回合的目标是创作 AI 任务模板，不是直接执行普通工作。',
    '- 任务模板保持简单：几个用户需要填写的输入项，加几张流程步骤卡片。',
    '- 不要设计新的权限系统、审批层、DSL、调度器或第二套 Agent。',
    '- 如果是新任务，必须先真实实践或沙箱实践出可行流程，再把成功路径包装成任务；不能凭空猜，也不能只保存通用模板。',
    '- 发现类工具只用于收集上下文；list_hosts、list_scripts、read_remote_file、get_ai_task 或数据库持久化结果都不算工作流验证。',
    '- 缺少目标主机、仓库地址、分支、端口、运行命令、密钥或清理偏好时，先 ask_user 或 request_secret。',
    '- 如果是打包上面对话，从本 IDE 会话历史里提取已经成功验证的路径，忽略失败分支；缺关键条件时先问用户。',
    '- 需要密钥、token、密码时，使用 request_secret，不要让用户在普通文本里粘贴明文。',
    '- 必须调用 verify_outcome 记录命令、HTTP、文件或端口级成功证据；没有成功实践和 verify_outcome 证据时，不要调用 create_ai_task 或 update_ai_task。',
    '- For GitHub deployment tasks, the practice run must actually use the repository (clone/checkout plus build/run, or docker build from the repo URL). If practice only used a prebuilt Docker image, save an image-based deployment task instead and do not include repo_url or GitHub-project claims.',
    '- 证据齐全后，先调用 preview_ai_task 检查结构，再调用 create_ai_task 保存任务；修改已有任务时用 update_ai_task。',
    '',
    '保存任务的结构如下：',
    '{',
    '  "name": "任务名称",',
    '  "description": "任务说明",',
    '  "inputs": [{ "key": "host", "label": "目标主机", "type": "host", "required": true }],',
    '  "steps": [{ "title": "步骤标题", "instruction": "给 1Shell AI 的执行说明" }]',
    '}',
  ].join('\n');
}

function startTaskAuthoring(): void {
  const prompt = buildTaskAuthoringPrompt();
  taskModalOpen.value = false;
  nextEntry.value = 'task';
  taskAuthoringContext.value = {
    mode: taskMode.value,
    intent: taskIntent.value.trim(),
  };
  ide.inputText.value = prompt;
  window.setTimeout(() => {
    ide.sendMessage();
    nextEntry.value = 'core';
    taskAuthoringContext.value = null;
  }, 0);
}

function draftTaskName(): string {
  const firstLine = taskIntent.value.trim().split(/\r?\n/).find(Boolean) || '';
  return firstLine.slice(0, 80) || '未命名 AI 任务';
}

async function saveEmptyTaskDraft(): Promise<void> {
  savingTaskDraft.value = true;
  try {
    const resp = await requestJson<AiTaskSaveResponse>('/api/ai-tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: draftTaskName(),
        description: taskIntent.value.trim(),
        inputs: [
          { key: 'host', label: '目标主机', type: 'host', required: true },
        ],
        steps: [
          { title: '实践流程', instruction: '先让 1Shell AI 根据目标真实实践或沙箱实践可行方案。' },
          { title: '整理步骤', instruction: '把已经验证过的流程整理成可复用步骤。' },
          { title: '输出报告', instruction: '执行后总结输入、操作、结果和遗留问题。' },
        ],
      }),
    });
    taskModalOpen.value = false;
    notify.success('任务草稿已创建');
    void router.push({ path: '/features', query: { tab: 'tasks', task: resp.task.id } });
  } catch (err) {
    notify.error(err instanceof Error ? err.message : String(err), 5000);
  } finally {
    savingTaskDraft.value = false;
  }
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
        <button
          v-if="taskSuggestionVisible"
          type="button"
          class="ide-command-suggestion"
          @mousedown.prevent
          @click="selectTaskSuggestion"
        >
          <span class="ide-command-suggestion-icon">
            <AppIcon name="spark" :size="15" />
          </span>
          <span class="ide-command-suggestion-copy">
            <strong>/task</strong>
            <span>创作或打包一个可复用 AI 任务</span>
          </span>
          <AppIcon name="arrow-right" :size="14" />
        </button>
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
          <div class="ide-chat-left-actions">
            <IdeApprovalModeMenu
              :model-value="approvalMode"
              :disabled="ide.isRunning.value"
              density="full"
              @update:model-value="setApprovalMode"
            />
            <span class="ide-chat-hint">{{ ide.isRunning.value ? ide.statusText.value : '待命' }}</span>
          </div>
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
            @click="sendOrOpenTask"
          >
            <AppIcon name="arrow-up" :size="16" :stroke-width="2" />
            <span>发送</span>
          </button>
        </div>
      </div>
    </main>

    <Teleport to="body">
      <div v-if="taskModalOpen" class="task-command-backdrop" @click.self="closeTaskModal">
        <section class="task-command-modal" role="dialog" aria-modal="true" aria-labelledby="task-command-title">
          <header class="task-command-header">
            <span class="task-command-icon">
              <AppIcon name="spark" :size="18" />
            </span>
            <div class="task-command-title-wrap">
              <h2 id="task-command-title">/task</h2>
              <p>AI 任务创作</p>
            </div>
            <button type="button" class="task-command-close" title="关闭" @click="closeTaskModal">
              <AppIcon name="close" :size="16" />
            </button>
          </header>

          <div class="task-command-body">
            <div class="task-command-segmented" role="tablist" aria-label="任务创作模式">
              <button
                type="button"
                class="task-command-segment"
                :class="{ 'task-command-segment-active': taskMode === 'new' }"
                @click="taskMode = 'new'"
              >
                新任务
              </button>
              <button
                type="button"
                class="task-command-segment"
                :class="{ 'task-command-segment-active': taskMode === 'pack' }"
                @click="taskMode = 'pack'"
              >
                打包对话
              </button>
            </div>

            <label class="task-command-label" for="task-command-intent">
              {{ taskMode === 'pack' ? '要打包的流程' : '任务目标' }}
            </label>
            <textarea
              id="task-command-intent"
              v-model="taskIntent"
              rows="7"
              class="task-command-textarea"
              :placeholder="taskMode === 'pack' ? '例如：把上面部署和验证服务的流程打包成任务' : '例如：创建一个检查 Nginx 状态并自动修复的任务'"
              spellcheck="false"
            />
          </div>

          <footer class="task-command-footer">
            <button type="button" class="task-command-ghost" @click="closeTaskModal">
              取消
            </button>
            <button
              type="button"
              class="task-command-secondary"
              :disabled="savingTaskDraft"
              @click="saveEmptyTaskDraft"
            >
              {{ savingTaskDraft ? '保存中...' : '保存空草稿' }}
            </button>
            <button type="button" class="task-command-primary" @click="startTaskAuthoring">
              开始创作
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
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

:global(.dark) .ide-page {
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

:global(.dark) .ide-page-header {
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

:global(.dark) .ide-page-title-icon {
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

:global(.dark) .ide-page-title p {
  color: #94a3b8;
}

.ide-page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ide-approval-mode-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 10px;
  background: rgba(241, 245, 249, 0.86);
}

.ide-approval-mode-btn {
  min-height: 30px;
  border: 0;
  border-radius: 7px;
  padding: 0 9px;
  color: #475569;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  transition: background-color 160ms ease, color 160ms ease;
}

.ide-approval-mode-btn:hover:not(:disabled),
.ide-approval-mode-btn--active {
  color: #0369a1;
  background: #ffffff;
}

.ide-approval-mode-btn:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

:global(.dark) .ide-approval-mode-group {
  border-color: rgba(51, 65, 85, 0.84);
  background: rgba(2, 6, 23, 0.72);
}

:global(.dark) .ide-approval-mode-btn {
  color: #cbd5e1;
}

:global(.dark) .ide-approval-mode-btn:hover:not(:disabled),
:global(.dark) .ide-approval-mode-btn--active {
  color: #7dd3fc;
  background: rgba(30, 41, 59, 0.96);
}

.ide-page-status {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #475569;
}

:global(.dark) .ide-page-status {
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

:global(.dark) .ide-page-ghost-btn {
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
}

:global(.dark) .ide-page-ghost-btn:hover:not(:disabled) {
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

:global(.dark) .ide-chat-empty {
  color: #94a3b8;
}

:global(.dark) .ide-chat-empty strong {
  color: #e2e8f0;
}

.ide-chat-composer {
  border-top: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(255, 255, 255, 0.78);
  padding: 14px 22px 18px;
  display: grid;
  gap: 10px;
}

:global(.dark) .ide-chat-composer {
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

:global(.dark) .ide-chat-input {
  background: rgba(2, 6, 23, 0.72);
  border-color: rgba(71, 85, 105, 0.9);
  color: #e2e8f0;
}

.ide-command-suggestion {
  min-height: 52px;
  border: 1px solid rgba(14, 165, 233, 0.24);
  border-radius: 9px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  color: #0f172a;
  background: rgba(240, 249, 255, 0.88);
  cursor: pointer;
  text-align: left;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.ide-command-suggestion:hover,
.ide-command-suggestion:focus-visible {
  border-color: rgba(14, 165, 233, 0.48);
  background: #e0f2fe;
  outline: none;
}

.ide-command-suggestion:focus-visible {
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.16);
}

.ide-command-suggestion-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(186, 230, 253, 0.9);
}

.ide-command-suggestion-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.ide-command-suggestion-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  font-weight: 760;
}

.ide-command-suggestion-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #475569;
  font-size: 12px;
}

:global(.dark) .ide-command-suggestion {
  color: #e2e8f0;
  border-color: rgba(56, 189, 248, 0.2);
  background: rgba(14, 165, 233, 0.1);
}

:global(.dark) .ide-command-suggestion:hover,
:global(.dark) .ide-command-suggestion:focus-visible {
  border-color: rgba(56, 189, 248, 0.34);
  background: rgba(14, 165, 233, 0.16);
}

:global(.dark) .ide-command-suggestion-icon {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.24);
  background: rgba(15, 23, 42, 0.72);
}

:global(.dark) .ide-command-suggestion-copy span {
  color: #94a3b8;
}

.ide-chat-composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ide-chat-left-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.ide-chat-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #64748b;
}

:global(.dark) .ide-chat-hint {
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

:global(.dark) .ide-chat-stop-btn {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.24);
  border-color: rgba(248, 113, 113, 0.35);
}

:global(.dark) .ide-chat-stop-btn:hover {
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

.task-command-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(8px);
}

.task-command-modal {
  width: min(620px, calc(100vw - 36px));
  max-height: calc(100vh - 36px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(255, 255, 255, 0.96);
  color: #0f172a;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
}

:global(.dark) .task-command-modal {
  border-color: rgba(71, 85, 105, 0.78);
  background: rgba(15, 23, 42, 0.98);
  color: #e2e8f0;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.46);
}

.task-command-header {
  min-height: 62px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 15px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.24);
}

:global(.dark) .task-command-header {
  border-bottom-color: rgba(51, 65, 85, 0.72);
}

.task-command-icon {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0369a1;
  background: #e0f2fe;
  border: 1px solid #bae6fd;
}

:global(.dark) .task-command-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.24);
}

.task-command-title-wrap {
  min-width: 0;
  flex: 1;
}

.task-command-title-wrap h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 760;
  letter-spacing: 0;
}

.task-command-title-wrap p {
  margin: 2px 0 0;
  color: #64748b;
  font-size: 12px;
}

:global(.dark) .task-command-title-wrap p {
  color: #94a3b8;
}

.task-command-close {
  width: 36px;
  height: 36px;
  border: 1px solid rgba(148, 163, 184, 0.36);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  background: rgba(255, 255, 255, 0.76);
  cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
}

.task-command-close:hover {
  color: #0369a1;
  border-color: rgba(14, 165, 233, 0.42);
}

:global(.dark) .task-command-close {
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
}

.task-command-body {
  min-height: 0;
  overflow-y: auto;
  padding: 15px;
  display: grid;
  gap: 12px;
}

.task-command-segmented {
  width: max-content;
  max-width: 100%;
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: #f1f5f9;
}

:global(.dark) .task-command-segmented {
  border-color: rgba(51, 65, 85, 0.85);
  background: rgba(2, 6, 23, 0.72);
}

.task-command-segment {
  min-width: 86px;
  height: 32px;
  border: 0;
  border-radius: 7px;
  color: #64748b;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  transition: background-color 160ms ease, color 160ms ease;
}

.task-command-segment-active {
  color: #0369a1;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

:global(.dark) .task-command-segment {
  color: #94a3b8;
}

:global(.dark) .task-command-segment-active {
  color: #7dd3fc;
  background: rgba(30, 41, 59, 0.96);
}

.task-command-label {
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}

:global(.dark) .task-command-label {
  color: #cbd5e1;
}

.task-command-textarea {
  width: 100%;
  min-height: 168px;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: rgba(248, 250, 252, 0.92);
  color: #0f172a;
  padding: 11px 12px;
  font-size: 13px;
  line-height: 1.55;
  outline: none;
}

.task-command-textarea:focus {
  border-color: #0284c7;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.16);
}

:global(.dark) .task-command-textarea {
  border-color: rgba(71, 85, 105, 0.9);
  background: rgba(2, 6, 23, 0.72);
  color: #e2e8f0;
}

.task-command-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  padding: 13px 15px;
  border-top: 1px solid rgba(148, 163, 184, 0.24);
}

:global(.dark) .task-command-footer {
  border-top-color: rgba(51, 65, 85, 0.72);
}

.task-command-ghost,
.task-command-secondary,
.task-command-primary {
  min-height: 38px;
  border-radius: 8px;
  padding: 0 13px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 740;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.task-command-ghost,
.task-command-secondary {
  border: 1px solid rgba(148, 163, 184, 0.42);
  background: rgba(255, 255, 255, 0.78);
  color: #475569;
}

.task-command-ghost:hover,
.task-command-secondary:hover:not(:disabled) {
  color: #0369a1;
  border-color: rgba(14, 165, 233, 0.42);
}

.task-command-secondary:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

:global(.dark) .task-command-ghost,
:global(.dark) .task-command-secondary {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
  color: #cbd5e1;
}

.task-command-primary {
  border: 1px solid #0284c7;
  color: #ffffff;
  background: #0284c7;
}

.task-command-primary:hover {
  background: #0369a1;
  border-color: #0369a1;
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

  .ide-chat-composer-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .ide-chat-left-actions {
    width: 100%;
    justify-content: space-between;
  }

  .ide-chat-stop-btn,
  .ide-chat-send-btn {
    width: 100%;
  }

  .task-command-footer {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .task-command-ghost,
  .task-command-secondary,
  .task-command-primary {
    width: 100%;
  }

}
</style>
