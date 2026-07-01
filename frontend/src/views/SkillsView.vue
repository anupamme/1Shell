<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import AppIcon from '@/components/AppIcon.vue';
import McpModal from '@/components/skills/McpModal.vue';
import LocalMcpModal from '@/components/skills/LocalMcpModal.vue';
import DeployMcpModal from '@/components/skills/DeployMcpModal.vue';
import SkillAiImportModal from '@/components/skills/SkillAiImportModal.vue';
import { type McpInfo, type McpServersResponse } from '@/utils/skills';
import ClaudeIconUrl from '@/assets/agent-icons/claude.svg?url';
import OpenAiIconUrl from '@/assets/agent-icons/openai.svg?url';
import OpenCodeIconUrl from '@/assets/agent-icons/opencode.svg?url';
import GeminiIconUrl from '@/assets/agent-icons/gemini.svg?url';

const { requestJson } = useApiClient();
const notify = useNotifyStore();

type CapabilityKind = 'mcp' | 'skill';
type MatrixTab = CapabilityKind;

interface CapabilityAgent {
  id: string;
  label: string;
  icon?: string;
  kind?: string;
  installed?: boolean;
  configured?: boolean;
  status?: string;
  supports?: Record<CapabilityKind, boolean>;
}

interface CapabilityRow {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  tags?: string[];
  category?: string;
  source?: string;
  transport?: string;
  origin?: string;
  originPaths?: string[];
  foundIn?: string[];
  runtimeStatus?: string;
  runtimeError?: string;
  toolCount?: number;
  managed?: boolean;
  external?: boolean;
  readonly?: boolean;
  importable?: boolean;
  exposure: Record<string, boolean>;
}

interface CapabilityResponse {
  ok: boolean;
  agents: CapabilityAgent[];
  capabilities: CapabilityRow[];
}

interface ScanResponse {
  ok: boolean;
  scan?: {
    mcpCount: number;
    skillCount: number;
    installedSkillCount?: number;
    unmanagedSkillCount?: number;
    warnings?: string[];
  };
}

const activeTab = ref<MatrixTab>('mcp');
const query = ref('');
const agents = ref<CapabilityAgent[]>([]);
const mcpRows = ref<CapabilityRow[]>([]);
const skillRows = ref<CapabilityRow[]>([]);
const loading = ref(false);
const loadError = ref('');
const togglingKey = ref('');
const importingKey = ref('');
const scanning = ref(false);
const lastScanSummary = ref('');

const mcpModalOpen = ref(false);
const editingMcp = ref<McpInfo | null>(null);
const localModalOpen = ref(false);
const deployModalOpen = ref(false);
const skillAiImportModalOpen = ref(false);
const legacyMcpServers = ref<McpInfo[]>([]);
const oneShellIconUrl = `${import.meta.env.BASE_URL}logo.png`;

const AGENT_ICON_URLS: Record<string, string> = {
  'oneshell-ai': oneShellIconUrl,
  'claude-code': ClaudeIconUrl,
  codex: OpenAiIconUrl,
  opencode: OpenCodeIconUrl,
  gemini: GeminiIconUrl,
};

const activeRows = computed(() => activeTab.value === 'mcp' ? mcpRows.value : skillRows.value);
const filteredRows = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (!term) return activeRows.value;
  return activeRows.value.filter((row) => {
    const haystack = [
      row.name,
      row.id,
      row.description,
      row.source,
      row.transport,
      row.origin,
      ...(row.originPaths || []),
      ...(row.foundIn || []),
      ...(row.tags || []),
    ].join(' ').toLowerCase();
    return haystack.includes(term);
  });
});

const mcpCount = computed(() => mcpRows.value.length);
const skillCount = computed(() => skillRows.value.length);
const exposedMcpCount = computed(() => countExposed(mcpRows.value));
const exposedSkillCount = computed(() => countExposed(skillRows.value));
const activeAgentColumns = computed(() => agents.value.filter((agent) => agent.supports?.[activeTab.value] !== false));
const matrixGridStyle = computed(() => ({
  gridTemplateColumns: `minmax(18rem, 1fr) repeat(${Math.max(activeAgentColumns.value.length, 1)}, 3.25rem) 2.75rem`,
}));

function countExposed(rows: CapabilityRow[]): number {
  return rows.filter((row) => Object.values(row.exposure || {}).some(Boolean)).length;
}

