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
  { to: '/panel/runtime',  label: '详情', icon: 'chart',       title: '详情' },
  { to: '/panel/hosts',    label: '主机', icon: 'server',      title: 'VPS 仓库' },
  { to: '/panel/workloads', label: '运行', icon: 'play-square', title: '运行' },
  { to: '/panel/files',    label: '文件', icon: 'folder',      title: '文件' },
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
