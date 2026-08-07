<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import AppIcon from '@/components/AppIcon.vue';
import IdeAgentTimeline from '@/components/ide/IdeAgentTimeline.vue';
import IdeApprovalCard from '@/components/ide/IdeApprovalCard.vue';
import IdeApprovalModeMenu from '@/components/ide/IdeApprovalModeMenu.vue';
import IdeModelSlashMenu from '@/components/ide/IdeModelSlashMenu.vue';
import IdeSlashCommandMenu from '@/components/ide/IdeSlashCommandMenu.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useAgentModelProviders } from '@/composables/useAgentModelProviders';
import { useIdeChat, type IdeApprovalMode } from '@/composables/useIdeChat';
import {
  agentSlashCommandsForSurface,
  filterAgentSlashCommands,
  parseAgentClearCommand,
  parseAgentModeCommand,
  parseAgentModelCommand,
  type AgentSlashCommand,
} from '@/utils/agentSlashCommands';
import { isNearScrollBottom, scrollToBottomIfPinned } from '@/utils/streaming';

interface ModuleContext {
  name: string;
  icon: string;
  hint: string;
}

interface Pos {
  x: number;
  y: number;
}

const route = useRoute();
const { confirm } = useConfirm();
const moduleCtx = ref<ModuleContext>({ name: '1Shell', icon: 'robot', hint: '' });
const approvalMode = ref<IdeApprovalMode>('manual');
const modelProviders = useAgentModelProviders();
const ide = useIdeChat({
  sessionPrefix: 'fab',
  approvalMode: () => approvalMode.value,
  context: () => ({
    module: moduleCtx.value.name,
    moduleHint: moduleCtx.value.hint,
    modelPreference: modelProviders.modelPreference.value !== '默认模型' ? modelProviders.modelPreference.value : undefined,
  }),
  messagePayload: () => ({
    entry: 'core',
    approvalMode: approvalMode.value,
    modelPreference: modelProviders.modelPreference.value !== '默认模型' ? modelProviders.modelPreference.value : undefined,
  }),
});
const slashCommands = agentSlashCommandsForSurface('fab');
const slashHighlight = ref(0);
const slashSubView = ref<'model' | null>(null);
const slashSubHighlight = ref(0);

const EXCLUDED_ROUTES = new Set(['agent']);
const visible = computed(() => !EXCLUDED_ROUTES.has(String(route.name || '')));

const MODULE_MAP: Record<string, ModuleContext> = {
  console: { name: '主控', icon: 'console', hint: '当前在主控页面。可结合主机和终端上下文处理运维目标。' },
  scripts: { name: '脚本', icon: 'wrench', hint: '当前在脚本库页面。可管理纯代码脚本与工具。' },
  skills: { name: '扩展', icon: 'package', hint: '当前在扩展页面。可管理 Skill、远程 MCP 和本地 MCP。' },
  probe: { name: '探针监控', icon: 'radio', hint: '当前在探针监控页面。可查看主机探针数据和健康状态。' },
  audit: { name: '审计日志', icon: 'clipboard', hint: '当前在审计日志页面。可查询操作日志。' },
  hosts: { name: '主机', icon: 'server', hint: '当前在主机页面。可查看和管理连接目标。' },
  'cli-setup': { name: 'AI 配置', icon: 'cog', hint: '当前在 AI 引擎配置页面。' },
  'panel-hosts': { name: '主机', icon: 'server', hint: '当前在主机页面。可查看和管理连接目标。' },
  'panel-runtime': { name: '详情', icon: 'chart', hint: '当前在详情页面。可按 VPS 查看探针摘要、资源图表、内部体检和带宽趋势。' },
  'panel-workloads': { name: '运行', icon: 'play-square', hint: '当前在运行页面。可查看并操作容器、系统服务、Windows Service 和监听端口。' },
  'panel-files': { name: '文件', icon: 'folder', hint: '当前在文件页面。可按 VPS 浏览远程文件。' },
  'panel-probe': { name: '探针监控', icon: 'radio', hint: '当前在探针监控页面。可查看主机探针数据和健康状态。' },
  'panel-audit': { name: '审计日志', icon: 'clipboard', hint: '当前在审计日志页面。可查询操作日志。' },
  'config-scripts': { name: '脚本配置', icon: 'wrench', hint: '当前在配置 / 脚本库页面。可管理纯代码脚本与工具。' },
  'config-skills': { name: '扩展配置', icon: 'package', hint: '当前在配置 / 扩展页面。可管理 Skill、远程 MCP 和本地 MCP。' },
  'config-mcp': { name: 'MCP 配置', icon: 'plug', hint: '当前在配置 / MCP 页面。可管理 MCP 服务、远程开放与凭证。' },
  'config-ai': { name: 'AI 配置', icon: 'cog', hint: '当前在配置 / AI 页面。可管理 AI 引擎与模型接入。' },
};

