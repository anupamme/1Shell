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
}

const navItems: NavItem[] = [
  { to: '/',          label: '主页',   matchPrefix: '/' },
  { to: '/agent',     label: 'Agent',  matchPrefix: '/agent' },
  { to: '/terminal',  label: '终端',   matchPrefix: '/terminal' },
  { to: '/panel',     label: '面板',   matchPrefix: '/panel' },
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
  <header class="app-header shrink-0 flex items-center h-12 px-3 bg-white/95 dark:bg-slate-900 border-b border-slate-200/80 dark:border-slate-700 transition-colors">
    <!-- 左侧：Logo + 导航 -->
    <div class="flex items-center gap-2">
      <RouterLink
        to="/"
        class="shrink-0 w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center hover:opacity-80 transition-opacity"
        title="1Shell"
      >
        <img src="/logo.png" alt="1Shell" class="w-full h-full object-cover" />
      </RouterLink>
      <div class="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1"></div>
      <nav class="app-header-nav flex gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="app-header-nav-link px-3 py-1.5 text-sm font-medium rounded-lg transition-colors duration-150"
          :class="isActive(item)
            ? 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-500/10'
            : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06]'"
        >
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
        class="app-header-github flex items-center justify-center w-8 h-8 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] rounded-lg transition-colors duration-150"
        title="GitHub 项目主页"
      >
        <AppIcon name="github" :size="18" />
      </a>
      <RouterLink
        to="/settings"
        class="flex items-center justify-center w-8 h-8 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] rounded-lg transition-colors duration-150"
        title="系统设置"
      >
        <AppIcon name="cog" :size="18" />
      </RouterLink>
      <button
        type="button"
        class="flex items-center justify-center w-8 h-8 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] rounded-lg transition-colors duration-150"
        title="主题切换"
        @click="toggleTheme"
      >
        <AppIcon :name="themeIcon" :size="17" />
      </button>
    </div>
  </header>
</template>
