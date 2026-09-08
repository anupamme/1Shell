<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { getCachedPageState, isPageStateFresh, readStorageState, setCachedPageState, writeStorageState } from '@/composables/usePageState';
import AppIcon from '@/components/AppIcon.vue';
import type { DiagnosticsResponse, EndpointsResponse } from '@/utils/cliSetup';

const { requestJson } = useApiClient();
const notify = useNotifyStore();

type McpHubTab = 'server' | 'remote' | 'ai' | 'api' | 'logs';

interface AiMcpSettings {
  oneshellAiMcp: { enabled: boolean };
  aiApprover: { enabled: boolean };
}

interface SkillsProviderOption {
  id: string;
  name: string;
  models: Array<{ id?: string; model?: string }>;
  model?: string;
}

interface RemoteMcpConfig {
  enabled: boolean;
  auditEnabled: boolean;
  requireHttps: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  allowedTools: string[];
  updatedAt?: string | null;
}

interface RemoteMcpTool {
  name: string;
  description?: string;
  exposed: boolean;
}

interface RemoteMcpToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  expiresAt?: string | null;
  allowedTools: string[];
  allowedHosts: string[];
  allowedScripts: string[];
  allowedPaths: string[];
}

interface RemoteMcpStatus {
  ok: boolean;
  config: RemoteMcpConfig;
  tools: RemoteMcpTool[];
  tokens: RemoteMcpToken[];
  warnings: string[];
}

interface HostOption { id: string; name?: string; }
interface ScriptOption { id: string; name?: string; }

interface McpHubCache {
  endpoints: EndpointsResponse | null;
  diagnostics: DiagnosticsResponse['checks'];
  remoteStatus: RemoteMcpStatus | null;
  hosts: HostOption[];
  scripts: ScriptOption[];
}

const MCP_HUB_PREFS_KEY = '1shell.mcp-hub.prefs.v3';
const MCP_HUB_CACHE_KEY = 'mcp-hub.page.cache.v3';
const MCP_HUB_CACHE_TTL_MS = 45_000;

const savedTab = readStorageState<string>(MCP_HUB_PREFS_KEY, 'server');
const currentTab = ref<McpHubTab>(
  savedTab === 'remote' || savedTab === 'ai' || savedTab === 'api' || savedTab === 'logs' ? savedTab : 'server'
);
const endpoints = ref<EndpointsResponse | null>(null);
const diagnostics = ref<DiagnosticsResponse['checks']>([]);
const remoteStatus = ref<RemoteMcpStatus | null>(null);
const hosts = ref<HostOption[]>([]);
const scripts = ref<ScriptOption[]>([]);
const endpointError = ref<string | null>(null);
const diagnosticsError = ref<string | null>(null);
const remoteError = ref<string | null>(null);
const endpointLoading = ref(true);
const diagnosticsLoading = ref(false);
const remoteLoading = ref(true);
const savingRemote = ref(false);
const newTokenName = ref('');
const newTokenValue = ref('');
const expandedTokenId = ref<string | null>(null);
const tokenHostDrafts = reactive<Record<string, string>>({});
const tokenScriptDrafts = reactive<Record<string, string>>({});
const tokenPathDrafts = reactive<Record<string, string>>({});
const creatingToken = ref(false);
const revokingTokenId = ref<string | null>(null);
const showCreateModal = ref(false);
const newTokenSelectedTools = ref<Set<string>>(new Set());
const newTokenToolFilter = ref('');
const tokenToolFilter = ref('');

interface AuditLogRow {
  id: number;
  timestamp: string;
  action: string;
  source: string;
  host_id?: string | null;
  host_name?: string | null;
  command?: string | null;
  exit_code?: number | null;
  duration_ms?: number | null;
  client_ip?: string | null;
  error?: string | null;
  details?: string | null;
}
type LogScope = 'all' | 'mcp' | 'remote_mcp';
type LogResult = 'all' | 'ok' | 'denied';
const logRows = ref<AuditLogRow[]>([]);
const logTotal = ref(0);
const logLoading = ref(false);
const logError = ref<string | null>(null);
const logScope = ref<LogScope>('all');
const logResult = ref<LogResult>('all');
const logKeyword = ref('');
const logLimit = 100;

const tokenReady = computed(() => Boolean(endpoints.value?.token.ready));
const mcpUrl = computed(() => endpoints.value?.endpoints.mcp.url || '');
const bridgeUrl = computed(() => endpoints.value?.endpoints.bridge.url || '');
const tokenMasked = computed(() => endpoints.value?.token.masked || '****');
const mcpProtocol = computed(() => endpoints.value?.endpoints.mcp.protocol || 'SSE');
const remoteConfig = computed(() => remoteStatus.value?.config || null);
const remoteTools = computed(() => remoteStatus.value?.tools || []);
const remoteTokens = computed(() => remoteStatus.value?.tokens || []);
const activeRemoteTokens = computed(() => remoteTokens.value.filter((t) => !t.revokedAt));
const selectedRemoteToken = computed(() => activeRemoteTokens.value.find((t) => t.id === expandedTokenId.value) || activeRemoteTokens.value[0] || null);
const remoteWarnings = computed(() => remoteStatus.value?.warnings || []);
const successfulChecks = computed(() => diagnostics.value.filter((c) => c.ok).length);
const failedChecks = computed(() => diagnostics.value.filter((c) => !c.ok).length);
const remoteOn = computed(() => Boolean(remoteConfig.value?.enabled));