async function loadMatrix(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [mcp, skills] = await Promise.all([
      requestJson<CapabilityResponse>('/api/host-capabilities/mcp'),
      requestJson<CapabilityResponse>('/api/host-capabilities/skills'),
    ]);
    agents.value = mcp.agents?.length ? mcp.agents : (skills.agents || []);
    mcpRows.value = mcp.capabilities || [];
    skillRows.value = skills.capabilities || [];
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadLegacyMcps(): Promise<void> {
  try {
    const data = await requestJson<McpServersResponse>('/api/mcp-servers');
    legacyMcpServers.value = data.servers || [];
  } catch {
    legacyMcpServers.value = [];
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadMatrix(), loadLegacyMcps()]);
}

async function scanHost(): Promise<void> {
  scanning.value = true;
  try {
    const data = await requestJson<ScanResponse>('/api/host-capabilities/scan', { method: 'POST' });
    const scan = data.scan;
    const warningCount = scan?.warnings?.length || 0;
    const externalSkillCount = scan?.skillCount ?? 0;
    const summary = `${scan?.mcpCount || 0} 个 MCP，${externalSkillCount} 个外部 Skill`;
    lastScanSummary.value = warningCount ? `${summary}，${warningCount} 个警告` : summary;
    notify.success(`扫描完成：${lastScanSummary.value}`);
    await reloadAll();
  } catch (err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '扫描失败';
    notify.error(msg, 5000);
  } finally {
    scanning.value = false;
  }
}

async function toggleExposure(row: CapabilityRow, agent: CapabilityAgent): Promise<void> {
  if (!canManageExposure(row)) {
    notify.info('外部发现项需要先导入 1Shell 管理，才能调整暴露范围');
    return;
  }
  const next = !Boolean(row.exposure?.[agent.id]);
  const key = `${row.kind}:${row.id}:${agent.id}`;
  if (togglingKey.value) return;
  togglingKey.value = key;
  row.exposure = { ...(row.exposure || {}), [agent.id]: next };
  try {
    const data = await requestJson<{ ok: boolean; capability?: CapabilityRow; error?: string }>(
      `/api/host-capabilities/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.id)}/exposure/${encodeURIComponent(agent.id)}`,
      { method: 'PUT', body: JSON.stringify({ enabled: next }) },
    );
    if (!data.ok) throw new Error(data.error || '保存失败');
    if (data.capability) replaceRow(data.capability);
    notify.success(next ? '已暴露给 Agent' : '已取消暴露');
  } catch (err) {
    row.exposure = { ...(row.exposure || {}), [agent.id]: !next };
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '保存失败';
    notify.error(msg, 5000);
  } finally {
    togglingKey.value = '';
  }
}

async function importCapability(row: CapabilityRow): Promise<void> {
  const key = `${row.kind}:${row.id}`;
  if (importingKey.value) return;
  importingKey.value = key;
  try {
    const data = await requestJson<{ ok: boolean; capability?: CapabilityRow; error?: string }>(
      `/api/host-capabilities/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.id)}/import`,
      { method: 'POST' },
    );
    if (!data.ok) throw new Error(data.error || '导入失败');
    notify.success('已导入 1Shell 管理');
    await reloadAll();
  } catch (err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '导入失败';
    notify.error(msg, 5000);
  } finally {
    importingKey.value = '';
  }
}

function replaceRow(row: CapabilityRow): void {
  const target = row.kind === 'mcp' ? mcpRows : skillRows;
  target.value = target.value.map((item) => item.id === row.id ? row : item);
}

function openNewMcp(): void {
  editingMcp.value = null;
  mcpModalOpen.value = true;
}

function openLocalModal(): void {
  localModalOpen.value = true;
}

function openDeployModal(): void {
  deployModalOpen.value = true;
}

function openSkillImport(): void {
  skillAiImportModalOpen.value = true;
}

function openEditMcp(row: CapabilityRow): void {
  const item = legacyMcpServers.value.find((mcp) => mcp.id === row.id);
  if (!item) {
    notify.info('该 MCP 来自 preset 或外部发现，当前阶段只能调整暴露范围');
    return;
  }
  editingMcp.value = item;
  mcpModalOpen.value = true;
}

function agentClass(agent: CapabilityAgent): string {
  if (agent.id === 'oneshell-ai') return 'agent-oneshell';
  if (agent.id === 'claude-code') return 'agent-claude';
  if (agent.id === 'codex') return 'agent-codex';
  if (agent.id === 'opencode') return 'agent-opencode';
  return 'agent-generic';
}

