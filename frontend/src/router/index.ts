import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/',             name: 'home',        component: () => import('@/views/WorldHomeView.vue') },
  { path: '/console',      name: 'console',     component: () => import('@/views/MainConsoleView.vue') },
  { path: '/ide',          name: 'ide',         component: () => import('@/views/IdeView.vue') },
  { path: '/hosts',        name: 'hosts',       component: () => import('@/views/HostRepositoryView.vue') },
  { path: '/audit',        name: 'audit',       component: () => import('@/views/AuditView.vue') },
  { path: '/probe',        name: 'probe',       component: () => import('@/views/ProbeView.vue') },
  { path: '/cli-setup',    name: 'cli-setup',   component: () => import('@/views/CliSetupView.vue') },
  { path: '/features',     name: 'features',    component: () => import('@/views/FeaturesView.vue') },
  { path: '/scripts',      redirect: { path: '/features', query: { tab: 'programs' } } },
  { path: '/skills',       name: 'skills',      component: () => import('@/views/SkillsView.vue') },
  { path: '/mcp-hub',      name: 'mcp-hub',     component: () => import('@/views/McpHubView.vue') },
  { path: '/settings',     name: 'settings',    component: () => import('@/views/SettingsView.vue') },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