const filteredTokenTools = computed(() => {
  const q = tokenToolFilter.value.trim().toLowerCase();
  if (!q) return remoteTools.value;
  return remoteTools.value.filter((t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
});

const filteredNewTokenTools = computed(() => {
  const q = newTokenToolFilter.value.trim().toLowerCase();
  if (!q) return remoteTools.value;
  return remoteTools.value.filter((t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
});

const nativeRemoteConfig = computed(() => JSON.stringify({
  mcpServers: {
    '1shell-vps': {
      type: 'http',
      url: mcpUrl.value || 'https://your-domain.com/mcp/sse',
      headers: { 'X-Remote-Mcp-Token': '<1SHELL_REMOTE_API_KEY>' },
    },
  },
}, null, 2));

const stdioBridgeConfig = computed(() => JSON.stringify({
  mcpServers: {
    '1shell-vps': {
      command: 'node',
      args: ['bin/1shell-mcp-stdio.js'],
      env: {
        ONESHELL_URL: (mcpUrl.value || 'https://your-domain.com/mcp/sse').replace(/\/mcp\/sse$/, ''),
        ONESHELL_TOKEN: '<1SHELL_REMOTE_API_KEY>',
      },
    },
  },
}, null, 2));

function saveCache(): void {
  setCachedPageState<McpHubCache>(MCP_HUB_CACHE_KEY, {
    endpoints: endpoints.value,
    diagnostics: diagnostics.value,
    remoteStatus: remoteStatus.value,
    hosts: hosts.value,
    scripts: scripts.value,
  });
}

function restoreCache(): boolean {
  const entry = getCachedPageState<McpHubCache>(MCP_HUB_CACHE_KEY);
  if (!entry) return false;
  endpoints.value = entry.value.endpoints || null;
  diagnostics.value = entry.value.diagnostics || [];
  remoteStatus.value = entry.value.remoteStatus || null;
  hosts.value = entry.value.hosts || [];
  scripts.value = entry.value.scripts || [];
  syncRemoteForm();
  endpointLoading.value = false;
  remoteLoading.value = false;
  return true;
}

function syncRemoteForm(): void {
  for (const token of remoteStatus.value?.tokens || []) {
    tokenHostDrafts[token.id] = (token.allowedHosts || []).join('\n');
    tokenScriptDrafts[token.id] = (token.allowedScripts || []).join('\n');
    tokenPathDrafts[token.id] = (token.allowedPaths || []).join('\n');
  }
}

function parseLines(raw: string): string[] {
  return raw.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

// 计算所有 active token allowedTools 的并集（即"全局允许集合"应该等于的值）
function computeGlobalUnion(overrideToken?: { id: string; allowedTools: string[] }): string[] {
  const union = new Set<string>();
  for (const token of remoteTokens.value) {
    if (token.revokedAt) continue;
    const list = overrideToken && overrideToken.id === token.id ? overrideToken.allowedTools : (token.allowedTools || []);
    for (const name of list) union.add(name);
  }
  if (overrideToken && !remoteTokens.value.some((t) => t.id === overrideToken.id)) {
    for (const name of overrideToken.allowedTools) union.add(name);
  }
  return Array.from(union);
}

async function syncGlobalAllowedTools(overrideToken?: { id: string; allowedTools: string[] }): Promise<void> {
  const next = computeGlobalUnion(overrideToken);
  const current = remoteConfig.value?.allowedTools || [];
  const same = next.length === current.length && next.every((n) => current.includes(n));
  if (same) return;
  try {
    await requestJson('/api/remote-mcp/config', { method: 'PUT', body: JSON.stringify({ allowedTools: next }) });
  } catch (err) {
    notify.error(err instanceof Error ? err.message : '同步全局工具失败', 5000);
  }
}

async function loadEndpoints(): Promise<void> {
  endpointLoading.value = true;
  try {
    endpoints.value = await requestJson<EndpointsResponse>('/api/agent/endpoints');
    endpointError.value = null;
    saveCache();
  } catch (err) {
    endpointError.value = err instanceof Error ? err.message : '加载失败';
    endpoints.value = null;
  } finally { endpointLoading.value = false; }
}

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<{ hosts?: HostOption[] }>('/api/hosts');
    hosts.value = Array.isArray(data.hosts) ? data.hosts : [];
    saveCache();
  } catch { hosts.value = []; }
}

async function loadScripts(): Promise<void> {
  try {
    const data = await requestJson<{ scripts?: ScriptOption[] }>('/api/scripts');
    scripts.value = Array.isArray(data.scripts) ? data.scripts : [];
    saveCache();
  } catch { scripts.value = []; }
}

async function loadRemoteStatus(): Promise<void> {
  remoteLoading.value = true;
  remoteError.value = null;
  try {
    remoteStatus.value = await requestJson<RemoteMcpStatus>('/api/remote-mcp/status');
    syncRemoteForm();
    saveCache();
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : '加载失败';
  } finally { remoteLoading.value = false; }
}

async function saveRemoteConfig(patch: Partial<RemoteMcpConfig>): Promise<void> {
  savingRemote.value = true;
  try {
    await requestJson('/api/remote-mcp/config', { method: 'PUT', body: JSON.stringify(patch) });
    await loadRemoteStatus();
    notify.success('远程 MCP 配置已保存');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : '保存失败', 5000);
  } finally { savingRemote.value = false; }
}

async function toggleRemoteEnabled(): Promise<void> { await saveRemoteConfig({ enabled: !remoteOn.value }); }
async function toggleAuditEnabled(): Promise<void> { await saveRemoteConfig({ auditEnabled: !remoteConfig.value?.auditEnabled }); }
async function toggleRequireHttps(): Promise<void> { await saveRemoteConfig({ requireHttps: !remoteConfig.value?.requireHttps }); }

function openCreateModal(): void {
  newTokenName.value = '';
  newTokenSelectedTools.value = new Set(remoteTools.value.map((t) => t.name)); // 默认全选
  newTokenToolFilter.value = '';
  showCreateModal.value = true;
}

function toggleNewTokenTool(name: string): void {
  const next = new Set(newTokenSelectedTools.value);
  if (next.has(name)) next.delete(name); else next.add(name);
  newTokenSelectedTools.value = next;
}

function setAllNewTokenTools(mode: 'all' | 'none'): void {
  if (mode === 'all') newTokenSelectedTools.value = new Set(remoteTools.value.map((t) => t.name));
  else newTokenSelectedTools.value = new Set();
}

async function createRemoteToken(): Promise<void> {
  creatingToken.value = true;
  const tools = Array.from(newTokenSelectedTools.value);
  try {
    const data = await requestJson<{ ok: boolean; token: string; record: RemoteMcpToken }>('/api/remote-mcp/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: newTokenName.value.trim() || '远程 API Key', allowedTools: tools }),
    });
    newTokenValue.value = data.token;
    expandedTokenId.value = data.record.id;
    showCreateModal.value = false;
    await loadRemoteStatus();
    await syncGlobalAllowedTools();
    notify.success('API Key 已创建，请立即复制保存');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : '创建失败', 5000);
  } finally { creatingToken.value = false; }
}

async function updateTokenTools(token: RemoteMcpToken, toolName: string): Promise<void> {
  const current = new Set(token.allowedTools || []);
  if (current.has(toolName)) current.delete(toolName); else current.add(toolName);
  const nextList = Array.from(current);
  try {
    await requestJson(`/api/remote-mcp/tokens/${encodeURIComponent(token.id)}`, {
      method: 'PUT', body: JSON.stringify({ allowedTools: nextList }),
    });
    await syncGlobalAllowedTools({ id: token.id, allowedTools: nextList });
    await loadRemoteStatus();
  } catch (err) { notify.error(err instanceof Error ? err.message : '更新失败', 5000); }
}

async function bulkTokenTools(token: RemoteMcpToken, mode: 'all' | 'none'): Promise<void> {
  const nextList = mode === 'all' ? remoteTools.value.map((t) => t.name) : [];
  try {
    await requestJson(`/api/remote-mcp/tokens/${encodeURIComponent(token.id)}`, {
      method: 'PUT', body: JSON.stringify({ allowedTools: nextList }),
    });
    await syncGlobalAllowedTools({ id: token.id, allowedTools: nextList });
    await loadRemoteStatus();
  } catch (err) { notify.error(err instanceof Error ? err.message : '更新失败', 5000); }
}

async function saveTokenHosts(token: RemoteMcpToken): Promise<void> {
  try {
    await requestJson(`/api/remote-mcp/tokens/${encodeURIComponent(token.id)}`, {
      method: 'PUT', body: JSON.stringify({ allowedHosts: parseLines(tokenHostDrafts[token.id] || '') }),
    });
    await loadRemoteStatus();
    notify.success('主机权限已更新');
  } catch (err) { notify.error(err instanceof Error ? err.message : '更新失败', 5000); }
}

async function saveTokenScripts(token: RemoteMcpToken): Promise<void> {
  try {
    await requestJson(`/api/remote-mcp/tokens/${encodeURIComponent(token.id)}`, {
      method: 'PUT', body: JSON.stringify({ allowedScripts: parseLines(tokenScriptDrafts[token.id] || '') }),
    });
    await loadRemoteStatus();
    notify.success('脚本权限已更新');
  } catch (err) { notify.error(err instanceof Error ? err.message : '更新失败', 5000); }
}

async function saveTokenPaths(token: RemoteMcpToken): Promise<void> {
  try {
    await requestJson(`/api/remote-mcp/tokens/${encodeURIComponent(token.id)}`, {
      method: 'PUT', body: JSON.stringify({ allowedPaths: parseLines(tokenPathDrafts[token.id] || '') }),
    });
    await loadRemoteStatus();
    notify.success('路径权限已更新');
  } catch (err) { notify.error(err instanceof Error ? err.message : '更新失败', 5000); }
}