function agentIconUrl(agent: CapabilityAgent): string {
  return AGENT_ICON_URLS[agent.id] || '';
}

function agentFallback(agent: CapabilityAgent): string {
  const label = agent.label || agent.id;
  return label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function agentTitle(agent: CapabilityAgent): string {
  const parts = [agent.label || agent.id];
  if (agent.installed === false) parts.push('未安装');
  else if (agent.configured === false) parts.push('未配置');
  return parts.join(' · ');
}

function sourceLabel(row: CapabilityRow): string {
  const map: Record<string, string> = {
    managed: '1Shell 管理',
    preset: 'Preset',
    oneshell: '1Shell 内置',
    imported: '已导入',
    installed: '外部安装',
    external: '外部发现',
    unmanaged: '未管理',
  };
  return map[row.source || ''] || row.source || '未知来源';
}

function sourceClass(row: CapabilityRow): string {
  return `source-${row.source || 'unknown'}`;
}

function typeLabel(row: CapabilityRow): string {
  if (row.kind === 'skill') return row.category || 'skill';
  if (row.transport === 'stdio') return 'stdio';
  if (row.transport === 'remote') return 'remote';
  return row.transport || 'mcp';
}

function rowMetaLine(row: CapabilityRow): string {
  const parts: string[] = [];
  if (row.kind === 'mcp' && row.transport) parts.push(typeLabel(row));
  if (row.kind === 'mcp' && Number(row.toolCount || 0) > 0) parts.push(`${row.toolCount} tools`);
  if (row.runtimeStatus && row.runtimeStatus !== typeLabel(row)) parts.push(row.runtimeStatus);
  return parts.slice(0, 3).join(' / ');
}

function isToggleBusy(row: CapabilityRow, agent: CapabilityAgent): boolean {
  return togglingKey.value === `${row.kind}:${row.id}:${agent.id}`;
}

function isImportBusy(row: CapabilityRow): boolean {
  return importingKey.value === `${row.kind}:${row.id}`;
}

function canManageExposure(row: CapabilityRow): boolean {
  return row.managed !== false && row.readonly !== true;
}

onMounted(() => {
  void reloadAll();
});
</script>

<template>
  <div class="flex flex-col flex-1 min-w-0 h-full p-2 gap-2">
    <header class="matrix-header">
      <div class="flex items-center gap-2 min-w-0">
        <span class="header-logo">
          <AppIcon name="package" :size="17" />
        </span>
        <h1 class="text-base font-bold text-slate-800 dark:text-slate-100 truncate">扩展</h1>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" class="matrix-action secondary" :disabled="loading" @click="reloadAll">
          <AppIcon name="restart" :size="13" />
          <span>刷新</span>
        </button>
        <button type="button" class="matrix-action secondary" :disabled="scanning" @click="scanHost">
          <AppIcon name="target" :size="13" />
          <span>{{ scanning ? '扫描中' : '扫描' }}</span>
        </button>
        <button v-if="activeTab === 'skill'" type="button" class="matrix-action primary" @click="openSkillImport">
          <AppIcon name="robot" :size="13" />
          <span>AI 导入</span>
        </button>
        <template v-else>
          <button type="button" class="matrix-action secondary" @click="openLocalModal">
            <AppIcon name="box" :size="13" />
            <span>本地 MCP</span>
          </button>
          <button type="button" class="matrix-action secondary" @click="openDeployModal">
            <AppIcon name="robot" :size="13" />
            <span>AI 部署</span>
          </button>
          <button type="button" class="matrix-action primary" @click="openNewMcp">
            <AppIcon name="plus" :size="13" />
            <span>添加 MCP</span>
          </button>
        </template>
      </div>
    </header>

    <section class="matrix-toolbar">
      <div class="segmented" role="tablist" aria-label="Capability type">
        <button type="button" class="segment" :class="{ active: activeTab === 'mcp' }" @click="activeTab = 'mcp'">
          <AppIcon name="plug" :size="14" />
          <span>MCP</span>
          <b>{{ mcpCount }}</b>
        </button>
        <button type="button" class="segment" :class="{ active: activeTab === 'skill' }" @click="activeTab = 'skill'">
          <AppIcon name="puzzle" :size="14" />
          <span>Skill</span>
          <b>{{ skillCount }}</b>
        </button>
      </div>

      <label class="search-box">
        <AppIcon name="search" :size="13" />
        <input v-model="query" type="search" placeholder="名称、标签、来源" />
      </label>
    </section>

    <main class="matrix-panel">
      <div v-if="loadError" class="state-message text-red-500">
        {{ loadError }}
      </div>
      <div v-else-if="loading && activeRows.length === 0" class="state-message">
        正在加载扩展矩阵
      </div>
      <div v-else-if="filteredRows.length === 0" class="state-message">
        没有匹配的 {{ activeTab === 'mcp' ? 'MCP' : 'Skill' }}
      </div>
      <div v-else class="matrix-table">
        <div class="matrix-row matrix-head" :style="matrixGridStyle">
          <div class="capability-col"></div>
          <div
            v-for="agent in activeAgentColumns"
            :key="agent.id"
            class="agent-col agent-head-col"
            :title="agentTitle(agent)"
          >
            <span class="agent-head" :class="[agentClass(agent), { unavailable: agent.installed === false || agent.configured === false }]">
              <img v-if="agentIconUrl(agent)" class="agent-logo" :src="agentIconUrl(agent)" :alt="agent.label || agent.id" draggable="false" />
              <span v-else class="agent-fallback">{{ agentFallback(agent) }}</span>
            </span>
          </div>
          <div class="action-col"></div>
        </div>

        <div v-for="row in filteredRows" :key="`${row.kind}:${row.id}`" class="matrix-row" :style="matrixGridStyle">
          <div class="capability-col min-w-0">
            <div class="capability-title-line">
              <span class="capability-name truncate">{{ row.name || row.id }}</span>
              <span v-if="row.source" class="source-chip" :class="sourceClass(row)">{{ sourceLabel(row) }}</span>
            </div>
            <div v-if="rowMetaLine(row)" class="capability-facts truncate">
              {{ rowMetaLine(row) }}
            </div>
          </div>

          <div v-for="agent in activeAgentColumns" :key="agent.id" class="agent-col">
            <button
              type="button"
              class="agent-toggle"
              :class="[agentClass(agent), { on: row.exposure?.[agent.id], busy: isToggleBusy(row, agent), readonly: !canManageExposure(row) }]"
              :title="!canManageExposure(row) ? '外部发现项，导入后可管理暴露范围' : `${row.exposure?.[agent.id] ? '取消暴露给' : '暴露给'} ${agent.label}`"
              :aria-label="!canManageExposure(row) ? `${row.name || row.id} 暂不可管理` : `${row.exposure?.[agent.id] ? '取消暴露给' : '暴露给'} ${agent.label}`"
              :aria-pressed="Boolean(row.exposure?.[agent.id])"
              :disabled="Boolean(togglingKey) || !canManageExposure(row)"
              @click="toggleExposure(row, agent)"
            >
              <img v-if="agentIconUrl(agent)" class="agent-logo" :src="agentIconUrl(agent)" :alt="agent.label || agent.id" draggable="false" />
              <span v-else class="agent-fallback">{{ agentFallback(agent) }}</span>
            </button>
          </div>

          <div class="action-col">
            <button
              v-if="row.importable && row.managed === false"
              type="button"
              class="row-action"
              title="导入 1Shell 管理"
              :disabled="Boolean(importingKey)"
              @click="importCapability(row)"
            >
              <AppIcon name="download" :size="14" />
            </button>
            <button
              v-else-if="row.kind === 'mcp'"
              type="button"
              class="row-action"
              title="编辑 MCP"
              @click="openEditMcp(row)"
            >
              <AppIcon name="toolbox" :size="14" />
            </button>
          </div>
        </div>
      </div>
    </main>

    <McpModal
      v-model:open="mcpModalOpen"
      :editing="editingMcp"
      @saved="reloadAll"
    />
    <LocalMcpModal
      v-model:open="localModalOpen"
      @saved="reloadAll"
    />
    <DeployMcpModal
      v-model:open="deployModalOpen"
      @saved="reloadAll"
    />
    <SkillAiImportModal
      v-model:open="skillAiImportModalOpen"
      @saved="reloadAll"
    />
  </div>
</template>

<style scoped>
.matrix-header {
  min-height: 3.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 0.92);
  color: rgb(51 65 85);
}

