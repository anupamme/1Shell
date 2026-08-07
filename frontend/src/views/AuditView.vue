<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useApiClient } from '@/composables/useApiClient';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import { useNotifyStore } from '@/stores/notify';

const PAGE_SIZE = 20;

const ACTION_LABELS: Record<string, string> = {
  bridge_exec: '命令执行',
  script_run: '脚本执行',
  script_save: '脚本保存',
  host_create: '新增主机',
  host_update: '更新主机',
  host_delete: '删除主机',
  local_config_update: '本地配置',
  login: '登录',
};

const ACTION_BADGES: Record<string, string> = {
  bridge_exec:         'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
  script_run:          'bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/20',
  script_save:         'bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/20',
  host_create:         'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20',
  host_update:         'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  host_delete:         'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20',
  local_config_update: 'bg-cyan-50 text-cyan-600 border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-300 dark:border-cyan-500/20',
  login:               'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20',
};

const DEFAULT_BADGE = 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20';

interface AuditEntry {
  id: number;
  action: string;
  timestamp: string;
  source?: string;
  host_id?: string;
  host_name?: string;
  exit_code?: number | null;
  duration_ms?: number | null;
  command?: string;
  details?: string;
  client_ip?: string;
  error?: string;
}

interface AuditResponse {
  logs: AuditEntry[];
  total: number;
  source: string;
}

interface HarnessTrace {
  id: number;
  trace_id: string;
  ts_start?: string;
  ts_end?: string;
  source?: string;
  run_id?: string;
  session_id?: string;
  host_id?: string;
  stage?: string;
  event_type?: string;
  tool_name?: string;
  input_summary?: string;
  capabilities?: string;
  decision: string;
  block_reason?: string;
  needed_approval?: number;
  exit_code?: number | null;
  duration_ms?: number | null;
  result_summary?: string;
}

interface HarnessTraceResponse {
  traces: HarnessTrace[];
  total: number;
  source: string;
}

interface ReasoningChainItem {
  id: number;
  traceId?: string;
  startedAt?: string;
  endedAt?: string;
  source?: string;
  runId?: string;
  sessionId?: string;
  hostId?: string;
  stage: string;
  eventType: string;
  toolName?: string;
  summary?: string;
  decision?: string;
  blockReason?: string;
  riskLevel?: string;
  riskAction?: string;
  resultSummary?: string;
  exitCode?: number | null;
  durationMs?: number | null;
}

interface ReasoningChainResponse {
  chain: ReasoningChainItem[];
  total: number;
  source: string;
  error?: string;
}

const DECISION_LABELS: Record<string, string> = {
  allowed: '放行',
  allowed_with_warning: '风险提醒后放行',
  allowed_after_security_check: '安全校验后放行',
  blocked: '已拦截',
  denied: '已拒绝',
  error: '执行错误',
  pending: '进行中',
  event: '链路事件',
};

const DECISION_BADGES: Record<string, string> = {
  allowed: 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20',
  allowed_with_warning: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  allowed_after_security_check: 'bg-cyan-50 text-cyan-600 border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-300 dark:border-cyan-500/20',
  blocked: 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20',
  denied:  'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  error:   'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/20',
  pending: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/20',
  event: 'bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/20',
};

const STAGE_LABELS: Record<string, string> = {
  instruction: '指令',
  perception: '感知',
  reasoning: '推理',
  security: '安全校验',
  execution: '执行',
  result: '结果',
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  instruction_received: '收到指令',
  tool_decision: '工具决策',
  phase_decision: '阶段决策',
  reasoning_summary: '推理摘要',
  security_check: '安全检查',
  final_result: '最终结果',
  tool_call: '工具调用',
};

interface AuditPrefs {
  action: string;
  source: string;
  host: string;
  keyword: string;
  applied: { action: string; source: string; hostId: string; keyword: string };
  offset: number;
}

interface AuditCache {
  logs: AuditEntry[];
  total: number;
  dataSource: string;
  offset: number;
}

const AUDIT_PREFS_KEY = '1shell.audit.prefs.v1';
const AUDIT_CACHE_KEY = 'audit.page.cache.v1';
const AUDIT_CACHE_TTL_MS = 45_000;

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const savedPrefs = readStorageState<AuditPrefs>(AUDIT_PREFS_KEY, {
  action: '',
  source: '',
  host: '',
  keyword: '',
  applied: { action: '', source: '', hostId: '', keyword: '' },
  offset: 0,
});