watch(
  () => route.name,
  (name) => {
    const key = String(name || '');
    moduleCtx.value = MODULE_MAP[key] || { name: '1Shell', icon: 'robot', hint: '' };
  },
  { immediate: true },
);

const STORAGE_KEY = '1shell-fab-pos';
const FAB_SIZE = 52;
const FAB_MARGIN = 16;
const PANEL_WIDTH = 460;
const PANEL_HEIGHT = 620;
const PANEL_GAP = 12;
const DRAG_THRESHOLD = 4;

function defaultPos(): Pos {
  return {
    x: window.innerWidth - FAB_SIZE - 28,
    y: window.innerHeight - FAB_SIZE - 28,
  };
}

function clampPos(p: Pos): Pos {
  const maxX = window.innerWidth - FAB_SIZE - FAB_MARGIN;
  const maxY = window.innerHeight - FAB_SIZE - FAB_MARGIN;
  return {
    x: Math.max(FAB_MARGIN, Math.min(maxX, p.x)),
    y: Math.max(FAB_MARGIN, Math.min(maxY, p.y)),
  };
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPos();
    const obj = JSON.parse(raw) as Partial<Pos>;
    if (typeof obj.x !== 'number' || typeof obj.y !== 'number') return defaultPos();
    return clampPos({ x: obj.x, y: obj.y });
  } catch {
    return defaultPos();
  }
}

const pos = ref<Pos>(loadPos());
const panelOpen = ref(false);
const chatEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
let followOutput = true;
let dragStartMouseX = 0;
let dragStartMouseY = 0;
let dragStartPosX = 0;
let dragStartPosY = 0;
let isDragging = false;
let dragStarted = false;

function persistPos(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pos.value));
}

