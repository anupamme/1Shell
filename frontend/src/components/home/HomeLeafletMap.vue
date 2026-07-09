<script setup lang="ts">
// 主页真实地图：Leaflet + CARTO Positron 浅色底图（固定浅色，不随主题切换）
import { onActivated, onBeforeUnmount, onMounted, watch, ref } from 'vue';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoHost } from '@/composables/useGeoHosts';

const props = defineProps<{
  hosts: GeoHost[];
}>();

const emit = defineEmits<{
  'node-click': [host: GeoHost, x: number, y: number];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let map: L.Map | null = null;
let markerLayer: L.LayerGroup | null = null;
let resizeObserver: ResizeObserver | null = null;
let hasFitted = false;

// 瓦片走后端同源代理（/api/map/tiles）：CSP 不放行外域、浏览器不直连第三方，
// 服务端负责 CARTO Voyager → Positron → OSM 降级与磁盘缓存。
// v 是缓存版本号：旧版本曾把灰色降级瓦片按 7 天下发给浏览器，升版本一次性作废
const TILE_URL = '/api/map/tiles/{z}/{x}/{y}{r}.png?v=2';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>';

// 在线 = 品牌蓝，离线 = 玫红，未探测 = 中性灰
function markerColor(host: GeoHost): string {
  if (host.online === false) return '#e11d48';
  if (host.online === true) return '#0284c7';
  return '#64748b';
}

// divIcon 节点：16px 实心点 + 脉冲光环，整个 34×34 区域可点，比 circleMarker 显眼且好点
function nodeIcon(host: GeoHost): L.DivIcon {
  const color = markerColor(host);
  const pulse = host.online === undefined || host.online === null ? '' : '<span class="node-pulse"></span>';
  return L.divIcon({
    className: 'home-map-node',
    html: `<span class="node-wrap" style="--node-color:${color}">${pulse}<span class="node-dot"></span></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function locatedHosts(): GeoHost[] {
  return props.hosts.filter((host) => Number.isFinite(host.lat) && Number.isFinite(host.lng));
}

function renderMarkers(): void {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  for (const host of locatedHosts()) {
    const marker = L.marker([host.lat, host.lng], { icon: nodeIcon(host), keyboard: false });
    marker.bindTooltip(host.name, { direction: 'top', offset: L.point(0, -14), opacity: 0.95 });
    marker.on('click', (event: L.LeafletMouseEvent) => {
      // 必须拦原生 DOM 事件：Leaflet 包装事件拦不住冒泡，会冒到页面根节点的
      // closeTooltip，把刚打开的气泡当场关掉
      event.originalEvent.stopPropagation();
      emit('node-click', host, event.originalEvent.clientX, event.originalEvent.clientY);
    });
    markerLayer.addLayer(marker);
  }
}

function fitToHosts(): void {
  if (!map) return;
  const points = locatedHosts().map((host) => [host.lat, host.lng] as [number, number]);
  if (!points.length) {
    map.setView([28, 12], 2);
    return;
  }
  map.fitBounds(L.latLngBounds(points), { padding: [56, 56], maxZoom: 6 });
}

onMounted(() => {
  if (!containerRef.value) return;
  map = L.map(containerRef.value, {
    zoomControl: false,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 12,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // 去掉 “Leaflet + 国旗” 前缀，保留 OSM / CARTO 数据来源署名（使用条款要求）
  map.attributionControl.setPrefix('');
  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 12,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  fitToHosts();
  renderMarkers();
  if (locatedHosts().length) hasFitted = true;

  resizeObserver = new ResizeObserver(() => {
    map?.invalidateSize();
  });
  resizeObserver.observe(containerRef.value);
});

watch(() => props.hosts, () => {
  renderMarkers();
  if (!hasFitted && locatedHosts().length) {
    hasFitted = true;
    fitToHosts();
  }
});

onActivated(() => {
  map?.invalidateSize();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  map?.remove();
  map = null;
  markerLayer = null;
});
</script>

<template>
  <div ref="containerRef" class="home-leaflet-map h-full w-full"></div>
</template>

<style scoped>
.home-leaflet-map {
  position: relative;
  z-index: 0;
  background: #cfe3ee; /* 贴近 Voyager 水面色，瓦片加载间隙不突兀 */
  isolation: isolate;
  font-family: inherit;
}

/* 控件贴合应用视觉：圆角、细边框、无默认粗描边 */
.home-leaflet-map :deep(.leaflet-control-zoom) {
  border: none;
  box-shadow: 0 2px 10px rgba(30, 58, 95, 0.14);
  border-radius: 10px;
  overflow: hidden;
}
.home-leaflet-map :deep(.leaflet-control-zoom a) {
  width: 30px;
  height: 30px;
  line-height: 30px;
  color: #334155;
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
}
.home-leaflet-map :deep(.leaflet-control-zoom a:last-child) {
  border-bottom: none;
}
.home-leaflet-map :deep(.leaflet-control-attribution) {
  background: rgba(255, 255, 255, 0.75);
  color: #64748b;
  font-size: 10px;
}
.home-leaflet-map :deep(.leaflet-tooltip) {
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.4);
  box-shadow: 0 4px 14px rgba(30, 58, 95, 0.16);
  color: #1e293b;
  font-weight: 600;
  font-size: 12px;
}
</style>

<!-- 节点样式放非 scoped 块：divIcon 的 HTML 注入在 Leaflet pane 里，且 @keyframes 不吃 scoped -->
<style>
.home-map-node {
  background: transparent;
  border: none;
}
.home-map-node .node-wrap {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
.home-map-node .node-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border-radius: 50%;
  background: var(--node-color, #0284c7);
  border: 3px solid #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.4), 0 3px 10px rgba(15, 23, 42, 0.25);
  transition: transform 0.15s ease;
}
.home-map-node:hover .node-dot {
  transform: scale(1.2);
}
.home-map-node .node-pulse {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 34px;
  height: 34px;
  margin: -17px 0 0 -17px;
  border-radius: 50%;
  background: var(--node-color, #0284c7);
  animation: home-node-pulse 2s ease-out infinite;
  pointer-events: none;
}
@keyframes home-node-pulse {
  0%   { transform: scale(0.35); opacity: 0.5; }
  70%  { transform: scale(1); opacity: 0; }
  100% { transform: scale(1); opacity: 0; }
}
</style>
