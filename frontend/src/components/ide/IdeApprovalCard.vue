<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import SecretRefPicker from '@/components/SecretRefPicker.vue';
import type { IdeApprovalRequest } from '@/composables/useIdeChat';

const props = withDefaults(defineProps<{
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

const customHasText = computed(() => props.customText.trim().length > 0);

const aiWorkNote = computed(() => String(props.request?.workNote || '').trim());

const harnessReason = computed(() => {
  const request = props.request;
  if (!request || request.mode !== 'approval') return '';
  return String(request.reason || request.riskReason || '').trim();
});

const promptTitle = computed(() => {
  const request = props.request;
  if (!request) return '';
  if (request.mode === 'approval') return `允许 1Shell AI ${request.title || '执行此操作'}吗？`;
  return request.title || (request.mode === 'request_secret' ? '需要 Secret 引用' : '需要补充信息');
});

const promptLead = computed(() => {
  const request = props.request;
  if (!request) return '';
  if (request.mode === 'approval') {
    if (aiWorkNote.value) return '下面展示 1Shell AI 的真实工作笔记；harness 的审批理由会单独列出。';
    return request.reason || request.riskReason || 'harness 判断该操作需要你确认后才会继续。';
  }
  if (request.mode === 'request_secret') return request.reason || '1Shell AI 需要一个已保存的 secret ref/id。';
  return request.reason || '1Shell AI 需要你补充信息后继续。';
});

const actionLabel = computed(() => {
  const request = props.request;
  if (!request) return '操作内容';
  if (request.mode === 'approval') {
    if (request.actionKind === 'command') return '将要执行的命令';
    if (request.actionKind?.startsWith('file')) return '将要执行的文件操作';
    return '将要执行的操作';
  }
  if (request.mode === 'request_secret') return '请求内容';
  return '问题';
});

const actionText = computed(() => {
  const request = props.request;
  if (!request) return '';
  const explicit = String(request.actionText || '').trim();
  if (explicit) return explicit;
  const detail = String(request.detail || '').trim();
  if (detail) return detail;
  if (request.input !== undefined) {
    try {
      return JSON.stringify(request.input, null, 2);
    } catch {
      return String(request.input);
    }
  }
  return '';
});

const detailText = computed(() => {
  const request = props.request;
  if (!request) return '';
  const detail = String(request.detail || '').trim();
  if (!detail || detail === actionText.value) return '';
  if (request.actionText && detail.includes(request.actionText)) return '';
  return detail;
});

const riskText = computed(() => {
  const value = String(props.request?.riskLevel || '').trim().toLowerCase();
  const map: Record<string, string> = {
    safe: '安全',
    low: '低',
    medium: '中',
    high: '高',
    critical: '严重',
  };
  return map[value] || value || '';
});

const riskTone = computed(() => {
  const value = String(props.request?.riskLevel || '').trim().toLowerCase();
  if (value === 'critical' || value === 'high') return 'danger';
  if (value === 'medium') return 'warning';
  return 'neutral';
});

function placeholder(request: IdeApprovalRequest): string {
  if (request.mode === 'request_secret') return '填写 secret ref/id...';
  if (request.mode === 'ask_user') return '回复 1Shell AI...';
  return '告诉 1Shell AI 如何调整...';
}

function onCustomKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (customHasText.value) emit('custom');
  }
}
</script>

