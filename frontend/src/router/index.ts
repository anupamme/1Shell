import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  // ========== 顶层页面 + 独立设置 ==========
  // 4.7.3：主页重构为真实地图仪表盘（HomeDashboardView），旧 WorldHomeView 下线备查
  { path: '/',         name: 'home',     component: () => import('@/views/HomeDashboardView.vue') },
  { path: '/agent',    name: 'agent',    component: () => import('@/views/AgentView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  {
    path: '/panel',
    component: () => import('@/views/PanelView.vue'),
    redirect: '/panel/runtime',
    children: [
      { path: 'hosts',     name: 'panel-hosts',     component: () => import('@/views/HostRepositoryView.vue'), props: { mode: 'hosts' } },
      { path: 'runtime',   name: 'panel-runtime',   component: () => import('@/views/HostRepositoryView.vue'), props: { mode: 'runtime' } },
      { path: 'workloads', name: 'panel-workloads', component: () => import('@/views/WorkloadsView.vue') },
      { path: 'files',     name: 'panel-files',     component: () => import('@/views/HostRepositoryView.vue'), props: { mode: 'files' } },
      { path: 'probe',     name: 'panel-probe',     component: () => import('@/views/ProbeView.vue') },
      { path: 'audit',     name: 'panel-audit',     component: () => import('@/views/AuditView.vue') },
      { path: 'features',  redirect: '/config/features' },
      { path: 'skills',    redirect: '/config/skills' },
      { path: 'mcp',       redirect: '/config/mcp' },
      { path: 'ai',        redirect: '/config/ai' },
    ],
  },
  {
    path: '/config',
    component: () => import('@/views/ConfigView.vue'),
    redirect: '/config/ai',
    children: [
      { path: 'features',  name: 'config-features',  component: () => import('@/views/FeaturesView.vue') },
      { path: 'skills',    name: 'config-skills',    component: () => import('@/views/SkillsView.vue') },
      { path: 'mcp',       name: 'config-mcp',       component: () => import('@/views/McpHubView.vue') },
      { path: 'ai',        name: 'config-ai',        component: () => import('@/views/CliSetupView.vue') },
    ],
  },

  // ========== 兼容旧路径 ==========
  // 终端页已并入 Agent 页（4.7.2）：?host= 语义保留（选中主机 + 展开终端分栏）
  { path: '/terminal',  redirect: (to) => ({ path: '/agent', query: to.query }) },
  { path: '/console',   redirect: (to) => ({ path: '/agent', query: to.query }) },
  { path: '/ide',       redirect: '/agent' },
  { path: '/hosts',     redirect: '/panel/hosts' },
  { path: '/runtime',   redirect: '/panel/runtime' },
  { path: '/workloads', redirect: '/panel/workloads' },
  { path: '/files',     redirect: '/panel/files' },
  { path: '/probe',     redirect: '/panel/probe' },
  { path: '/audit',     redirect: '/panel/audit' },
  { path: '/features',  redirect: '/config/features' },
  { path: '/scripts',   redirect: { path: '/config/features', query: { tab: 'programs' } } },
  { path: '/skills',    redirect: '/config/skills' },
  { path: '/mcp-hub',   redirect: '/config/mcp' },
  { path: '/cli-setup', redirect: '/config/ai' },
  { path: '/panel/settings', redirect: '/settings' },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
