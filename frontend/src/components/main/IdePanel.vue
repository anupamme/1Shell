<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import IdeApprovalModeMenu from '@/components/ide/IdeApprovalModeMenu.vue';
import IdeModelSlashMenu from '@/components/ide/IdeModelSlashMenu.vue';
import IdeSlashCommandMenu from '@/components/ide/IdeSlashCommandMenu.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useAgentModelProviders } from '@/composables/useAgentModelProviders';
import { useIdeChat, type IdeApprovalMode, type IdeTimelineItem } from '@/composables/useIdeChat';
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
const { requestJson } = useApiClient();
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

interface SessionMeta {
  id: string;
  title: string;
  entry: string;
  hostId: string;
  workspaceHostIds?: string[];
  modelLabel: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
  awaitingApproval?: boolean;
}

interface SessionDetail extends SessionMeta {
  timeline: IdeTimelineItem[];
  runId?: string;
}

const sessions = ref<SessionMeta[]>([]);
const sessionsLoading = ref(false);
const scopeMenuOpen = ref(false);
const historyMenuOpen = ref(false);
const selectedScopeId = ref('all');

const activeScopeLabel = computed(() => {
  if (selectedScopeId.value === 'all') return '全局';
  const host = hosts.hostMap.get(selectedScopeId.value);
  return host?.name || selectedScopeId.value || '全局';
});

const scopeOptions = computed(() => [
  { id: 'all', label: '全局', detail: '不限定单台 VPS' },
  ...hosts.items.map((host) => ({
    id: host.id,
    label: host.name || host.id,
    detail: host.id === LOCAL_HOST_ID || host.type === 'local'
      ? '本机'
      : `${host.username || 'root'}@${host.host}:${host.port || 22}`,
  })),
]);

const historySessions = computed(() => {
  return [...sessions.value].sort((a, b) => parseSessionTime(b.updatedAt) - parseSessionTime(a.updatedAt));
});

function selectedWorkspaceHostIds(): string[] {
  const id = String(selectedScopeId.value || '').trim();
  return id && id !== 'all' ? [id] : [];
}

function hostPayloadForScope(): Array<Record<string, unknown>> {
  const ids = selectedWorkspaceHostIds();
  const selectedHosts = ids.length
    ? ids.map((id) => hosts.hostMap.get(id)).filter(Boolean)
    : hosts.items;
  return selectedHosts.map((host) => ({
    id: host?.id || LOCAL_HOST_ID,
    name: host?.name || '本机',
    username: host?.username,
    host: host?.host,
    port: host?.port,
  }));
}

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
    const workspaceHostIds = selectedWorkspaceHostIds();
    const hostScope = workspaceHostIds.length ? workspaceHostIds.join(',') : 'all';
    return {
      module: '主控',
      moduleHint: '当前在主控页面。可结合主机和终端上下文处理运维目标。',
      agentGoal: agentGoalObjective(agentGoal.value) || undefined,
      threadGoal: serializeAgentGoal(agentGoal.value),
      modelPreference: currentModel.value !== '默认模型' ? currentModel.value : undefined,
      taskAuthoring: taskAuthoringContext.value,
      activeSessionId: sessionTerminal.activeSessionId.value,
      terminalStatus: sessionTerminal.statusText.value,
      hostScope,
      workspaceHostIds,
      toolPolicy: toolPolicyForHost(hostScope),
      hosts: hostPayloadForScope(),
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
  onRunComplete: () => {
    void loadSessions();
  },
});

watch(() => ide.timeline.value.length, () => { scrollToBottom(); });
watch(() => ide.timeline.value, () => { scrollToBottom(); }, { deep: true });
watch(() => ide.inputText.value, () => { slashHighlight.value = 0; });
watch(() => props.active, (active) => {
  if (active) {
    void loadSessions();
    void nextTick(() => scrollToBottom(true));
  }
});

onMounted(() => {
  void loadSessions();
});

onBeforeUnmount(() => {
  ide.dispose();
});

function onChatScroll(): void {
  const el = chatAreaEl.value;
  followOutput = !el || isNearScrollBottom(el);
}

function scrollToBottom(force = false): void {
  const el = chatAreaEl.value;
  const wasPinned = force || (followOutput && (!el || isNearScrollBottom(el)));
  if (force) followOutput = true;
  void nextTick(() => {
    scrollToBottomIfPinned(chatAreaEl.value, wasPinned);
  });
}

function parseSessionTime(value: string): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

