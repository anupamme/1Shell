import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  // ========== 四大顶层页面 + 独立设置 ==========
  { path: '/',         name: 'home',     component: () => import('@/views/WorldHomeView.vue') },
  { path: '/agent',    name: 'agent',    component: () => import('@/views/AgentView.vue') },
  { path: '/terminal', name: 'terminal', component: () => import('@/views/MainConsoleView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  {
    path: '/panel',
    component: () => import('@/views/PanelView.vue'),
    redirect: '/panel/hosts',
    children: [
      { path: 'hosts',     name: 'panel-hosts',     component: () => import('@/views/HostRepositoryView.vue') },
      { path: 'probe',     name: 'panel-probe',     component: () => import('@/views/ProbeView.vue') },
      { path: 'audit',     name: 'panel-audit',     component: () => import('@/views/AuditView.vue') },
      { path: 'features',  name: 'panel-features',  component: () => import('@/views/FeaturesView.vue') },
      { path: 'skills',    name: 'panel-skills',    component: () => import('@/views/SkillsView.vue') },
      { path: 'mcp',       name: 'panel-mcp',       component: () => import('@/views/McpHubView.vue') },
      { path: 'ai',        name: 'panel-ai',        component: () => import('@/views/CliSetupView.vue') },
    ],
  },

  // ========== 兼容旧路径 ==========
  { path: '/console',   redirect: '/terminal' },
  { path: '/ide',       redirect: '/terminal' },
  { path: '/hosts',     redirect: '/panel/hosts' },
  { path: '/probe',     redirect: '/panel/probe' },
  { path: '/audit',     redirect: '/panel/audit' },
  { path: '/features',  redirect: '/panel/features' },
  { path: '/scripts',   redirect: { path: '/panel/features', query: { tab: 'programs' } } },
  { path: '/skills',    redirect: '/panel/skills' },
  { path: '/mcp-hub',   redirect: '/panel/mcp' },
  { path: '/cli-setup', redirect: '/panel/ai' },
  { path: '/panel/settings', redirect: '/settings' },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