:global(.dark) .matrix-header {
  border-color: rgb(30 41 59);
  background: rgb(15 23 42);
  color: rgb(226 232 240);
}

.header-logo {
  width: 2rem;
  height: 2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(219 234 254);
  border-radius: 0.5rem;
  color: rgb(2 132 199);
  background: rgb(239 246 255);
}

:global(.dark) .header-logo {
  border-color: rgb(14 165 233 / 0.26);
  color: rgb(125 211 252);
  background: rgb(14 165 233 / 0.12);
}

.matrix-toolbar {
  display: grid;
  grid-template-columns: auto minmax(14rem, 24rem);
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 0.92);
}

:global(.dark) .matrix-toolbar {
  border-color: rgb(30 41 59);
  background: rgb(15 23 42);
}

.segmented {
  display: inline-flex;
  align-items: center;
  overflow: hidden;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background: rgb(248 250 252);
}

:global(.dark) .segmented {
  border-color: rgb(30 41 59);
  background: rgb(2 6 23 / 0.45);
}

.segment {
  min-height: 2rem;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0 0.75rem;
  border-right: 1px solid rgb(226 232 240);
  font-size: 0.75rem;
  font-weight: 700;
  color: rgb(100 116 139);
}

.segment:last-child {
  border-right: 0;
}

