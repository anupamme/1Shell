<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { useConfirm } from '@/composables/useConfirm';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import {
  isLocalMcp,
  type McpInfo,
  type McpServersResponse,
  type SkillInfo,
  type SkillsResponse,
  type TabKey,
} from '@/utils/skills';
import AppIcon from '@/components/AppIcon.vue';
import SkillCard from '@/components/skills/SkillCard.vue';
import McpCard from '@/components/skills/McpCard.vue';
import LocalMcpCard from '@/components/skills/LocalMcpCard.vue';
import McpModal from '@/components/skills/McpModal.vue';
import LocalMcpModal from '@/components/skills/LocalMcpModal.vue';
import DeployMcpModal from '@/components/skills/DeployMcpModal.vue';
import DeployClaudeSkillModal from '@/components/skills/DeployClaudeSkillModal.vue';

const { requestJson } = useApiClient();
const notify = useNotifyStore();
const { confirm } = useConfirm();

interface SkillsCache {
  skills: SkillInfo[];
  allMcpServers: McpInfo[];
}

const SKILLS_PREFS_KEY = '1shell.skills.prefs.v1';
const SKILLS_CACHE_KEY = 'skills.page.cache.v1';
const SKILLS_CACHE_TTL_MS = 45_000;

// ── 数据 ──────────────────────────────────────────
const storedTab = readStorageState<TabKey | 'claude'>(SKILLS_PREFS_KEY, 'skill');
const currentTab = ref<TabKey>(storedTab === 'claude' ? 'skill' : storedTab);
const skills = ref<SkillInfo[]>([]);
const allMcpServers = ref<McpInfo[]>([]);
const skillLoadError = ref<string | null>(null);
const mcpLoadError = ref<string | null>(null);

const remoteMcps = computed(() => allMcpServers.value.filter((m) => !isLocalMcp(m)));
const localMcps  = computed(() => allMcpServers.value.filter((m) => isLocalMcp(m)));

function saveSkillsCache(): void {
  setCachedPageState<SkillsCache>(SKILLS_CACHE_KEY, {
    skills: skills.value,
    allMcpServers: allMcpServers.value,
  });
}

function restoreSkillsCache(): boolean {
  const entry = getCachedPageState<SkillsCache>(SKILLS_CACHE_KEY);
  if (!entry) return false;
  skills.value = entry.value.skills || [];
  allMcpServers.value = entry.value.allMcpServers || [];
  return true;
}

// ── Modal 控制 ───────────────────────────────────
const mcpModalOpen = ref(false);
const editingMcp = ref<McpInfo | null>(null);
const localModalOpen = ref(false);
const deployModalOpen = ref(false);
const deployClaudeSkillModalOpen = ref(false);

// ── API ──────────────────────────────────────────
async function loadSkills(): Promise<void> {
  try {
    const data = await requestJson<SkillsResponse>('/api/skills');
    skills.value = data.skills || [];
    skillLoadError.value = null;
    saveSkillsCache();
  } catch (err) {
    skillLoadError.value = err instanceof Error ? err.message : '加载失败';
  }
}

async function loadMcps(): Promise<void> {
  try {
    const data = await requestJson<McpServersResponse>('/api/mcp-servers');
    allMcpServers.value = data.servers || [];
    mcpLoadError.value = null;
    saveSkillsCache();
  } catch (err) {
    mcpLoadError.value = err instanceof Error ? err.message : '加载失败';
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadSkills(), loadMcps()]);
}

