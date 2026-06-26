<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useNotifyStore } from '@/stores/notify';

interface WorkloadEndpoint {
  protocol?: string | null;
  address?: string | null;
  port?: string | null;
  endpoint?: string | null;
  containerPort?: string | null;
  hostIp?: string | null;
  hostPort?: string | null;
  published?: boolean;
}

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
  runTime?: string | null;
  entrypoints?: WorkloadEndpoint[];
  entrypointsText?: string[];
  primaryEndpoint?: string | null;
  publishedPortCount?: number;
  ipAddresses?: string[];
  networkText?: string | null;
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
  durationMs?: number | null;
  platformSupported?: boolean;
  platform?: string | null;
  dockerInstalled?: boolean | null;
  dockerReachable?: boolean;
  dockerError?: string | null;
  engineVersion?: string | null;
  workloadCount: number;
  runningWorkloadCount: number;
  stoppedWorkloadCount: number;
  unhealthyWorkloadCount: number;
  primaryWorkloadCount?: number;
  containerCount: number;
  runningContainerCount?: number;
  composeWorkloadCount?: number;
  serviceCount?: number;
  projectProcessCount?: number;
  infrastructureCount?: number;
  processCount: number;
  systemdWorkloadCount: number;
  windowsServiceCount?: number;
  listeningPortCount: number;
  publishedPortCount: number;
  warnings?: string[];
  error?: string | null;
  loading?: boolean;
  cached?: boolean;
  sortIndex?: number;
  items?: WorkloadItem[];
}

interface WorkloadsSummaryResponse {
  ok: boolean;
  module: string;
  collectedAt: string;
  hostCount: number;
  okHostCount: number;
  failedHostCount: number;
  pendingHostCount?: number;
  workloadCount: number;
  runningWorkloadCount: number;
  stoppedWorkloadCount: number;
  unhealthyWorkloadCount: number;
  primaryWorkloadCount?: number;
  containerCount: number;
  runningContainerCount?: number;
  serviceCount?: number;
  projectProcessCount?: number;
  infrastructureCount?: number;
  processCount: number;
  systemdWorkloadCount: number;
  windowsServiceCount?: number;
  composeWorkloadCount: number;
  dockerHostCount: number;
  dockerUnavailableHostCount?: number;
  dockerMissingHostCount?: number;
  dockerUnsupportedHostCount?: number;
  listeningPortCount: number;
  publishedPortCount: number;
  composeProjectCount: number;
  hosts: HostWorkloadSummary[];
  items: WorkloadItem[];
  warnings?: string[];
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
  durationMs?: number | null;
  platformSupported?: boolean;
  platform?: string | null;
  dockerInstalled?: boolean | null;
  dockerReachable?: boolean;
  dockerError?: string | null;
  engineVersion?: string | null;
  cached?: boolean;
  items?: WorkloadItem[];
  warnings?: string[];
  error?: string | null;
}

type StateFilter = 'all' | 'running' | 'stopped' | 'unhealthy';
type SourceFilter = 'all' | 'docker' | 'compose' | 'systemd' | 'windows-service' | 'tunnel' | 'process' | 'published';
type KindFilter = 'primary' | 'all' | 'container' | 'port';
type MetricAccent = 'rose' | 'emerald';
type WorkloadAction = 'start' | 'stop' | 'restart' | 'delete' | 'recreate';

interface MetricItem {
  label: string;
  value: number;
  hint: string;
  accent?: MetricAccent;
  muted?: boolean;
}

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
const summary = ref<WorkloadsSummaryResponse | null>(null);
const hostFilter = ref('all');
const kindFilter = ref<KindFilter>('primary');
const stateFilter = ref<StateFilter>('all');
const sourceFilter = ref<SourceFilter>('all');
const search = ref('');
const expandedEndpointRows = ref<Set<string>>(new Set());
const expandedActionRows = ref<Set<string>>(new Set());
const actingWorkloadKeys = ref<Set<string>>(new Set());
const refreshingHostIds = ref<Set<string>>(new Set());
const COMPACT_ENDPOINT_LIMIT = 2;
const WORKLOAD_ACTIONS: WorkloadAction[] = ['start', 'stop', 'restart', 'recreate', 'delete'];
const MODULE_ID = 'workloads';
const HOST_LOAD_CONCURRENCY = 4;
let loadSequence = 0;
let activeAbortController: AbortController | null = null;

