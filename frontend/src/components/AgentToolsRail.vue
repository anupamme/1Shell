<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';

interface SkillItem {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
}
interface McpServer {
  id: string;
  name: string;
  enabled?: boolean;
  exposeToIde?: boolean;
  toolCount?: number;
  runtimeStatus?: string;
}

type ToolTab = 'skill' | 'mcp';

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const props = withDefaults(defineProps<{
  embedded?: boolean;
}>(), {
  embedded: false,
});

const tab = ref<ToolTab>('skill');
const skills = ref<SkillItem[]>([]);
const servers = ref<McpServer[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);

const skillOnCount = computed(() => skills.value.filter((s) => s.enabled).length);
// MCP 暴露给 agent 的条件：服务启用且 exposeToIde !== false
const mcpOnCount = computed(() => servers.value.filter((s) => s.enabled !== false && s.exposeToIde !== false).length);

async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    const [sk, mcp] = await Promise.allSettled([
      requestJson<{ ok: boolean; skills: SkillItem[] }>('/api/skills'),
      requestJson<{ ok: boolean; servers: McpServer[] }>('/api/mcp-servers'),
    ]);
    if (sk.status === 'fulfilled' && sk.value.ok) skills.value = sk.value.skills || [];
    if (mcp.status === 'fulfilled' && mcp.value.ok) servers.value = mcp.value.servers || [];
  } finally {
    loading.value = false;
  }
}

