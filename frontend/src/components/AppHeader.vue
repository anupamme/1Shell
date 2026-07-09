<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from './AppIcon.vue';

const route = useRoute();

const GITHUB_URL = 'https://github.com/weidu12123/1Shell';

interface NavItem {
  to: string;
  label: string;
  matchPrefix: string;
  icon: string;
}

const navItems: NavItem[] = [
  { to: '/',          label: '主页',   matchPrefix: '/',         icon: 'globe' },
  { to: '/agent',     label: 'Agent',  matchPrefix: '/agent',    icon: 'robot' },
  { to: '/panel',     label: '面板',   matchPrefix: '/panel',    icon: 'chart' },
  { to: '/config',    label: '配置',   matchPrefix: '/config',   icon: 'toolbox' },
];

function isActive(item: NavItem): boolean {
  if (item.to === '/') return route.path === '/';
  return route.path.startsWith(item.matchPrefix);
}

const isDark = ref(true);
const themeIcon = computed<'sun' | 'moon'>(() => isDark.value ? 'sun' : 'moon');

function syncFromDom(): void {
  isDark.value = document.documentElement.classList.contains('dark');
}

function toggleTheme(): void {
  const html = document.documentElement;
  const next = !html.classList.contains('dark');
  if (next) html.classList.add('dark');
  else html.classList.remove('dark');
  localStorage.setItem('1shell-theme', next ? 'dark' : 'light');
  syncFromDom();
}

onMounted(syncFromDom);
</script>

<template>
  <header class="app-header shrink-0 flex items-center h-14 px-4 bg-white/85 dark:bg-[#070b15]/95 border-b border-slate-200/80 dark:border-white/[0.08] transition-colors backdrop-blur-xl">
    <!-- 左侧：Logo + 导航 -->
    <div class="flex items-center gap-3 min-w-0">
      <RouterLink
        to="/"
        class="shrink-0 w-9 h-9 rounded-lg overflow-hidden flex items-center justify-center shadow-sm ring-1 ring-slate-200/70 dark:ring-white/10 hover:opacity-90 transition-opacity"
        title="1Shell"
      >
        <img src="/logo.png" alt="1Shell" class="w-full h-full object-cover" />
      </RouterLink>
      <div class="hidden sm:block w-px h-6 bg-slate-200 dark:bg-white/10"></div>
      <nav class="app-header-nav flex gap-1 min-w-0">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="app-header-nav-link inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
          :class="isActive(item)
            ? 'text-slate-950 dark:text-white bg-slate-900/[0.06] dark:bg-white/[0.08] shadow-sm'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.06]'"
        >
          <AppIcon :name="item.icon" :size="15" />
          {{ item.label }}
        </RouterLink>
      </nav>
    </div>

    <!-- 右侧：GitHub + 设置 + 主题 -->
    <div class="app-header-actions flex items-center gap-1 ml-auto">
      <a
        :href="GITHUB_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="app-header-github flex items-center justify-center w-9 h-9 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07] rounded-lg transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        title="GitHub 项目主页"
      >
        <AppIcon name="github" :size="18" />
      </a>
      <RouterLink
        to="/settings"
        class="flex items-center justify-center w-9 h-9 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07] rounded-lg transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        title="系统设置"
      >
        <AppIcon name="cog" :size="18" />
      </RouterLink>
      <button
        type="button"
        class="flex items-center justify-center w-9 h-9 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07] rounded-lg transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        title="主题切换"
        @click="toggleTheme"
      >
        <AppIcon :name="themeIcon" :size="17" />
      </button>
    </div>
  </header>
</template>