const kindOptions: { value: KindFilter; label: string }[] = [
  { value: 'primary', label: '项目/服务' },
  { value: 'container', label: '容器' },
  { value: 'port', label: '端口/进程' },
  { value: 'all', label: '全部' },
];

const stateOptions: { value: StateFilter; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '运行中' },
  { value: 'stopped', label: '已停止' },
  { value: 'unhealthy', label: '异常' },
];

const sourceOptions: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部来源' },
  { value: 'compose', label: 'Compose' },
  { value: 'docker', label: 'Docker' },
  { value: 'systemd', label: 'systemd' },
  { value: 'windows-service', label: 'Windows Service' },
  { value: 'tunnel', label: '隧道' },
  { value: 'process', label: '进程' },
  { value: 'published', label: '暴露端口' },
];

const hostRows = computed(() => (summary.value?.hosts || []).slice().sort((a, b) => {
  if (Boolean(a.loading) !== Boolean(b.loading)) return a.loading ? 1 : -1;
  if (a.loading && b.loading) {
    if ((a.sortIndex ?? 0) !== (b.sortIndex ?? 0)) return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
    return a.hostName.localeCompare(b.hostName, 'zh-Hans-CN');
  }
  if (a.ok !== b.ok) return a.ok ? 1 : -1;
  if (a.unhealthyWorkloadCount !== b.unhealthyWorkloadCount) return b.unhealthyWorkloadCount - a.unhealthyWorkloadCount;
  if ((a.primaryWorkloadCount || 0) !== (b.primaryWorkloadCount || 0)) return (b.primaryWorkloadCount || 0) - (a.primaryWorkloadCount || 0);
  if (a.containerCount !== b.containerCount) return b.containerCount - a.containerCount;
  if (a.workloadCount !== b.workloadCount) return b.workloadCount - a.workloadCount;
  if ((a.sortIndex ?? 0) !== (b.sortIndex ?? 0)) return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
  return a.hostName.localeCompare(b.hostName, 'zh-Hans-CN');
}));

const hostOptions = computed(() => hostRows.value.map((host) => ({ id: host.hostId, name: host.hostName })));

const visibleSourceOptions = computed(() => {
  if (kindFilter.value === 'primary') {
    return sourceOptions.filter((option) => ['all', 'compose', 'docker', 'systemd', 'windows-service', 'tunnel', 'process', 'published'].includes(option.value));
  }
  if (kindFilter.value === 'container') {
    return sourceOptions.filter((option) => ['all', 'compose', 'docker', 'published'].includes(option.value));
  }
  if (kindFilter.value === 'port') {
    return sourceOptions.filter((option) => ['all', 'systemd', 'windows-service', 'tunnel', 'process'].includes(option.value));
  }
  return sourceOptions;
});

