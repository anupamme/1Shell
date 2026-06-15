<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import type { IdeApprovalMode } from '@/composables/useIdeChat';

const props = withDefaults(defineProps<{
  modelValue: IdeApprovalMode;
  disabled?: boolean;
  density?: 'full' | 'compact';
}>(), {
  disabled: false,
  density: 'full',
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: IdeApprovalMode): void;
}>();

interface ApprovalModeOption {
  key: IdeApprovalMode;
  label: string;
  description: string;
  icon: string;
}

const modes: ApprovalModeOption[] = [
  {
    key: 'manual',
    label: '请求批准',
    description: '编辑外部文件和使用互联网时始终询问',
    icon: 'hand',
  },
  {
    key: 'delegated',
    label: '替我审批',
    description: '仅对检测到的风险操作请求批准',
    icon: 'shield',
  },
  {
    key: 'full_access',
    label: '完全访问权限',
    description: '可不受限制地访问互联网和您电脑上的任何文件',
    icon: 'alert',
  },
];

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const activeMode = computed(() => modes.find((mode) => mode.key === props.modelValue) || modes[0]);

function toggleOpen(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

function selectMode(mode: IdeApprovalMode): void {
  open.value = false;
  if (mode !== props.modelValue) emit('update:modelValue', mode);
}

function onDocumentPointerDown(event: PointerEvent): void {
  const root = rootEl.value;
  if (!root || root.contains(event.target as Node)) return;
  open.value = false;
}

document.addEventListener('pointerdown', onDocumentPointerDown);

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
});
</script>

<template>
  <div
    ref="rootEl"
    class="ide-approval-menu"
    :class="[
      `ide-approval-menu--${density}`,
      { 'ide-approval-menu--disabled': disabled },
    ]"
  >
    <button
      type="button"
      class="ide-approval-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggleOpen"
    >
      <AppIcon :name="activeMode.icon" :size="density === 'compact' ? 14 : 15" />
      <span>{{ activeMode.label }}</span>
      <AppIcon name="arrow-right" :size="density === 'compact' ? 12 : 13" class="ide-approval-trigger-chevron" />
    </button>

    <div v-if="open" class="ide-approval-popover" role="menu">
      <div class="ide-approval-popover-heading">应如何批准 Codex 操作？</div>
      <button
        v-for="mode in modes"
        :key="mode.key"
        type="button"
        class="ide-approval-option"
        :class="{ 'ide-approval-option--active': modelValue === mode.key }"
        role="menuitemradio"
        :aria-checked="modelValue === mode.key"
        @click="selectMode(mode.key)"
      >
        <span class="ide-approval-option-icon">
          <AppIcon :name="mode.icon" :size="17" />
        </span>
        <span class="ide-approval-option-copy">
          <strong>{{ mode.label }}</strong>
          <span>{{ mode.description }}</span>
        </span>
        <AppIcon v-if="modelValue === mode.key" name="check" :size="18" class="ide-approval-option-check" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.ide-approval-menu {
  position: relative;
  display: inline-flex;
  min-width: 0;
}

.ide-approval-trigger {
  min-height: 40px;
  max-width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.38);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 11px;
  color: #ea580c;
  background: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  font-size: 13px;
  font-weight: 760;
  line-height: 1;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.ide-approval-menu--compact .ide-approval-trigger {
  min-height: 34px;
  padding: 0 9px;
  font-size: 12px;
}

.ide-approval-trigger:hover:not(:disabled),
.ide-approval-trigger:focus-visible {
  border-color: rgba(249, 115, 22, 0.5);
  background: #fff7ed;
  outline: none;
}

.ide-approval-trigger:focus-visible {
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.16);
}

.ide-approval-trigger:disabled {
  opacity: 0.54;
  cursor: not-allowed;
}

.ide-approval-trigger-chevron {
  transform: rotate(90deg);
  transition: transform 160ms ease;
}

.ide-approval-trigger[aria-expanded='true'] .ide-approval-trigger-chevron {
  transform: rotate(-90deg);
}

.ide-approval-popover {
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  z-index: 40;
  width: min(535px, calc(100vw - 32px));
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 14px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.98);
  color: #0f172a;
  box-shadow: 0 22px 54px rgba(15, 23, 42, 0.2);
}

.ide-approval-menu--compact .ide-approval-popover {
  width: min(430px, calc(100vw - 32px));
  padding: 10px;
}

.ide-approval-popover-heading {
  padding: 4px 52px 8px 8px;
  color: #64748b;
  font-size: 13px;
  font-weight: 760;
}

.ide-approval-option {
  width: 100%;
  min-height: 64px;
  border: 0;
  border-radius: 9px;
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 12px;
  padding: 9px 8px;
  color: #0f172a;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background-color 160ms ease, color 160ms ease;
}

.ide-approval-menu--compact .ide-approval-option {
  min-height: 58px;
  grid-template-columns: 28px minmax(0, 1fr) 22px;
  gap: 9px;
  padding: 8px 7px;
}

.ide-approval-option:hover,
.ide-approval-option--active {
  background: rgba(241, 245, 249, 0.92);
}

.ide-approval-option-icon {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
}

.ide-approval-option-copy {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.ide-approval-option-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: currentColor;
  font-size: 15px;
  font-weight: 760;
  letter-spacing: 0;
}

.ide-approval-menu--compact .ide-approval-option-copy strong {
  font-size: 13px;
}

.ide-approval-option-copy span {
  color: #64748b;
  font-size: 13px;
  line-height: 1.35;
}

.ide-approval-menu--compact .ide-approval-option-copy span {
  font-size: 11.5px;
}

.ide-approval-option-check {
  color: #64748b;
}

:global(.dark) .ide-approval-trigger {
  color: #fb923c;
  border-color: rgba(71, 85, 105, 0.82);
  background: rgba(15, 23, 42, 0.72);
}

:global(.dark) .ide-approval-trigger:hover:not(:disabled),
:global(.dark) .ide-approval-trigger:focus-visible {
  border-color: rgba(251, 146, 60, 0.46);
  background: rgba(30, 41, 59, 0.96);
}

:global(.dark) .ide-approval-popover {
  color: #f8fafc;
  border-color: rgba(71, 85, 105, 0.7);
  background: rgba(30, 30, 30, 0.98);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.48);
}

:global(.dark) .ide-approval-popover-heading {
  color: #a3a3a3;
}

:global(.dark) .ide-approval-option {
  color: #f8fafc;
}

:global(.dark) .ide-approval-option:hover,
:global(.dark) .ide-approval-option--active {
  background: rgba(63, 63, 70, 0.72);
}

:global(.dark) .ide-approval-option-icon,
:global(.dark) .ide-approval-option-check {
  color: #d4d4d8;
}

:global(.dark) .ide-approval-option-copy span {
  color: #a3a3a3;
}

@media (max-width: 560px) {
  .ide-approval-popover {
    left: -4px;
    width: calc(100vw - 28px);
  }

  .ide-approval-option-copy strong,
  .ide-approval-option-copy span {
    white-space: normal;
  }
}
</style>