// 表单 UI 状态
const filterAction = ref(savedPrefs.action);
const filterSource = ref(savedPrefs.source);
const filterHost = ref(savedPrefs.host);
const filterKeyword = ref(savedPrefs.keyword);

// 实际生效的查询参数（仅在 筛选 / 重置 / Enter / 刷新 时同步）
const appliedFilters = ref(savedPrefs.applied);

const offset = ref(savedPrefs.offset);
const total = ref(0);
const dataSource = ref('--');
const logs = ref<AuditEntry[]>([]);
const loading = ref(false);
const errorText = ref<string | null>(null);

// ── Tab：审计日志 / Harness 轨迹 ──────────────────────
const activeTab = ref<'audit' | 'harness'>('audit');

// ── Harness 轨迹状态 ──────────────────────────────────
const TRACE_PAGE_SIZE = 20;
const traces = ref<HarnessTrace[]>([]);
const traceTotal = ref(0);
const traceOffset = ref(0);
const traceLoading = ref(false);
const traceError = ref<string | null>(null);
const traceLoaded = ref(false);
const traceFilterDecision = ref('');
const traceFilterKeyword = ref('');
const traceApplied = ref<{ decision: string; keyword: string }>({ decision: '', keyword: '' });
const chainLoading = ref(false);
const chainError = ref<string | null>(null);
const chainRows = ref<ReasoningChainItem[]>([]);
const chainTitle = ref('');
const chainActiveKey = ref('');

const tracePage = computed(() => Math.floor(traceOffset.value / TRACE_PAGE_SIZE) + 1);
const traceTotalPages = computed(() => Math.max(1, Math.ceil(traceTotal.value / TRACE_PAGE_SIZE)));
const tracePrevDisabled = computed(() => traceOffset.value <= 0);
const traceNextDisabled = computed(() => traceOffset.value + TRACE_PAGE_SIZE >= traceTotal.value);
const traceBlockedCount = computed(() => traces.value.filter((t) => t.decision === 'blocked' || t.decision === 'denied').length);

function buildTraceQuery(off: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(TRACE_PAGE_SIZE));
  params.set('offset', String(off));
  if (traceApplied.value.decision) params.set('decision', traceApplied.value.decision);
  if (traceApplied.value.keyword) params.set('keyword', traceApplied.value.keyword);
  return params.toString();
}

async function loadTraces(targetOffset: number = traceOffset.value): Promise<void> {
  traceOffset.value = Math.max(targetOffset, 0);
  traceLoading.value = true;
  traceError.value = null;
  try {
    const resp = await requestJson<HarnessTraceResponse>(`/api/audit/harness-traces?${buildTraceQuery(traceOffset.value)}`);
    traces.value = Array.isArray(resp.traces) ? resp.traces : [];
    traceTotal.value = Number(resp.total) || 0;
    traceLoaded.value = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    traceError.value = msg;
    notify.error(`加载轨迹失败：${msg}`, 5000);
    traces.value = [];
  } finally {
    traceLoading.value = false;
  }
}

function applyTraceFilters(): void {
  traceApplied.value = { decision: traceFilterDecision.value, keyword: traceFilterKeyword.value.trim() };
  loadTraces(0);
}
function resetTraceFilters(): void {
  traceFilterDecision.value = '';
  traceFilterKeyword.value = '';
  traceApplied.value = { decision: '', keyword: '' };
  loadTraces(0);
}
function traceGotoPrev(): void { if (!tracePrevDisabled.value) loadTraces(traceOffset.value - TRACE_PAGE_SIZE); }
function traceGotoNext(): void { if (!traceNextDisabled.value) loadTraces(traceOffset.value + TRACE_PAGE_SIZE); }
function onTraceFilterEnter(e: KeyboardEvent): void { if (e.key === 'Enter') applyTraceFilters(); }