<template>
  <section
    v-if="request"
    class="ide-approval-card"
    :class="[`ide-approval-card--${density}`, `ide-approval-card--${riskTone}`]"
    role="dialog"
    aria-live="polite"
    :aria-label="promptTitle"
  >
    <header class="ide-approval-head">
      <span class="ide-approval-icon">
        <AppIcon name="shield" :size="16" />
      </span>
      <div class="ide-approval-copy">
        <div class="ide-approval-kicker">
          <span>需要确认</span>
          <span>{{ request.countdown }}s 后自动拒绝</span>
        </div>
        <h3>{{ promptTitle }}</h3>
        <p>{{ promptLead }}</p>
      </div>
    </header>

    <div class="ide-approval-meta" aria-label="审批事实">
      <span class="ide-approval-chip">
        <AppIcon name="wrench" :size="13" />
        {{ request.toolName }}
      </span>
      <span v-if="request.hostId" class="ide-approval-chip">
        <AppIcon name="server" :size="13" />
        {{ request.hostId }}
      </span>
      <span v-if="riskText" class="ide-approval-chip" :class="`ide-approval-chip--${riskTone}`">
        风险 {{ riskText }}
      </span>
    </div>

    <div class="ide-approval-body">
      <div v-if="aiWorkNote" class="ide-approval-note ide-approval-note--ai">
        <div class="ide-approval-note-title">
          <AppIcon name="spark" :size="13" />
          <span>1Shell AI 的工作笔记</span>
        </div>
        <p>{{ aiWorkNote }}</p>
      </div>

      <div v-if="harnessReason" class="ide-approval-note ide-approval-note--harness">
        <div class="ide-approval-note-title">
          <AppIcon name="shield" :size="13" />
          <span>harness 审批理由</span>
        </div>
        <p>{{ harnessReason }}</p>
      </div>

      <div class="ide-approval-command-head">
        <span>{{ actionLabel }}</span>
      </div>
      <pre class="ide-approval-command">{{ actionText || request.detail || '(无可显示内容)' }}</pre>
      <p v-if="detailText" class="ide-approval-detail">{{ detailText }}</p>

      <SecretRefPicker
        v-if="request.mode === 'request_secret'"
        :secret-name="request.secretName"
        :label="request.label"
        :provider="request.provider"
        @submit="(secretRef) => emit('secretSubmit', secretRef)"
      />
    </div>

    <footer class="ide-approval-actions">
      <template v-if="request.mode === 'approval'">
        <button type="button" class="ide-approval-decision ide-approval-decision--allow" @click="emit('allow')">
          <span class="ide-approval-index">1</span>
          <span>
            <strong>是，允许执行</strong>
            <small>只允许当前这次操作</small>
          </span>
          <AppIcon name="check" :size="16" />
        </button>

        <div class="ide-approval-custom-decision">
          <span class="ide-approval-index">2</span>
          <input
            :value="customText"
            type="text"
            class="ide-approval-input"
            :placeholder="placeholder(request)"
            @input="emit('update:customText', ($event.target as HTMLInputElement).value)"
            @keydown="onCustomKeydown"
          />
          <button
            type="button"
            class="ide-approval-send"
            :disabled="!customHasText"
            @click="emit('custom')"
          >
            提交
          </button>
        </div>

        <button type="button" class="ide-approval-decision ide-approval-decision--deny" @click="emit('deny')">
          <span class="ide-approval-index">3</span>
          <span>
            <strong>否，拒绝</strong>
            <small>停止这次工具调用</small>
          </span>
          <AppIcon name="close" :size="16" />
        </button>
      </template>

      <template v-else>
        <div class="ide-approval-custom-decision ide-approval-custom-decision--primary">
          <span class="ide-approval-index">1</span>
          <input
            :value="customText"
            type="text"
            class="ide-approval-input"
            :placeholder="placeholder(request)"
            @input="emit('update:customText', ($event.target as HTMLInputElement).value)"
            @keydown="onCustomKeydown"
          />
          <button
            type="button"
            class="ide-approval-send"
            :disabled="!customHasText"
            @click="emit('custom')"
          >
            提交
          </button>
        </div>
        <button type="button" class="ide-approval-decision ide-approval-decision--deny" @click="emit('deny')">
          <span class="ide-approval-index">2</span>
          <span>
            <strong>取消</strong>
            <small>不提供这项信息</small>
          </span>
          <AppIcon name="close" :size="16" />
        </button>
      </template>
    </footer>
  </section>
</template>

<style scoped>
.ide-approval-card {
  min-height: 0;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.38);
  border-radius: 8px;
  background: #f8fafc;
  color: #0f172a;
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.16);
}

:global(.dark) .ide-approval-card {
  border-color: rgba(71, 85, 105, 0.9);
  background: #111827;
  color: #e5e7eb;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.34);
}

.ide-approval-card--warning {
  border-color: rgba(217, 119, 6, 0.48);
}

.ide-approval-card--danger {
  border-color: rgba(220, 38, 38, 0.5);
}

