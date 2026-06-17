<script setup lang="ts">
import { computed } from 'vue';
import { hostAddressText, parseHostListResult, type StructuredHost } from '@/utils/structuredToolResults';

const props = withDefaults(defineProps<{
  result: unknown;
  compact?: boolean;
}>(), {
  compact: false,
});

const parsed = computed(() => parseHostListResult(props.result));

function hostName(host: StructuredHost): string {
  return host.name || host.id || '-';
}
</script>

<template>
  <div v-if="parsed" class="host-list-result" :class="{ 'host-list-result--compact': compact }">
    <div class="host-list-result__summary">
      <strong>{{ parsed.hosts.length }} 台主机</strong>
      <span v-if="parsed.summary">{{ parsed.summary }}</span>
    </div>
    <div class="host-list-result__table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>ID</th>
            <th>名称</th>
            <th>地址</th>
            <th>类型</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(host, index) in parsed.hosts" :key="host.id || `${host.name}-${index}`">
            <td>{{ index + 1 }}</td>
            <td><code>{{ host.id || '-' }}</code></td>
            <td>{{ hostName(host) }}</td>
            <td><code>{{ hostAddressText(host) || '-' }}</code></td>
            <td>{{ host.type || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.host-list-result {
  display: grid;
  gap: 8px;
}

.host-list-result__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: #475569;
  font-size: 12px;
  line-height: 1.4;
}

.host-list-result__summary strong {
  color: #0f172a;
  font-weight: 760;
}

.host-list-result__summary span {
  color: #64748b;
}

.host-list-result__table-wrap {
  overflow-x: auto;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 8px;
  background: rgba(248, 250, 252, 0.82);
}

.host-list-result table {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.45;
}

.host-list-result th,
.host-list-result td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.92);
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
}

.host-list-result tbody tr:last-child td {
  border-bottom: 0;
}

.host-list-result th {
  color: #64748b;
  background: rgba(241, 245, 249, 0.92);
  font-size: 11px;
  font-weight: 760;
}

.host-list-result td {
  color: #334155;
}

.host-list-result code {
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  word-break: normal;
}

.host-list-result--compact table {
  min-width: 560px;
  font-size: 11px;
}

.host-list-result--compact th,
.host-list-result--compact td {
  padding: 7px 8px;
}

:global(.dark) .host-list-result__summary {
  color: #cbd5e1;
}

:global(.dark) .host-list-result__summary strong {
  color: #e2e8f0;
}

:global(.dark) .host-list-result__summary span {
  color: #94a3b8;
}

:global(.dark) .host-list-result__table-wrap {
  border-color: rgba(51, 65, 85, 0.86);
  background: rgba(2, 6, 23, 0.3);
}

:global(.dark) .host-list-result th {
  color: #94a3b8;
  background: rgba(15, 23, 42, 0.9);
}

:global(.dark) .host-list-result th,
:global(.dark) .host-list-result td {
  border-bottom-color: rgba(51, 65, 85, 0.76);
}

:global(.dark) .host-list-result td {
  color: #cbd5e1;
}

:global(.dark) .host-list-result code {
  color: #e2e8f0;
}
</style>
