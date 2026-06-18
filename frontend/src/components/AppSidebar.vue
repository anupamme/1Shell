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
  { to: '/panel/hosts',    label: '主机', icon: 'server',      title: 'VPS 仓库' },
  { to: '/panel/features', label: '程序', icon: 'wrench',      title: '任务与程序' },
  { to: '/panel/skills',   label: '扩展', icon: 'package',     title: '扩展' },
  { to: '/panel/mcp',      label: 'MCP',  icon: 'plug',        title: 'MCP Hub' },
  { to: '/panel/ai',       label: 'AI',   icon: 'spark',       title: 'AI 配置' },
  { to: '/panel/probe',    label: '探针', icon: 'radio',       title: '探针' },
  { to: '/panel/audit',    label: '审计', icon: 'clipboard',   title: '审计日志' },
];
</script>

<template>
  <aside class="sidebar-aside app-sidebar shrink-0 w-16 flex flex-col items-stretch py-3">
    <nav class="app-sidebar-nav flex flex-col gap-1 px-1">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="side-nav-item"
        :title="item.title"
      >
        <AppIcon :name="item.icon" :size="20" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </aside>
</template>