async function toggleSkill(item: SkillItem): Promise<void> {
  const next = !item.enabled;
  busyId.value = item.id;
  item.enabled = next; // optimistic
  try {
    await requestJson(`/api/skills/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: next }),
    });
  } catch (err) {
    item.enabled = !next; // revert
    notify.error(err instanceof Error ? err.message : String(err), 4000);
  } finally {
    busyId.value = null;
  }
}

function mcpOn(s: McpServer): boolean {
  return s.enabled !== false && s.exposeToIde !== false;
}

async function toggleMcp(s: McpServer): Promise<void> {
  const next = !mcpOn(s);
  busyId.value = s.id;
  // 开 = 同时启用服务并暴露给 agent；关 = 只收起对 agent 的暴露（不动服务本身的运行）
  const patch = next ? { enabled: true, exposeToIde: true } : { exposeToIde: false };
  const prevEnabled = s.enabled;
  const prevExpose = s.exposeToIde;
  s.enabled = next ? true : s.enabled;
  s.exposeToIde = next;
  try {
    await requestJson(`/api/mcp-servers/${encodeURIComponent(s.id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  } catch (err) {
    s.enabled = prevEnabled;
    s.exposeToIde = prevExpose;
    notify.error(err instanceof Error ? err.message : String(err), 4000);
  } finally {
    busyId.value = null;
  }
}

defineExpose({ reload: loadAll });
onMounted(() => { void loadAll(); });
</script>

<template>
  <aside
    :class="props.embedded
      ? 'flex-1 min-h-0 flex flex-col overflow-hidden bg-transparent'
      : 'w-64 shrink-0 h-full flex flex-col border-l border-slate-200 dark:border-white/[0.05] bg-stone-50 dark:bg-[#0f1321]'"
  >
    <div class="shrink-0 flex items-center gap-2 px-4 h-11 border-b border-slate-200 dark:border-white/[0.05]">
      <AppIcon name="wrench" :size="15" class="text-slate-400 dark:text-slate-500" />
      <span class="text-[11px] font-semibold tracking-widest text-slate-400 dark:text-slate-500 uppercase">Tools</span>
      <button class="ml-auto text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors cursor-pointer" title="刷新" @click="loadAll">
        <AppIcon name="history" :size="13" />
      </button>
    </div>

    <!-- tab switch -->
    <div class="shrink-0 flex gap-1 p-2 border-b border-slate-200 dark:border-white/[0.04]">
      <button
        class="flex-1 h-7 rounded-md text-xs font-medium flex items-center justify-center gap-1 transition-colors cursor-pointer"
        :class="tab === 'skill' ? 'bg-white dark:bg-white/[0.06] text-slate-700 dark:text-slate-200 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
        @click="tab = 'skill'"
      >
        <AppIcon name="library" :size="13" /> Skill
        <span v-if="skillOnCount" class="text-[9px] px-1 rounded-full bg-emerald-100 dark:bg-emerald-400/15 text-emerald-600 dark:text-emerald-400">{{ skillOnCount }}</span>
      </button>
      <button
        class="flex-1 h-7 rounded-md text-xs font-medium flex items-center justify-center gap-1 transition-colors cursor-pointer"
        :class="tab === 'mcp' ? 'bg-white dark:bg-white/[0.06] text-slate-700 dark:text-slate-200 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
        @click="tab = 'mcp'"
      >
        <AppIcon name="plug" :size="13" /> MCP
        <span v-if="mcpOnCount" class="text-[9px] px-1 rounded-full bg-emerald-100 dark:bg-emerald-400/15 text-emerald-600 dark:text-emerald-400">{{ mcpOnCount }}</span>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden p-2">
      <div v-if="loading" class="px-2 py-6 text-center text-xs text-slate-400 dark:text-slate-600">加载中…</div>

      <!-- skill list -->
      <template v-else-if="tab === 'skill'">
        <p class="px-2 pb-2 text-[10px] leading-4 text-slate-400 dark:text-slate-600">开启的技能会进入 agent 的可用技能目录，由它按需读取使用。默认全关。</p>
        <div
          v-for="s in skills"
          :key="s.id"
          class="mb-1.5 rounded-lg border border-slate-200 dark:border-white/[0.05] bg-white dark:bg-[#11141f] p-2.5"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{{ s.name || s.id }}</div>
              <div v-if="s.description" class="text-[10px] leading-4 text-slate-400 dark:text-slate-600 truncate mt-0.5" :title="s.description">{{ s.description }}</div>
            </div>
            <button
              type="button"
              class="shrink-0 mt-0.5 w-8 h-[18px] rounded-full transition-colors relative cursor-pointer disabled:opacity-50"
              :class="s.enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"
              :disabled="busyId === s.id"
              :title="s.enabled ? '已启用' : '已禁用'"
              @click="toggleSkill(s)"
            >
              <span class="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all" :class="s.enabled ? 'left-[18px]' : 'left-0.5'"></span>
            </button>
          </div>
        </div>
        <div v-if="!skills.length" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">暂无技能</div>
      </template>

      <!-- mcp list -->
      <template v-else>
        <p class="px-2 pb-2 text-[10px] leading-4 text-slate-400 dark:text-slate-600">开启后该 MCP 的工具会暴露给 agent。这是全局设置，与 MCP Hub 同步。</p>
        <div
          v-for="m in servers"
          :key="m.id"
          class="mb-1.5 rounded-lg border border-slate-200 dark:border-white/[0.05] bg-white dark:bg-[#11141f] p-2.5"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{{ m.name || m.id }}</div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span v-if="m.runtimeStatus" class="text-[10px] text-slate-400 dark:text-slate-600">{{ m.runtimeStatus }}</span>
                <span v-if="m.toolCount" class="text-[10px] text-slate-400 dark:text-slate-600">· {{ m.toolCount }} 工具</span>
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 mt-0.5 w-8 h-[18px] rounded-full transition-colors relative cursor-pointer disabled:opacity-50"
              :class="mcpOn(m) ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'"
              :disabled="busyId === m.id"
              :title="mcpOn(m) ? '已暴露给 agent' : '未暴露'"
              @click="toggleMcp(m)"
            >
              <span class="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all" :class="mcpOn(m) ? 'left-[18px]' : 'left-0.5'"></span>
            </button>
          </div>
        </div>
        <div v-if="!servers.length" class="px-2 py-8 text-center text-xs text-slate-400 dark:text-slate-600">暂无 MCP Server</div>
      </template>
    </div>
  </aside>
</template>
