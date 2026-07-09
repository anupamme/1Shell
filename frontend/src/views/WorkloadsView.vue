<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';

interface WorkloadStats {
  cpuPercentText?: string | null;
  memoryUsage?: string | null;
  netIO?: string | null;
}

interface WorkloadItem {
  id: string;
  nativeId?: string | null;
  shortId?: string | null;
  kind: 'container' | 'service' | 'port' | string;
  source: 'docker' | 'compose' | 'systemd' | 'windows-service' | 'tunnel' | 'process' | string;
  sourceLabel?: string | null;
  name: string;
  displayName?: string | null;
  hostId: string;
  hostName: string;
  imageName?: string | null;
  imageId?: string | null;
  state?: string | null;
  status?: string | null;
  health?: string | null;
  running?: boolean;
  failed?: boolean;
  entrypointsText?: string[];
  primaryEndpoint?: string | null;
  ipAddresses?: string[];
  relatedResource?: string | null;
  composeProject?: string | null;
  composeService?: string | null;
  composeWorkingDir?: string | null;
  processName?: string | null;
  pid?: string | null;
  user?: string | null;
  port?: string | null;
  command?: string | null;
  serviceName?: string | null;
  cwd?: string | null;
  primary?: boolean;
  projectCandidate?: boolean;
  infrastructure?: boolean;
  stats?: WorkloadStats | null;
  evidence?: string[];
}

interface HostWorkloadSummary {
  hostId: string;
  hostName: string;
  ok: boolean;
  collectedAt?: string | null;
  platformSupported?: boolean;
  dockerInstalled?: boolean | null;
  dockerReachable?: boolean;
  dockerError?: string | null;
  workloadCount: number;
  runningWorkloadCount: number;
  unhealthyWorkloadCount: number;
  warnings?: string[];
  error?: string | null;
  loading?: boolean;
  cached?: boolean;
  sortIndex?: number;
  items?: WorkloadItem[];
}

interface WorkloadsSummary {
  collectedAt: string;
  hostCount: number;
  failedHostCount: number;
  pendingHostCount: number;
  unhealthyWorkloadCount: number;
  hosts: HostWorkloadSummary[];
  items: WorkloadItem[];
}

interface HostInfo {
  id: string;
  name?: string | null;
  preference?: {
    archived?: boolean | null;
  } | null;
}

interface HostsListResponse {
  hosts?: HostInfo[];
}

interface HostWorkloadDetailResponse {
  hostId: string;
  hostName: string;
  ok: boolean;
  collectedAt?: string | null;
  platformSupported?: boolean;
  dockerInstalled?: boolean | null;
  dockerReachable?: boolean;
  dockerError?: string | null;
  cached?: boolean;
  items?: WorkloadItem[];
  warnings?: string[];
  error?: string | null;
}

type SourceFilter = 'all' | 'docker' | 'compose' | 'systemd' | 'windows-service' | 'tunnel' | 'process';
type KindFilter = 'primary' | 'container' | 'port';
type WorkloadAction = 'start' | 'stop' | 'restart' | 'delete' | 'recreate';

interface WorkloadActionResponse {
  ok: boolean;
  action?: WorkloadAction;
  error?: string | null;
  result?: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
}

const { requestJson } = useApiClient();
const { confirm } = useConfirm();
const notify = useNotifyStore();

const loading = ref(false);
const error = ref('');
const summary = ref<WorkloadsSummary | null>(null);
const hostFilter = ref('');
const kindFilter = ref<KindFilter>('primary');
const unhealthyOnly = ref(false);
const sourceFilter = ref<SourceFilter>('all');
const search = ref('');
const expandedEndpointRows = ref<Set<string>>(new Set());
const actingWorkloadKeys = ref<Set<string>>(new Set());
const refreshingHostIds = ref<Set<string>>(new Set());
const COMPACT_ENDPOINT_LIMIT = 2;
const WORKLOAD_ACTIONS: WorkloadAction[] = ['start', 'stop', 'restart', 'recreate', 'delete'];
const HOST_LOAD_CONCURRENCY = 4;
let loadSequence = 0;
let activeAbortController: AbortController | null = null;

const kindOptions: { value: KindFilter; label: string }[] = [
  { value: 'primary', label: '项目/服务' },
  { value: 'container', label: '容器' },
  { value: 'port', label: '端口/进程' },
];

const SOURCE_FILTER_LABELS: Record<Exclude<SourceFilter, 'all'>, string> = {
  compose: 'Compose',
  docker: 'Docker',
  systemd: 'systemd',
  'windows-service': 'Windows Service',
  tunnel: '隧道',
  process: '进程',
};

const hostRows = computed(() => (summary.value?.hosts || []).slice().sort((a, b) => {
  if ((a.sortIndex ?? 0) !== (b.sortIndex ?? 0)) return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
  return a.hostName.localeCompare(b.hostName, 'zh-Hans-CN');
}));

