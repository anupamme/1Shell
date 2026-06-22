<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import IdeApprovalModeMenu from '@/components/ide/IdeApprovalModeMenu.vue';
import IdeModelSlashMenu from '@/components/ide/IdeModelSlashMenu.vue';
import IdeSlashCommandMenu from '@/components/ide/IdeSlashCommandMenu.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useAgentModelProviders } from '@/composables/useAgentModelProviders';
import { useIdeChat, type IdeApprovalMode } from '@/composables/useIdeChat';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import {
  agentGoalObjective,
  emptyAgentGoalState,
  parseAgentGoalCommand,
  reduceAgentGoalCommand,
  serializeAgentGoal,
  type AgentGoalCommand,
} from '@/utils/agentGoal';
import {
  agentSlashCommandsForSurface,
  filterAgentSlashCommands,
  parseAgentClearCommand,
  parseAgentModeCommand,
  parseAgentModelCommand,
  parseAgentTaskCommand,
  type AgentSlashCommand,
} from '@/utils/agentSlashCommands';
import { buildTaskAuthoringPrompt, looksLikeTaskPackRequest, type TaskAuthoringMode } from '@/utils/taskAuthoring';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';

const props = defineProps<{ active?: boolean }>();

const hosts = useHostsStore();
const sessionTerminal = useSessionTerminal();
const { confirm } = useConfirm();
const approvalMode = ref<IdeApprovalMode>('manual');
const agentGoal = ref(emptyAgentGoalState());
const composerMode = ref<'chat' | 'goal'>('chat');
const modelProviders = useAgentModelProviders();
const currentModel = modelProviders.modelPreference;
const nextEntry = ref<'console' | 'task'>('console');
const taskAuthoringContext = ref<Record<string, unknown> | null>(null);
const slashHighlight = ref(0);
const slashSubView = ref<'model' | null>(null);
const slashSubHighlight = ref(0);
const slashCommands = agentSlashCommandsForSurface('console');
const chatAreaEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
let followOutput = true;

const activeHostName = computed(() => {
  const host = hosts.hostMap.get(sessionTerminal.activeHostId.value || LOCAL_HOST_ID);
  return host?.name || '本机';
});

function toolPolicyForHost(hostId: string): Record<string, unknown> | undefined {
  const id = String(hostId || '').trim();
  if (!id || id === 'all') return undefined;
  return {
    source: 'agent_workspace',
    gatewayMode: 'execute',
    allowedHosts: [id],
  };
}

const isGoalComposerMode = computed(() => composerMode.value === 'goal');
const slashCmds = computed<AgentSlashCommand[]>(() => {
  if (slashSubView.value) return [];
  if (isGoalComposerMode.value || ide.isRunning.value) return [];
  return filterAgentSlashCommands(ide.inputText.value, slashCommands);
});
const showSlashMenu = computed(() => slashCmds.value.length > 0 || slashSubView.value !== null);
const inputPlaceholder = computed(() => isGoalComposerMode.value
  ? '1Shell 应继续朝哪个目标努力？'
  : '输入目标或问题，按 Enter 发送，Shift + Enter 换行...'
);

const ide = useIdeChat({
  sessionPrefix: 'console-ide',
  approvalMode: () => approvalMode.value,
  context: () => {
    const hostId = sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
    const host = hosts.hostMap.get(hostId);
    return {
      module: '主控',
      moduleHint: '当前在主控页面。可结合主机和终端上下文处理运维目标。',
      agentGoal: agentGoalObjective(agentGoal.value) || undefined,
      threadGoal: serializeAgentGoal(agentGoal.value),
      modelPreference: currentModel.value !== '默认模型' ? currentModel.value : undefined,
      taskAuthoring: taskAuthoringContext.value,
      activeSessionId: sessionTerminal.activeSessionId.value,
      terminalStatus: sessionTerminal.statusText.value,
      hostScope: hostId,
      toolPolicy: toolPolicyForHost(hostId),
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
    entry: nextEntry.value,
    approvalMode: approvalMode.value,
    goal: agentGoalObjective(agentGoal.value) || undefined,
    goalStatus: serializeAgentGoal(agentGoal.value)?.status,
    threadGoal: serializeAgentGoal(agentGoal.value),
    modelPreference: currentModel.value !== '默认模型' ? currentModel.value : undefined,
    claudeCodeEnabled: false,
  }),
});