.segment.active {
  background: white;
  color: rgb(15 23 42);
}

:global(.dark) .segment {
  border-color: rgb(30 41 59);
}

:global(.dark) .segment.active {
  background: rgb(30 41 59);
  color: rgb(248 250 252);
}

.segment b {
  min-width: 1.1rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  color: rgb(100 116 139);
  background: rgb(241 245 249);
}

:global(.dark) .segment b {
  color: rgb(203 213 225);
  background: rgb(15 23 42);
}

.search-box {
  min-height: 2rem;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.625rem;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background: rgb(248 250 252);
  color: rgb(148 163 184);
}

:global(.dark) .search-box {
  border-color: rgb(30 41 59);
  background: rgb(2 6 23 / 0.5);
}

.search-box input {
  min-width: 0;
  height: 2rem;
  background: transparent;
  outline: none;
  font-size: 0.75rem;
  color: rgb(30 41 59);
}

:global(.dark) .search-box input {
  color: rgb(226 232 240);
}

.matrix-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 0.94);
}

:global(.dark) .matrix-panel {
  border-color: rgb(30 41 59);
  background: rgb(15 23 42);
}

.matrix-table {
  width: 100%;
  min-width: 36rem;
}

.matrix-row {
  display: grid;
  align-items: center;
  min-height: 3.375rem;
  border-bottom: 1px solid rgb(226 232 240);
}

.matrix-row:last-child {
  border-bottom: 0;
}

.matrix-row:not(.matrix-head):hover {
  background: rgb(248 250 252 / 0.72);
}

:global(.dark) .matrix-row {
  border-color: rgb(30 41 59);
}

:global(.dark) .matrix-row:not(.matrix-head):hover {
  background: rgb(30 41 59 / 0.35);
}

.matrix-head {
  min-height: 2.875rem;
  position: sticky;
  top: 0;
  z-index: 2;
  background: rgb(248 250 252);
}

:global(.dark) .matrix-head {
  background: rgb(2 6 23);
}

.capability-col,
.agent-col,
.action-col {
  min-width: 0;
}

.capability-col {
  padding: 0 0.875rem;
}

.agent-col,
.action-col {
  display: flex;
  justify-content: center;
  padding: 0 0.35rem;
}

.agent-head-col {
  align-self: stretch;
  align-items: center;
}

.capability-title-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.capability-name {
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 750;
  color: rgb(15 23 42);
}

:global(.dark) .capability-name {
  color: rgb(248 250 252);
}

.capability-facts {
  min-width: 0;
  margin-top: 0.125rem;
  font-size: 0.72rem;
  line-height: 1.2;
  color: rgb(100 116 139);
}

:global(.dark) .capability-facts {
  color: rgb(148 163 184);
}

.source-chip {
  display: inline-flex;
  align-items: center;
  max-width: 6.5rem;
  min-height: 1.125rem;
  padding: 0 0.375rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  font-size: 0.625rem;
  font-weight: 700;
  color: rgb(100 116 139);
  background: rgb(241 245 249);
}

.source-chip.source-managed {
  color: rgb(4 120 87);
  background: rgb(236 253 245);
}

.source-chip.source-oneshell {
  color: rgb(2 132 199);
  background: rgb(239 246 255);
}

.source-chip.source-preset {
  color: rgb(79 70 229);
  background: rgb(238 242 255);
}

.source-chip.source-external {
  color: rgb(100 116 139);
  border-color: rgb(226 232 240);
  background: rgb(248 250 252);
}

.source-chip.source-installed,
.source-chip.source-unmanaged {
  color: rgb(79 70 229);
  background: rgb(238 242 255);
}