async function loadReasoningChain(trace: HarnessTrace): Promise<void> {
  const params = new URLSearchParams();
  if (trace.run_id) params.set('runId', trace.run_id);
  else if (trace.session_id) params.set('sessionId', trace.session_id);
  if (!params.toString()) {
    notify.warn('这条轨迹没有 runId/sessionId，无法聚合推理链路', 4000);
    return;
  }
  params.set('limit', '200');
  chainActiveKey.value = trace.run_id ? `run:${trace.run_id}` : `session:${trace.session_id}`;
  chainTitle.value = trace.run_id ? `runId=${trace.run_id}` : `sessionId=${trace.session_id}`;
  chainLoading.value = true;
  chainError.value = null;
  try {
    const resp = await requestJson<ReasoningChainResponse>(`/api/audit/reasoning-chain?${params.toString()}`);
    if (resp.error) throw new Error(resp.error);
    chainRows.value = Array.isArray(resp.chain) ? resp.chain : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    chainError.value = msg;
    chainRows.value = [];
    notify.error(`加载推理链路失败：${msg}`, 5000);
  } finally {
    chainLoading.value = false;
  }
}

function closeReasoningChain(): void {
  chainRows.value = [];
  chainError.value = null;
  chainTitle.value = '';
  chainActiveKey.value = '';
}

function traceChainKey(trace: HarnessTrace): string {
  return trace.run_id ? `run:${trace.run_id}` : trace.session_id ? `session:${trace.session_id}` : '';
}

function canLoadReasoningChain(trace: HarnessTrace): boolean {
  return Boolean(trace.run_id || trace.session_id);
}

function switchTab(tab: 'audit' | 'harness'): void {
  activeTab.value = tab;
  if (tab === 'harness' && !traceLoaded.value) loadTraces(0);
}

function decisionLabel(d: string): string { return DECISION_LABELS[d] || d || '--'; }
function decisionBadge(d: string): string { return DECISION_BADGES[d] || DEFAULT_BADGE; }
function stageLabel(stage: string | undefined): string { return STAGE_LABELS[stage || ''] || stage || '--'; }
function eventTypeLabel(eventType: string | undefined): string { return EVENT_TYPE_LABELS[eventType || ''] || eventType || '--'; }
function parseCapabilities(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.join(', ');
  } catch { /* fall through */ }
  return String(raw);
}

function saveAuditPrefs(): void {
  writeStorageState<AuditPrefs>(AUDIT_PREFS_KEY, {
    action: filterAction.value,
    source: filterSource.value,
    host: filterHost.value,
    keyword: filterKeyword.value,
    applied: appliedFilters.value,
    offset: offset.value,
  });
}

function saveAuditCache(): void {
  setCachedPageState<AuditCache>(AUDIT_CACHE_KEY, {
    logs: logs.value,
    total: total.value,
    dataSource: dataSource.value,
    offset: offset.value,
  });
}

function restoreAuditCache(): boolean {
  const entry = getCachedPageState<AuditCache>(AUDIT_CACHE_KEY);
  if (!entry) return false;
  logs.value = entry.value.logs || [];
  total.value = Number(entry.value.total) || 0;
  dataSource.value = entry.value.dataSource || '--';
  offset.value = Number(entry.value.offset) || 0;
  return true;
}

const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const prevDisabled = computed(() => offset.value <= 0);
const nextDisabled = computed(() => offset.value + PAGE_SIZE >= total.value);

function buildQuery(off: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(off));
  const f = appliedFilters.value;
  if (f.action)  params.set('action', f.action);
  if (f.source)  params.set('source', f.source);
  if (f.hostId)  params.set('hostId', f.hostId);
  if (f.keyword) params.set('keyword', f.keyword);
  return params.toString();
}

async function loadAuditLogs(targetOffset: number = offset.value): Promise<void> {
  offset.value = Math.max(targetOffset, 0);
  loading.value = true;
  errorText.value = null;
  try {
    const resp = await requestJson<AuditResponse>(`/api/audit/logs?${buildQuery(offset.value)}`);
    logs.value = Array.isArray(resp.logs) ? resp.logs : [];
    total.value = Number(resp.total) || 0;
    dataSource.value = resp.source || '--';
    saveAuditPrefs();
    saveAuditCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText.value = msg;
    notify.error(`加载失败：${msg}`, 5000);
    logs.value = [];
  } finally {
    loading.value = false;
  }
}

function collectFilters(): void {
  appliedFilters.value = {
    action: filterAction.value,
    source: filterSource.value,
    hostId: filterHost.value.trim(),
    keyword: filterKeyword.value.trim(),
  };
}

