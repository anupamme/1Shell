<script setup lang="ts">
// 全局左侧导航栏：常态 60px 图标栏，悬停（带延迟防误触）以悬浮层展开显示文字，
// 展开层覆盖在内容上方、不挤压主区域
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
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

// ---- 悬停展开（150ms 延迟防划过误触；收起稍缓避免抖动） ----
const expanded = ref(false);
let expandTimer: ReturnType<typeof setTimeout> | null = null;
let collapseTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
}

function onEnter(): void {
  clearTimers();
  expandTimer = setTimeout(() => { expanded.value = true; }, 150);
}

function onLeave(): void {
  clearTimers();
  collapseTimer = setTimeout(() => { expanded.value = false; }, 120);
}

// 键盘 Tab 聚焦进入时也展开，可访问性兜底
function onFocusIn(): void {
  clearTimers();
  expanded.value = true;
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && (event.currentTarget as Node).contains(next)) return;
  onLeave();
}

onBeforeUnmount(clearTimers);

// ---- 主题切换（自 AppHeader 迁移） ----
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

const itemBase = 'nav-rail-item relative flex h-10 shrink-0 items-center gap-3 rounded-lg px-[10px] text-sm font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60';
const itemIdle = 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.06]';
const itemActive = 'text-slate-950 dark:text-white bg-slate-900/[0.06] dark:bg-white/[0.08] shadow-sm';
</script>

<template>
  <!-- 占位：固定 60px 宽度，展开层悬浮，不影响主内容布局 -->
  <div class="app-nav-rail relative h-full w-[60px] shrink-0 z-40">
    <aside
      class="absolute inset-y-0 left-0 flex flex-col overflow-hidden border-r border-slate-200/80 bg-white/85 backdrop-blur-xl transition-[width,box-shadow] duration-200 ease-out dark:border-white/[0.08] dark:bg-[#070b15]/95"
      :class="expanded ? 'w-[208px] shadow-2xl bg-white/95' : 'w-[60px]'"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @focusin="onFocusIn"
      @focusout="onFocusOut"
    >
      <!-- Logo -->
      <RouterLink
        to="/"
        class="mx-[10px] mt-3 flex h-10 shrink-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        title="1Shell"
      >
        <span class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-sm ring-1 ring-slate-200/70 dark:ring-white/10">
          <img src="/logo.png" alt="1Shell" class="h-full w-full object-cover" />
        </span>
        <span class="nav-rail-label whitespace-nowrap text-sm font-bold text-slate-900 dark:text-white" :class="expanded ? 'opacity-100' : 'opacity-0'">1Shell</span>
      </RouterLink>

      <div class="mx-[10px] my-3 h-px shrink-0 bg-slate-200 dark:bg-white/10"></div>

      <!-- 主导航 -->
      <nav class="flex flex-col gap-1 px-[8px]">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :class="[itemBase, isActive(item) ? itemActive : itemIdle]"
          :title="expanded ? undefined : item.label"
        >
          <span class="flex w-6 shrink-0 items-center justify-center"><AppIcon :name="item.icon" :size="17" /></span>
          <span class="nav-rail-label whitespace-nowrap" :class="expanded ? 'opacity-100' : 'opacity-0'">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <!-- 底部：GitHub / 设置 / 主题 -->
      <div class="mt-auto flex flex-col gap-1 px-[8px] pb-3">
        <div class="mx-[2px] mb-2 h-px shrink-0 bg-slate-200 dark:bg-white/10"></div>
        <a
          :href="GITHUB_URL"
          target="_blank"
          rel="noopener noreferrer"
          :class="[itemBase, itemIdle]"
          :title="expanded ? undefined : 'GitHub 项目主页'"
        >
          <span class="flex w-6 shrink-0 items-center justify-center"><AppIcon name="github" :size="17" /></span>
          <span class="nav-rail-label whitespace-nowrap" :class="expanded ? 'opacity-100' : 'opacity-0'">GitHub</span>
        </a>
        <RouterLink
          to="/settings"
          :class="[itemBase, route.path.startsWith('/settings') ? itemActive : itemIdle]"
          :title="expanded ? undefined : '系统设置'"
        >
          <span class="flex w-6 shrink-0 items-center justify-center"><AppIcon name="cog" :size="17" /></span>
          <span class="nav-rail-label whitespace-nowrap" :class="expanded ? 'opacity-100' : 'opacity-0'">系统设置</span>
        </RouterLink>
        <button
          type="button"
          :class="[itemBase, itemIdle]"
          :title="expanded ? undefined : '主题切换'"
          @click="toggleTheme"
        >
          <span class="flex w-6 shrink-0 items-center justify-center"><AppIcon :name="themeIcon" :size="16" /></span>
          <span class="nav-rail-label whitespace-nowrap" :class="expanded ? 'opacity-100' : 'opacity-0'">{{ isDark ? '浅色模式' : '深色模式' }}</span>
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.nav-rail-label {
  transition: opacity 0.15s ease;
}
</style>
