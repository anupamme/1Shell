<script setup lang="ts">
import { RouterLink } from 'vue-router';
import AppIcon from './AppIcon.vue';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  title: string;
}

const navItems: NavItem[] = [
  { to: '/config/ai',       label: 'AI',   icon: 'spark',   title: 'AI 配置' },
  { to: '/config/skills',   label: '扩展', icon: 'package', title: '扩展' },
  { to: '/config/scripts', label: '脚本', icon: 'wrench', title: '脚本库' },
  { to: '/config/mcp',      label: 'MCP',  icon: 'plug',    title: 'MCP Hub' },
];
</script>

<template>
  <aside class="sidebar-aside app-sidebar shrink-0 w-[76px] flex flex-col items-stretch py-3 border-r border-slate-200/70 dark:border-white/[0.06]">
    <div class="px-2 pb-3">
      <div class="h-8 rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.04] text-[10px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-center">
        配置
      </div>
    </div>
    <nav class="app-sidebar-nav flex flex-col gap-1.5 px-2">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="side-nav-item outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        :title="item.title"
      >
        <AppIcon :name="item.icon" :size="20" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </aside>
</template>