function onWindowResize(): void {
  pos.value = clampPos(pos.value);
  persistPos();
}

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  dragStartMouseX = e.clientX;
  dragStartMouseY = e.clientY;
  dragStartPosX = pos.value.x;
  dragStartPosY = pos.value.y;
  isDragging = true;
  dragStarted = false;
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent): void {
  if (!isDragging) return;
  const dx = e.clientX - dragStartMouseX;
  const dy = e.clientY - dragStartMouseY;
  if (!dragStarted && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
  dragStarted = true;
  pos.value = clampPos({ x: dragStartPosX + dx, y: dragStartPosY + dy });
}

function onMouseUp(): void {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  isDragging = false;
  if (dragStarted) {
    persistPos();
    return;
  }
  togglePanel();
}

function togglePanel(): void {
  panelOpen.value = !panelOpen.value;
  if (panelOpen.value) void nextTick(() => scrollChatToBottom(true));
}

function closePanel(): void {
  panelOpen.value = false;
}

const panelPos = computed<{ left: number; top: number }>(() => {
  const fabX = pos.value.x;
  const fabY = pos.value.y;
  const fabCenterX = fabX + FAB_SIZE / 2;
  const fabCenterY = fabY + FAB_SIZE / 2;
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  let left = fabCenterX > winW / 2 ? fabX - PANEL_WIDTH - PANEL_GAP : fabX + FAB_SIZE + PANEL_GAP;
  if (left < FAB_MARGIN) left = FAB_MARGIN;
  if (left + PANEL_WIDTH + FAB_MARGIN > winW) left = winW - PANEL_WIDTH - FAB_MARGIN;

  let top = fabCenterY > winH / 2 ? fabY + FAB_SIZE - PANEL_HEIGHT : fabY;
  if (top < FAB_MARGIN) top = FAB_MARGIN;
  if (top + PANEL_HEIGHT + FAB_MARGIN > winH) top = winH - PANEL_HEIGHT - FAB_MARGIN;

  return { left, top };
});

watch(() => ide.timeline.value.length, () => { scrollChatToBottom(); });
watch(() => ide.timeline.value, () => { scrollChatToBottom(); }, { deep: true });
watch(() => ide.inputText.value, () => { slashHighlight.value = 0; });

const slashCmds = computed<AgentSlashCommand[]>(() => {
  if (slashSubView.value || ide.isRunning.value) return [];
  return filterAgentSlashCommands(ide.inputText.value, slashCommands);
});
const showSlashMenu = computed(() => slashCmds.value.length > 0 || slashSubView.value !== null);

function onChatScroll(): void {
  const el = chatEl.value;
  followOutput = !el || isNearScrollBottom(el);
}

function scrollChatToBottom(force = false): void {
  const el = chatEl.value;
  const wasPinned = force || (followOutput && (!el || isNearScrollBottom(el)));
  if (force) followOutput = true;
  void nextTick(() => {
    scrollToBottomIfPinned(chatEl.value, wasPinned);
  });
}

function onInputKeydown(event: KeyboardEvent): void {
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
      slashSubView.value = null;
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

function approvalModeLabel(mode: IdeApprovalMode): string {
  if (mode === 'full_access') return '完全权限';
  if (mode === 'delegated') return '委托审批';
  return '人工审批';
}

async function handleSlashTextCommand(value: string): Promise<boolean> {
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

  const modelCommand = parseAgentModelCommand(value);
  if (!modelCommand) return false;
  ide.inputText.value = '';
  if (!modelCommand.arg) {
    ide.pushSystemEvent('/model', `当前模型偏好：${modelProviders.modelPreference.value}`);
    return true;
  }
  modelProviders.modelPreference.value = modelCommand.arg;
  ide.pushSystemEvent('/model', `已记录本会话模型偏好：${modelCommand.arg}。实际模型路由以当前后端配置为准。`, 'success');
  return true;
}

async function sendOrHandleCommand(): Promise<void> {
  if (await handleSlashTextCommand(ide.inputText.value)) return;
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

function selectSlashCommand(command: AgentSlashCommand | undefined): void {
  if (!command || ide.isRunning.value) return;
  slashHighlight.value = 0;
  if (command.cmd === '/model') { openSlashModel(); return; }
  if (command.cmd === '/mode') { ide.inputText.value = '/mode '; void nextTick(() => inputEl.value?.focus()); return; }
  if (command.cmd === '/compact') { ide.inputText.value = ''; ide.prefillAndSend('/compact'); return; }
  if (command.cmd === '/remind') { ide.inputText.value = ''; ide.prefillAndSend('/remind'); return; }
  if (command.cmd === '/clear') { ide.inputText.value = ''; void clearChat(); return; }
  ide.inputText.value = `${command.cmd} `;
  void nextTick(() => inputEl.value?.focus());
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  ide.dispose();
});

onMounted(() => {
  window.addEventListener('resize', onWindowResize);
});
</script>

<template>
  <template v-if="visible">
    <button
      type="button"
      class="ai-fab-btn"
      :class="{ 'ai-fab-btn--open': panelOpen }"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      aria-label="打开 1Shell AI"
      title="1Shell AI（可拖拽）"
      @mousedown="onMouseDown"
    >
      <AppIcon v-if="!panelOpen" name="robot" :size="27" :stroke-width="1.8" />
      <AppIcon v-else name="close" :size="20" :stroke-width="2" />
    </button>

    <section
      v-if="panelOpen"
      class="ai-fab-panel"
      :style="{ left: panelPos.left + 'px', top: panelPos.top + 'px' }"
    >
      <header class="ai-fab-header">
        <span class="ai-fab-header-icon">
          <AppIcon :name="moduleCtx.icon" :size="18" />
        </span>
        <span class="ai-fab-title">1Shell AI</span>
        <span class="ai-fab-badge">{{ moduleCtx.name }}</span>
        <button
          type="button"
          class="ai-fab-mini-btn"
          :disabled="!ide.isRunning.value"
          @click="ide.stop"
        >
          停止
        </button>
        <button
          type="button"
          class="ai-fab-mini-btn"
          :disabled="ide.isRunning.value || !ide.hasMessages.value"
          @click="ide.resetChat"
        >
          清空
        </button>
        <button type="button" class="ai-fab-mini-btn" @click="closePanel">
          关闭
        </button>
      </header>

      <div ref="chatEl" class="ai-fab-chat" @scroll="onChatScroll">
        <div v-if="!ide.hasMessages.value" class="ai-fab-placeholder">
          <div class="ai-fab-placeholder-icon">
            <AppIcon name="robot" :size="30" :stroke-width="1.6" />
          </div>
          <strong>1Shell AI</strong>
          <span>{{ moduleCtx.hint || '输入目标后，这里会显示工作笔记、工具调用和最终回复。' }}</span>
        </div>
        <IdeAgentTimeline v-else :items="ide.timeline.value" density="compact" />
      </div>

      <div class="ai-fab-input-area">
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
        <label class="sr-only" for="ai-fab-input">输入给 1Shell AI 的消息</label>
        <textarea
          id="ai-fab-input"
          ref="inputEl"
          v-model="ide.inputText.value"
          rows="3"
          placeholder="输入你的目标..."
          class="ai-fab-input"
          :disabled="ide.isRunning.value"
          spellcheck="false"
          @keydown="onInputKeydown"
        />
        <div class="ai-fab-bottom-row">
          <div class="ai-fab-left-actions">
            <IdeApprovalModeMenu
              :model-value="approvalMode"
              :disabled="ide.isRunning.value"
              density="compact"
              @update:model-value="setApprovalMode"
            />
            <span class="ai-fab-status">{{ ide.statusText.value }}</span>
          </div>
          <button
            v-if="!ide.isRunning.value"
            type="button"
            class="ai-fab-send-btn"
            :disabled="!ide.inputText.value.trim()"
            @click="sendOrHandleCommand"
          >
            <AppIcon name="arrow-up" :size="14" :stroke-width="2" />
            <span>发送</span>
          </button>
          <button
            v-else
            type="button"
            class="ai-fab-stop-btn"
            @click="ide.stop"
          >
            停止
          </button>
        </div>
      </div>
    </section>
  </template>
</template>

<style scoped>
.ai-fab-btn {
  position: fixed;
  z-index: 8000;
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  background: #0284c7;
  box-shadow: 0 14px 34px rgba(2, 132, 199, 0.34);
  cursor: grab;
  transition: background-color 180ms ease, box-shadow 180ms ease, border-radius 180ms ease;
}

.ai-fab-btn:hover {
  background: #0369a1;
  box-shadow: 0 16px 38px rgba(2, 132, 199, 0.42);
}

.ai-fab-btn:focus-visible {
  outline: 3px solid rgba(14, 165, 233, 0.34);
  outline-offset: 3px;
}

.ai-fab-btn--open {
  border-radius: 12px;
  cursor: pointer;
}

.ai-fab-panel {
  position: fixed;
  z-index: 8001;
  width: 460px;
  max-width: calc(100vw - 32px);
  height: 620px;
  max-height: calc(100vh - 32px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.34);
  border-radius: 12px;
  background: rgba(248, 250, 252, 0.94);
  color: #0f172a;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(18px);
}

.dark .ai-fab-panel {
  background: rgba(15, 23, 42, 0.94);
  color: #e2e8f0;
  border-color: rgba(71, 85, 105, 0.78);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
}

.ai-fab-header {
  min-height: 54px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.26);
  background: rgba(255, 255, 255, 0.72);
}

.dark .ai-fab-header {
  background: rgba(15, 23, 42, 0.72);
  border-bottom-color: rgba(51, 65, 85, 0.72);
}

.ai-fab-header-icon {
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

.dark .ai-fab-header-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.24);
}

