<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { AgentSlashCommand } from '@/utils/agentSlashCommands';

withDefaults(defineProps<{
  commands: AgentSlashCommand[];
  highlighted?: number;
  density?: 'full' | 'compact';
}>(), {
  highlighted: 0,
  density: 'full',
});

const emit = defineEmits<{
  select: [command: AgentSlashCommand];
}>();
</script>

<template>
  <div class="ide-slash-menu" :class="`ide-slash-menu--${density}`">
    <div class="ide-slash-menu-title">命令</div>
    <button
      v-for="(command, index) in commands"
      :key="command.cmd"
      type="button"
      class="ide-slash-command"
      :class="{ 'ide-slash-command--active': index === highlighted }"
      @mousedown.prevent
      @click="emit('select', command)"
    >
      <span class="ide-slash-command-icon">
        <AppIcon :name="command.icon" :size="density === 'compact' ? 13 : 14" />
      </span>
      <span class="ide-slash-command-copy">
        <span class="ide-slash-command-head">
          <strong>{{ command.cmd }}</strong>
          <span>{{ command.label }}</span>
        </span>
        <span class="ide-slash-command-desc">{{ command.desc }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.ide-slash-menu {
  position: absolute;
  left: 22px;
  right: 22px;
  bottom: calc(100% - 8px);
  z-index: 35;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.34);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
}

.ide-slash-menu--compact {
  left: 12px;
  right: 12px;
  bottom: calc(100% - 6px);
  border-radius: 9px;
}

.ide-slash-menu-title {
  padding: 9px 12px 6px;
  color: #64748b;
  font-size: 10px;
  line-height: 1.2;
  font-weight: 780;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.ide-slash-command {
  width: 100%;
  min-height: 50px;
  border: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: #334155;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease;
}

.ide-slash-menu--compact .ide-slash-command {
  min-height: 46px;
  gap: 9px;
  padding: 7px 10px;
}

.ide-slash-command:hover,
.ide-slash-command--active {
  color: #0369a1;
  background: #f0f9ff;
}

.ide-slash-command-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  background: #f1f5f9;
  flex: 0 0 auto;
}

.ide-slash-command--active .ide-slash-command-icon,
.ide-slash-command:hover .ide-slash-command-icon {
  color: #0284c7;
  background: #e0f2fe;
}

.ide-slash-command-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.ide-slash-command-head {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ide-slash-command-head strong,
.ide-slash-command-head span,
.ide-slash-command-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ide-slash-command-head strong {
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  font-weight: 780;
}

.ide-slash-command-head span {
  font-size: 12px;
  font-weight: 700;
}

.ide-slash-command-desc {
  color: #64748b;
  font-size: 11px;
}

.dark .ide-slash-menu {
  border-color: rgba(71, 85, 105, 0.82);
  background: rgba(15, 23, 42, 0.98);
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.36);
}

.dark .ide-slash-menu-title,
.dark .ide-slash-command-desc {
  color: #94a3b8;
}

.dark .ide-slash-command {
  color: #cbd5e1;
}

.dark .ide-slash-command:hover,
.dark .ide-slash-command--active {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
}

.dark .ide-slash-command-icon {
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.05);
}

.dark .ide-slash-command:hover .ide-slash-command-icon,
.dark .ide-slash-command--active .ide-slash-command-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.15);
}
</style>
