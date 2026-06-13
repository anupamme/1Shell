<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import SecretRefPicker from '@/components/SecretRefPicker.vue';
import type { IdeApprovalRequest } from '@/composables/useIdeChat';

withDefaults(defineProps<{
  request: IdeApprovalRequest | null;
  customText: string;
  density?: 'full' | 'compact';
}>(), {
  density: 'full',
});

const emit = defineEmits<{
  'update:customText': [value: string];
  allow: [];
  deny: [];
  custom: [];
  secretSubmit: [secretRef: string];
}>();

function onCustomKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('custom');
  }
}

function placeholder(request: IdeApprovalRequest): string {
  return request.mode === 'request_secret' ? '填写 secret ref/id...' : '自定义回复...';
}
</script>

<template>
  <section v-if="request" class="ide-approval-card" :class="`ide-approval-card--${density}`">
    <header class="ide-approval-head">
      <span class="ide-approval-icon">
        <AppIcon name="shield" :size="15" />
      </span>
      <div class="ide-approval-title">
        <strong>{{ request.title }}</strong>
        <span>{{ request.countdown }}s</span>
      </div>
    </header>

    <div class="ide-approval-body">
      <div class="ide-approval-desc">
        <template v-if="request.mode === 'approval'">AI 要执行 {{ request.toolName }}</template>
        <template v-else-if="request.mode === 'request_secret'">AI 需要 Secret 引用</template>
        <template v-else>AI 需要你补充信息</template>
      </div>
      <pre class="ide-approval-detail">{{ request.detail }}</pre>
      <SecretRefPicker
        v-if="request.mode === 'request_secret'"
        :secret-name="request.secretName"
        :label="request.label"
        :provider="request.provider"
        @submit="(secretRef) => emit('secretSubmit', secretRef)"
      />
    </div>

    <footer class="ide-approval-actions">
      <button type="button" class="ide-approval-btn ide-approval-btn--deny" @click="emit('deny')">
        拒绝
      </button>
      <div class="ide-approval-custom">
        <input
          :value="customText"
          type="text"
          class="ide-approval-input"
          :placeholder="placeholder(request)"
          @input="emit('update:customText', ($event.target as HTMLInputElement).value)"
          @keydown="onCustomKeydown"
        />
        <button type="button" class="ide-approval-btn ide-approval-btn--custom" @click="emit('custom')">
          回复
        </button>
      </div>
      <button
        v-if="request.mode === 'approval'"
        type="button"
        class="ide-approval-btn ide-approval-btn--allow"
        @click="emit('allow')"
      >
        允许
      </button>
    </footer>
  </section>
</template>

<style scoped>
.ide-approval-card {
  border: 1px solid rgba(245, 158, 11, 0.34);
  border-radius: 8px;
  background: rgba(255, 251, 235, 0.94);
  color: #0f172a;
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.12);
  overflow: hidden;
}

:global(html.dark) .ide-approval-card {
  background: rgba(30, 41, 59, 0.92);
  border-color: rgba(245, 158, 11, 0.42);
  color: #e2e8f0;
}

.ide-approval-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(245, 158, 11, 0.22);
}

.ide-approval-card--compact .ide-approval-head {
  padding: 8px 10px;
}

.ide-approval-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #b45309;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.32);
}

.ide-approval-title {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ide-approval-title strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.ide-approval-title span {
  flex: none;
  font-size: 11px;
  color: #92400e;
}

:global(html.dark) .ide-approval-title span {
  color: #fcd34d;
}

.ide-approval-body {
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}

.ide-approval-card--compact .ide-approval-body {
  padding: 8px 10px;
}

.ide-approval-desc {
  font-size: 12px;
  color: #64748b;
}

:global(html.dark) .ide-approval-desc {
  color: #cbd5e1;
}

.ide-approval-detail {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  padding: 9px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  line-height: 1.5;
}

.ide-approval-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(245, 158, 11, 0.18);
}

.ide-approval-card--compact .ide-approval-actions {
  padding: 8px 10px;
}

.ide-approval-custom {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ide-approval-input {
  min-width: 0;
  flex: 1;
  min-height: 36px;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: rgba(255, 255, 255, 0.92);
  color: #0f172a;
  padding: 0 9px;
  font-size: 12px;
  outline: none;
}

.ide-approval-input:focus {
  border-color: #0284c7;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.16);
}

:global(html.dark) .ide-approval-input {
  background: rgba(2, 6, 23, 0.72);
  border-color: rgba(71, 85, 105, 0.9);
  color: #e2e8f0;
}

.ide-approval-btn {
  min-height: 36px;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0 11px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.ide-approval-btn--deny {
  color: #b91c1c;
  border-color: rgba(220, 38, 38, 0.28);
  background: rgba(254, 242, 242, 0.92);
}

.ide-approval-btn--deny:hover {
  background: #fee2e2;
}

.ide-approval-btn--custom {
  color: #0369a1;
  border-color: rgba(14, 165, 233, 0.3);
  background: rgba(240, 249, 255, 0.92);
}

.ide-approval-btn--custom:hover {
  background: #e0f2fe;
}

.ide-approval-btn--allow {
  color: #ffffff;
  background: #059669;
}

.ide-approval-btn--allow:hover {
  background: #047857;
}

@media (max-width: 520px) {
  .ide-approval-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .ide-approval-custom {
    width: 100%;
  }
}
</style>