.ai-fab-title {
  min-width: 0;
  flex: 1;
  font-size: 14px;
  font-weight: 750;
  color: #0f172a;
}

.dark .ai-fab-title {
  color: #e2e8f0;
}

.ai-fab-badge {
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  padding: 3px 7px;
  color: #0369a1;
  background: rgba(14, 165, 233, 0.1);
  font-size: 11px;
  font-weight: 700;
}

.ai-fab-mini-btn,
.ai-fab-send-btn,
.ai-fab-stop-btn {
  min-height: 36px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.ai-fab-mini-btn {
  border: 1px solid rgba(148, 163, 184, 0.42);
  background: rgba(255, 255, 255, 0.72);
  color: #475569;
  padding: 0 9px;
  font-size: 12px;
  font-weight: 650;
}

.ai-fab-mini-btn:hover:not(:disabled) {
  color: #0369a1;
  border-color: rgba(14, 165, 233, 0.42);
}

.ai-fab-mini-btn:disabled,
.ai-fab-send-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.dark .ai-fab-mini-btn {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(71, 85, 105, 0.8);
  color: #cbd5e1;
}

.dark .ai-fab-mini-btn:hover:not(:disabled) {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.34);
  background: rgba(30, 41, 59, 0.84);
}

.ai-fab-chat {
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}

