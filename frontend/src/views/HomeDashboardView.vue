<script setup lang="ts">
// 主页（4.7.3 重构）：真实地图仪表盘 —— KPI 概览 + Leaflet 地图卡 + 右侧运维栏
// 地图固定浅色底图，页面框架跟随昼夜主题
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import HomeLeafletMap from '@/components/home/HomeLeafletMap.vue';
import HostTooltip from '@/components/home/HostTooltip.vue';
import UnresolvedModal from '@/components/home/UnresolvedModal.vue';
import ManualLocationModal from '@/components/home/ManualLocationModal.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useGeoHosts, type GeoHost } from '@/composables/useGeoHosts';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { MainHost } from '@/utils/mainConsole';

interface ProbeEntry {
  hostId: string;
  online?: boolean;
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  diskUsage?: number | null;
}

interface ProbeSnapshot {
  probes?: ProbeEntry[];
}

interface HostsListResponse {
  hosts?: MainHost[];
}

interface LocateTarget {
  hostId: string;
  hostName: string;
  existing: {
    countryCode: string | null;
    country: string | null;
    city: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
}

const router = useRouter();
const { requestJson } = useApiClient();
const geo = useGeoHosts();

const hosts = ref<MainHost[]>([]);
const probes = ref<ProbeEntry[]>([]);
const POLL_MS = 8000;
let pollHandle: ReturnType<typeof setInterval> | null = null;

const activeTooltip = ref<{ host: GeoHost; x: number; y: number } | null>(null);
const showUnresolved = ref(false);
const locateTarget = ref<LocateTarget | null>(null);

const sshHosts = computed(() => hosts.value.filter((host) => host.id !== LOCAL_HOST_ID));

const probeMap = computed<Map<string, ProbeEntry>>(() => {
  const map = new Map<string, ProbeEntry>();
  for (const probe of probes.value) map.set(probe.hostId, probe);
  return map;
});

const totalCount = computed(() => sshHosts.value.length);
const onlineCount = computed(() => sshHosts.value.filter((host) => probeMap.value.get(host.id)?.online === true).length);

// 异常 = 离线 OR CPU/内存/磁盘 ≥ 90%
function isAbnormal(host: MainHost): boolean {
  const probe = probeMap.value.get(host.id);
  if (!probe) return false;
  if (probe.online === false) return true;
  const high = (value: number | null | undefined): boolean => typeof value === 'number' && value >= 90;
  return high(probe.cpuUsage) || high(probe.memoryUsage) || high(probe.diskUsage);
}

const abnormalHosts = computed(() => sshHosts.value.filter(isAbnormal));
const abnormalCount = computed(() => abnormalHosts.value.length);

function abnormalReason(host: MainHost): string {
  const probe = probeMap.value.get(host.id);
  if (!probe) return '未知';
  if (probe.online === false) return '离线';
  const tags: string[] = [];
  if (typeof probe.cpuUsage === 'number' && probe.cpuUsage >= 90) tags.push(`CPU ${Math.round(probe.cpuUsage)}%`);
  if (typeof probe.memoryUsage === 'number' && probe.memoryUsage >= 90) tags.push(`内存 ${Math.round(probe.memoryUsage)}%`);
  if (typeof probe.diskUsage === 'number' && probe.diskUsage >= 90) tags.push(`磁盘 ${Math.round(probe.diskUsage)}%`);
  return tags.join(' · ') || '异常';
}

// 最近主机：localStorage 优先，否则取首台 SSH 主机
const recentHost = computed<MainHost | null>(() => {
  let id: string | null = null;
  try { id = localStorage.getItem('1shell-last-host'); } catch { /* ignore */ }
  if (id) {
    const found = hosts.value.find((host) => host.id === id);
    if (found) return found;
  }
  return sshHosts.value[0] || null;
});

const recentHostProbe = computed(() => {
  const host = recentHost.value;
  if (!host) return null;
  return probeMap.value.get(host.id) || null;
});

const countryCount = computed(() => new Set(geo.hosts.value.map((host) => host.countryCode).filter(Boolean)).size);
const cityCount = computed(() => new Set(geo.hosts.value.map((host) => `${host.countryCode}:${host.city}`).filter((key) => !key.endsWith(':null'))).size);

const isEmpty = computed(() => geo.hosts.value.length === 0 && geo.unresolved.value.length === 0 && !geo.loading.value);

const quickLinks = [
  { label: '运行', icon: 'play-square', to: '/panel/workloads' },
  { label: '探针', icon: 'radio', to: '/panel/probe' },
  { label: '文件', icon: 'folder', to: '/panel/files' },
  { label: '审计', icon: 'clipboard', to: '/panel/audit' },
];

async function loadHosts(): Promise<void> {
  try {
    const data = await requestJson<HostsListResponse>('/api/hosts');
    hosts.value = data.hosts || [];
  } catch { /* 静默：未登录 / 网络错误 */ }
}

async function loadProbes(): Promise<void> {
  try {
    const snap = await requestJson<ProbeSnapshot>('/api/probes');
    probes.value = snap.probes || [];
  } catch { /* 静默 */ }
}

function onNodeClick(host: GeoHost, x: number, y: number): void {
  if (activeTooltip.value?.host.id === host.id) {
    activeTooltip.value = null;
    return;
  }
  activeTooltip.value = { host, x, y };
}

function closeTooltip(): void {
  activeTooltip.value = null;
}

function onConnect(hostId: string): void {
  router.push({ path: '/agent', query: { host: hostId } });
}

function connectRecent(): void {
  const host = recentHost.value;
  if (!host) {
    router.push('/agent');
    return;
  }
  onConnect(host.id);
}

function onLocateFromTooltip(hostId: string, hostName: string): void {
  const found = geo.hosts.value.find((host) => host.id === hostId);
  locateTarget.value = {
    hostId,
    hostName,
    existing: found
      ? {
          countryCode: found.countryCode,
          country: found.country,
          city: found.city,
          lat: found.lat,
          lng: found.lng,
        }
      : null,
  };
  activeTooltip.value = null;
}

function onLocateFromUnresolved(hostId: string, hostName: string): void {
  locateTarget.value = { hostId, hostName, existing: null };
  showUnresolved.value = false;
}

async function onLocateSaved(): Promise<void> {
  await geo.refresh(true);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') activeTooltip.value = null;
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  void loadHosts();
  void loadProbes();
  pollHandle = setInterval(() => { void loadProbes(); }, POLL_MS);
  await geo.refresh();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
});
</script>

