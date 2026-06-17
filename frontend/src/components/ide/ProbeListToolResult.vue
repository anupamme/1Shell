<script setup lang="ts">
import { computed } from 'vue';
import { parseProbeListResult, type StructuredProbe } from '@/utils/structuredToolResults';

const props = withDefaults(defineProps<{
  result: unknown;
  compact?: boolean;
}>(), {
  compact: false,
});

const parsed = computed(() => parseProbeListResult(props.result));
const onlineCount = computed(() => parsed.value?.probes.filter((probe) => probe.online === true && !probe.error).length || 0);

function probeName(probe: StructuredProbe): string {
  return probe.name || probe.hostId || probe.hostname || '-';
}

function statusText(probe: StructuredProbe): string {
  if (probe.error) return '异常';
  if (probe.online === true) return probe.stale ? '旧数据' : '在线';
  if (probe.online === false) return '离线';
  return '未知';
}

function statusClass(probe: StructuredProbe): string {
  if (probe.error || probe.online === false) return 'probe-list-result__status--error';
  if (probe.stale) return 'probe-list-result__status--stale';
  if (probe.online === true) return 'probe-list-result__status--online';
  return 'probe-list-result__status--unknown';
}

function percent(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)}%`;
}

function load(value: number | null): string {
  return value === null ? '-' : value.toFixed(value >= 10 ? 1 : 2);
}

function latency(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)} ms`;
}
</script>

<template>
  <div v-if="parsed" class="probe-list-result" :class="{ 'probe-list-result--compact': compact }">
    <div class="probe-list-result__summary">
      <strong>{{ parsed.probes.length }} 台探针</strong>
      <span>{{ onlineCount }} 台在线</span>
      <span v-if="parsed.generatedAt">更新 {{ parsed.generatedAt }}</span>
      <span v-if="parsed.summary">{{ parsed.summary }}</span>
    </div>

    <div class="probe-list-result__table-wrap">
      <table>
        <thead>
          <tr>
            <th>主机</th>
            <th>状态</th>
            <th>系统</th>
            <th>CPU</th>
            <th>内存</th>
            <th>磁盘</th>
            <th>负载</th>
            <th>延迟</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="probe in parsed.probes" :key="probe.hostId || probe.name || probe.hostname">
            <td>
              <strong>{{ probeName(probe) }}</strong>
              <code v-if="probe.hostId && probe.hostId !== probeName(probe)">{{ probe.hostId }}</code>
            </td>
            <td>
              <span class="probe-list-result__status" :class="statusClass(probe)">
                <span></span>
                {{ statusText(probe) }}
              </span>
              <small v-if="probe.error">{{ probe.error }}</small>
            </td>
            <td>{{ probe.platform || '-' }}</td>
            <td>{{ percent(probe.cpuUsage) }}</td>
            <td>{{ percent(probe.memoryUsage) }}</td>
            <td>{{ percent(probe.diskUsage) }}</td>
            <td>{{ load(probe.load1) }}</td>
            <td>{{ latency(probe.latencyMs) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.probe-list-result {
  display: grid;
  gap: 8px;
}

.probe-list-result__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: #475569;
  font-size: 12px;
  line-height: 1.4;
}

.probe-list-result__summary strong {
  color: #0f172a;
  font-weight: 760;
}

.probe-list-result__summary span {
  color: #64748b;
}

.probe-list-result__table-wrap {
  overflow-x: auto;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 8px;
  background: rgba(248, 250, 252, 0.82);
}

.probe-list-result table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.45;
}

.probe-list-result th,
.probe-list-result td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.92);
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
}

.probe-list-result tbody tr:last-child td {
  border-bottom: 0;
}

.probe-list-result th {
  color: #64748b;
  background: rgba(241, 245, 249, 0.92);
  font-size: 11px;
  font-weight: 760;
}

.probe-list-result td {
  color: #334155;
}

.probe-list-result td:first-child {
  display: grid;
  gap: 2px;
}

.probe-list-result code {
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
}

.probe-list-result__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 650;
}

.probe-list-result__status span {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent);
}

.probe-list-result__status--online {
  color: #059669;
}

.probe-list-result__status--stale {
  color: #b45309;
}

.probe-list-result__status--error {
  color: #dc2626;
}

.probe-list-result__status--unknown {
  color: #64748b;
}

.probe-list-result small {
  display: block;
  margin-top: 2px;
  max-width: 220px;
  white-space: normal;
  color: #dc2626;
}

.probe-list-result--compact table {
  min-width: 700px;
  font-size: 11px;
}

.probe-list-result--compact th,
.probe-list-result--compact td {
  padding: 7px 8px;
}

:global(.dark) .probe-list-result__summary {
  color: #cbd5e1;
}

:global(.dark) .probe-list-result__summary strong {
  color: #e2e8f0;
}

:global(.dark) .probe-list-result__summary span {
  color: #94a3b8;
}

:global(.dark) .probe-list-result__table-wrap {
  border-color: rgba(51, 65, 85, 0.86);
  background: rgba(2, 6, 23, 0.3);
}

:global(.dark) .probe-list-result th {
  color: #94a3b8;
  background: rgba(15, 23, 42, 0.9);
}

:global(.dark) .probe-list-result th,
:global(.dark) .probe-list-result td {
  border-bottom-color: rgba(51, 65, 85, 0.76);
}

:global(.dark) .probe-list-result td {
  color: #cbd5e1;
}

:global(.dark) .probe-list-result code {
  color: #94a3b8;
}
</style>