const hostOptions = computed(() => hostRows.value.map((host) => ({ id: host.hostId, name: host.hostName })));

const filteredItems = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return (summary.value?.items || []).filter((item) => {
    if (item.hostId !== hostFilter.value) return false;
    if (kindFilter.value === 'primary' && !isPrimaryItem(item)) return false;
    if (kindFilter.value === 'container' && item.kind !== 'container') return false;
    if (kindFilter.value === 'port' && item.kind === 'container') return false;
    if (unhealthyOnly.value && !item.failed && item.health !== 'unhealthy') return false;
    if (sourceFilter.value !== 'all' && item.source !== sourceFilter.value) return false;
    if (!kw) return true;
    return [
      item.name,
      item.displayName,
      item.shortId,
      item.hostName,
      item.imageName,
      item.state,
      item.status,
      item.health,
      item.relatedResource,
      item.composeProject,
      item.composeService,
      item.processName,
      item.serviceName,
      item.cwd,
      item.sourceLabel,
      item.command,
      ...(item.entrypointsText || []),
      ...(item.ipAddresses || []),
    ].filter(Boolean).join(' ').toLowerCase().includes(kw);
  }).sort(sortVisibleWorkloads);
});

const selectedHostSummary = computed(() => hostRows.value.find((host) => host.hostId === hostFilter.value) || null);

const failedHosts = computed(() => {
  const host = selectedHostSummary.value;
  return host && !host.loading && !host.ok ? [host] : [];
});

const visibleProblemHosts = computed(() => {
  const host = selectedHostSummary.value;
  return host && hostIssueText(host) ? [host] : [];
});

const headerSummaryText = computed(() => {
  if (!summary.value) return '';
  return `${summary.value.hostCount} 台主机 · ${filteredItems.value.length} 个运行项`;
});

const activeSourceLabel = computed(() => {
  const value = sourceFilter.value;
  return value === 'all' ? '' : SOURCE_FILTER_LABELS[value];
});

const emptyTitle = computed(() => {
  if (kindFilter.value === 'container') return '没有可展示的容器';
  if (kindFilter.value === 'port') return '没有可展示的端口/进程';
  return '没有可展示的项目/服务';
});

watch(kindFilter, (value) => {
  if (value === 'container' && ['systemd', 'windows-service', 'tunnel', 'process'].includes(sourceFilter.value)) {
    sourceFilter.value = 'all';
  }
  if (value === 'port' && ['docker', 'compose'].includes(sourceFilter.value)) {
    sourceFilter.value = 'all';
  }
});

function createEmptyHostSummary(host: HostInfo, sortIndex: number, collectedAt: string): HostWorkloadSummary {
  return {
    hostId: host.id,
    hostName: host.name || host.id,
    ok: false,
    collectedAt,
    platformSupported: true,
    dockerInstalled: null,
    dockerReachable: false,
    dockerError: null,
    workloadCount: 0,
    runningWorkloadCount: 0,
    unhealthyWorkloadCount: 0,
    warnings: [],
    error: null,
    loading: false,
    sortIndex,
    items: [],
  };
}

function createHostSkeleton(host: HostInfo, sortIndex: number, collectedAt: string): HostWorkloadSummary {
  return {
    ...createEmptyHostSummary(host, sortIndex, collectedAt),
    loading: true,
  };
}

function createHostSummary(result: HostWorkloadDetailResponse, host: HostInfo, sortIndex: number, collectedAt: string): HostWorkloadSummary {
  const items = Array.isArray(result.items) ? result.items : [];
  return {
    hostId: result.hostId || host.id,
    hostName: result.hostName || host.name || host.id,
    ok: Boolean(result.ok),
    collectedAt: result.collectedAt || collectedAt,
    platformSupported: result.platformSupported !== false,
    dockerInstalled: result.dockerInstalled ?? null,
    dockerReachable: Boolean(result.dockerReachable),
    dockerError: result.dockerError || null,
    workloadCount: items.length,
    runningWorkloadCount: items.filter((item) => item.running).length,
    unhealthyWorkloadCount: items.filter((item) => item.health === 'unhealthy' || item.failed).length,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
    error: result.error || null,
    loading: false,
    cached: result.cached === true,
    sortIndex,
    items,
  };
}

function createFailedHostSummary(host: HostInfo, sortIndex: number, collectedAt: string, error: Error): HostWorkloadSummary {
  return {
    ...createEmptyHostSummary(host, sortIndex, collectedAt),
    error: error.message || 'workload discovery failed',
  };
}