function applyFilters(): void {
  collectFilters();
  loadAuditLogs(0);
}

function resetFilters(): void {
  filterAction.value = '';
  filterSource.value = '';
  filterHost.value = '';
  filterKeyword.value = '';
  appliedFilters.value = { action: '', source: '', hostId: '', keyword: '' };
  loadAuditLogs(0);
}

function refresh(): void {
  collectFilters();
  loadAuditLogs(0);
}

function gotoPrev(): void {
  if (!prevDisabled.value) loadAuditLogs(offset.value - PAGE_SIZE);
}
function gotoNext(): void {
  if (!nextDisabled.value) loadAuditLogs(offset.value + PAGE_SIZE);
}

function onFilterEnter(e: KeyboardEvent): void {
  if (e.key === 'Enter') applyFilters();
}

// ── 格式化辅助 ────────────────────────────────────────

function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action || '未知操作';
}
function badgeClass(action: string): string {
  return ACTION_BADGES[action] || DEFAULT_BADGE;
}
function formatTime(value: string | undefined): string {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}
function formatSource(value: string | undefined): string {
  if (!value) return '--';
  return String(value).replace(/_/g, ' ');
}
function formatExit(entry: AuditEntry): string {
  if (entry.exit_code === null || entry.exit_code === undefined) return '--';
  return String(entry.exit_code);
}
function formatDuration(entry: AuditEntry): string {
  if (entry.duration_ms === null || entry.duration_ms === undefined) return '--';
  return `${entry.duration_ms} ms`;
}
function parseDetails(details: string | undefined): string {
  if (!details) return '';
  try {
    const data: unknown = JSON.parse(details);
    if (data && typeof data === 'object') {
      return Object.entries(data as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ');
    }
  } catch { /* fall through */ }
  return String(details);
}

onMounted(() => {
  const restored = restoreAuditCache();
  if (!restored || !isPageStateFresh(AUDIT_CACHE_KEY, AUDIT_CACHE_TTL_MS)) {
    loadAuditLogs(restored ? offset.value : 0);
  }
});
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <!-- 主面板 -->
    <main class="main-panel flex-1 min-h-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-hidden">
      <div v-show="activeTab === 'audit'" class="h-full flex flex-col min-h-0">
        <!-- 筛选栏 -->
        <div class="shrink-0 px-4 pt-4 pb-2 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex items-center gap-1 rounded-xl bg-slate-100 dark:bg-[#0b1324] p-1 self-end">
              <button
                type="button"
                class="h-7 px-3 rounded-lg text-xs font-semibold transition-all"
                :class="activeTab === 'audit' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-blue-500'"
                @click="switchTab('audit')"
              >审计日志</button>
              <button
                type="button"
                class="h-7 px-3 rounded-lg text-xs font-semibold transition-all"
                :class="activeTab === 'harness' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-blue-500'"
                @click="switchTab('harness')"
              >Harness 轨迹</button>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">操作类型</label>
              <select
                v-model="filterAction"
                class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              >
                <option value="">全部</option>
                <option v-for="(label, key) in ACTION_LABELS" :key="key" :value="key">{{ label }}</option>
              </select>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">来源</label>
              <select
                v-model="filterSource"
                class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              >
                <option value="">全部</option>
                <option value="web_ui">Web UI</option>
                <option value="ide">1Shell AI</option>
                <option value="bridge_api">Bridge API</option>
                <option value="mcp">MCP</option>
                <option value="script_run">脚本执行</option>
                <option value="socket">Socket</option>
              </select>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">主机</label>
              <input
                v-model="filterHost"
                @keydown="onFilterEnter"
                type="text"
                placeholder="主机名 / ID"
                class="h-8 w-32 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">关键词</label>
              <input
                v-model="filterKeyword"
                @keydown="onFilterEnter"
                type="text"
                placeholder="搜索命令 / 错误 / 详情"
                class="h-8 w-44 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <button
              @click="applyFilters"
              type="button"
              class="h-8 px-4 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-600 transition-colors"
            >筛选</button>
            <button
              @click="resetFilters"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:border-blue-300 dark:hover:text-blue-400 dark:hover:border-blue-400 transition-all"
            >重置</button>
            <button
              @click="refresh()"
              type="button"
              class="ml-auto h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-all"
            >立即刷新</button>
          </div>
        </div>

        <!-- 统计 -->
        <div class="shrink-0 p-4 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">日志总数</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ total }}</div>
            </div>
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">当前页</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ page }} / {{ totalPages }}</div>
            </div>
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">数据源</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ dataSource }}</div>
            </div>
          </div>
        </div>

        <!-- 列表 -->
        <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <div v-if="loading" class="text-xs text-slate-400 text-center py-10">加载中...</div>
          <div v-else-if="errorText" class="text-xs text-rose-500 dark:text-rose-400 text-center py-10">加载失败：{{ errorText }}</div>
          <div v-else-if="logs.length === 0" class="text-xs text-slate-400 text-center py-10">暂无审计记录</div>
          <article
            v-for="entry in logs"
            v-else
            :key="entry.id"
            class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-4 shadow-sm"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded-lg border text-[11px] font-semibold" :class="badgeClass(entry.action)">{{ actionLabel(entry.action) }}</span>
              <span class="text-[11px] text-slate-400">#{{ entry.id }}</span>
              <span class="text-[11px] text-slate-400 ml-auto">{{ formatTime(entry.timestamp) }}</span>
            </div>

            <div class="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">来源</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">{{ formatSource(entry.source) }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">主机</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-all">{{ entry.host_name || entry.host_id || '--' }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">退出码</div>
                <div class="mt-1 font-semibold" :class="entry.error ? 'text-rose-500 dark:text-rose-300' : 'text-slate-700 dark:text-slate-200'">{{ formatExit(entry) }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">耗时</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">{{ formatDuration(entry) }}</div>
              </div>
            </div>

            <div v-if="entry.command" class="mt-3">
              <div class="text-[10px] font-semibold text-slate-400 mb-1">命令</div>
              <pre class="rounded-xl bg-slate-100 dark:bg-slate-900 px-3 py-2 text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all max-h-36 overflow-auto">{{ entry.command }}</pre>
            </div>

            <div v-if="parseDetails(entry.details)" class="mt-3 text-[11px] text-slate-500 dark:text-slate-400 break-all">
              <span class="font-semibold text-slate-400">详情：</span>{{ parseDetails(entry.details) }}
            </div>

            <div v-if="entry.client_ip" class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">客户端 IP：{{ entry.client_ip }}</div>

            <div v-if="entry.error" class="mt-3 rounded-xl border border-rose-200 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-300 break-all">
              {{ entry.error }}
            </div>
          </article>
        </div>

        <!-- 分页 -->
        <div class="shrink-0 px-4 py-3 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between gap-3">
          <div class="text-[11px] text-slate-400">每页 {{ PAGE_SIZE }} 条 · 共 {{ total }} 条记录</div>
          <div class="flex items-center gap-2">
            <button
              @click="gotoPrev"
              :disabled="prevDisabled"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:border-blue-300 enabled:hover:text-blue-500"
            >上一页</button>
            <button
              @click="gotoNext"
              :disabled="nextDisabled"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:border-blue-300 enabled:hover:text-blue-500"
            >下一页</button>
          </div>
        </div>
      </div>

      <!-- Harness 轨迹面板 -->
      <div v-show="activeTab === 'harness'" class="h-full flex flex-col min-h-0">
        <!-- 筛选栏 -->
        <div class="shrink-0 px-4 pt-4 pb-2 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex items-center gap-1 rounded-xl bg-slate-100 dark:bg-[#0b1324] p-1 self-end">
              <button
                type="button"
                class="h-7 px-3 rounded-lg text-xs font-semibold transition-all"
                :class="activeTab === 'audit' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-blue-500'"
                @click="switchTab('audit')"
              >审计日志</button>
              <button
                type="button"
                class="h-7 px-3 rounded-lg text-xs font-semibold transition-all"
                :class="activeTab === 'harness' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-blue-500'"
                @click="switchTab('harness')"
              >Harness 轨迹</button>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">决策</label>
              <select
                v-model="traceFilterDecision"
                class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              >
                <option value="">全部</option>
                <option value="allowed">放行</option>
                <option value="blocked">已拦截</option>
                <option value="denied">已拒绝</option>
                <option value="error">执行错误</option>
              </select>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">关键词</label>
              <input
                v-model="traceFilterKeyword"
                @keydown="onTraceFilterEnter"
                type="text"
                placeholder="搜索命令 / 拦截原因 / 结果"
                class="h-8 w-52 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <button
              @click="applyTraceFilters"
              type="button"
              class="h-8 px-4 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-600 transition-colors"
            >筛选</button>
            <button
              @click="resetTraceFilters"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:border-blue-300 dark:hover:text-blue-400 dark:hover:border-blue-400 transition-all"
            >重置</button>
            <button
              @click="loadTraces(0)"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-all"
            >立即刷新</button>
            <div class="ml-auto text-[11px] text-slate-400 self-center">
              AI 与外部世界的边界关口决策记录 · 当前页拦截/拒绝 <span class="font-bold text-rose-500">{{ traceBlockedCount }}</span> 条
            </div>
          </div>
        </div>

        <!-- 统计 -->
        <div class="shrink-0 p-4 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">轨迹总数</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ traceTotal }}</div>
            </div>
            <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#0b1324] px-4 py-3">
              <div class="text-[11px] text-slate-400">当前页</div>
              <div class="mt-1 text-2xl font-bold text-slate-700 dark:text-slate-200">{{ tracePage }} / {{ traceTotalPages }}</div>
            </div>
          </div>
        </div>
        <!-- TRACE_LIST_PLACEHOLDER -->
        <div v-if="chainActiveKey" class="shrink-0 mx-4 mt-4 rounded-2xl border border-blue-200 dark:border-blue-500/20 bg-blue-50/60 dark:bg-blue-500/10 p-4">
          <div class="flex items-start gap-3">
            <div>
              <div class="text-sm font-bold text-slate-700 dark:text-slate-100">推理链路溯源</div>
              <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400 break-all">{{ chainTitle }} · {{ chainRows.length }} 个节点</div>
            </div>
            <button
              type="button"
              class="ml-auto h-7 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white/80 dark:bg-slate-800/80 text-[11px] font-semibold text-slate-500 dark:text-slate-300 hover:text-blue-500 hover:border-blue-300"
              @click="closeReasoningChain"
            >关闭</button>
          </div>
          <div v-if="chainLoading" class="mt-4 text-xs text-slate-400">链路加载中...</div>
          <div v-else-if="chainError" class="mt-4 text-xs text-rose-500 dark:text-rose-300">链路加载失败：{{ chainError }}</div>
          <div v-else-if="chainRows.length === 0" class="mt-4 text-xs text-slate-400">暂无可聚合的推理链路节点</div>
          <div v-else class="mt-4 space-y-3 max-h-80 overflow-y-auto pr-1">
            <div
              v-for="row in chainRows"
              :key="row.id"
              class="relative pl-5 before:absolute before:left-1.5 before:top-5 before:bottom-[-14px] before:w-px before:bg-blue-200 dark:before:bg-blue-500/30 last:before:hidden"
            >
              <span class="absolute left-0 top-1.5 h-3 w-3 rounded-full bg-blue-500 ring-4 ring-blue-100 dark:ring-blue-500/15"></span>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] font-semibold text-slate-600 dark:text-slate-300">{{ stageLabel(row.stage) }}</span>
                  <span class="text-[11px] font-semibold text-slate-600 dark:text-slate-200">{{ eventTypeLabel(row.eventType) }}</span>
                  <span v-if="row.toolName" class="text-[11px] font-mono text-slate-400">{{ row.toolName }}</span>
                  <span class="ml-auto text-[10px] text-slate-400">{{ formatTime(row.startedAt) }}</span>
                </div>
                <div v-if="row.summary" class="mt-2 text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-all">{{ row.summary }}</div>
                <div v-if="row.blockReason" class="mt-2 text-[11px] text-rose-500 dark:text-rose-300 break-all">拦截/校验：{{ row.blockReason }}</div>
                <div v-if="row.resultSummary" class="mt-2 text-[11px] text-slate-500 dark:text-slate-400 break-all">结果：{{ row.resultSummary }}</div>
                <div class="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
                  <span v-if="row.decision">决策：{{ decisionLabel(row.decision) }}</span>
                  <span v-if="row.riskLevel">风险：{{ row.riskLevel }}</span>
                  <span v-if="row.durationMs != null">耗时：{{ row.durationMs }}ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- 列表 -->
        <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <div v-if="traceLoading" class="text-xs text-slate-400 text-center py-10">加载中...</div>
          <div v-else-if="traceError" class="text-xs text-rose-500 dark:text-rose-400 text-center py-10">加载失败：{{ traceError }}</div>
          <div v-else-if="traces.length === 0" class="text-xs text-slate-400 text-center py-10">暂无轨迹记录</div>
          <article
            v-for="t in traces"
            v-else
            :key="t.id"
            class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] p-4 shadow-sm"
            :class="(t.decision === 'blocked' || t.decision === 'denied') ? 'ring-1 ring-rose-200 dark:ring-rose-500/30' : ''"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded-lg border text-[11px] font-semibold" :class="decisionBadge(t.decision)">{{ decisionLabel(t.decision) }}</span>
              <span v-if="t.stage" class="inline-flex items-center px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] font-semibold text-slate-500 dark:text-slate-300">{{ stageLabel(t.stage) }}</span>
              <span class="text-[11px] font-mono text-slate-500 dark:text-slate-300">{{ t.tool_name }}</span>
              <span class="text-[11px] text-slate-400">#{{ t.id }}</span>
              <span v-if="t.needed_approval" class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300">需审批</span>
              <button
                v-if="canLoadReasoningChain(t)"
                type="button"
                class="ml-auto h-6 px-2 rounded-lg border text-[11px] font-semibold transition-all"
                :class="chainActiveKey === traceChainKey(t) ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300' : 'border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-400 hover:border-blue-300 hover:text-blue-500'"
                @click="loadReasoningChain(t)"
              >查看链路</button>
              <span class="text-[11px] text-slate-400" :class="canLoadReasoningChain(t) ? '' : 'ml-auto'">{{ formatTime(t.ts_start) }}</span>
            </div>

            <div class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">来源</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">{{ formatSource(t.source) }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">主机</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-all">{{ t.host_id || '--' }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">授权能力</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200 break-all">{{ parseCapabilities(t.capabilities) || '默认' }}</div>
              </div>
              <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] bg-slate-50/70 dark:bg-[#111827] px-3 py-2">
                <div class="text-[10px] text-slate-400">退出码 / 耗时</div>
                <div class="mt-1 font-semibold text-slate-700 dark:text-slate-200">{{ t.exit_code ?? '--' }} · {{ t.duration_ms != null ? t.duration_ms + 'ms' : '--' }}</div>
              </div>
            </div>

            <div v-if="t.run_id || t.session_id || t.event_type" class="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400 break-all">
              <span v-if="t.run_id">runId={{ t.run_id }}</span>
              <span v-if="t.session_id">sessionId={{ t.session_id }}</span>
              <span v-if="t.event_type">事件={{ eventTypeLabel(t.event_type) }}</span>
            </div>

            <div v-if="t.input_summary" class="mt-3">
              <div class="text-[10px] font-semibold text-slate-400 mb-1">调用摘要</div>
              <pre class="rounded-xl bg-slate-100 dark:bg-slate-900 px-3 py-2 text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all max-h-32 overflow-auto">{{ t.input_summary }}</pre>
            </div>

            <div v-if="t.block_reason" class="mt-3 rounded-xl border border-rose-200 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-300 break-all">
              <span class="font-semibold">拦截原因：</span>{{ t.block_reason }}
            </div>

            <div v-if="t.result_summary && !t.block_reason" class="mt-2 text-[11px] text-slate-500 dark:text-slate-400 break-all">
              <span class="font-semibold text-slate-400">结果：</span>{{ t.result_summary }}
            </div>
          </article>
        </div>

        <!-- 分页 -->
        <div class="shrink-0 px-4 py-3 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-between gap-3">
          <div class="text-[11px] text-slate-400">每页 {{ TRACE_PAGE_SIZE }} 条 · 共 {{ traceTotal }} 条轨迹</div>
          <div class="flex items-center gap-2">
            <button
              @click="traceGotoPrev"
              :disabled="tracePrevDisabled"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:border-blue-300 enabled:hover:text-blue-500"
            >上一页</button>
            <button
              @click="traceGotoNext"
              :disabled="traceNextDisabled"
              type="button"
              class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:border-blue-300 enabled:hover:text-blue-500"
            >下一页</button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