function createConsoleSessionId(): string {
  return `console-ide-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function scopeFromSession(session: SessionDetail): string {
  const ids = Array.isArray(session.workspaceHostIds)
    ? session.workspaceHostIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (ids.length === 1) return ids[0];
  const hostId = String(session.hostId || '').trim();
  return hostId && hostId !== 'all' ? hostId : 'all';
}

function chooseScope(id: string): void {
  if (ide.isRunning.value) return;
  selectedScopeId.value = id || 'all';
  scopeMenuOpen.value = false;
}

function toggleScopeMenu(): void {
  if (ide.isRunning.value) return;
  scopeMenuOpen.value = !scopeMenuOpen.value;
  historyMenuOpen.value = false;
}

function toggleHistoryMenu(): void {
  historyMenuOpen.value = !historyMenuOpen.value;
  scopeMenuOpen.value = false;
  if (historyMenuOpen.value) void loadSessions();
}

function startNewSession(): void {
  if (ide.isRunning.value) return;
  taskAuthoringContext.value = null;
  nextEntry.value = 'console';
  historyMenuOpen.value = false;
  scopeMenuOpen.value = false;
  ide.loadSession({ id: createConsoleSessionId(), timeline: [] });
  void nextTick(() => inputEl.value?.focus());
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    const resp = await requestJson<{ ok: boolean; sessions: SessionMeta[] }>('/api/agent/sessions');
    if (resp.ok) sessions.value = resp.sessions || [];
  } catch {
    // History is helpful, but the live chat should keep working without it.
  } finally {
    sessionsLoading.value = false;
  }
}

async function selectHistorySession(id: string): Promise<void> {
  if (!id || ide.isRunning.value) return;
  try {
    const resp = await requestJson<{ ok: boolean; session: SessionDetail }>(`/api/agent/sessions/${encodeURIComponent(id)}`);
    if (!resp.ok || !resp.session) throw new Error('会话不存在');
    selectedScopeId.value = scopeFromSession(resp.session);
    ide.loadSession({
      id: resp.session.id,
      timeline: resp.session.timeline || [],
      running: Boolean(resp.session.running),
      runId: resp.session.runId || '',
    });
    if (resp.session.running) void ide.reattachSession();
    historyMenuOpen.value = false;
    followOutput = true;
    void nextTick(() => scrollToBottom(true));
  } catch (err) {
    ide.pushSystemEvent('历史加载失败', (err as Error).message || '无法加载这条 1Shell AI 会话', 'warning');
  }
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
  followOutput = true;
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
    followOutput = true;
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
          <span>范围：{{ activeScopeLabel }}</span>
        </div>
      </div>

      <div class="console-ide-actions">
        <div class="console-ide-menu-wrap">
          <button
            type="button"
            class="console-ide-ghost-btn"
            :disabled="ide.isRunning.value"
            @click="toggleScopeMenu"
          >
            范围：{{ activeScopeLabel }}
          </button>
          <div v-if="scopeMenuOpen" class="console-ide-menu console-ide-scope-menu">
            <button
              v-for="scope in scopeOptions"
              :key="scope.id"
              type="button"
              class="console-ide-menu-item"
              :class="{ 'console-ide-menu-item--active': selectedScopeId === scope.id }"
              @click="chooseScope(scope.id)"
            >
              <strong>{{ scope.label }}</strong>
              <span>{{ scope.detail }}</span>
            </button>
          </div>
        </div>
        <div class="console-ide-menu-wrap">
          <button
            type="button"
            class="console-ide-ghost-btn"
            @click="toggleHistoryMenu"
          >
            历史
          </button>
          <div v-if="historyMenuOpen" class="console-ide-menu console-ide-history-menu">
            <div v-if="sessionsLoading" class="console-ide-menu-empty">加载中...</div>
            <div v-else-if="!historySessions.length" class="console-ide-menu-empty">暂无历史对话</div>
            <template v-else>
              <button
                v-for="session in historySessions"
                :key="session.id"
                type="button"
                class="console-ide-menu-item"
                :class="{ 'console-ide-menu-item--active': ide.currentSessionId.value === session.id }"
                :disabled="ide.isRunning.value"
                @click="selectHistorySession(session.id)"
              >
                <strong>{{ session.title || '新对话' }}</strong>
                <span>{{ session.preview || session.modelLabel || session.updatedAt }}</span>
              </button>
            </template>
          </div>
        </div>
        <button
          type="button"
          class="console-ide-ghost-btn"
          :disabled="ide.isRunning.value"
          @click="startNewSession"
        >
          新对话
        </button>
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
  min-width: 0;
  min-height: 0;
  max-width: 100%;
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
  min-width: 0;
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

.console-ide-actions {
  min-width: 0;
  position: relative;
  justify-content: flex-end;
  flex-wrap: wrap;
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
  white-space: nowrap;
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

.console-ide-menu-wrap {
  position: relative;
  display: inline-flex;
}

.console-ide-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  width: min(340px, 82vw);
  max-height: 340px;
  overflow: auto;
  display: grid;
  gap: 4px;
  padding: 6px;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.14);
}

.console-ide-scope-menu {
  width: min(260px, 78vw);
}

.console-ide-menu-item {
  width: 100%;
  min-height: 44px;
  border: 0;
  border-radius: 6px;
  display: grid;
  gap: 2px;
  padding: 7px 9px;
  color: #334155;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.console-ide-menu-item:hover:not(:disabled),
.console-ide-menu-item--active {
  background: rgba(224, 242, 254, 0.78);
  color: #075985;
}

.console-ide-menu-item:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.console-ide-menu-item strong,
.console-ide-menu-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-ide-menu-item strong {
  font-size: 12px;
  line-height: 1.25;
}

.console-ide-menu-item span,
.console-ide-menu-empty {
  color: #64748b;
  font-size: 11px;
  line-height: 1.35;
}

.console-ide-menu-empty {
  padding: 14px 10px;
  text-align: center;
}

:global(.dark) .console-ide-menu {
  border-color: rgba(71, 85, 105, 0.8);
  background: rgba(15, 23, 42, 0.98);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.36);
}

:global(.dark) .console-ide-menu-item {
  color: #cbd5e1;
}

:global(.dark) .console-ide-menu-item:hover:not(:disabled),
:global(.dark) .console-ide-menu-item--active {
  color: #e0f2fe;
  background: rgba(14, 165, 233, 0.16);
}

:global(.dark) .console-ide-menu-item span,
:global(.dark) .console-ide-menu-empty {
  color: #94a3b8;
}

.console-ide-scroll {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
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
  min-width: 0;
  max-width: 100%;
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
  min-width: 0;
  box-sizing: border-box;
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