:global(.dark) .source-chip {
  color: rgb(203 213 225);
  border-color: rgb(30 41 59);
  background: rgb(30 41 59);
}

.agent-head,
.agent-toggle {
  width: 2.15rem;
  height: 2.15rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(226 232 240);
  border-radius: 999px;
  background: white;
}

.agent-head.unavailable {
  opacity: 0.45;
}

.agent-toggle {
  color: rgb(148 163 184);
  opacity: 0.38;
  transition: transform 0.14s ease, opacity 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}

.agent-toggle:hover {
  transform: translateY(-1px);
  opacity: 0.72;
}

.agent-toggle.on {
  opacity: 1;
}

.agent-toggle.busy {
  cursor: wait;
  opacity: 0.55;
}

.agent-toggle.readonly {
  cursor: not-allowed;
  opacity: 0.24;
}

.agent-toggle.readonly.on {
  opacity: 1;
}

.agent-toggle.readonly:hover {
  transform: none;
}

.agent-logo {
  width: 1.18rem;
  height: 1.18rem;
  display: block;
  object-fit: contain;
  pointer-events: none;
}

.agent-oneshell .agent-logo {
  width: 1.45rem;
  height: 1.45rem;
  border-radius: 0.375rem;
}

.agent-fallback {
  font-size: 0.6875rem;
  font-weight: 800;
  line-height: 1;
  color: rgb(100 116 139);
}

.agent-head.agent-oneshell,
.agent-oneshell.on {
  border-color: rgb(191 219 254);
  background: rgb(239 246 255);
}

.agent-head.agent-claude,
.agent-claude.on {
  border-color: rgb(254 215 170);
  background: rgb(255 247 237);
}

.agent-head.agent-codex,
.agent-codex.on {
  border-color: rgb(167 243 208);
  background: rgb(236 253 245);
}

.agent-head.agent-opencode,
.agent-opencode.on {
  border-color: rgb(199 210 254);
  background: rgb(238 242 255);
}

.agent-head.agent-generic,
.agent-generic.on {
  border-color: rgb(226 232 240);
  background: rgb(248 250 252);
}

:global(.dark) .agent-head,
:global(.dark) .agent-toggle {
  border-color: rgb(30 41 59);
  background: rgb(15 23 42);
}

:global(.dark) .agent-codex .agent-logo,
:global(.dark) .agent-opencode .agent-logo {
  filter: invert(1);
}

:global(.dark) .agent-head.agent-oneshell,
:global(.dark) .agent-oneshell.on {
  border-color: rgb(14 165 233 / 0.3);
  background: rgb(14 165 233 / 0.14);
}

:global(.dark) .agent-head.agent-claude,
:global(.dark) .agent-claude.on {
  border-color: rgb(249 115 22 / 0.3);
  background: rgb(249 115 22 / 0.14);
}

:global(.dark) .agent-head.agent-codex,
:global(.dark) .agent-codex.on {
  border-color: rgb(34 197 94 / 0.3);
  background: rgb(34 197 94 / 0.14);
}

:global(.dark) .agent-head.agent-opencode,
:global(.dark) .agent-opencode.on {
  border-color: rgb(99 102 241 / 0.34);
  background: rgb(99 102 241 / 0.16);
}

.matrix-action,
.row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-height: 2rem;
  border-radius: 0.5rem;
  font-size: 0.75rem;
  font-weight: 750;
}

.matrix-action {
  padding: 0 0.75rem;
}

.matrix-action:disabled {
  cursor: wait;
  opacity: 0.55;
}

.matrix-action.primary {
  color: white;
  background: rgb(37 99 235);
}

.matrix-action.secondary {
  color: rgb(51 65 85);
  border: 1px solid rgb(226 232 240);
  background: rgb(248 250 252);
}

:global(.dark) .matrix-action.secondary {
  color: rgb(226 232 240);
  border-color: rgb(30 41 59);
  background: rgb(2 6 23 / 0.5);
}

.row-action {
  width: 2rem;
  color: rgb(100 116 139);
}

.row-action:disabled {
  cursor: wait;
  opacity: 0.55;
}

.row-action:hover {
  background: rgb(241 245 249);
  color: rgb(15 23 42);
}

:global(.dark) .row-action:hover {
  background: rgb(30 41 59);
  color: rgb(248 250 252);
}

.state-message {
  min-height: 18rem;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 0.8125rem;
  color: rgb(100 116 139);
}

@media (max-width: 960px) {
  .matrix-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .matrix-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