// ── 删除 ────────────────────────────────────────
async function onDeleteSkill(id: string): Promise<void> {
  const s = skills.value.find((x) => x.id === id);
  if (!s) return;
  const ok = await confirm({
    title: '删除 Skill',
    message: `删除 Skill "${s.name || id}"？\n整个目录（SKILL.md + rules/ + workflows/ + references/）将被删除，不可恢复。`,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await requestJson(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notify.success('已删除');
    await loadSkills();
  } catch (err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '删除失败';
    notify.error(msg, 5000);
  }
}

async function onUpdateMcp(id: string, patch: Partial<McpInfo>): Promise<void> {
  try {
    const data = await requestJson<{ server?: McpInfo }>(`/api/mcp-servers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    if (data.server) {
      allMcpServers.value = allMcpServers.value.map((m) => m.id === id ? data.server! : m);
      saveSkillsCache();
    } else {
      await loadMcps();
    }
  } catch (err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '更新失败';
    notify.error(msg, 5000);
  }
}

async function onDeleteMcp(id: string): Promise<void> {
  const m = allMcpServers.value.find((x) => x.id === id);
  if (!m) return;
  const ok = await confirm({
    title: '删除 MCP',
    message: `删除 MCP "${m.name}"？`,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await requestJson(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notify.success('已删除');
    await loadMcps();
  } catch (err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : '删除失败';
    notify.error(msg, 5000);
  }
}

// ── Modal 打开 ───────────────────────────────────
function openNewMcp(): void {
  editingMcp.value = null;
  mcpModalOpen.value = true;
}
function openEditMcp(id: string): void {
  const m = remoteMcps.value.find((x) => x.id === id);
  if (!m) return;
  editingMcp.value = m;
  mcpModalOpen.value = true;
}
function openLocalModal(): void  { localModalOpen.value = true; }
function openDeployModal(): void { deployModalOpen.value = true; }
function openDeployClaudeSkillModal(): void { deployClaudeSkillModalOpen.value = true; }

watch(currentTab, (tab) => writeStorageState(SKILLS_PREFS_KEY, tab));

onMounted(() => {
  const restored = restoreSkillsCache();
  if (!restored || !isPageStateFresh(SKILLS_CACHE_KEY, SKILLS_CACHE_TTL_MS)) void reloadAll();
});
</script>

<template>
  <div class="flex flex-col flex-1 min-w-0 h-full p-2 gap-2">
    <!-- 顶栏 -->
    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] shadow-sm text-slate-700 dark:text-slate-200">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">
          <AppIcon name="package" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            仓库
            <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300 font-semibold">Warehouse</span>
          </div>
          <div class="text-[11px] text-slate-400">Skill 与 MCP Server 的导入与存放</div>
        </div>
      </div>
      <div class="flex-1"></div>
    </header>

    <!-- Tab 切换 -->
    <div class="shrink-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] px-4 flex items-center gap-2 text-slate-700 dark:text-slate-200">
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'skill' }" @click="currentTab = 'skill'">
        <AppIcon name="package" :size="14" />
        <span>Skill（<span>{{ skills.length }}</span>）</span>
      </button>
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'mcp' }" @click="currentTab = 'mcp'">
        <AppIcon name="plug" :size="14" />
        <span>MCP Server（<span>{{ remoteMcps.length }}</span>）</span>
      </button>
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'local' }" @click="currentTab = 'local'">
        <AppIcon name="box" :size="14" />
        <span>本地 MCP（<span>{{ localMcps.length }}</span>）</span>
      </button>
      <div class="flex-1"></div>
      <button
        v-if="currentTab === 'skill'"
        class="text-[11px] px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white hover:opacity-90"
        @click="openDeployClaudeSkillModal"
      >+ 导入 Skill</button>
      <button
        v-if="currentTab === 'mcp'"
        class="text-[11px] px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600"
        @click="openNewMcp"
      >+ 添加 MCP</button>
      <button
        v-if="currentTab === 'local'"
        class="text-[11px] px-3 py-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600"
        @click="openLocalModal"
      >+ 添加本地 MCP</button>
      <button
        v-if="currentTab === 'local'"
        class="text-[11px] px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-blue-500 text-white hover:opacity-90 inline-flex items-center gap-1.5"
        @click="openDeployModal"
      >
        <AppIcon name="robot" :size="12" />
        <span>AI 部署</span>
      </button>
    </div>

    <!-- 主体面板 -->
    <main class="flex-1 min-h-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] overflow-auto p-4 text-slate-700 dark:text-slate-200">
      <!-- Skill -->
      <div v-show="currentTab === 'skill'" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div v-if="skillLoadError" class="col-span-full text-red-500 text-center py-10 text-xs">加载失败: {{ skillLoadError }}</div>
        <div v-else-if="skills.length === 0" class="col-span-full text-[12px] text-slate-400 text-center py-10">
          暂无 1Shell 扩展。<br/>
          可导入或维护 Skill，并由 1Shell runner 在目标主机上执行。
        </div>
        <SkillCard
          v-for="s in skills"
          :key="s.id"
          :skill="s"
          @delete="onDeleteSkill"
        />
      </div>

      <!-- MCP 远程 -->
      <div v-show="currentTab === 'mcp'" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div v-if="mcpLoadError" class="col-span-full text-red-500 text-center py-10 text-xs">加载失败: {{ mcpLoadError }}</div>
        <div v-else-if="remoteMcps.length === 0" class="col-span-full text-[12px] text-slate-400 text-center py-10">
          尚未登记 MCP Server。<br/>
          点右上角 "+ 添加 MCP" 登记一个远程 URL 类 MCP。
        </div>
        <McpCard
          v-for="m in remoteMcps"
          :key="m.id"
          :mcp="m"
          @edit="openEditMcp"
          @update="onUpdateMcp"
          @delete="onDeleteMcp"
        />
      </div>

      <!-- 本地 MCP -->
      <div v-show="currentTab === 'local'" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <!-- 与老版一致：本地 pane 在错误时不显示错误信息（共用 loadMcps 但仅 pane-mcp 写错误） -->
        <div v-if="localMcps.length === 0" class="col-span-full text-[12px] text-slate-400 text-center py-10">
          尚未添加本地 MCP。<br/>
          点 "📦 + 添加本地 MCP" 手动注册，或 "🤖 AI 部署" 从 GitHub 一键部署。
        </div>
        <LocalMcpCard
          v-for="m in localMcps"
          :key="m.id"
          :mcp="m"
          @update="onUpdateMcp"
          @delete="onDeleteMcp"
        />
      </div>
    </main>

    <!-- Modals -->
    <McpModal
      v-model:open="mcpModalOpen"
      :editing="editingMcp"
      @saved="loadMcps"
    />
    <LocalMcpModal
      v-model:open="localModalOpen"
      @saved="loadMcps"
    />
    <DeployMcpModal
      v-model:open="deployModalOpen"
      @saved="loadMcps"
    />
    <DeployClaudeSkillModal
      v-model:open="deployClaudeSkillModalOpen"
      @saved="reloadAll"
    />
  </div>
</template>