.ai-fab-placeholder {
  min-height: 260px;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 8px;
  text-align: center;
  color: #64748b;
}

.ai-fab-placeholder-icon {
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

.ai-fab-placeholder strong {
  color: #0f172a;
  font-size: 14px;
}

.ai-fab-placeholder span {
  max-width: 280px;
  font-size: 12px;
  line-height: 1.5;
}

.dark .ai-fab-placeholder {
  color: #94a3b8;
}

.dark .ai-fab-placeholder strong {
  color: #e2e8f0;
}

.ai-fab-input-area {
  position: relative;
  display: grid;
  gap: 9px;
  padding: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.26);
  background: rgba(255, 255, 255, 0.78);
}

.dark .ai-fab-input-area {
  background: rgba(15, 23, 42, 0.78);
  border-top-color: rgba(51, 65, 85, 0.72);
}

.ai-fab-input {
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

.ai-fab-input:focus {
  border-color: #0284c7;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.16);
}

.ai-fab-input:disabled {
  opacity: 0.68;
  cursor: not-allowed;
}

.dark .ai-fab-input {
  background: rgba(2, 6, 23, 0.72);
  border-color: rgba(71, 85, 105, 0.9);
  color: #e2e8f0;
}

.ai-fab-bottom-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ai-fab-left-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-fab-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
  font-size: 12px;
}

.dark .ai-fab-status {
  color: #94a3b8;
}

.ai-fab-send-btn {
  min-width: 82px;
  border: 1px solid #0284c7;
  color: #ffffff;
  background: #0284c7;
  padding: 0 13px;
  font-size: 13px;
  font-weight: 750;
}

.ai-fab-send-btn:hover:not(:disabled) {
  background: #0369a1;
  border-color: #0369a1;
}

.ai-fab-stop-btn {
  min-width: 72px;
  border: 1px solid rgba(220, 38, 38, 0.38);
  color: #b91c1c;
  background: #fef2f2;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 750;
}

.ai-fab-stop-btn:hover {
  background: #fee2e2;
  border-color: rgba(185, 28, 28, 0.54);
}

.dark .ai-fab-stop-btn {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.24);
  border-color: rgba(248, 113, 113, 0.35);
}

.dark .ai-fab-stop-btn:hover {
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
  .ai-fab-panel {
    left: 12px !important;
    right: 12px;
    width: auto;
  }

  .ai-fab-header {
    flex-wrap: wrap;
  }

  .ai-fab-bottom-row {
    align-items: stretch;
    flex-direction: column;
  }

  .ai-fab-left-actions {
    justify-content: space-between;
  }

  .ai-fab-send-btn,
  .ai-fab-stop-btn {
    width: 100%;
  }
}
</style>