.ide-approval-head {
  flex: none;
  display: flex;
  gap: 10px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.24);
}

.ide-approval-card--compact .ide-approval-head {
  padding: 12px 12px 10px;
}

.ide-approval-icon {
  flex: none;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(37, 99, 235, 0.28);
  border-radius: 8px;
  color: #1d4ed8;
  background: rgba(37, 99, 235, 0.08);
}

.ide-approval-card--warning .ide-approval-icon {
  border-color: rgba(217, 119, 6, 0.34);
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
}

.ide-approval-card--danger .ide-approval-icon {
  border-color: rgba(220, 38, 38, 0.34);
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.1);
}

.ide-approval-copy {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.ide-approval-kicker {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
}

:global(.dark) .ide-approval-kicker {
  color: #94a3b8;
}

.ide-approval-copy h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.35;
  font-weight: 800;
  letter-spacing: 0;
}

.ide-approval-card--compact .ide-approval-copy h3 {
  font-size: 14px;
}

.ide-approval-copy p {
  margin: 0;
  color: #475569;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}

:global(.dark) .ide-approval-copy p {
  color: #cbd5e1;
}

.ide-approval-meta {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px 0;
}

.ide-approval-card--compact .ide-approval-meta {
  padding: 8px 12px 0;
}

.ide-approval-chip {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 999px;
  padding: 0 8px;
  color: #475569;
  background: rgba(255, 255, 255, 0.76);
  font-size: 11px;
  font-weight: 700;
}

.ide-approval-chip--warning {
  border-color: rgba(217, 119, 6, 0.3);
  color: #92400e;
  background: rgba(254, 243, 199, 0.84);
}

.ide-approval-chip--danger {
  border-color: rgba(220, 38, 38, 0.3);
  color: #991b1b;
  background: rgba(254, 226, 226, 0.84);
}

:global(.dark) .ide-approval-chip {
  border-color: rgba(71, 85, 105, 0.9);
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.76);
}

:global(.dark) .ide-approval-chip--warning {
  border-color: rgba(245, 158, 11, 0.36);
  color: #fbbf24;
  background: rgba(120, 53, 15, 0.24);
}

:global(.dark) .ide-approval-chip--danger {
  border-color: rgba(248, 113, 113, 0.36);
  color: #fca5a5;
  background: rgba(127, 29, 29, 0.28);
}

.ide-approval-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  display: grid;
  gap: 8px;
  padding: 12px 14px;
}

.ide-approval-card--compact .ide-approval-body {
  padding: 10px 12px;
}

.ide-approval-command-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #64748b;
  font-size: 11px;
  font-weight: 800;
}

:global(.dark) .ide-approval-command-head {
  color: #94a3b8;
}

.ide-approval-note {
  display: grid;
  gap: 6px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.68);
  padding: 9px 10px;
}

.ide-approval-note--ai {
  border-color: rgba(14, 165, 233, 0.24);
  background: rgba(224, 242, 254, 0.52);
}

.ide-approval-note--harness {
  border-color: rgba(148, 163, 184, 0.34);
  background: rgba(248, 250, 252, 0.74);
}

.ide-approval-note-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #475569;
  font-size: 11px;
  font-weight: 800;
}

.ide-approval-note--ai .ide-approval-note-title {
  color: #0369a1;
}

.ide-approval-note p {
  margin: 0;
  color: #334155;
  font-size: 12px;
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;
}

:global(.dark) .ide-approval-note {
  border-color: rgba(71, 85, 105, 0.82);
  background: rgba(15, 23, 42, 0.58);
}

:global(.dark) .ide-approval-note--ai {
  border-color: rgba(56, 189, 248, 0.22);
  background: rgba(14, 165, 233, 0.1);
}

:global(.dark) .ide-approval-note-title {
  color: #cbd5e1;
}

:global(.dark) .ide-approval-note--ai .ide-approval-note-title {
  color: #7dd3fc;
}

:global(.dark) .ide-approval-note p {
  color: #dbeafe;
}

.ide-approval-command {
  margin: 0;
  max-height: 190px;
  overflow: auto;
  border: 1px solid rgba(15, 23, 42, 0.86);
  border-radius: 8px;
  background: #111827;
  color: #e5e7eb;
  padding: 11px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
}