<template>
  <div class="h-full min-h-0 overflow-auto bg-slate-50 text-slate-800 dark:bg-[#07111f] dark:text-slate-100" @click="closeTooltip">
    <div class="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-4 p-4">
      <!-- 左地图 + 右信息栏 -->
      <section class="grid flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div class="relative h-[56vh] min-h-[420px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.04] xl:h-auto xl:min-h-[520px]">
          <HomeLeafletMap :hosts="geo.hosts.value" @node-click="onNodeClick" />

          <!-- 左上角信息 chip -->
          <div class="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2" @click.stop>
            <span class="rounded-full border border-slate-200/80 bg-white/85 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
              全球部署 · {{ geo.hosts.value.length }} 台主机
            </span>
            <button
              v-if="geo.unresolved.value.length > 0"
              type="button"
              class="rounded-full border border-slate-300 bg-white/85 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur transition hover:border-sky-300 hover:text-sky-700"
              @click="showUnresolved = true"
            >
              {{ geo.unresolved.value.length }} 台未定位
            </button>
          </div>

          <!-- 空状态 -->
          <div v-if="isEmpty" class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div class="pointer-events-auto rounded-2xl border border-slate-200 bg-white/95 px-6 py-4 text-center shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/90">
              <p class="text-base font-semibold text-slate-800 dark:text-slate-100">还没有 VPS</p>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">去 Agent 页添加第一台主机</p>
              <button
                type="button"
                class="mt-3 h-8 rounded-lg bg-sky-600 px-4 text-sm font-medium text-white transition hover:bg-sky-500"
                @click.stop="router.push('/agent')"
              >
                打开 Agent →
              </button>
            </div>
          </div>
        </div>

        <aside class="flex min-h-0 flex-col gap-4">
          <!-- 概览 -->
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div class="grid grid-cols-2 gap-x-3 gap-y-4">
              <div>
                <p class="text-xs text-slate-500 dark:text-slate-400">主机总数</p>
                <p class="mt-1 text-2xl font-semibold leading-none">{{ totalCount }}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500 dark:text-slate-400">在线</p>
                <p class="mt-1 text-2xl font-semibold leading-none text-emerald-600 dark:text-emerald-300">{{ onlineCount }}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500 dark:text-slate-400">异常</p>
                <p class="mt-1 text-2xl font-semibold leading-none" :class="abnormalCount > 0 ? 'text-rose-600 dark:text-rose-300' : ''">{{ abnormalCount }}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500 dark:text-slate-400">部署范围</p>
                <p class="mt-1 text-2xl font-semibold leading-none">{{ countryCount }} <span class="text-sm font-normal text-slate-500 dark:text-slate-400">国 · {{ cityCount }} 城</span></p>
              </div>
            </div>
          </div>

          <!-- 最近主机 -->
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div class="flex items-center gap-2 text-sm font-semibold">
              <AppIcon name="recent-host" :size="16" class="text-slate-400" />
              <span>最近主机</span>
            </div>
            <div v-if="recentHost" class="mt-3">
              <p class="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{{ recentHost.name }}</p>
              <p class="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">{{ recentHost.username }}@{{ recentHost.host }}</p>
              <div class="mt-3 flex items-center justify-between gap-2">
                <span class="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <span
                    class="h-2 w-2 rounded-full"
                    :class="recentHostProbe?.online ? 'bg-emerald-500' : recentHostProbe ? 'bg-rose-500' : 'bg-slate-400'"
                  ></span>
                  {{ recentHostProbe?.online ? '在线' : (recentHostProbe ? '离线' : '未探测') }}
                </span>
                <button
                  type="button"
                  class="h-8 rounded-lg bg-sky-600 px-3 text-xs font-medium text-white transition hover:bg-sky-500"
                  @click="connectRecent"
                >
                  连接
                </button>
              </div>
            </div>
            <p v-else class="mt-3 text-sm text-slate-500 dark:text-slate-400">还没有 VPS，去 Agent 页添加</p>
          </div>

          <!-- 异常主机 -->
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <AppIcon name="alert" :size="16" class="text-slate-400" />
                <span>异常主机</span>
              </div>
              <span
                v-if="abnormalCount > 0"
                class="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
              >{{ abnormalCount }}</span>
            </div>
            <ul v-if="abnormalCount > 0" class="mt-3 space-y-1.5">
              <li
                v-for="host in abnormalHosts.slice(0, 5)"
                :key="host.id"
                class="flex items-center justify-between gap-2 rounded-lg border border-rose-100 bg-rose-50/60 px-2.5 py-1.5 text-xs dark:border-rose-400/15 dark:bg-rose-400/[0.06]"
              >
                <span class="truncate font-medium text-slate-700 dark:text-slate-200">{{ host.name }}</span>
                <span class="shrink-0 font-mono text-[11px] text-rose-600 dark:text-rose-300">{{ abnormalReason(host) }}</span>
              </li>
            </ul>
            <p v-if="abnormalCount > 5" class="mt-2 text-center text-[11px] text-slate-400">还有 {{ abnormalCount - 5 }} 台 …</p>
            <div v-if="abnormalCount === 0" class="mt-3 flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-300">
              <AppIcon name="check" :size="14" :stroke-width="2.4" />
              <span>{{ totalCount > 0 ? '全部主机运行正常' : '暂无主机' }}</span>
            </div>
            <button
              type="button"
              class="mt-3 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:text-slate-300 dark:hover:text-sky-200"
              @click="router.push('/panel/probe')"
            >
              打开探针中心
            </button>
          </div>

          <!-- 快捷入口 -->
          <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div class="flex items-center gap-2 text-sm font-semibold">
              <AppIcon name="zap" :size="16" class="text-slate-400" />
              <span>快捷入口</span>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <button
                v-for="link in quickLinks"
                :key="link.to"
                type="button"
                class="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 dark:border-white/10 dark:text-slate-300 dark:hover:bg-sky-400/10 dark:hover:text-sky-200"
                @click="router.push(link.to)"
              >
                <AppIcon :name="link.icon" :size="15" />
                <span>{{ link.label }}</span>
              </button>
            </div>
          </div>
        </aside>
      </section>
    </div>

    <HostTooltip
      v-if="activeTooltip"
      :host="activeTooltip.host"
      :x="activeTooltip.x"
      :y="activeTooltip.y"
      @connect="onConnect"
      @locate="onLocateFromTooltip"
      @close="activeTooltip = null"
    />
    <UnresolvedModal
      v-if="showUnresolved"
      :unresolved="geo.unresolved.value"
      @close="showUnresolved = false"
      @locate="onLocateFromUnresolved"
    />
    <ManualLocationModal
      v-if="locateTarget"
      :host-id="locateTarget.hostId"
      :host-name="locateTarget.hostName"
      :existing="locateTarget.existing"
      @close="locateTarget = null"
      @saved="onLocateSaved"
    />
  </div>
</template>