watch(() => ide.timeline.value.length, () => { void nextTick(() => scrollToBottom()); });
watch(() => ide.timeline.value, () => { void nextTick(() => scrollToBottom()); }, { deep: true });
watch(() => ide.inputText.value, () => { slashHighlight.value = 0; });
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
  if (isGoalComposerMode.value && event.key === 'Escape') {
    event.preventDefault();
    closeGoalComposer();
    return;
  }
  if (showSlashMenu.value) {
    if (slashSubView.value === 'model') {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        slashSubHighlight.value = Math.min(slashSubHighlight.value + 1, modelProviders.modelOptions.value.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        slashSubHighlight.value = Math.max(slashSubHighlight.value - 1, 0);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const option = slashSubHighlight.value === 0 ? null : modelProviders.modelOptions.value[slashSubHighlight.value - 1];
        void selectModelFromSlash(option?.providerId || null, option?.modelId || null);
        return;
      }
      if (event.key === 'Escape' || event.key === 'Backspace') {
        event.preventDefault();
        closeSlashSubView();
        return;
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      slashHighlight.value = Math.min(slashHighlight.value + 1, slashCmds.value.length - 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      slashHighlight.value = Math.max(slashHighlight.value - 1, 0);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      selectSlashCommand(slashCmds.value[slashHighlight.value]);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      ide.inputText.value = `${slashCmds.value[slashHighlight.value]?.cmd || ''} `;
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      ide.inputText.value = '';
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendOrHandleCommand();
  }
}

function onSecretRefSubmit(secretRef: string): void {
  ide.approveCustomText.value = secretRef;
  ide.approveCustom();
}

async function setApprovalMode(mode: IdeApprovalMode): Promise<void> {
  if (ide.isRunning.value || approvalMode.value === mode) return;
  if (mode === 'full_access') {
    const ok = await confirm({
      title: '启用完全访问权限',
      message: '完全访问权限会对本次 1Shell AI 对话预授权更高风险的文件、命令和网络操作。确定要启用吗？',
      okText: '启用完全访问权限',
      okClass: 'bg-red-600 hover:bg-red-700 text-white',
    });
    if (!ok) return;
  }
  approvalMode.value = mode;
}

async function handleAgentShellCommand(value: string): Promise<boolean> {
  const goalCommand = parseAgentGoalCommand(value);
  if (goalCommand) {
    ide.inputText.value = '';
    if (goalCommand.action === 'show') {
      openGoalComposer();
      return true;
    }
    if (goalCommand.action === 'edit') {
      openGoalComposer(agentGoal.value.objective);
      return true;
    }
    applyAgentGoalCommand(goalCommand);
    return true;
  }

  const modeCommand = parseAgentModeCommand(value);
  if (modeCommand) {
    ide.inputText.value = '';
    if (!modeCommand.raw) {
      ide.pushSystemEvent('/mode', `当前审批模式：${approvalModeLabel(approvalMode.value)}`);
      return true;
    }
    if (!modeCommand.mode) {
      ide.pushSystemEvent('/mode', '用法：/mode manual | delegated | full', 'warning');
      return true;
    }
    await setApprovalMode(modeCommand.mode);
    ide.pushSystemEvent('/mode', `审批模式已切换为：${approvalModeLabel(approvalMode.value)}`, 'success');
    return true;
  }

  if (parseAgentClearCommand(value)) {
    ide.inputText.value = '';
    await clearChat();
    return true;
  }

  const taskIntent = parseAgentTaskCommand(value);
  if (taskIntent !== null) {
    ide.inputText.value = '';
    startTaskAuthoring(taskIntent);
    return true;
  }

  const command = parseAgentModelCommand(value);
  if (!command) return false;
  ide.inputText.value = '';

  if (!command.arg) {
    ide.pushSystemEvent('/model', `当前模型偏好：${currentModel.value}`);
    return true;
  }
  currentModel.value = command.arg;
  ide.pushSystemEvent('/model', `已记录本会话模型偏好：${command.arg}。实际模型路由以当前后端配置为准。`, 'success');
  return true;
}

function openSlashModel(): void {
  ide.inputText.value = '';
  slashSubView.value = 'model';
  slashSubHighlight.value = 0;
  void modelProviders.loadProviders().catch((err) => {
    ide.pushSystemEvent('/model', err instanceof Error ? err.message : String(err), 'warning');
  });
}

function closeSlashSubView(): void {
  slashSubView.value = null;
  slashHighlight.value = 0;
}

async function selectModelFromSlash(providerId: string | null, modelId: string | null = null): Promise<void> {
  try {
    const nextModel = await modelProviders.selectProvider(providerId, modelId);
    ide.inputText.value = '';
    slashSubView.value = null;
    ide.pushSystemEvent('/model', `模型偏好已切换为：${nextModel}`, 'success');
  } catch (err) {
    ide.pushSystemEvent('/model', err instanceof Error ? err.message : String(err), 'warning');
  }
  void nextTick(() => inputEl.value?.focus());
}

function applyAgentGoalCommand(command: AgentGoalCommand): void {
  const result = reduceAgentGoalCommand(agentGoal.value, command);
  if (result.needsEditor) {
    openGoalComposer(agentGoal.value.objective);
    return;
  }
  agentGoal.value = result.state;
  ide.pushSystemEvent(result.title, result.text, result.tone);
}

function openGoalComposer(prefill = ''): void {
  if (ide.isRunning.value) return;
  composerMode.value = 'goal';
  slashSubView.value = null;
  ide.inputText.value = prefill;
  void nextTick(() => inputEl.value?.focus());
}

function closeGoalComposer(): void {
  if (!isGoalComposerMode.value) return;
  composerMode.value = 'chat';
  ide.inputText.value = '';
  void nextTick(() => inputEl.value?.focus());
}

function submitGoalComposer(): void {
  const objective = ide.inputText.value.trim();
  if (!objective || ide.isRunning.value) return;
  applyAgentGoalCommand({ kind: 'goal', action: 'set', objective });
  composerMode.value = 'chat';
  ide.inputText.value = '';
}

function approvalModeLabel(mode: IdeApprovalMode): string {
  if (mode === 'full_access') return '完全权限';
  if (mode === 'delegated') return '委托审批';
  return '人工审批';
}

async function sendOrHandleCommand(): Promise<void> {
  if (isGoalComposerMode.value) {
    submitGoalComposer();
    return;
  }
  if (await handleAgentShellCommand(ide.inputText.value)) return;
  ide.sendMessage();
}

async function clearChat(): Promise<void> {
  if (ide.isRunning.value) return;
  if (!ide.hasMessages.value) {
    ide.resetChat();
    return;
  }
  const ok = await confirm({ title: '清空', message: '清空当前 1Shell AI 对话时间线？' });
  if (ok) ide.resetChat();
}

function startTaskAuthoring(intent: string): void {
  const mode: TaskAuthoringMode = looksLikeTaskPackRequest(intent) ? 'pack' : 'new';
  nextEntry.value = 'task';
  taskAuthoringContext.value = { mode, intent: intent.trim() };
  ide.inputText.value = buildTaskAuthoringPrompt({ mode, intent });
  window.setTimeout(() => {
    ide.sendMessage();
    nextEntry.value = 'console';
    taskAuthoringContext.value = null;
  }, 0);
}

function selectSlashCommand(command: AgentSlashCommand | undefined): void {
  if (!command || ide.isRunning.value) return;
  slashHighlight.value = 0;
  if (command.cmd === '/model') { openSlashModel(); return; }
  if (command.cmd === '/goal') { ide.inputText.value = ''; openGoalComposer(); return; }
  if (command.cmd === '/task') { ide.inputText.value = '/task '; void nextTick(() => inputEl.value?.focus()); return; }
  if (command.cmd === '/compact') { ide.inputText.value = ''; ide.prefillAndSend('/compact'); return; }
  if (command.cmd === '/remind') { ide.inputText.value = ''; ide.prefillAndSend('/remind'); return; }
  if (command.cmd === '/clear') { ide.inputText.value = ''; void clearChat(); return; }
  ide.inputText.value = `${command.cmd} `;
  void nextTick(() => inputEl.value?.focus());
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
      </div>

      <div class="console-ide-actions">
        <button
          type="button"
          class="console-ide-ghost-btn"
          :disabled="ide.isRunning.value || !ide.hasMessages.value"
          @click="clearChat"
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
      <IdeSlashCommandMenu
        v-if="showSlashMenu && !slashSubView"
        :commands="slashCmds"
        :highlighted="slashHighlight"
        density="compact"
        @select="selectSlashCommand"
      />
      <IdeModelSlashMenu
        v-if="slashSubView === 'model'"
        :options="modelProviders.modelOptions.value"
        :active-model-key="modelProviders.activeModelKey.value"
        :highlighted="slashSubHighlight"
        :loading="modelProviders.loading.value"
        density="compact"
        @back="closeSlashSubView"
        @select="selectModelFromSlash"
      />
      <div v-if="isGoalComposerMode" class="console-ide-goal-banner">
        <span class="console-ide-goal-icon">
          <AppIcon name="target" :size="13" />
        </span>
        <strong>目标</strong>
        <span>下一条输入会保存为 Agent 工作目标</span>
        <button type="button" title="退出目标输入" @click="closeGoalComposer">
          <AppIcon name="close" :size="11" />
        </button>
      </div>
      <label class="sr-only" for="console-ide-input">输入给 1Shell AI 的消息</label>
      <textarea
        id="console-ide-input"
        ref="inputEl"
        v-model="ide.inputText.value"
        rows="3"
        class="console-ide-input"
        :class="{ 'console-ide-input--goal': isGoalComposerMode }"
        :placeholder="inputPlaceholder"
        :disabled="ide.isRunning.value"
        spellcheck="false"
        @keydown="onInputKeydown"
      />
      <div class="console-ide-composer-row">
        <div class="console-ide-left-actions">
          <IdeApprovalModeMenu
            :model-value="approvalMode"
            :disabled="ide.isRunning.value"
            density="compact"
            @update:model-value="setApprovalMode"
          />
          <span class="console-ide-status">{{ ide.statusText.value }}</span>
        </div>
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
          @click="sendOrHandleCommand"
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

:global(.dark) .console-ide-panel {
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

:global(.dark) .console-ide-header {
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

:global(.dark) .console-ide-title-icon {
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

:global(.dark) .console-ide-title-text span {
  color: #94a3b8;
}

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

.console-ide-ghost-btn {
  border: 1px solid rgba(148, 163, 184, 0.42);
  background: rgba(255, 255, 255, 0.72);
  color: #475569;
  padding: 0 9px;
  font-size: 12px;
  font-weight: 650;
}

.console-ide-ghost-btn:hover:not(:disabled) {
  color: #0369a1;
  border-color: rgba(14, 165, 233, 0.42);
}

.console-ide-ghost-btn:disabled,
.console-ide-send-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

:global(.dark) .console-ide-ghost-btn {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
  color: #cbd5e1;
}

:global(.dark) .console-ide-ghost-btn:hover:not(:disabled) {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.34);
  background: rgba(30, 41, 59, 0.84);
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

:global(.dark) .console-ide-empty {
  color: #94a3b8;
}

:global(.dark) .console-ide-empty strong {
  color: #e2e8f0;
}

.console-ide-composer {
  position: relative;
  display: grid;
  gap: 9px;
  padding: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(255, 255, 255, 0.78);
}

:global(.dark) .console-ide-composer {
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

.console-ide-input--goal,
.console-ide-input--goal:focus {
  border-color: rgba(16, 185, 129, 0.72);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.14);
}

.console-ide-input:disabled {
  opacity: 0.68;
  cursor: not-allowed;
}

:global(.dark) .console-ide-input {
  background: rgba(2, 6, 23, 0.72);
  border-color: rgba(71, 85, 105, 0.9);
  color: #e2e8f0;
}

:global(.dark) .console-ide-input--goal,
:global(.dark) .console-ide-input--goal:focus {
  border-color: rgba(52, 211, 153, 0.54);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.12);
}

.console-ide-goal-banner {
  min-height: 36px;
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 8px;
  background: rgba(236, 253, 245, 0.92);
  color: #047857;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 8px;
  font-size: 12px;
}

.console-ide-goal-banner strong,
.console-ide-goal-banner span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-ide-goal-banner strong {
  font-weight: 760;
}

.console-ide-goal-banner span {
  color: #059669;
}

.console-ide-goal-banner button {
  width: 24px;
  height: 24px;
  margin-left: auto;
  border: 0;
  border-radius: 7px;
  color: #059669;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.console-ide-goal-banner button:hover,
.console-ide-goal-banner button:focus-visible {
  color: #065f46;
  background: rgba(16, 185, 129, 0.12);
  outline: none;
}

.console-ide-goal-icon {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: rgba(16, 185, 129, 0.1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

:global(.dark) .console-ide-goal-banner {
  border-color: rgba(52, 211, 153, 0.24);
  background: rgba(6, 78, 59, 0.22);
  color: #a7f3d0;
}

:global(.dark) .console-ide-goal-banner span,
:global(.dark) .console-ide-goal-banner button {
  color: #6ee7b7;
}

:global(.dark) .console-ide-goal-icon {
  background: rgba(52, 211, 153, 0.1);
}

.console-ide-composer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.console-ide-left-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.console-ide-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
  font-size: 12px;
}

:global(.dark) .console-ide-status {
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

:global(.dark) .console-ide-stop-btn {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.24);
  border-color: rgba(248, 113, 113, 0.35);
}

:global(.dark) .console-ide-stop-btn:hover {
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

@media (max-width: 560px) {
  .console-ide-composer-row {
    align-items: stretch;
    flex-direction: column;
  }

  .console-ide-left-actions {
    justify-content: space-between;
  }

  .console-ide-send-btn,
  .console-ide-stop-btn {
    width: 100%;
  }
}
</style>