.ide-approval-card--compact .ide-approval-command {
  max-height: 140px;
  font-size: 11px;
}

.ide-approval-detail {
  margin: 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

:global(.dark) .ide-approval-detail {
  color: #94a3b8;
}

.ide-approval-actions {
  flex: none;
  display: grid;
  gap: 8px;
  border-top: 1px solid rgba(148, 163, 184, 0.22);
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.94), #f8fafc);
  padding: 10px 14px 14px;
}

:global(.dark) .ide-approval-actions {
  border-top-color: rgba(71, 85, 105, 0.75);
  background: linear-gradient(180deg, rgba(17, 24, 39, 0.94), #111827);
}

.ide-approval-card--compact .ide-approval-actions {
  padding: 9px 12px 12px;
}

.ide-approval-decision,
.ide-approval-custom-decision {
  min-width: 0;
  min-height: 44px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.82);
  color: #0f172a;
  padding: 8px 10px;
}

.ide-approval-decision {
  cursor: pointer;
  text-align: left;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.ide-approval-decision:hover {
  border-color: rgba(59, 130, 246, 0.38);
  background: #ffffff;
}

.ide-approval-decision:focus-visible,
.ide-approval-send:focus-visible,
.ide-approval-input:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.2);
}

.ide-approval-decision strong {
  display: block;
  font-size: 13px;
  line-height: 1.25;
}

.ide-approval-decision small {
  display: block;
  margin-top: 2px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.35;
}

.ide-approval-index {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #e2e8f0;
  color: #0f172a;
  font-size: 12px;
  font-weight: 800;
}

.ide-approval-decision--allow {
  border-color: rgba(5, 150, 105, 0.32);
}

.ide-approval-decision--allow:hover {
  background: rgba(236, 253, 245, 0.95);
}

.ide-approval-decision--allow .ide-approval-index {
  background: #059669;
  color: #ffffff;
}

.ide-approval-decision--deny {
  border-color: rgba(220, 38, 38, 0.28);
}

.ide-approval-decision--deny:hover {
  background: rgba(254, 242, 242, 0.95);
}

.ide-approval-decision--deny .ide-approval-index {
  background: #fee2e2;
  color: #991b1b;
}

.ide-approval-custom-decision {
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.ide-approval-input {
  min-width: 0;
  width: 100%;
  min-height: 34px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.94);
  color: #0f172a;
  padding: 0 10px;
  font-size: 12px;
}

.ide-approval-send {
  min-height: 34px;
  border: 1px solid rgba(37, 99, 235, 0.28);
  border-radius: 7px;
  background: #ffffff;
  color: #1d4ed8;
  padding: 0 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.ide-approval-send:hover:not(:disabled) {
  border-color: rgba(37, 99, 235, 0.48);
  background: #eff6ff;
}

.ide-approval-send:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

:global(.dark) .ide-approval-decision,
:global(.dark) .ide-approval-custom-decision {
  border-color: rgba(71, 85, 105, 0.9);
  background: rgba(15, 23, 42, 0.74);
  color: #e5e7eb;
}

:global(.dark) .ide-approval-decision:hover {
  border-color: rgba(96, 165, 250, 0.42);
  background: rgba(30, 41, 59, 0.88);
}

:global(.dark) .ide-approval-decision small {
  color: #94a3b8;
}

:global(.dark) .ide-approval-index {
  background: #334155;
  color: #f8fafc;
}

:global(.dark) .ide-approval-input {
  border-color: rgba(71, 85, 105, 0.9);
  background: rgba(2, 6, 23, 0.82);
  color: #e5e7eb;
}

:global(.dark) .ide-approval-send {
  border-color: rgba(96, 165, 250, 0.38);
  background: rgba(15, 23, 42, 0.9);
  color: #93c5fd;
}

:global(.dark) .ide-approval-send:hover:not(:disabled) {
  background: rgba(30, 64, 175, 0.22);
}

@media (max-width: 520px) {
  .ide-approval-head {
    padding: 12px;
  }

  .ide-approval-kicker {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .ide-approval-custom-decision {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .ide-approval-custom-decision .ide-approval-send {
    grid-column: 2;
    width: 100%;
  }
}
</style>