const filteredItems = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return (summary.value?.items || []).filter((item) => {
    if (hostFilter.value !== 'all' && item.hostId !== hostFilter.value) return false;
    if (kindFilter.value === 'primary' && !isPrimaryItem(item)) return false;
    if (kindFilter.value === 'container' && item.kind !== 'container') return false;
    if (kindFilter.value === 'port' && item.kind === 'container') return false;
    if (stateFilter.value === 'running' && !item.running) return false;
    if (stateFilter.value === 'stopped' && item.running) return false;
    if (stateFilter.value === 'unhealthy' && !item.failed && item.health !== 'unhealthy') return false;
    if (sourceFilter.value === 'published' && !(item.publishedPortCount || 0)) return false;
    if (sourceFilter.value !== 'all' && sourceFilter.value !== 'published' && item.source !== sourceFilter.value) return false;
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

const stats = computed(() => ({
  hosts: summary.value?.hostCount || 0,
  workloads: summary.value?.workloadCount || 0,
  primary: summary.value?.primaryWorkloadCount || 0,
  running: summary.value?.runningWorkloadCount || 0,
  unhealthy: summary.value?.unhealthyWorkloadCount || 0,
  containers: summary.value?.containerCount || 0,
  runningContainers: summary.value?.runningContainerCount || 0,
  services: summary.value?.serviceCount || 0,
  projectProcesses: summary.value?.projectProcessCount || 0,
  infrastructure: summary.value?.infrastructureCount || 0,
  processes: summary.value?.processCount || 0,
  systemd: summary.value?.systemdWorkloadCount || 0,
  windowsServices: summary.value?.windowsServiceCount || 0,
  compose: summary.value?.composeWorkloadCount || 0,
  ports: summary.value?.listeningPortCount || 0,
  published: summary.value?.publishedPortCount || 0,
  failedHosts: summary.value?.failedHostCount || 0,
  pendingHosts: summary.value?.pendingHostCount || 0,
  dockerUnavailable: summary.value?.dockerUnavailableHostCount || 0,
}));

const selectedHostSummary = computed(() => {
  if (hostFilter.value === 'all') return null;
  return hostRows.value.find((host) => host.hostId === hostFilter.value) || null;
});

const visibleProblemHosts = computed(() => {
  const hosts = selectedHostSummary.value ? [selectedHostSummary.value] : hostRows.value;
  return hosts.filter((host) => hostIssueText(host));
});

const displayModeHint = computed(() => {
  if (kindFilter.value === 'primary') return '默认视角';
  if (kindFilter.value === 'container') return '只看容器';
  if (kindFilter.value === 'port') return '诊断端口';
  return '服务优先';
});

const metricItems = computed<MetricItem[]>(() => [
  { label: '主机', value: stats.value.hosts, hint: `${stats.value.failedHosts} 失败 / ${stats.value.pendingHosts} 采集中` },
  { label: '项目/服务', value: stats.value.primary, hint: `${stats.value.projectProcesses} 源码进程` },
  { label: '容器', value: stats.value.containers, hint: `${stats.value.compose} Compose` },
  { label: '当前显示', value: filteredItems.value.length, hint: displayModeHint.value },
  { label: '服务来源', value: stats.value.services, hint: `${stats.value.systemd} systemd / ${stats.value.windowsServices} Windows` },
  { label: '诊断端口', value: stats.value.ports, hint: `${stats.value.infrastructure} 基础入口`, muted: true },
]);

const searchPlaceholder = computed(() => {
  if (kindFilter.value === 'primary') return '搜索项目、服务、容器、源码进程、入口或主机';
  if (kindFilter.value === 'container') return '搜索容器、镜像、Compose、入口或主机';
  if (kindFilter.value === 'port') return '搜索端口、进程、服务、命令或主机';
  return '搜索项目、服务、容器、端口、进程、镜像或主机';
});

const emptyTitle = computed(() => {
  if (kindFilter.value === 'primary') return '没有可展示的项目/服务';
  if (kindFilter.value === 'container') return '没有可展示的容器';
  if (kindFilter.value === 'port') return '没有可展示的端口/进程';
  return '没有可展示的运行项';
});

const emptyMessage = computed(() => {
  if (kindFilter.value === 'primary') return '当前筛选下未发现容器、系统服务、Windows Service 或源码运行进程。需要排查基础端口时，可以切到端口/进程。';
  if (kindFilter.value === 'container') return '当前筛选下未发现 Docker/Compose 容器。';
  if (kindFilter.value === 'port') return '当前筛选下未发现监听端口或进程归属。';
  return '当前筛选下没有匹配的项目、服务、容器、监听端口或进程。';
});

watch(kindFilter, (value) => {
  if (value === 'container' && (sourceFilter.value === 'systemd' || sourceFilter.value === 'windows-service' || sourceFilter.value === 'tunnel' || sourceFilter.value === 'process')) {
    sourceFilter.value = 'all';
  }
  if (value === 'port' && (sourceFilter.value === 'docker' || sourceFilter.value === 'compose' || sourceFilter.value === 'published')) {
    sourceFilter.value = 'all';
  }
});

function createEmptyHostSummary(host: HostInfo, sortIndex: number, collectedAt: string): HostWorkloadSummary {
  return {
    hostId: host.id,
    hostName: host.name || host.id,
    ok: false,
    collectedAt,
    durationMs: null,
    platformSupported: true,
    platform: null,
    dockerInstalled: null,
    dockerReachable: false,
    dockerError: null,
    engineVersion: null,
    workloadCount: 0,
    runningWorkloadCount: 0,
    stoppedWorkloadCount: 0,
    unhealthyWorkloadCount: 0,
    primaryWorkloadCount: 0,
    containerCount: 0,
    runningContainerCount: 0,
    composeWorkloadCount: 0,
    serviceCount: 0,
    projectProcessCount: 0,
    infrastructureCount: 0,
    processCount: 0,
    systemdWorkloadCount: 0,
    windowsServiceCount: 0,
    listeningPortCount: 0,
    publishedPortCount: 0,
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
    durationMs: result.durationMs ?? null,
    platformSupported: result.platformSupported !== false,
    platform: result.platform || null,
    dockerInstalled: result.dockerInstalled ?? null,
    dockerReachable: Boolean(result.dockerReachable),
    dockerError: result.dockerError || null,
    engineVersion: result.engineVersion || null,
    workloadCount: items.length,
    runningWorkloadCount: items.filter((item) => item.running).length,
    stoppedWorkloadCount: items.filter((item) => !item.running).length,
    unhealthyWorkloadCount: items.filter((item) => item.health === 'unhealthy' || item.failed).length,
    primaryWorkloadCount: items.filter(isPrimaryItem).length,
    containerCount: items.filter((item) => item.kind === 'container').length,
    runningContainerCount: items.filter((item) => item.kind === 'container' && item.running).length,
    composeWorkloadCount: items.filter((item) => item.source === 'compose').length,
    serviceCount: items.filter((item) => item.kind === 'service').length,
    projectProcessCount: items.filter((item) => item.projectCandidate).length,
    infrastructureCount: items.filter((item) => item.infrastructure).length,
    processCount: items.filter((item) => item.kind !== 'container').length,
    systemdWorkloadCount: items.filter((item) => item.source === 'systemd').length,
    windowsServiceCount: items.filter((item) => item.source === 'windows-service').length,
    listeningPortCount: countListeningEndpoints(items),
    publishedPortCount: countPublishedPorts(items),
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

function buildWorkloadsSummary(hosts: HostWorkloadSummary[], collectedAt: string): WorkloadsSummaryResponse {
  const items = hosts.flatMap((host) => host.items || []);
  const completedHosts = hosts.filter((host) => !host.loading);
  const okHosts = completedHosts.filter((host) => host.ok);

  return {
    ok: true,
    module: MODULE_ID,
    collectedAt,
    hostCount: hosts.length,
    okHostCount: okHosts.length,
    failedHostCount: completedHosts.length - okHosts.length,
    pendingHostCount: hosts.filter((host) => host.loading).length,
    workloadCount: sumHostCount(hosts, 'workloadCount'),
    runningWorkloadCount: sumHostCount(hosts, 'runningWorkloadCount'),
    stoppedWorkloadCount: sumHostCount(hosts, 'stoppedWorkloadCount'),
    unhealthyWorkloadCount: sumHostCount(hosts, 'unhealthyWorkloadCount'),
    primaryWorkloadCount: sumHostCount(hosts, 'primaryWorkloadCount'),
    containerCount: sumHostCount(hosts, 'containerCount'),
    runningContainerCount: sumHostCount(hosts, 'runningContainerCount'),
    serviceCount: sumHostCount(hosts, 'serviceCount'),
    projectProcessCount: sumHostCount(hosts, 'projectProcessCount'),
    infrastructureCount: sumHostCount(hosts, 'infrastructureCount'),
    processCount: sumHostCount(hosts, 'processCount'),
    systemdWorkloadCount: sumHostCount(hosts, 'systemdWorkloadCount'),
    windowsServiceCount: sumHostCount(hosts, 'windowsServiceCount'),
    composeWorkloadCount: sumHostCount(hosts, 'composeWorkloadCount'),
    dockerHostCount: okHosts.filter((host) => host.dockerReachable).length,
    dockerUnavailableHostCount: okHosts.filter((host) => host.dockerInstalled && !host.dockerReachable).length,
    dockerMissingHostCount: okHosts.filter((host) => host.dockerInstalled === false).length,
    dockerUnsupportedHostCount: okHosts.filter((host) => host.platformSupported === false).length,
    listeningPortCount: sumHostCount(hosts, 'listeningPortCount'),
    publishedPortCount: sumHostCount(hosts, 'publishedPortCount'),
    composeProjectCount: countUnique(items.map((item) => item.composeProject).filter(Boolean)),
    hosts: hosts.slice(),
    items,
    warnings: hosts.flatMap((host) => host.warnings || []),
  };
}

function replaceHostSummary(nextHost: HostWorkloadSummary, collectedAt: string): void {
  const hosts = summary.value?.hosts ? summary.value.hosts.slice() : [];
  const index = hosts.findIndex((host) => host.hostId === nextHost.hostId);
  if (index === -1) hosts.push(nextHost);
  else hosts[index] = nextHost;
  summary.value = buildWorkloadsSummary(hosts, collectedAt);
}

type HostCountKey = 'workloadCount'
  | 'runningWorkloadCount'
  | 'stoppedWorkloadCount'
  | 'unhealthyWorkloadCount'
  | 'primaryWorkloadCount'
  | 'containerCount'
  | 'runningContainerCount'
  | 'serviceCount'
  | 'projectProcessCount'
  | 'infrastructureCount'
  | 'processCount'
  | 'systemdWorkloadCount'
  | 'windowsServiceCount'
  | 'composeWorkloadCount'
  | 'listeningPortCount'
  | 'publishedPortCount';

function sumHostCount(hosts: HostWorkloadSummary[], key: HostCountKey): number {
  return hosts.reduce((total, host) => total + (host[key] || 0), 0);
}

function countPublishedPorts(items: WorkloadItem[]): number {
  return items.reduce((total, item) => {
    if (Array.isArray(item.entrypoints)) {
      return total + item.entrypoints.filter((port) => port.published).length;
    }
    return total + (item.publishedPortCount || 0);
  }, 0);
}

function countUnique(values: Array<string | null | undefined>): number {
  return new Set(values.filter(Boolean)).size;
}

function hasListeningEndpoint(item: WorkloadItem): boolean {
  if (!item || item.kind === 'container') return false;
  if (item.port) return true;
  return (item.entrypoints || []).some((entrypoint) => entrypoint?.port || entrypoint?.endpoint);
}

function countListeningEndpoints(items: WorkloadItem[]): number {
  return items.reduce((total, item) => {
    if (!item || item.kind === 'container') return total;
    if (Array.isArray(item.entrypoints) && item.entrypoints.length) return total + item.entrypoints.length;
    return total + (hasListeningEndpoint(item) ? 1 : 0);
  }, 0);
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

function isActionRowExpanded(item: WorkloadItem): boolean {
  return expandedActionRows.value.has(workloadRowKey(item));
}

function toggleActionRow(item: WorkloadItem): void {
  const key = workloadRowKey(item);
  const next = new Set(expandedActionRows.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedActionRows.value = next;
}

function closeActionRow(item: WorkloadItem): void {
  const key = workloadRowKey(item);
  if (!expandedActionRows.value.has(key)) return;
  const next = new Set(expandedActionRows.value);
  next.delete(key);
  expandedActionRows.value = next;
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
  if (action === 'start') return 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200';
  if (action === 'stop' || action === 'delete') return 'border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200';
  return 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200';
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
      closeActionRow(item);
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

function hostStateText(host: HostWorkloadSummary): string {
  if (host.loading) return '采集中';
  if (!host.ok) return '采集失败';
  if (host.platformSupported === false) return 'N/A';
  if (host.unhealthyWorkloadCount > 0) return `${host.unhealthyWorkloadCount} 异常`;
  if (kindFilter.value === 'primary') return `${host.primaryWorkloadCount || 0}/${host.workloadCount}`;
  if (kindFilter.value === 'container') return `${host.runningContainerCount || 0}/${host.containerCount}`;
  if (kindFilter.value === 'port') return `${host.processCount}/${host.listeningPortCount}`;
  return `${host.runningWorkloadCount}/${host.workloadCount}`;
}

function hostMetaText(host: HostWorkloadSummary): string {
  if (host.loading) return '等待单机结果';
  const duration = formatDuration(host.durationMs);
  if (!host.ok) return host.error || `采集失败 / ${duration}`;
  if (host.platformSupported === false) return `暂不支持 / ${duration}`;
  if (kindFilter.value === 'primary') return `${host.primaryWorkloadCount || 0} 项目服务 / ${host.serviceCount || 0} 服务 / ${duration}`;
  if (kindFilter.value === 'port') return `${host.listeningPortCount} 端口 / ${host.processCount} 进程 / ${duration}`;
  if (kindFilter.value === 'all') return `${host.containerCount} 容器 / ${host.listeningPortCount} 端口 / ${duration}`;
  return `${host.containerCount} 容器 / ${host.composeWorkloadCount || 0} Compose / ${duration}`;
}

function hostStateClass(host: HostWorkloadSummary): string {
  if (host.loading) return 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300';
  if (!host.ok) return 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200';
  if (host.platformSupported === false) return 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300';
  if (host.unhealthyWorkloadCount > 0) return 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200';
  return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200';
}

function hostIssueText(host: HostWorkloadSummary): string {
  if (host.loading) return '';
  if (!host.ok) return host.error || '采集失败，请检查 SSH 连接和远程命令执行权限';
  if (host.platformSupported === false) return '该平台暂未采集运行项';
  if (kindFilter.value === 'primary' && (host.primaryWorkloadCount || 0) === 0 && host.workloadCount > 0) return '只发现基础端口或诊断进程，未识别到项目/服务候选';
  if (kindFilter.value === 'container' && host.containerCount === 0 && host.workloadCount > 0) return '只发现监听端口/进程，未发现 Docker/Compose 容器';
  if (host.workloadCount === 0) return '未发现监听端口、进程归属、系统服务或容器';
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

function workloadMeta(item: WorkloadItem): string {
  if (item.kind !== 'container') {
    return [item.processName, item.pid ? `pid ${item.pid}` : '', item.user].filter(Boolean).join(' / ') || '--';
  }
  return item.shortId || '--';
}

function targetLabel(item: WorkloadItem): string {
  if (item.kind !== 'container') return item.command || item.serviceName || item.processName || '--';
  return item.imageName || '--';
}

function targetMeta(item: WorkloadItem): string {
  if (item.kind !== 'container') return item.serviceName || item.cwd || item.relatedResource || '--';
  return item.imageId || item.relatedResource || '--';
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
  if (!item.stats) {
    if (item.kind === 'container') return item.status || '--';
    if (item.infrastructure) return '基础入口';
    if (item.source === 'systemd') return 'systemd 服务';
    if (item.source === 'windows-service') return 'Windows 服务';
    return item.projectCandidate ? '项目候选' : item.status || '--';
  }
  return [
    item.stats.cpuPercentText ? `CPU ${item.stats.cpuPercentText}` : '',
    item.stats.memoryUsage ? `Mem ${item.stats.memoryUsage}` : '',
  ].filter(Boolean).join(' / ') || '--';
}

function evidenceLabel(item: WorkloadItem): string {
  const values = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  return values.length ? values.join(' + ') : '--';
}

function visibleEvidenceLabel(item: WorkloadItem): string {
  const values = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  const meaningful = values.filter((value) => !['running', 'compose-label'].includes(value));
  return meaningful.join(' + ');
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
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
      <header class="shrink-0 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-600 text-white shadow-sm">
            <AppIcon name="container" :size="18" />
          </span>
          <div>
            <h1 class="text-lg font-semibold tracking-normal">运行项</h1>
            <p class="text-sm text-slate-500 dark:text-slate-400">项目服务 / 源码进程 / systemd / Windows Service / Docker / Compose</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="summary?.collectedAt" class="text-xs text-slate-500 dark:text-slate-400">{{ formatTime(summary.collectedAt) }}</span>
          <button
            v-if="selectedHostSummary"
            type="button"
            class="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-cyan-700 transition hover:border-cyan-300 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-cyan-200 dark:hover:bg-cyan-400/10"
            :disabled="isHostRefreshing(selectedHostSummary.hostId)"
            :title="`刷新 ${selectedHostSummary.hostName}`"
            @click="refreshSelectedHost"
          >
            <AppIcon name="restart" :size="15" :class="isHostRefreshing(selectedHostSummary.hostId) ? 'animate-spin' : ''" />
            <span>{{ isHostRefreshing(selectedHostSummary.hostId) ? '刷新中' : '刷新当前主机' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="loading"
            @click="refreshAllWorkloads"
          >
            <AppIcon name="radio" :size="15" />
            <span>{{ loading ? '刷新中' : '刷新' }}</span>
          </button>
        </div>
      </header>

      <div v-if="loading" class="h-1 shrink-0 overflow-hidden rounded-full bg-cyan-100 dark:bg-cyan-400/10">
        <div class="h-full w-1/3 animate-pulse rounded-full bg-cyan-500"></div>
      </div>

      <section class="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-6">
        <div
          v-for="metric in metricItems"
          :key="metric.label"
          class="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"
          :class="metric.muted ? 'text-slate-500 dark:text-slate-400' : ''"
        >
          <p class="text-xs text-slate-500 dark:text-slate-400">{{ metric.label }}</p>
          <div class="mt-1 flex items-end justify-between gap-2">
            <p
              class="text-2xl font-semibold leading-none"
              :class="metric.accent === 'rose' ? 'text-rose-600 dark:text-rose-300' : metric.accent === 'emerald' ? 'text-emerald-600 dark:text-emerald-300' : ''"
            >
              {{ metric.value }}
            </p>
            <p class="truncate text-xs text-slate-500 dark:text-slate-400">{{ metric.hint }}</p>
          </div>
        </div>
      </section>

      <section class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[168px_minmax(0,1fr)] gap-3 xl:grid-cols-[220px_minmax(0,1fr)] xl:grid-rows-1">
        <aside class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div class="shrink-0 flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-3 dark:border-white/10">
            <p class="text-sm font-semibold">主机</p>
            <button
              type="button"
              class="rounded-md px-2 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-50 dark:text-cyan-200 dark:hover:bg-cyan-400/10"
              @click="selectHost('all')"
            >全部</button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-1.5">
            <div
              v-for="host in hostRows"
              :key="host.hostId"
              class="mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition"
              :class="hostFilter === host.hostId ? 'bg-cyan-50 text-cyan-800 dark:bg-cyan-400/10 dark:text-cyan-100' : 'hover:bg-slate-100 dark:hover:bg-white/[0.06]'"
            >
              <button type="button" class="min-w-0 flex-1 text-left" @click="selectHost(host.hostId)">
                <span class="block truncate text-sm font-medium">{{ host.hostName }}</span>
                <span class="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400" :title="hostMetaText(host)">
                  {{ hostMetaText(host) }}
                </span>
              </button>
              <div class="flex shrink-0 items-center gap-1">
                <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="hostStateClass(host)">
                  {{ hostStateText(host) }}
                </span>
                <button
                  type="button"
                  class="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-white hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-white/[0.08] dark:hover:text-cyan-200"
                  :disabled="isHostRefreshing(host.hostId)"
                  :title="`刷新 ${host.hostName}`"
                  @click.stop="refreshHostFromList(host)"
                >
                  <AppIcon name="restart" :size="14" :class="isHostRefreshing(host.hostId) ? 'animate-spin' : ''" />
                </button>
              </div>
            </div>
            <div v-if="!hostRows.length && !loading" class="p-4 text-sm text-slate-500 dark:text-slate-400">暂无主机</div>
          </div>
        </aside>

        <main class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div class="shrink-0 flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-3 dark:border-white/10">
            <select v-model="hostFilter" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-400 dark:border-white/10 dark:bg-[#07111f]">
              <option value="all">全部主机</option>
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
            <select v-model="stateFilter" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-400 dark:border-white/10 dark:bg-[#07111f]">
              <option v-for="option in stateOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select v-model="sourceFilter" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-400 dark:border-white/10 dark:bg-[#07111f]">
              <option v-for="option in visibleSourceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <input
              v-model="search"
              type="search"
              :placeholder="searchPlaceholder"
              class="min-w-[260px] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-400 dark:border-white/10 dark:bg-[#07111f]"
            />
          </div>

          <div v-if="error" class="m-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-100">
            {{ error }}
          </div>

          <div v-else class="min-h-0 flex-1 overflow-auto">
            <div class="workload-grid sticky top-0 z-10 gap-4 border-b border-slate-200 bg-white px-3 py-2.5 text-xs font-medium uppercase tracking-normal text-slate-500 dark:border-white/10 dark:bg-[#0b1324] dark:text-slate-400">
              <span>主机</span>
              <span>运行项</span>
              <span>来源</span>
              <span>入口</span>
              <span>状态</span>
              <span>操作</span>
              <span>资源</span>
              <span>目标 / 证据</span>
            </div>

            <div v-if="!filteredItems.length && !loading" class="p-8 text-sm text-slate-600 dark:text-slate-300">
              <div class="mx-auto max-w-3xl rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-left dark:border-white/15 dark:bg-white/[0.03]">
                <div class="flex items-start gap-3">
                  <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200">
                    <AppIcon name="alert" :size="18" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="font-semibold text-slate-900 dark:text-slate-100">{{ emptyTitle }}</p>
                    <p class="mt-1 text-slate-500 dark:text-slate-400">{{ emptyMessage }} 主机侧采集结果如下。</p>
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
                <p v-else class="mt-4 text-xs text-slate-500 dark:text-slate-400">采集成功，当前筛选条件没有匹配项。</p>
              </div>
            </div>

            <div
              v-for="item in filteredItems"
              :key="workloadRowKey(item)"
              class="workload-grid items-start gap-4 border-b border-slate-200/80 px-3 py-3 text-sm odd:bg-slate-50/60 last:border-b-0 hover:bg-cyan-50/30 dark:border-white/10 dark:odd:bg-white/[0.025] dark:hover:bg-cyan-400/[0.04]"
            >
              <button type="button" class="min-w-0 break-words text-left text-cyan-700 hover:underline dark:text-cyan-200" @click="selectHost(item.hostId)">
                {{ item.hostName }}
              </button>

              <div class="min-w-0">
                <div class="flex min-w-0 items-center gap-2">
                  <span
                    class="h-2.5 w-2.5 shrink-0 rounded-full"
                    :class="item.failed ? 'bg-rose-500' : item.running ? 'bg-emerald-500' : 'bg-slate-400'"
                  ></span>
                  <span class="min-w-0 break-words font-semibold text-slate-900 dark:text-slate-100" :title="item.nativeId || item.id">{{ workloadTitle(item) }}</span>
                </div>
                <p class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400" :title="workloadMeta(item)">{{ workloadMeta(item) }}</p>
              </div>

              <div class="min-w-0">
                <span class="inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1" :class="sourceClass(item)">
                  <span class="break-words">{{ sourceLabel(item) }}</span>
                </span>
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
                <div v-if="supportedWorkloadActions(item).length" class="flex w-fit flex-col items-start gap-1.5">
                  <button
                    type="button"
                    :disabled="isWorkloadActionBusy(item)"
                    class="inline-flex h-8 items-center justify-center rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition hover:border-cyan-300 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-cyan-400/10"
                    :title="isActionRowExpanded(item) ? '收起操作' : '展开操作'"
                    @click.stop="toggleActionRow(item)"
                  >
                    操作
                  </button>
                  <div v-if="isActionRowExpanded(item)" class="flex flex-wrap gap-1.5">
                    <button
                      v-for="action in supportedWorkloadActions(item)"
                      :key="action"
                      type="button"
                      class="inline-flex h-8 min-w-[52px] items-center justify-center rounded-md border px-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
                      :class="workloadActionClass(action)"
                      :disabled="isWorkloadActionBusy(item)"
                      :title="workloadActionTitle(item, action)"
                      @click.stop="runWorkloadAction(item, action)"
                    >
                      {{ isWorkloadActionBusy(item, action) ? '执行中' : workloadActionLabel(action) }}
                    </button>
                  </div>
                </div>
                <span v-else class="text-xs text-slate-400 dark:text-slate-500">--</span>
              </div>

              <div class="min-w-0">
                <p class="break-words text-slate-700 dark:text-slate-200" :title="resourceLabel(item)">{{ resourceLabel(item) }}</p>
                <p v-if="item.stats?.netIO" class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400" :title="item.stats.netIO">Net {{ item.stats.netIO }}</p>
              </div>

              <div class="min-w-0">
                <p class="break-words text-slate-700 dark:text-slate-200" :title="targetLabel(item)">{{ targetLabel(item) }}</p>
                <p class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400" :title="targetMeta(item)">{{ targetMeta(item) }}</p>
                <p v-if="visibleEvidenceLabel(item)" class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400" :title="evidenceLabel(item)">{{ visibleEvidenceLabel(item) }}</p>
              </div>
            </div>
          </div>
        </main>
      </section>
    </div>
  </div>
</template>

<style scoped>
.workload-grid {
  display: grid;
  width: 100%;
  min-width: 1280px;
  grid-template-columns:
    minmax(56px, 0.34fr)
    minmax(210px, 1.18fr)
    minmax(92px, 0.46fr)
    minmax(190px, 1.02fr)
    minmax(84px, 0.4fr)
    minmax(92px, 0.42fr)
    minmax(240px, 1.18fr)
    minmax(320px, 1.82fr);
}

@media (min-width: 1700px) {
  .workload-grid {
    min-width: 0;
    grid-template-columns:
      minmax(56px, 0.32fr)
      minmax(220px, 1.2fr)
      minmax(92px, 0.42fr)
      minmax(200px, 1.02fr)
      minmax(84px, 0.38fr)
      minmax(92px, 0.38fr)
      minmax(260px, 1.22fr)
      minmax(360px, 1.76fr);
  }
}
</style>