function fillTokenHosts(token: RemoteMcpToken, mode: 'all' | 'none'): void {
  tokenHostDrafts[token.id] = mode === 'all' ? hosts.value.map((h) => h.id).join('\n') : '';
}
function fillTokenScripts(token: RemoteMcpToken, mode: 'all' | 'none'): void {
  tokenScriptDrafts[token.id] = mode === 'all' ? scripts.value.map((s) => s.id).join('\n') : '';
}
function fillTokenPaths(token: RemoteMcpToken, preset: 'none' | 'logs' | 'home'): void {
  if (preset === 'none') tokenPathDrafts[token.id] = '';
  else if (preset === 'logs') tokenPathDrafts[token.id] = '/var/log\n/opt/*/logs';
  else tokenPathDrafts[token.id] = '/home\n/tmp';
}

async function revokeRemoteToken(id: string): Promise<void> {
  revokingTokenId.value = id;
  try {
    await requestJson(`/api/remote-mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadRemoteStatus();
    await syncGlobalAllowedTools();
    notify.success('API Key 已删除');
  } catch (err) {
    notify.error(err instanceof Error ? err.message : '吊销失败', 5000);
  } finally { revokingTokenId.value = null; }
}

function tokenToolCount(token: RemoteMcpToken): number {
  return (token.allowedTools || []).length;
}

function formatApiKeyName(token: RemoteMcpToken): string {
  return token.name === 'Remote MCP Token' ? '远程 API Key' : token.name;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

async function loadDiagnostics(): Promise<void> {
  diagnosticsLoading.value = true;
  diagnosticsError.value = null;
  try {
    const data = await requestJson<DiagnosticsResponse>('/api/agent/diagnostics');
    diagnostics.value = data.checks || [];
    saveCache();
  } catch (err) {
    diagnosticsError.value = err instanceof Error ? err.message : '诊断失败';
    diagnostics.value = [];
  } finally { diagnosticsLoading.value = false; }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadEndpoints(), loadDiagnostics(), loadRemoteStatus(), loadHosts(), loadScripts()]);
}

async function copy(text: string, successMsg = '已复制'): Promise<void> {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); notify.success(successMsg); }
  catch { notify.error('复制失败'); }
}

const DENIED_ACTIONS = new Set([
  'remote_mcp_disabled',
  'remote_mcp_https_required',
  'remote_mcp_host_denied',
  'remote_mcp_origin_denied',
  'remote_mcp_token_invalid',
  'remote_mcp_token_expired',
  'mcp_tool_denied',
  'mcp_path_denied',
  'mcp_script_denied',
  'mcp_host_denied',
]);

function isDeniedAction(action: string): boolean {
  if (!action) return false;
  if (DENIED_ACTIONS.has(action)) return true;
  return action.includes('_denied') || action.includes('_invalid') || action.includes('_expired') || action.includes('_required') || action.includes('_disabled');
}

function logResultLabel(row: AuditLogRow): { label: string; cls: string } {
  if (isDeniedAction(row.action) || row.error) {
    return { label: '拒绝', cls: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300' };
  }
  if (typeof row.exit_code === 'number' && row.exit_code !== 0) {
    return { label: '失败', cls: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300' };
  }
  return { label: '成功', cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300' };
}

function logSourceLabel(source: string): string {
  if (source === 'remote_mcp') return '远程';
  if (source === 'mcp') return '本地';
  return source || '—';
}

function shortDetails(row: AuditLogRow): string {
  const pieces: string[] = [];
  if (row.command) pieces.push(row.command);
  if (row.error) pieces.push(`错误: ${row.error}`);
  if (row.details) {
    try {
      const obj = JSON.parse(row.details);
      const compact = Object.entries(obj)
        .filter(([k, v]) => v != null && v !== '' && k !== 'host')
        .slice(0, 4)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' · ');
      if (compact) pieces.push(compact);
    } catch {
      pieces.push(row.details);
    }
  }
  return pieces.join(' — ');
}

async function loadLogs(): Promise<void> {
  logLoading.value = true;
  logError.value = null;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(logLimit));
    if (logKeyword.value.trim()) params.set('keyword', logKeyword.value.trim());

    let combined: AuditLogRow[] = [];
    let total = 0;
    if (logScope.value === 'all') {
      const [a, b] = await Promise.all([
        requestJson<{ ok: boolean; logs: AuditLogRow[]; total: number }>(`/api/audit/logs?${new URLSearchParams({ ...Object.fromEntries(params), source: 'mcp' }).toString()}`),
        requestJson<{ ok: boolean; logs: AuditLogRow[]; total: number }>(`/api/audit/logs?${new URLSearchParams({ ...Object.fromEntries(params), source: 'remote_mcp' }).toString()}`),
      ]);
      combined = [...(a.logs || []), ...(b.logs || [])].sort((x, y) => (y.id || 0) - (x.id || 0)).slice(0, logLimit);
      total = (a.total || 0) + (b.total || 0);
    } else {
      params.set('source', logScope.value);
      const data = await requestJson<{ ok: boolean; logs: AuditLogRow[]; total: number }>(`/api/audit/logs?${params.toString()}`);
      combined = data.logs || [];
      total = data.total || 0;
    }

    if (logResult.value === 'denied') {
      combined = combined.filter((r) => isDeniedAction(r.action) || !!r.error);
    } else if (logResult.value === 'ok') {
      combined = combined.filter((r) => !isDeniedAction(r.action) && !r.error && (r.exit_code == null || r.exit_code === 0));
    }

    logRows.value = combined;
    logTotal.value = total;
  } catch (err) {
    logError.value = err instanceof Error ? err.message : '加载失败';
    logRows.value = [];
  } finally { logLoading.value = false; }
}

watch([logScope, logResult], () => { void loadLogs(); });

// ── 1Shell AI MCP 板块（子 agent 委托 + AI 审批 + 模型选择） ──
const aiMcpLoading = ref(false);
const aiMcpSaving = ref(false);
const aiMcpError = ref<string | null>(null);
const aiMcpLoaded = ref(false);
const aiMcpDelegationOn = ref(true);
const aiApproverOn = ref(false);
const skillsProviders = ref<SkillsProviderOption[]>([]);
const activeModelKey = ref('');
const modelSwitching = ref(false);

function providerModelOptions(provider: SkillsProviderOption): Array<{ key: string; label: string }> {
  if (Array.isArray(provider.models) && provider.models.length > 0) {
    return provider.models.map((m) => ({
      key: `${provider.id}:${m.id || m.model || ''}`,
      // 单模型档案（models=[{id:'default'}]）不带模型名，回退到 provider 的活跃模型投影
      label: m.model || provider.model || m.id || '(未命名模型)',
    }));
  }
  const single = provider.model || '';
  return single ? [{ key: `${provider.id}:${single}`, label: single }] : [];
}

async function loadAiMcpSettings(): Promise<void> {
  if (aiMcpLoading.value) return;
  aiMcpError.value = null;
  aiMcpLoading.value = true;
  try {
    const [secRes, provRes] = await Promise.all([
      requestJson<{ ok?: boolean; settings?: AiMcpSettings }>('/api/security/settings'),
      requestJson<{ ok?: boolean; providers?: SkillsProviderOption[]; activeRoute?: { providerId?: string; modelId?: string } | null; activeProviderId?: string | null }>('/api/agent/providers/skills'),
    ]);
    if (secRes.settings) {
      aiMcpDelegationOn.value = secRes.settings.oneshellAiMcp?.enabled !== false;
      aiApproverOn.value = secRes.settings.aiApprover?.enabled === true;
    }
    skillsProviders.value = Array.isArray(provRes.providers) ? provRes.providers : [];
    const route = provRes.activeRoute;
    const routePid = route?.providerId || provRes.activeProviderId || '';
    const routeModel = route?.modelId || '';
    activeModelKey.value = routePid ? `${routePid}:${routeModel}` : '';
    aiMcpLoaded.value = true;
  } catch (err) {
    aiMcpError.value = err instanceof Error ? err.message : '加载 1Shell AI 设置失败';
  } finally {
    aiMcpLoading.value = false;
  }
}

async function onActiveModelChange(key: string): Promise<void> {
  const [providerId, modelId] = key.split(':');
  if (!providerId) return;
  modelSwitching.value = true;
  aiMcpError.value = null;
  try {
    await requestJson(`/api/agent/providers/skills/${encodeURIComponent(providerId)}/activate`, {
      method: 'PUT',
      body: JSON.stringify({ modelId: modelId || null }),
    });
    notify.success('1Shell AI 模型已切换');
  } catch (err) {
    aiMcpError.value = err instanceof Error ? err.message : '切换模型失败';
    await loadAiMcpSettings();
  } finally {
    modelSwitching.value = false;
  }
}

async function saveAiMcpSettings(): Promise<void> {
  aiMcpError.value = null;
  aiMcpSaving.value = true;
  try {
    await requestJson('/api/security/settings', {
      method: 'PUT',
      body: JSON.stringify({
        oneshellAiMcp: { enabled: aiMcpDelegationOn.value },
        aiApprover: { enabled: aiApproverOn.value },
      }),
    });
    notify.success('1Shell AI 设置已保存');
  } catch (err) {
    aiMcpError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    aiMcpSaving.value = false;
  }
}

watch(currentTab, (tab) => {
  writeStorageState(MCP_HUB_PREFS_KEY, tab);
  if (tab === 'logs' && logRows.value.length === 0) void loadLogs();
  // Provider 可能在「接入 → AI 配置」被增删，每次打开都刷新模型列表（两个 GET 很轻）
  if (tab === 'ai') void loadAiMcpSettings();
});

onMounted(() => {
  const restored = restoreCache();
  if (!restored || !isPageStateFresh(MCP_HUB_CACHE_KEY, MCP_HUB_CACHE_TTL_MS)) void reloadAll();
  if (currentTab.value === 'ai') void loadAiMcpSettings();
});
</script>

<template>
  <div class="flex flex-col flex-1 min-w-0 h-full p-2 gap-2">
    <!-- Header -->
    <header class="shrink-0 h-14 flex items-center px-5 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] shadow-sm text-slate-700 dark:text-slate-200">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 text-white flex items-center justify-center">
          <AppIcon name="plug" :size="18" />
        </span>
        <div>
          <div class="text-[14px] font-semibold tracking-tight">1Shell MCP</div>
          <div class="text-[11px] text-slate-400 dark:text-slate-500">面向 AI 客户端的 MCP 服务、远程开放与凭证管理</div>
        </div>
      </div>
      <div class="flex-1"></div>
      <RouterLink
        to="/config/skills"
        class="text-[12px] px-3 h-8 rounded-lg border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 inline-flex items-center gap-1.5 mr-2"
      >
        <AppIcon name="package" :size="13" />
        外部 MCP 仓库
      </RouterLink>
      <button
        class="text-[12px] px-3 h-8 rounded-lg border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 inline-flex items-center gap-1.5"
        @click="reloadAll"
      >
        <AppIcon name="history" :size="13" />
        刷新
      </button>
    </header>

    <!-- Tabs -->
    <div class="shrink-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] px-4 flex items-center gap-1 text-slate-700 dark:text-slate-200">
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'server' }" @click="currentTab = 'server'">
        <AppIcon name="server" :size="14" />
        1Shell MCP
      </button>
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'remote' }" @click="currentTab = 'remote'">
        <AppIcon name="cloud" :size="14" />
        远程开放
        <span v-if="remoteOn" class="ml-1 w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
      </button>
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'ai' }" @click="currentTab = 'ai'">
        <AppIcon name="zap" :size="14" />
        1Shell AI
      </button>
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'api' }" @click="currentTab = 'api'">
        <AppIcon name="lock" :size="14" />
        API Key
        <span v-if="activeRemoteTokens.length" class="ml-1 text-[10px] px-1.5 rounded bg-slate-100 text-slate-500 dark:bg-[#1e293b] dark:text-slate-300 tabular-nums">{{ activeRemoteTokens.length }}</span>
      </button>
      <button class="tab-btn inline-flex items-center gap-1.5" :class="{ active: currentTab === 'logs' }" @click="currentTab = 'logs'">
        <AppIcon name="clipboard" :size="14" />
        调用日志
      </button>
    </div>

    <!-- Main -->
    <main class="flex-1 min-h-0 bg-shell-panel rounded-2xl border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] overflow-auto p-5 text-slate-700 dark:text-slate-200">
      <!-- ─────────── Tab 1：1Shell MCP（仅本地接入 + 诊断） ─────────── -->
      <div v-show="currentTab === 'server'" class="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-5 items-start">
        <!-- 左：接入端点（紧凑表格）+ 接入指引 -->
        <div class="flex flex-col gap-5 min-w-0">
          <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] overflow-hidden">
            <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-baseline justify-between">
              <div>
                <div class="text-[13px] font-semibold">接入端点</div>
                <div class="text-[11px] text-slate-400 mt-0.5">本机或局域网内 AI 客户端使用 Bridge Token 访问。</div>
              </div>
              <span class="text-[11px]"
                :class="tokenReady ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'"
              >{{ tokenReady ? '已就绪' : '缺少 Bridge Token' }}</span>
            </div>

            <div v-if="endpointLoading" class="px-5 py-6 text-[12px] text-slate-400">加载端点中…</div>
            <div v-else-if="endpointError" class="px-5 py-6 text-[12px] text-red-500">端点加载失败：{{ endpointError }}</div>
            <table v-else class="w-full text-[12px]">
              <thead class="bg-slate-50/70 dark:bg-[#0b1324]/60">
                <tr class="text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                  <th class="font-medium text-left px-5 py-2 w-[110px]">用途</th>
                  <th class="font-medium text-left py-2 w-[60px]">协议</th>
                  <th class="font-medium text-left py-2">URL</th>
                  <th class="font-medium text-right px-5 py-2 w-[60px]"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-[#1e293b]">
                <tr>
                  <td class="px-5 py-2.5 font-medium">MCP 服务</td>
                  <td class="py-2.5 font-mono text-[11px] text-slate-500">{{ mcpProtocol }}</td>
                  <td class="py-2.5 font-mono text-[11px] truncate max-w-0">{{ mcpUrl || '—' }}</td>
                  <td class="px-5 py-2.5 text-right">
                    <button class="h-7 w-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300 hover:text-blue-500 inline-flex items-center justify-center" title="复制" @click="copy(mcpUrl)">
                      <AppIcon name="save" :size="12" />
                    </button>
                  </td>
                </tr>
                <tr>
                  <td class="px-5 py-2.5 font-medium">Bridge 接口</td>
                  <td class="py-2.5 font-mono text-[11px] text-slate-500">HTTP</td>
                  <td class="py-2.5 font-mono text-[11px] truncate max-w-0">{{ bridgeUrl || '—' }}</td>
                  <td class="px-5 py-2.5 text-right">
                    <button class="h-7 w-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300 hover:text-blue-500 inline-flex items-center justify-center" title="复制" @click="copy(bridgeUrl)">
                      <AppIcon name="save" :size="12" />
                    </button>
                  </td>
                </tr>
                <tr>
                  <td class="px-5 py-2.5 font-medium">Bridge Token</td>
                  <td class="py-2.5 font-mono text-[11px] text-slate-500">Header</td>
                  <td class="py-2.5 font-mono text-[11px] truncate max-w-0">{{ tokenMasked }}</td>
                  <td class="px-5 py-2.5 text-right">
                    <span class="text-[10px] px-1.5 py-0.5 rounded inline-block"
                      :class="tokenReady ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'"
                    >{{ tokenReady ? '已配置' : '未配置' }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- 接入指引：简短四步，填补下方空白且提供实际信息 -->
          <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] p-5">
            <div class="text-[13px] font-semibold mb-3">接入步骤</div>
            <ol class="space-y-2.5 text-[12px] text-slate-600 dark:text-slate-300">
              <li class="flex gap-3">
                <span class="font-mono text-[11px] tabular-nums w-5 shrink-0 text-slate-400">01</span>
                <span>在 AI 客户端的 MCP 配置里添加上方 <span class="font-mono text-[11px]">MCP 地址</span>，Header 设置 <span class="font-mono text-[11px]">X-Bridge-Token</span>。</span>
              </li>
              <li class="flex gap-3">
                <span class="font-mono text-[11px] tabular-nums w-5 shrink-0 text-slate-400">02</span>
                <span>需要从外部访问时，在「<button class="text-blue-500 hover:text-blue-600 underline-offset-2 hover:underline" @click="currentTab = 'remote'">远程开放</button>」打开总开关并部署到 VPS。</span>
              </li>
              <li class="flex gap-3">
                <span class="font-mono text-[11px] tabular-nums w-5 shrink-0 text-slate-400">03</span>
                <span>在「<button class="text-blue-500 hover:text-blue-600 underline-offset-2 hover:underline" @click="currentTab = 'api'">API Key</button>」为每个外部客户端创建独立凭证，按需限制工具、主机、脚本和路径。</span>
              </li>
              <li class="flex gap-3">
                <span class="font-mono text-[11px] tabular-nums w-5 shrink-0 text-slate-400">04</span>
                <span>在「<button class="text-blue-500 hover:text-blue-600 underline-offset-2 hover:underline" @click="currentTab = 'logs'">调用日志</button>」查看每次工具调用、拒绝原因和耗时。</span>
              </li>
            </ol>
          </section>
        </div>

        <!-- 右：诊断 -->
        <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] overflow-hidden">
          <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-baseline justify-between">
            <div>
              <div class="text-[13px] font-semibold">连接诊断</div>
              <div class="text-[11px] text-slate-400 mt-0.5">验证本地端点、Token 和反代链路是否就绪。</div>
            </div>
            <span class="text-[11px] tabular-nums"
              :class="failedChecks === 0 && diagnostics.length ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'"
            >{{ successfulChecks }}/{{ diagnostics.length || '—' }}<template v-if="failedChecks"> · 失败 {{ failedChecks }}</template></span>
          </div>

          <div v-if="diagnosticsLoading" class="px-5 py-6 text-[12px] text-slate-400 text-center">诊断中…</div>
          <div v-else-if="diagnosticsError" class="px-5 py-6 text-[12px] text-red-500 text-center">{{ diagnosticsError }}</div>
          <div v-else-if="diagnostics.length === 0" class="px-5 py-6 text-[12px] text-slate-400 text-center">暂无诊断结果</div>
          <div v-else class="divide-y divide-slate-100 dark:divide-[#1e293b]">
            <div v-for="(c, i) in diagnostics" :key="i" class="px-5 py-2.5 flex items-center gap-3 text-[12px]">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="c.ok ? 'bg-emerald-500' : 'bg-red-500'"></span>
              <span class="flex-1 truncate">{{ c.name }}</span>
              <span class="text-[11px] tabular-nums" :class="c.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">{{ c.ms != null ? `${c.ms}ms` : (c.detail || c.error || '') }}</span>
            </div>
          </div>
          <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b]">
            <button class="w-full h-8 rounded-md border border-slate-200 dark:border-[#1e293b] text-[12px] hover:border-blue-300 hover:text-blue-500" @click="loadDiagnostics">重新诊断</button>
          </div>
        </section>
      </div>

      <!-- ─────────── Tab 2：远程开放（开关 + 安全 + 客户端配置） ─────────── -->
      <div v-show="currentTab === 'remote'" class="flex flex-col gap-5 max-w-[960px]">
        <!-- 总开关 -->
        <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] p-5 flex items-center gap-4">
          <div class="min-w-0 flex-1">
            <div class="text-[14px] font-semibold">远程访问</div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
              <template v-if="remoteOn">外部 AI 客户端可通过 HTTPS + API Key 连接。在「API Key」页为每个客户端创建独立凭证并配置权限。</template>
              <template v-else>关闭中。仅本地 / localhost MCP 可用。</template>
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="text-[12px]" :class="remoteOn ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'">{{ remoteOn ? '已启用' : '未启用' }}</span>
            <button
              type="button"
              class="shell-switch"
              :class="[remoteOn ? 'is-on' : '', (savingRemote || remoteLoading) ? 'is-disabled' : '']"
              :disabled="savingRemote || remoteLoading"
              :aria-pressed="remoteOn"
              @click="toggleRemoteEnabled"
            ></button>
          </div>
        </section>

        <!-- 安全 -->
        <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] overflow-hidden">
          <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] text-[13px] font-semibold">安全</div>
          <div class="divide-y divide-slate-100 dark:divide-[#1e293b]">
            <div class="px-5 py-3 flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-[13px]">强制 HTTPS</div>
                <div class="text-[11px] text-slate-400 mt-0.5">建议开启。反代需正确传递 X-Forwarded-Proto=https。</div>
              </div>
              <button type="button" class="shell-switch" :class="[remoteConfig?.requireHttps ? 'is-on' : '', (savingRemote || !remoteOn) ? 'is-disabled' : '']" :disabled="savingRemote || !remoteOn" @click="toggleRequireHttps"></button>
            </div>
            <div class="px-5 py-3 flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-[13px]">记录远程调用</div>
                <div class="text-[11px] text-slate-400 mt-0.5">写入审计日志，包含调用、拒绝原因和参数摘要。</div>
              </div>
              <button type="button" class="shell-switch" :class="[remoteConfig?.auditEnabled ? 'is-on' : '', (savingRemote || !remoteOn) ? 'is-disabled' : '']" :disabled="savingRemote || !remoteOn" @click="toggleAuditEnabled"></button>
            </div>
          </div>
        </section>

        <!-- 客户端接入配置（移到这里） -->
        <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] overflow-hidden">
          <div class="px-5 py-3 border-b border-slate-100 dark:border-[#1e293b]">
            <div class="text-[13px] font-semibold">客户端接入配置</div>
            <div class="text-[11px] text-slate-400 mt-0.5">复制到外部 AI 客户端；不支持远程 HTTP MCP 时使用本地 stdio 桥接。</div>
          </div>
          <div class="px-5 py-4 grid gap-3 grid-cols-1 md:grid-cols-2">
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center justify-between">
                <div class="text-[11px] font-medium text-slate-500 dark:text-slate-400">直接远程连接</div>
                <button class="text-[11px] text-blue-500 hover:text-blue-600" @click="copy(nativeRemoteConfig, '配置已复制')">复制</button>
              </div>
              <pre class="rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-950 text-slate-100 text-[11px] leading-relaxed p-3 overflow-auto max-h-56 font-mono">{{ nativeRemoteConfig }}</pre>
            </div>
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center justify-between">
                <div class="text-[11px] font-medium text-slate-500 dark:text-slate-400">本地 stdio 桥接</div>
                <button class="text-[11px] text-blue-500 hover:text-blue-600" @click="copy(stdioBridgeConfig, '配置已复制')">复制</button>
              </div>
              <pre class="rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-950 text-slate-100 text-[11px] leading-relaxed p-3 overflow-auto max-h-56 font-mono">{{ stdioBridgeConfig }}</pre>
            </div>
          </div>
        </section>

        <div v-if="remoteWarnings.length" class="rounded-2xl border border-amber-200 bg-amber-50/70 dark:border-amber-500/20 dark:bg-amber-500/10 px-4 py-3">
          <div class="text-[12px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
            <AppIcon name="alert" :size="13" />
            提醒
          </div>
          <ul class="mt-1.5 text-[11px] text-amber-700/80 dark:text-amber-200/80 space-y-1 list-disc pl-5">
            <li v-for="w in remoteWarnings" :key="w">{{ w }}</li>
          </ul>
        </div>
      </div>

      <!-- ─────────── Tab 3：API Key（创建 + 列表 + 详情） ─────────── -->
      <!-- 1Shell AI 板块：子 agent 委托 + AI 审批 + 思考配置 -->
      <div v-show="currentTab === 'ai'" class="flex flex-col gap-5 max-w-[880px]">
        <div class="rounded-2xl bg-shell-panel border border-slate-200 dark:border-[#1e293b] dark:bg-[#0f172a] p-5 flex flex-col gap-4">
          <div>
            <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">1Shell AI MCP</div>
            <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">把 1Shell AI 作为能力开放给外部 AI agent：探查委托与命令审批共用 skills 槽位模型（在「接入 → AI 配置」维护密钥与模型）。</div>
          </div>

          <div v-if="aiMcpLoading" class="text-xs text-slate-400">正在加载设置…</div>
          <template v-else>
            <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
              <input v-model="aiMcpDelegationOn" type="checkbox" class="mt-1" />
              <span>
                <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">对外提供 1Shell AI 委托（ask_1shell_ai）</span>
                <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">外部 agent 可把运维/探查/诊断目标委托给 1Shell AI（mode=answer 只读探查，mode=execute 需其自行确认策略）。关闭后 MCP 客户端将看不到 ask_1shell_ai / get_1shell_ai_run 工具。</span>
              </span>
            </label>

            <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
              <input v-model="aiApproverOn" type="checkbox" class="mt-1" />
              <span>
                <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">AI 审批（1Shell AI 替我审批）</span>
                <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">外部 AI agent 经 MCP 执行"需要人工审批"的高危命令且无人在场时，交给 1Shell AI 评估放行或拒绝。灾难红线、命令黑名单与最高危阻断照常硬拦；AI 评估失败一律拒绝；每次决策写入审计。</span>
              </span>
            </label>

            <div class="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324]">
              <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">模型选择（1Shell AI 引擎）</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">委托任务与 AI 审批共用此模型。Provider 与密钥在「接入 → AI 配置」的 Skills 槽位维护。</div>
              <select
                v-model="activeModelKey"
                class="h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 outline-none dark:border-[#1e293b] dark:bg-[#0f1a30] dark:text-slate-200 disabled:opacity-50"
                :disabled="modelSwitching || skillsProviders.length === 0"
                @change="onActiveModelChange(($event.target as HTMLSelectElement).value)"
              >
                <option v-if="skillsProviders.length === 0" value="">（未配置 Provider）</option>
                <optgroup v-for="provider in skillsProviders" :key="provider.id" :label="provider.name || provider.id">
                  <option v-for="opt in providerModelOptions(provider)" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
                </optgroup>
              </select>
              <div class="text-[11px] text-slate-400">AI 审批使用固定的小输出上限（400 token），不随思考配置变化。</div>
            </div>

            <div class="flex items-center justify-between">
              <div class="text-xs text-red-500">{{ aiMcpError }}</div>
              <button
                class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                :disabled="aiMcpSaving"
                @click="saveAiMcpSettings"
              >{{ aiMcpSaving ? '保存中…' : '保存' }}</button>
            </div>
          </template>
        </div>
      </div>

      <div v-show="currentTab === 'api'" class="flex flex-col gap-4">
        <div class="flex items-baseline justify-between">
          <div>
            <div class="text-[14px] font-semibold">API Key</div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">为每个外部客户端创建独立凭证，并限制其能调用的工具、能访问的主机、脚本和路径。</div>
          </div>
          <button class="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] font-medium hover:bg-blue-600 inline-flex items-center gap-1" @click="openCreateModal">
            <AppIcon name="plus" :size="13" />
            新建 API Key
          </button>
        </div>

        <div v-if="newTokenValue" class="rounded-xl border border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/25 dark:bg-emerald-500/10 px-3 py-2.5">
          <div class="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">新 API Key 只显示一次，请立即复制保存</div>
          <div class="mt-1.5 flex items-center gap-2">
            <input readonly :value="newTokenValue" class="flex-1 h-8 px-2 rounded-lg border border-emerald-200 dark:border-emerald-500/25 bg-white dark:bg-[#0b1324] text-[12px] font-mono outline-none" />
            <button class="h-8 px-3 rounded-lg bg-emerald-500 text-white text-[12px] font-medium hover:bg-emerald-600" @click="copy(newTokenValue, 'API Key 已复制')">复制</button>
            <button class="h-8 px-2 rounded-lg border border-emerald-200 dark:border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-[12px]" @click="newTokenValue = ''">关闭</button>
          </div>
        </div>

        <div v-if="activeRemoteTokens.length === 0" class="rounded-2xl border border-dashed border-slate-200 dark:border-[#1e293b] py-12 text-center text-[12px] text-slate-400">
          暂无 API Key。点击右上角「新建 API Key」开始。
        </div>
        <div v-else class="grid gap-4 grid-cols-1 lg:grid-cols-[300px_1fr]">
          <!-- 左：列表 -->
          <div class="rounded-xl border border-slate-200 dark:border-[#1e293b] divide-y divide-slate-100 dark:divide-[#1e293b] overflow-hidden self-start">
            <button
              v-for="token in activeRemoteTokens"
              :key="token.id"
              type="button"
              class="w-full px-3 py-2.5 text-left flex items-center gap-2 text-[12px] transition-colors"
              :class="selectedRemoteToken?.id === token.id ? 'bg-blue-50/70 dark:bg-blue-500/10' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'"
              @click="expandedTokenId = token.id"
            >
              <div class="flex-1 min-w-0">
                <div class="font-medium truncate">{{ formatApiKeyName(token) }}</div>
                <div class="text-[11px] text-slate-400 font-mono truncate mt-0.5">{{ token.prefix }}…</div>
              </div>
              <span class="text-[10px] px-1.5 py-0.5 rounded shrink-0 tabular-nums"
                :class="tokenToolCount(token) > 0 ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300' : 'bg-slate-100 text-slate-500 dark:bg-[#1e293b] dark:text-slate-400'"
              >{{ tokenToolCount(token) }}/{{ remoteTools.length }}</span>
            </button>
          </div>

          <!-- 右：详情 -->
          <div v-if="selectedRemoteToken" class="rounded-xl border border-slate-200 dark:border-[#1e293b] p-4 flex flex-col gap-4 min-w-0 bg-white dark:bg-[#111827]">
            <div class="flex items-start justify-between gap-3 pb-3 border-b border-slate-100 dark:border-[#1e293b]">
              <div class="min-w-0">
                <div class="text-[13px] font-semibold truncate">{{ formatApiKeyName(selectedRemoteToken) }}</div>
                <div class="mt-0.5 text-[11px] text-slate-400 font-mono truncate">
                  {{ selectedRemoteToken.prefix }}… · 创建 {{ formatDate(selectedRemoteToken.createdAt) }} · 最近使用 {{ formatDate(selectedRemoteToken.lastUsedAt) }}
                </div>
              </div>
              <button v-if="!selectedRemoteToken.revokedAt" class="text-[11px] text-red-500 hover:text-red-600 disabled:opacity-50 shrink-0" :disabled="revokingTokenId === selectedRemoteToken.id" @click="revokeRemoteToken(selectedRemoteToken.id)">
                删除
              </button>
            </div>

            <!-- 工具：本 Key 自己控制 -->
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div class="text-[12px] font-medium">允许调用的工具</div>
                  <div class="text-[11px] text-slate-400 mt-0.5">已选 {{ tokenToolCount(selectedRemoteToken) }} / {{ remoteTools.length }}。</div>
                </div>
                <div class="flex items-center gap-1.5">
                  <input v-model="tokenToolFilter" placeholder="过滤..." class="h-7 px-2 rounded-md border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] outline-none focus:border-blue-400 w-28" />
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" :disabled="!!selectedRemoteToken.revokedAt" @click="bulkTokenTools(selectedRemoteToken, 'all')">全开</button>
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" :disabled="!!selectedRemoteToken.revokedAt" @click="bulkTokenTools(selectedRemoteToken, 'none')">全关</button>
                </div>
              </div>
              <div v-if="filteredTokenTools.length === 0" class="text-[11px] text-slate-400 py-3 text-center rounded-lg border border-dashed border-slate-200 dark:border-[#1e293b]">
                没有匹配的工具。
              </div>
              <div v-else class="rounded-lg border border-slate-200 dark:border-[#1e293b] divide-y divide-slate-100 dark:divide-[#1e293b] overflow-hidden max-h-80 overflow-y-auto">
                <div v-for="tool in filteredTokenTools" :key="`${selectedRemoteToken.id}:${tool.name}`" class="px-3 py-2 flex items-center gap-3 text-[12px]">
                  <div class="flex-1 min-w-0">
                    <span class="font-mono text-[12px]">{{ tool.name }}</span>
                    <div v-if="tool.description" class="text-[11px] text-slate-400 truncate mt-0.5">{{ tool.description }}</div>
                  </div>
                  <button
                    type="button"
                    class="shell-switch"
                    :class="[(selectedRemoteToken.allowedTools || []).includes(tool.name) ? 'is-on' : '', selectedRemoteToken.revokedAt ? 'is-disabled' : '']"
                    :disabled="!!selectedRemoteToken.revokedAt"
                    @click="updateTokenTools(selectedRemoteToken, tool.name)"
                  ></button>
                </div>
              </div>
            </div>

            <!-- 主机 -->
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="text-[12px] font-medium">允许访问的主机</div>
                  <div class="text-[11px] text-slate-400 mt-0.5">每行一个主机 ID，留空表示不限制。</div>
                </div>
                <div class="flex gap-1 shrink-0">
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenHosts(selectedRemoteToken, 'all')">全部</button>
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenHosts(selectedRemoteToken, 'none')">不限</button>
                  <button class="text-[11px] px-2.5 h-7 rounded-md bg-blue-500 text-white hover:bg-blue-600" type="button" @click="saveTokenHosts(selectedRemoteToken)">保存</button>
                </div>
              </div>
              <textarea v-model="tokenHostDrafts[selectedRemoteToken.id]" rows="2" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] font-mono outline-none focus:border-blue-400" placeholder="local&#10;vps-test"></textarea>
              <div v-if="hosts.length" class="flex flex-wrap gap-1">
                <button
                  v-for="host in hosts"
                  :key="`${selectedRemoteToken.id}:host:${host.id}`"
                  type="button"
                  class="text-[11px] px-2 h-6 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300"
                  @click="tokenHostDrafts[selectedRemoteToken.id] = [...new Set([...(parseLines(tokenHostDrafts[selectedRemoteToken.id] || '')), host.id])].join('\n')"
                >{{ host.name || host.id }}</button>
              </div>
            </div>

            <!-- 脚本 -->
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="text-[12px] font-medium">允许操作的脚本</div>
                  <div class="text-[11px] text-slate-400 mt-0.5">限制 run_script / get_script / save_script，留空表示不限制。</div>
                </div>
                <div class="flex gap-1 shrink-0">
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenScripts(selectedRemoteToken, 'all')">全部</button>
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenScripts(selectedRemoteToken, 'none')">不限</button>
                  <button class="text-[11px] px-2.5 h-7 rounded-md bg-blue-500 text-white hover:bg-blue-600" type="button" @click="saveTokenScripts(selectedRemoteToken)">保存</button>
                </div>
              </div>
              <textarea v-model="tokenScriptDrafts[selectedRemoteToken.id]" rows="2" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] font-mono outline-none focus:border-blue-400" placeholder="safe-nginx-status&#10;backup-report"></textarea>
              <div v-if="scripts.length" class="flex flex-wrap gap-1 max-h-20 overflow-auto">
                <button
                  v-for="script in scripts"
                  :key="`${selectedRemoteToken.id}:script:${script.id}`"
                  type="button"
                  class="text-[11px] px-2 h-6 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300"
                  @click="tokenScriptDrafts[selectedRemoteToken.id] = [...new Set([...(parseLines(tokenScriptDrafts[selectedRemoteToken.id] || '')), script.id])].join('\n')"
                >{{ script.name || script.id }}</button>
              </div>
            </div>

            <!-- 路径 -->
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="text-[12px] font-medium">允许访问的路径</div>
                  <div class="text-[11px] text-slate-400 mt-0.5">限制文件类工具可访问的目录，支持 * 通配。</div>
                </div>
                <div class="flex gap-1 shrink-0">
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenPaths(selectedRemoteToken, 'logs')">日志</button>
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenPaths(selectedRemoteToken, 'home')">家目录</button>
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" type="button" @click="fillTokenPaths(selectedRemoteToken, 'none')">不限</button>
                  <button class="text-[11px] px-2.5 h-7 rounded-md bg-blue-500 text-white hover:bg-blue-600" type="button" @click="saveTokenPaths(selectedRemoteToken)">保存</button>
                </div>
              </div>
              <textarea v-model="tokenPathDrafts[selectedRemoteToken.id]" rows="3" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] font-mono outline-none focus:border-blue-400" placeholder="/var/log/nginx&#10;/opt/myapp/logs"></textarea>
              <div class="text-[11px] text-slate-400">作用于 list_remote_dir / read_remote_file / write_remote_file / upload_file / download_file。</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ─────────── Tab 4：调用日志 ─────────── -->
      <div v-show="currentTab === 'logs'" class="flex flex-col gap-4 min-w-0">
        <!-- 工具条：作用域 + 结果 + 关键字 + 刷新 -->
        <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] p-3 flex items-center gap-2 flex-wrap">
          <div class="inline-flex rounded-lg border border-slate-200 dark:border-[#1e293b] overflow-hidden text-[12px]">
            <button class="px-3 h-7 transition-colors" :class="logScope === 'all' ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'" @click="logScope = 'all'">全部</button>
            <button class="px-3 h-7 border-l border-slate-200 dark:border-[#1e293b] transition-colors" :class="logScope === 'mcp' ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'" @click="logScope = 'mcp'">本地</button>
            <button class="px-3 h-7 border-l border-slate-200 dark:border-[#1e293b] transition-colors" :class="logScope === 'remote_mcp' ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'" @click="logScope = 'remote_mcp'">远程</button>
          </div>
          <div class="inline-flex rounded-lg border border-slate-200 dark:border-[#1e293b] overflow-hidden text-[12px]">
            <button class="px-3 h-7 transition-colors" :class="logResult === 'all' ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'" @click="logResult = 'all'">所有</button>
            <button class="px-3 h-7 border-l border-slate-200 dark:border-[#1e293b] transition-colors" :class="logResult === 'ok' ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'" @click="logResult = 'ok'">成功</button>
            <button class="px-3 h-7 border-l border-slate-200 dark:border-[#1e293b] transition-colors" :class="logResult === 'denied' ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-[#0b1324]'" @click="logResult = 'denied'">拒绝/失败</button>
          </div>
          <input
            v-model="logKeyword"
            placeholder="过滤工具名 / IP / 错误..."
            class="h-7 px-2 rounded-md border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[12px] outline-none focus:border-blue-400 flex-1 min-w-[180px]"
            @keyup.enter="loadLogs"
          />
          <button class="h-7 px-3 rounded-md border border-slate-200 dark:border-[#1e293b] text-[12px] hover:border-blue-300 hover:text-blue-500 inline-flex items-center gap-1.5" @click="loadLogs">
            <AppIcon name="history" :size="12" />
            刷新
          </button>
          <span class="text-[11px] text-slate-400 tabular-nums ml-auto">显示 {{ logRows.length }} 条<template v-if="logTotal && logTotal > logRows.length"> · 共 {{ logTotal }}</template></span>
        </section>

        <!-- 日志表 -->
        <section class="rounded-2xl border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#111827] overflow-hidden">
          <div v-if="logLoading" class="px-5 py-10 text-center text-[12px] text-slate-400">加载中…</div>
          <div v-else-if="logError" class="px-5 py-10 text-center text-[12px] text-red-500">{{ logError }}</div>
          <div v-else-if="logRows.length === 0" class="px-5 py-10 text-center text-[12px] text-slate-400">没有匹配的调用记录。</div>
          <div v-else class="overflow-auto">
            <table class="w-full text-[12px]">
              <thead class="bg-slate-50/70 dark:bg-[#0b1324]/60 text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                <tr>
                  <th class="font-medium text-left px-4 py-2 w-[150px]">时间</th>
                  <th class="font-medium text-left py-2 w-[60px]">来源</th>
                  <th class="font-medium text-left py-2 w-[70px]">结果</th>
                  <th class="font-medium text-left py-2 w-[180px]">操作</th>
                  <th class="font-medium text-left py-2">客户端 / 详情</th>
                  <th class="font-medium text-right px-4 py-2 w-[70px]">耗时</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-[#1e293b]">
                <tr v-for="row in logRows" :key="row.id" class="hover:bg-slate-50/60 dark:hover:bg-[#0b1324]/60">
                  <td class="px-4 py-2 font-mono text-[11px] text-slate-500 whitespace-nowrap">{{ formatDate(row.timestamp) }}</td>
                  <td class="py-2">
                    <span class="text-[10px] px-1.5 py-0.5 rounded"
                      :class="row.source === 'remote_mcp' ? 'bg-cyan-50 text-cyan-600 dark:bg-cyan-500/10 dark:text-cyan-300' : 'bg-slate-100 text-slate-500 dark:bg-[#1e293b] dark:text-slate-300'"
                    >{{ logSourceLabel(row.source) }}</span>
                  </td>
                  <td class="py-2">
                    <span class="text-[10px] px-1.5 py-0.5 rounded" :class="logResultLabel(row).cls">{{ logResultLabel(row).label }}</span>
                  </td>
                  <td class="py-2 font-mono text-[11px] truncate max-w-0">{{ row.action }}</td>
                  <td class="py-2 text-[11px] truncate max-w-0">
                    <div class="flex flex-col">
                      <span v-if="row.client_ip || row.host_name" class="text-slate-500 dark:text-slate-400 truncate">
                        <template v-if="row.client_ip">{{ row.client_ip }}</template>
                        <template v-if="row.host_name"> · {{ row.host_name }}</template>
                      </span>
                      <span class="text-slate-400 truncate">{{ shortDetails(row) || '—' }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-[11px] text-slate-500 tabular-nums">{{ row.duration_ms != null ? `${row.duration_ms}ms` : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>

    <!-- 创建 API Key 模态：在这里选要暴露的工具 -->
    <Teleport to="body">
      <div v-if="showCreateModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" @click.self="showCreateModal = false">
        <div class="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#0f172a] border border-slate-200 dark:border-[#1e293b] shadow-xl flex flex-col max-h-[80vh] overflow-hidden">
          <div class="px-5 py-4 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between">
            <div>
              <div class="text-[14px] font-semibold">新建 API Key</div>
              <div class="text-[11px] text-slate-400 mt-0.5">先选名称和要开放的工具，创建后还可在详情页继续调整主机、脚本、路径。</div>
            </div>
            <button class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" @click="showCreateModal = false">
              <AppIcon name="close" :size="16" />
            </button>
          </div>
          <div class="px-5 py-4 flex flex-col gap-4 overflow-auto">
            <div class="flex flex-col gap-1.5">
              <label class="text-[12px] font-medium">名称</label>
              <input v-model="newTokenName" placeholder="如：Cursor MacBook、ChatGPT VPS" class="h-8 px-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[12px] outline-none focus:border-blue-400" />
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <div class="text-[12px] font-medium">允许调用的工具</div>
                  <div class="text-[11px] text-slate-400 mt-0.5">已选 {{ newTokenSelectedTools.size }} / {{ remoteTools.length }}。</div>
                </div>
                <div class="flex items-center gap-1.5">
                  <input v-model="newTokenToolFilter" placeholder="过滤..." class="h-7 px-2 rounded-md border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-[11px] outline-none focus:border-blue-400 w-28" />
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" @click="setAllNewTokenTools('all')">全选</button>
                  <button class="text-[11px] px-2 h-7 rounded-md border border-slate-200 dark:border-[#1e293b] hover:border-blue-300" @click="setAllNewTokenTools('none')">全不选</button>
                </div>
              </div>
              <div class="rounded-lg border border-slate-200 dark:border-[#1e293b] divide-y divide-slate-100 dark:divide-[#1e293b] overflow-y-auto max-h-72">
                <div v-for="tool in filteredNewTokenTools" :key="`new:${tool.name}`" class="px-3 py-2 flex items-center gap-3 text-[12px]">
                  <div class="flex-1 min-w-0">
                    <span class="font-mono text-[12px]">{{ tool.name }}</span>
                    <div v-if="tool.description" class="text-[11px] text-slate-400 truncate mt-0.5">{{ tool.description }}</div>
                  </div>
                  <button type="button" class="shell-switch" :class="newTokenSelectedTools.has(tool.name) ? 'is-on' : ''" @click="toggleNewTokenTool(tool.name)"></button>
                </div>
                <div v-if="filteredNewTokenTools.length === 0" class="px-3 py-6 text-center text-[11px] text-slate-400">没有匹配的工具。</div>
              </div>
            </div>
          </div>
          <div class="px-5 py-3 border-t border-slate-100 dark:border-[#1e293b] flex items-center justify-end gap-2">
            <button class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-[12px] hover:border-blue-300" @click="showCreateModal = false">取消</button>
            <button class="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] font-medium hover:bg-blue-600 disabled:opacity-50" :disabled="creatingToken" @click="createRemoteToken">
              {{ creatingToken ? '创建中…' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
