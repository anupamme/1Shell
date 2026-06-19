<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { AgentModelProvider } from '@/composables/useAgentModelProviders';

withDefaults(defineProps<{
  providers: AgentModelProvider[];
  activeProviderId?: string | null;
  highlighted?: number;
  density?: 'full' | 'compact';
  loading?: boolean;
}>(), {
  activeProviderId: null,
  highlighted: 0,
  density: 'full',
  loading: false,
});

const emit = defineEmits<{
  back: [];
  select: [providerId: string | null];
}>();
</script>

<template>
  <div class="ide-model-slash-menu" :class="`ide-model-slash-menu--${density}`">
    <button type="button" class="ide-model-slash-back" @mousedown.prevent @click="emit('back')">
      <AppIcon name="arrow-right" :size="12" class="ide-model-slash-back-icon" />
      <span>返回命令列表</span>
    </button>

    <button
      type="button"
      class="ide-model-slash-option"
      :class="{ 'ide-model-slash-option--active': highlighted === 0 }"
      @mousedown.prevent
      @click="emit('select', null)"
    >
      <span class="ide-model-slash-dot" :class="{ 'ide-model-slash-dot--on': !activeProviderId }"></span>
      <span class="ide-model-slash-copy">
        <strong>默认模型</strong>
        <span>系统默认路由</span>
      </span>
    </button>

    <div v-if="providers.length" class="ide-model-slash-divider"></div>

    <button
      v-for="(provider, index) in providers"
      :key="provider.id"
      type="button"
      class="ide-model-slash-option"
      :class="{ 'ide-model-slash-option--active': highlighted === index + 1 }"
      @mousedown.prevent
      @click="emit('select', provider.id)"
    >
      <span class="ide-model-slash-dot" :class="{ 'ide-model-slash-dot--on': provider.id === activeProviderId }"></span>
      <span class="ide-model-slash-copy">
        <strong>{{ provider.model || '未指定模型' }}</strong>
        <span>{{ provider.name }}</span>
      </span>
    </button>

    <div v-if="loading" class="ide-model-slash-empty">读取模型配置中...</div>
    <div v-else-if="!providers.length" class="ide-model-slash-empty">暂无可用模型，前往 AI 配置添加渠道</div>
  </div>
</template>

<style scoped>
.ide-model-slash-menu {
  position: absolute;
  left: 22px;
  right: 22px;
  bottom: calc(100% - 8px);
  z-index: 36;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.34);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
}

.ide-model-slash-menu--compact {
  left: 12px;
  right: 12px;
  bottom: calc(100% - 6px);
  border-radius: 9px;
}

.ide-model-slash-back,
.ide-model-slash-option {
  width: 100%;
  border: 0;
  display: flex;
  align-items: center;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.ide-model-slash-back {
  gap: 7px;
  padding: 9px 12px;
  color: #64748b;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  font-size: 11px;
  font-weight: 700;
}

.ide-model-slash-back:hover {
  color: #0369a1;
  background: #f8fafc;
}

.ide-model-slash-back-icon {
  transform: rotate(180deg);
}

.ide-model-slash-option {
  min-height: 48px;
  gap: 10px;
  padding: 8px 12px;
  color: #334155;
}

.ide-model-slash-menu--compact .ide-model-slash-option {
  min-height: 44px;
  padding: 7px 10px;
}

.ide-model-slash-option:hover,
.ide-model-slash-option--active {
  color: #0369a1;
  background: #f0f9ff;
}

.ide-model-slash-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #cbd5e1;
  flex: 0 0 auto;
}

.ide-model-slash-dot--on {
  background: #10b981;
  box-shadow: 0 0 7px rgba(16, 185, 129, 0.45);
}

.ide-model-slash-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.ide-model-slash-copy strong,
.ide-model-slash-copy span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ide-model-slash-copy strong {
  font-size: 12px;
  font-weight: 760;
}

.ide-model-slash-copy span {
  color: #64748b;
  font-size: 11px;
}

.ide-model-slash-divider {
  height: 1px;
  margin: 0 12px;
  background: rgba(148, 163, 184, 0.18);
}

.ide-model-slash-empty {
  padding: 13px 12px;
  color: #64748b;
  text-align: center;
  font-size: 11px;
}

:global(.dark) .ide-model-slash-menu {
  border-color: rgba(71, 85, 105, 0.82);
  background: rgba(15, 23, 42, 0.98);
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.36);
}

:global(.dark) .ide-model-slash-back {
  color: #94a3b8;
  border-bottom-color: rgba(71, 85, 105, 0.5);
}

:global(.dark) .ide-model-slash-back:hover {
  color: #7dd3fc;
  background: rgba(255, 255, 255, 0.04);
}

:global(.dark) .ide-model-slash-option {
  color: #cbd5e1;
}

:global(.dark) .ide-model-slash-option:hover,
:global(.dark) .ide-model-slash-option--active {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
}

:global(.dark) .ide-model-slash-dot {
  background: #475569;
}

:global(.dark) .ide-model-slash-dot--on {
  background: #34d399;
}

:global(.dark) .ide-model-slash-copy span,
:global(.dark) .ide-model-slash-empty {
  color: #94a3b8;
}

:global(.dark) .ide-model-slash-divider {
  background: rgba(71, 85, 105, 0.52);
}
</style>