function buildWorkloadsSummary(hosts: HostWorkloadSummary[], collectedAt: string): WorkloadsSummary {
  const completedHosts = hosts.filter((host) => !host.loading);
  return {
    collectedAt,
    hostCount: hosts.length,
    failedHostCount: completedHosts.filter((host) => !host.ok).length,
    pendingHostCount: hosts.length - completedHosts.length,
    unhealthyWorkloadCount: hosts.reduce((total, host) => total + (host.unhealthyWorkloadCount || 0), 0),
    hosts: hosts.slice(),
    items: hosts.flatMap((host) => host.items || []),
  };
}

function replaceHostSummary(nextHost: HostWorkloadSummary, collectedAt: string): void {
  const hosts = summary.value?.hosts ? summary.value.hosts.slice() : [];
  const index = hosts.findIndex((host) => host.hostId === nextHost.hostId);
  if (index === -1) hosts.push(nextHost);
  else hosts[index] = nextHost;
  summary.value = buildWorkloadsSummary(hosts, collectedAt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError');
}

function workloadActionKey(item: WorkloadItem, action: WorkloadAction): string {
  return `${item.hostId}:${item.id}:${action}`;
}

function isWorkloadActionBusy(item: WorkloadItem, action?: WorkloadAction): boolean {
  if (action) return actingWorkloadKeys.value.has(workloadActionKey(item, action));
  return WORKLOAD_ACTIONS.some((value) => actingWorkloadKeys.value.has(workloadActionKey(item, value)));
}

function isHostRefreshing(hostId: string): boolean {
  return refreshingHostIds.value.has(hostId);
}

function setHostRefreshing(hostId: string, refreshing: boolean): void {
  const next = new Set(refreshingHostIds.value);
  if (refreshing) next.add(hostId);
  else next.delete(hostId);
  refreshingHostIds.value = next;
}

function supportedWorkloadActions(item: WorkloadItem): WorkloadAction[] {
  if (!item) return [];
  const isRunning = item.running === true || String(item.state || '').toLowerCase() === 'running' || String(item.state || '').toLowerCase() === 'listening';
  if (item.kind === 'container' && item.source === 'compose') {
    return isRunning ? ['stop', 'restart', 'recreate', 'delete'] : ['start', 'recreate', 'delete'];
  }
  if (item.kind === 'container' && item.source === 'docker') {
    return isRunning ? ['stop', 'restart', 'delete'] : ['start', 'delete'];
  }
  if ((item.source === 'systemd' || item.source === 'windows-service') && item.serviceName) {
    return isRunning ? ['stop', 'restart'] : ['start'];
  }
  return [];
}

function workloadActionLabel(action: WorkloadAction): string {
  if (action === 'start') return '启动';
  if (action === 'stop') return '停止';
  if (action === 'restart') return '重启';
  if (action === 'recreate') return '重建';
  return '删除';
}

function workloadActionClass(action: WorkloadAction): string {
  if (action === 'delete') return 'border-slate-200 bg-white text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400 dark:hover:border-rose-400/30 dark:hover:bg-rose-400/10 dark:hover:text-rose-200';
  return 'border-slate-200 bg-white text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-cyan-400/30 dark:hover:bg-cyan-400/10 dark:hover:text-cyan-200';
}

function workloadActionTitle(item: WorkloadItem, action: WorkloadAction): string {
  return `${workloadActionLabel(action)} ${workloadTitle(item)}`;
}

function hostWorkloadsUrl(hostId: string, forceRefresh = false): string {
  const suffix = forceRefresh ? '?refresh=1' : '';
  return `/api/panel/hosts/${encodeURIComponent(hostId)}/workloads${suffix}`;
}

async function refreshHostWorkload(hostId: string, options: { notifySuccess?: boolean; forceRefresh?: boolean } = {}): Promise<void> {
  const collectedAt = summary.value?.collectedAt || new Date().toISOString();
  const currentHost = summary.value?.hosts?.find((host) => host.hostId === hostId);
  if (!currentHost) {
    await loadWorkloads({ forceRefresh: options.forceRefresh === true });
    return;
  }
  if (isHostRefreshing(hostId)) return;
  setHostRefreshing(hostId, true);
  replaceHostSummary({
    ...currentHost,
    loading: true,
    error: null,
  }, collectedAt);
  try {
    const result = await requestJson<HostWorkloadDetailResponse>(hostWorkloadsUrl(hostId, options.forceRefresh === true));
    replaceHostSummary(createHostSummary(result, {
      id: currentHost.hostId,
      name: currentHost.hostName,
    }, currentHost.sortIndex ?? 0, collectedAt), collectedAt);
    if (options.notifySuccess) notify.success(`${currentHost.hostName} 已刷新`);
  } catch (err) {
    if (isAbortError(err)) return;
    replaceHostSummary({
      ...currentHost,
      ok: false,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    }, collectedAt);
    throw err;
  } finally {
    setHostRefreshing(hostId, false);
  }
}

async function refreshSelectedHost(): Promise<void> {
  const host = selectedHostSummary.value;
  if (!host || isHostRefreshing(host.hostId)) return;
  try {
    await refreshHostWorkload(host.hostId, { notifySuccess: true, forceRefresh: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify.error(message || `${host.hostName} 刷新失败`);
  }
}

async function refreshHostFromList(host: HostWorkloadSummary): Promise<void> {
  if (!host || isHostRefreshing(host.hostId)) return;
  try {
    await refreshHostWorkload(host.hostId, { notifySuccess: true, forceRefresh: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify.error(message || `${host.hostName} 刷新失败`);
  }
}

async function runWorkloadAction(item: WorkloadItem, action: WorkloadAction): Promise<void> {
  if (isWorkloadActionBusy(item, action)) return;
  const actionLabel = workloadActionLabel(action);
  const ok = await confirm({
    title: `${actionLabel}运行项`,
    message: `确定要在主机“${item.hostName}”上${actionLabel}${workloadTitle(item)}吗？`,
    okText: actionLabel,
    okClass: action === 'stop' || action === 'delete'
      ? 'bg-rose-600 hover:bg-rose-700 text-white'
      : action === 'restart' || action === 'recreate'
        ? 'bg-amber-600 hover:bg-amber-700 text-white'
        : 'bg-emerald-600 hover:bg-emerald-700 text-white',
  });
  if (!ok) return;

  const key = workloadActionKey(item, action);
  const nextBusy = new Set(actingWorkloadKeys.value);
  nextBusy.add(key);
  actingWorkloadKeys.value = nextBusy;
  try {
    const response = await requestJson<WorkloadActionResponse>(`/api/panel/hosts/${encodeURIComponent(item.hostId)}/workloads/${encodeURIComponent(item.id)}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        workload: {
          id: item.id,
          hostId: item.hostId,
          kind: item.kind,
          source: item.source,
          name: item.name,
          displayName: item.displayName,
          nativeId: item.nativeId,
          shortId: item.shortId,
          serviceName: item.serviceName,
          processName: item.processName,
          composeProject: item.composeProject,
          composeService: item.composeService,
          composeWorkingDir: item.composeWorkingDir,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(response.error || `${actionLabel}失败`);
    }
    notify.success(`${actionLabel}已提交`);
    try {
      await refreshHostWorkload(item.hostId, { forceRefresh: true });
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      notify.error(`操作已执行，但刷新主机状态失败：${message}`, 6000);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify.error(message || `${actionLabel}失败`);
  } finally {
    const next = new Set(actingWorkloadKeys.value);
    next.delete(key);
    actingWorkloadKeys.value = next;
  }
}

async function mapLimit<T>(items: T[], limit: number, iteratee: (item: T, index: number) => Promise<void>): Promise<void> {
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await iteratee(items[index], index);
    }
  }));
}

async function loadWorkloads(options: { forceRefresh?: boolean } = {}): Promise<void> {
  const token = ++loadSequence;
  activeAbortController?.abort();
  const abortController = new AbortController();
  activeAbortController = abortController;
  loading.value = true;
  error.value = '';
  try {
    const response = await requestJson<HostsListResponse>('/api/hosts', { signal: abortController.signal });
    if (token !== loadSequence) return;
    const hosts = (Array.isArray(response.hosts) ? response.hosts : [])
      .filter((host) => host && host.id && !host.preference?.archived);
    const collectedAt = new Date().toISOString();
    const hostSummaries = hosts.map((host, index) => createHostSkeleton(host, index, collectedAt));
    summary.value = buildWorkloadsSummary(hostSummaries, collectedAt);

    if (!hosts.some((host) => host.id === hostFilter.value)) {
      hostFilter.value = hosts[0]?.id || '';
    }

    if (!hosts.length) return;

    await mapLimit(hosts, HOST_LOAD_CONCURRENCY, async (host, index) => {
      if (token !== loadSequence) return;
      try {
        const result = await requestJson<HostWorkloadDetailResponse>(hostWorkloadsUrl(host.id, options.forceRefresh === true), {
          signal: abortController.signal,
        });
        if (token !== loadSequence) return;
        replaceHostSummary(createHostSummary(result, host, index, collectedAt), collectedAt);
      } catch (err) {
        if (token !== loadSequence || isAbortError(err)) return;
        replaceHostSummary(createFailedHostSummary(host, index, collectedAt, err as Error), collectedAt);
      } finally {
        if (token === loadSequence) {
          summary.value = buildWorkloadsSummary(summary.value?.hosts || hostSummaries, collectedAt);
        }
      }
    });

    if (token === loadSequence) {
      summary.value = buildWorkloadsSummary(summary.value?.hosts || hostSummaries, collectedAt);
    }
  } catch (err) {
    if (token !== loadSequence || isAbortError(err)) return;
    const message = (err as Error).message || '加载运行项失败';
    error.value = message;
    notify.error(message);
  } finally {
    if (token === loadSequence) {
      loading.value = false;
    }
  }
}

async function refreshAllWorkloads(): Promise<void> {
  await loadWorkloads({ forceRefresh: true });
}

function selectHost(hostId: string): void {
  hostFilter.value = hostId;
}

function selectFirstFailedHost(): void {
  const host = hostRows.value.find((item) => !item.loading && !item.ok);
  if (host) selectHost(host.hostId);
}

function showUnhealthy(): void {
  unhealthyOnly.value = true;
  const current = selectedHostSummary.value;
  if (current && current.unhealthyWorkloadCount > 0) return;
  const host = hostRows.value.find((item) => item.unhealthyWorkloadCount > 0);
  if (host) selectHost(host.hostId);
}

function hostStateText(host: HostWorkloadSummary): string {
  if (host.loading) return '采集中';
  if (!host.ok) return '采集失败';
  if (host.platformSupported === false) return 'N/A';
  if (host.unhealthyWorkloadCount > 0) return `${host.unhealthyWorkloadCount} 异常`;
  return `${host.runningWorkloadCount}/${host.workloadCount}`;
}

function hostStateClass(host: HostWorkloadSummary): string {
  if (host.loading) return 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300';
  if (!host.ok) return 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200';
  if (host.platformSupported === false) return 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300';
  if (host.unhealthyWorkloadCount > 0) return 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200';
  return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200';
}

function hostIssueText(host: HostWorkloadSummary): string {
  if (host.loading || !host.ok) return '';
  if (host.platformSupported === false) return '该平台暂未采集运行项';
  if (host.workloadCount === 0) return '未发现容器、系统服务或监听端口';
  if (host.dockerInstalled && !host.dockerReachable) return host.dockerError || 'Docker 不可用，已继续采集服务、端口和进程';
  return '';
}

function isPrimaryItem(item: WorkloadItem): boolean {
  if (item.primary === true) return true;
  return item.kind === 'container';
}

function sortVisibleWorkloads(a: WorkloadItem, b: WorkloadItem): number {
  if (Boolean(a.failed) !== Boolean(b.failed)) return a.failed ? -1 : 1;
  const primaryDelta = workloadPrimaryRank(a) - workloadPrimaryRank(b);
  if (primaryDelta) return primaryDelta;
  const kindDelta = workloadKindRank(a) - workloadKindRank(b);
  if (kindDelta) return kindDelta;
  if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
  const noiseDelta = workloadPortNoiseRank(a) - workloadPortNoiseRank(b);
  if (noiseDelta) return noiseDelta;
  const sourceDelta = workloadSourceRank(a) - workloadSourceRank(b);
  if (sourceDelta) return sourceDelta;
  const hostDelta = String(a.hostName || '').localeCompare(String(b.hostName || ''), 'zh-Hans-CN');
  if (hostDelta) return hostDelta;
  return workloadTitle(a).localeCompare(workloadTitle(b), 'zh-Hans-CN');
}

function workloadPrimaryRank(item: WorkloadItem): number {
  if (isPrimaryItem(item)) return 0;
  if (item.kind === 'container') return 1;
  if (item.kind === 'service') return 2;
  return 3;
}

function workloadKindRank(item: WorkloadItem): number {
  if (item.kind === 'container') return 0;
  if (item.kind === 'service') return 1;
  if (item.kind === 'port') return 2;
  return 3;
}

function workloadSourceRank(item: WorkloadItem): number {
  if (item.source === 'compose') return 0;
  if (item.source === 'docker') return 1;
  if (item.source === 'systemd') return 2;
  if (item.source === 'tunnel') return 3;
  if (item.source === 'windows-service') return 4;
  if (item.source === 'process') return 5;
  return 6;
}

function workloadPortNoiseRank(item: WorkloadItem): number {
  if (item.kind === 'container') return 0;
  if (item.infrastructure) return 2;
  const port = String(item.port || '');
  return port === '22' || port === '80' || port === '443' ? 1 : 0;
}

function sourceLabel(item: WorkloadItem): string {
  if (item.source === 'compose') return 'Compose';
  if (item.source === 'docker') return 'Docker';
  if (item.source === 'systemd') return 'systemd';
  if (item.source === 'windows-service') return 'Windows Service';
  if (item.source === 'tunnel') return item.sourceLabel || '隧道';
  if (item.source === 'process') return item.projectCandidate ? '源码进程' : '进程';
  return item.sourceLabel || item.source || '--';
}

function sourceClass(item: WorkloadItem): string {
  if (item.source === 'compose') return 'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-400/10 dark:text-cyan-200 dark:ring-cyan-400/20';
  if (item.source === 'docker') return 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-400/10 dark:text-blue-200 dark:ring-blue-400/20';
  if (item.source === 'systemd') return 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-400/10 dark:text-violet-200 dark:ring-violet-400/20';
  if (item.source === 'tunnel') return 'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-400/10 dark:text-teal-200 dark:ring-teal-400/20';
  if (item.source === 'windows-service') return 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-400/10 dark:text-indigo-200 dark:ring-indigo-400/20';
  if (item.projectCandidate) return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-400/20';
  return 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:ring-white/10';
}

function toggleSourceFilter(item: WorkloadItem): void {
  sourceFilter.value = sourceFilter.value === item.source ? 'all' : (item.source as SourceFilter);
}

function stateLabel(item: WorkloadItem): string {
  if (item.failed || item.health === 'unhealthy') return '异常';
  if (item.kind === 'port') return '监听中';
  const state = String(item.state || '').toLowerCase();
  if (state === 'listening') return '运行中';
  if (state === 'running') return '运行中';
  if (state === 'exited') return '已停止';
  if (state === 'created') return '已创建';
  if (state === 'restarting') return '重启中';
  if (state === 'paused') return '已暂停';
  return state || '--';
}

function stateClass(item: WorkloadItem): string {
  if (item.failed || item.health === 'unhealthy') return 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-400/10 dark:text-rose-200 dark:ring-rose-400/20';
  if (item.running) return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-400/20';
  return 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:ring-white/10';
}

function workloadTitle(item: WorkloadItem): string {
  return item.displayName || item.name || '--';
}

function endpointValues(item: WorkloadItem): string[] {
  const endpoints = [...new Set((item.entrypointsText || []).filter(Boolean))];
  if (endpoints.length) return endpoints;
  return [item.primaryEndpoint || '--'];
}

function visibleEndpointValues(item: WorkloadItem): string[] {
  const endpoints = endpointValues(item);
  if (isEndpointRowExpanded(item)) return endpoints;
  return endpoints.slice(0, COMPACT_ENDPOINT_LIMIT);
}

function hiddenEndpointCount(item: WorkloadItem): number {
  const hidden = endpointValues(item).length - COMPACT_ENDPOINT_LIMIT;
  return isEndpointRowExpanded(item) ? 0 : Math.max(0, hidden);
}

function hasCollapsibleEndpoints(item: WorkloadItem): boolean {
  return endpointValues(item).length > COMPACT_ENDPOINT_LIMIT;
}

function workloadRowKey(item: WorkloadItem): string {
  return `${item.hostId}:${item.id}`;
}

function isEndpointRowExpanded(item: WorkloadItem): boolean {
  return expandedEndpointRows.value.has(workloadRowKey(item));
}

function toggleEndpointRow(item: WorkloadItem): void {
  const key = workloadRowKey(item);
  const next = new Set(expandedEndpointRows.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedEndpointRows.value = next;
}

function endpointsTitle(item: WorkloadItem): string {
  return endpointValues(item).join('\n') || item.primaryEndpoint || '--';
}

function resourceLabel(item: WorkloadItem): string {
  if (item.stats) {
    return [
      item.stats.cpuPercentText ? `CPU ${item.stats.cpuPercentText}` : '',
      item.stats.memoryUsage ? `Mem ${item.stats.memoryUsage}` : '',
    ].filter(Boolean).join(' / ') || '--';
  }
  return item.status || '--';
}

function visibleEvidenceLabel(item: WorkloadItem): string {
  const values = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  const meaningful = values.filter((value) => !['running', 'compose-label'].includes(value));
  return meaningful.join(' + ');
}

function workloadTitleAttr(item: WorkloadItem): string {
  return [
    item.nativeId || item.id,
    item.kind === 'container' ? item.imageName : item.command || item.serviceName,
    visibleEvidenceLabel(item),
  ].filter(Boolean).join('\n');
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

onMounted(() => {
  void loadWorkloads();
});

onBeforeUnmount(() => {
  loadSequence += 1;
  activeAbortController?.abort();
  activeAbortController = null;
});
</script>

<template>
  <div class="flex h-full min-h-0 overflow-hidden bg-slate-50 px-4 py-4 text-slate-800 dark:bg-[#07111f] dark:text-slate-100">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-none flex-col gap-3">
      <div v-if="loading" class="h-1 shrink-0 overflow-hidden rounded-full bg-cyan-100 dark:bg-cyan-400/10">
        <div class="h-full w-1/3 animate-pulse rounded-full bg-cyan-500"></div>
      </div>

      <main class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
        <div class="shrink-0 flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-3 dark:border-white/10">
          <select v-model="hostFilter" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-400 dark:border-white/10 dark:bg-[#07111f]">
            <option v-for="host in hostOptions" :key="host.id" :value="host.id">{{ host.name }}</option>
          </select>
          <div class="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-white/10 dark:bg-[#07111f]">
            <button
              v-for="option in kindOptions"
              :key="option.value"
              type="button"
              class="h-8 min-w-[86px] rounded-md px-3 text-sm font-medium transition"
              :class="kindFilter === option.value ? 'bg-cyan-600 text-white shadow-sm' : 'text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-white/[0.06]'"
              @click="kindFilter = option.value"
            >
              {{ option.label }}
            </button>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition"
            :class="unhealthyOnly
              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200'
              : 'border-slate-200 bg-white text-slate-600 hover:border-rose-200 hover:text-rose-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:text-rose-200'"
            @click="unhealthyOnly = !unhealthyOnly"
          >
            <AppIcon name="alert" :size="14" />
            <span>只看异常</span>
          </button>
          <button
            v-if="sourceFilter !== 'all'"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm font-medium text-cyan-700 transition hover:bg-cyan-100 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-200 dark:hover:bg-cyan-400/20"
            title="清除来源筛选"
            @click="sourceFilter = 'all'"
          >
            <span>来源：{{ activeSourceLabel }}</span>
            <AppIcon name="close" :size="12" />
          </button>
          <input
            v-model="search"
            type="search"
            placeholder="搜索名称、镜像、端口或命令"
            class="min-w-[220px] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-400 dark:border-white/10 dark:bg-[#07111f]"
          />
          <span
            v-if="headerSummaryText"
            class="text-xs text-slate-500 dark:text-slate-400"
            :title="summary?.collectedAt ? `采集时间 ${formatTime(summary.collectedAt)}` : ''"
          >{{ headerSummaryText }}</span>
          <span v-if="summary?.pendingHostCount" class="animate-pulse text-xs font-medium text-cyan-600 dark:text-cyan-300">
            {{ summary.pendingHostCount }} 台采集中
          </span>
          <button
            v-if="summary?.unhealthyWorkloadCount"
            type="button"
            class="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200 transition hover:bg-amber-100 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/20"
            title="只看异常运行项"
            @click="showUnhealthy"
          >
            {{ summary.unhealthyWorkloadCount }} 异常
          </button>
          <button
            v-if="summary?.failedHostCount"
            type="button"
            class="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200 transition hover:bg-rose-100 dark:bg-rose-400/10 dark:text-rose-200 dark:ring-rose-400/20"
            title="查看采集失败的主机"
            @click="selectFirstFailedHost"
          >
            {{ summary.failedHostCount }} 台采集失败
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-cyan-400/10 dark:hover:text-cyan-200"
            :disabled="loading"
            @click="refreshAllWorkloads"
          >
            <AppIcon name="radio" :size="15" />
            <span>{{ loading ? '刷新中' : '全部刷新' }}</span>
          </button>
          <button
            v-if="selectedHostSummary"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="isHostRefreshing(selectedHostSummary.hostId)"
            :title="`刷新 ${selectedHostSummary.hostName}`"
            @click="refreshSelectedHost"
          >
            <AppIcon name="restart" :size="15" :class="isHostRefreshing(selectedHostSummary.hostId) ? 'animate-spin' : ''" />
            <span>{{ isHostRefreshing(selectedHostSummary.hostId) ? '刷新中' : '刷新' }}</span>
          </button>
        </div>

        <div v-if="failedHosts.length" class="shrink-0 space-y-1 border-b border-rose-200/70 bg-rose-50/70 px-3 py-2 dark:border-rose-400/20 dark:bg-rose-400/[0.06]">
          <div v-for="host in failedHosts" :key="host.hostId" class="flex flex-wrap items-center gap-2 text-sm">
            <AppIcon name="alert" :size="14" class="shrink-0 text-rose-600 dark:text-rose-300" />
            <span class="font-medium text-rose-700 dark:text-rose-200">{{ host.hostName }}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-rose-600/90 dark:text-rose-200/80" :title="host.error || ''">
              {{ host.error || '采集失败，请检查 SSH 连接和远程命令执行权限' }}
            </span>
            <button
              type="button"
              class="rounded-md border border-rose-200 bg-white px-2 py-0.5 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-400/30 dark:bg-transparent dark:text-rose-200 dark:hover:bg-rose-400/10"
              :disabled="isHostRefreshing(host.hostId)"
              @click="refreshHostFromList(host)"
            >
              {{ isHostRefreshing(host.hostId) ? '重试中' : '重试' }}
            </button>
          </div>
        </div>

        <div v-if="error" class="m-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-100">
          {{ error }}
        </div>

        <div v-else class="min-h-0 flex-1 overflow-auto">
          <div class="workload-grid sticky top-0 z-10 gap-4 border-b border-slate-200 bg-white px-3 py-2.5 text-xs font-medium uppercase tracking-normal text-slate-500 dark:border-white/10 dark:bg-[#0b1324] dark:text-slate-400">
            <span>运行项</span>
            <span>来源</span>
            <span>入口</span>
            <span>状态</span>
            <span>资源</span>
            <span>操作</span>
          </div>

          <div v-if="!filteredItems.length && !loading" class="p-8 text-sm text-slate-600 dark:text-slate-300">
            <div class="mx-auto max-w-3xl rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-left dark:border-white/15 dark:bg-white/[0.03]">
              <div class="flex items-start gap-3">
                <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200">
                  <AppIcon name="alert" :size="18" />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="font-semibold text-slate-900 dark:text-slate-100">{{ emptyTitle }}</p>
                  <p class="mt-1 text-slate-500 dark:text-slate-400">当前筛选条件下没有匹配的运行项。</p>
                </div>
              </div>
              <div v-if="visibleProblemHosts.length" class="mt-4 space-y-2">
                <div
                  v-for="host in visibleProblemHosts"
                  :key="host.hostId"
                  class="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-[#07111f]/60"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <button type="button" class="font-medium text-cyan-700 hover:underline dark:text-cyan-200" @click="selectHost(host.hostId)">
                      {{ host.hostName }}
                    </button>
                    <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="hostStateClass(host)">
                      {{ hostStateText(host) }}
                    </span>
                  </div>
                  <p class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400">{{ hostIssueText(host) }}</p>
                </div>
              </div>
            </div>
          </div>

          <div
            v-for="item in filteredItems"
            :key="workloadRowKey(item)"
            class="workload-grid items-start gap-4 border-b border-slate-200/80 px-3 py-3 text-sm odd:bg-slate-50/60 last:border-b-0 hover:bg-cyan-50/30 dark:border-white/10 dark:odd:bg-white/[0.025] dark:hover:bg-cyan-400/[0.04]"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="h-2.5 w-2.5 shrink-0 rounded-full"
                :class="item.failed ? 'bg-rose-500' : item.running ? 'bg-emerald-500' : 'bg-slate-400'"
              ></span>
              <span class="min-w-0 truncate font-semibold text-slate-900 dark:text-slate-100" :title="workloadTitleAttr(item)">{{ workloadTitle(item) }}</span>
            </div>

            <div class="min-w-0">
              <button
                type="button"
                class="inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition hover:opacity-80"
                :class="sourceClass(item)"
                :title="sourceFilter === item.source ? '清除来源筛选' : `只看 ${sourceLabel(item)}`"
                @click="toggleSourceFilter(item)"
              >
                <span class="truncate">{{ sourceLabel(item) }}</span>
              </button>
            </div>

            <div class="flex min-w-0 flex-wrap gap-1.5 font-mono text-xs text-slate-700 dark:text-slate-200" :title="endpointsTitle(item)">
              <span
                v-for="endpoint in visibleEndpointValues(item)"
                :key="endpoint"
                class="max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 leading-5 dark:bg-white/[0.06]"
              >
                {{ endpoint }}
              </span>
              <button
                v-if="hasCollapsibleEndpoints(item)"
                type="button"
                class="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[11px] font-medium leading-5 whitespace-nowrap text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-cyan-200 dark:hover:bg-cyan-400/10"
                @click.stop="toggleEndpointRow(item)"
              >
                {{ isEndpointRowExpanded(item) ? '收起' : `+${hiddenEndpointCount(item)}` }}
              </button>
            </div>

            <div class="min-w-0">
              <span class="inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1" :class="stateClass(item)">
                {{ stateLabel(item) }}
              </span>
              <p v-if="item.health && item.health !== 'healthy'" class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{{ item.health }}</p>
            </div>

            <div class="min-w-0">
              <p class="break-words text-slate-700 dark:text-slate-200" :title="resourceLabel(item)">{{ resourceLabel(item) }}</p>
              <p v-if="item.stats?.netIO" class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400" :title="item.stats.netIO">Net {{ item.stats.netIO }}</p>
            </div>

            <div class="min-w-0">
              <div v-if="supportedWorkloadActions(item).length" class="flex flex-wrap gap-1.5">
                <button
                  v-for="action in supportedWorkloadActions(item)"
                  :key="action"
                  type="button"
                  class="inline-flex h-7 items-center justify-center rounded-md border px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
                  :class="workloadActionClass(action)"
                  :disabled="isWorkloadActionBusy(item)"
                  :title="workloadActionTitle(item, action)"
                  @click.stop="runWorkloadAction(item, action)"
                >
                  {{ isWorkloadActionBusy(item, action) ? '执行中' : workloadActionLabel(action) }}
                </button>
              </div>
              <span v-else class="text-xs text-slate-400 dark:text-slate-500">--</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.workload-grid {
  display: grid;
  width: 100%;
  min-width: 880px;
  grid-template-columns:
    minmax(200px, 1.35fr)
    minmax(96px, 0.5fr)
    minmax(180px, 1.1fr)
    minmax(88px, 0.5fr)
    minmax(140px, 0.8fr)
    minmax(180px, 1fr);
}
</style>
