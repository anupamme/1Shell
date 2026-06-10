<script setup lang="ts">
// 系统设置 — 4.2：由弹窗改为独立页面（左侧分区导航 + 右侧内容）
import { ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import QRCode from 'qrcode';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { useAiChat } from '@/composables/useAiChat';
import IpFilterTab from '@/components/main/IpFilterTab.vue';

type SecurityMode = 'strict' | 'standard' | 'trusted';

interface SecuritySettings {
  securityMode: SecurityMode;
  agentPrivilegeIsolation: boolean;
  agentUser: string;
  updatedAt?: string | null;
}

interface SecuritySettingsResponse {
  ok?: boolean;
  settings?: SecuritySettings;
  modes?: string[];
}

interface AgentUserInitResponse {
  ok?: boolean;
  hostId?: string;
  agentUser?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

const route = useRoute();
const router = useRouter();
const { requestJson } = useApiClient();
const notify = useNotifyStore();
const chat = useAiChat();

const SECURITY_MODES: SecurityMode[] = ['strict', 'standard', 'trusted'];
const SECURITY_MODE_LABELS: Record<SecurityMode, string> = {
  strict: '严格 strict',
  standard: '标准 standard',
  trusted: '信任直通 trusted',
};

type Tab = 'account' | 'security' | 'ipfilter' | 'aiconfig' | 'desktop';

const TAB_ITEMS: Array<{ key: Tab; label: string; icon: string; desc: string }> = [
  { key: 'account',  label: '账号设置',    icon: 'lock',    desc: '用户名与访问口令' },
  { key: 'security', label: '安全',        icon: 'shield',  desc: '两步验证 · 安全档位 · 权限隔离' },
  { key: 'ipfilter', label: 'IP 访问控制', icon: 'globe',   desc: '黑白名单与访问限制' },
  { key: 'aiconfig', label: 'AI 配置',     icon: 'spark',   desc: '1Shell AI 的模型与 API' },
  { key: 'desktop',  label: '桌面版',      icon: 'console', desc: '自启 · 托盘 · 本地服务' },
];

function isTab(v: unknown): v is Tab {
  return typeof v === 'string' && TAB_ITEMS.some((t) => t.key === v);
}

const tab = ref<Tab>(isTab(route.query.tab) ? route.query.tab : 'account');

function switchTab(t: Tab): void {
  tab.value = t;
  void router.replace({ query: t === 'account' ? {} : { tab: t } });
}

const username = ref('');
const password = ref('');
const passwordConfirm = ref('');
const errorMsg = ref('');

const apiBase = ref('');
const apiKey = ref('');
const model = ref('');
const aiError = ref('');
const fetching = ref(false);
const modelsHints = ref<string[]>([]);

const securityLoading = ref(false);
const securitySaving = ref(false);
const securityError = ref('');
const securityModes = ref<SecurityMode[]>([...SECURITY_MODES]);
const securityMode = ref<SecurityMode>('strict');
const securitySettingsLoaded = ref(false);
const agentPrivilegeIsolation = ref(false);
const agentUser = ref('oneshell-agent');
const initHostId = ref('local');
const initLoading = ref(false);
const initResult = ref('');

// ── 两步验证（2FA） ──
interface TwoFaStatus {
  available?: boolean;
  enabled: boolean;
  pendingSetup?: boolean;
  remainingRecoveryCodes?: number;
  enabledAt?: string | null;
}
const twofaStatus = ref<TwoFaStatus | null>(null);
const twofaError = ref('');
const twofaBusy = ref(false);
const twofaSetup = ref<{ secret: string; otpauthUrl: string } | null>(null);
const twofaQrDataUrl = ref('');
const twofaCode = ref('');
const twofaDisableCode = ref('');
const twofaRecoveryCodes = ref<string[]>([]);

type DesktopBooleanKey = 'startAtLogin' | 'backgroundOnClose';

const desktopAvailable = ref(false);
const desktopLoading = ref(false);
const desktopSaving = ref(false);
const desktopError = ref('');
const desktopSettingsLoaded = ref(false);
const desktopSettings = ref<OneShellDesktopSettings | null>(null);

function loadTabData(t: Tab): void {
  if (t === 'aiconfig') {
    apiBase.value = chat.config.value.apiBase;
    apiKey.value = chat.config.value.apiKey;
    model.value = chat.config.value.model;
    aiError.value = '';
    modelsHints.value = [];
  } else if (t === 'security') {
    void loadSecuritySettings();
    void loadTwofaStatus();
  } else if (t === 'desktop') {
    void loadDesktopSettings();
  }
}

watch(tab, loadTabData);

onMounted(() => {
  loadTabData(tab.value);
});

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = '';
  if (password.value && password.value !== passwordConfirm.value) {
    errorMsg.value = '两次输入的口令不一致';
    return;
  }
  if (!username.value && !password.value) {
    errorMsg.value = '请填写用户名或密码';
    return;
  }
  try {
    const body: Record<string, string> = {};
    if (username.value) body.username = username.value;
    if (password.value) body.password = password.value;
    await requestJson('/api/auth/credentials', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    username.value = '';
    password.value = '';
    passwordConfirm.value = '';
    notify.success('凭据已更新，下次登录生效');
  } catch (err) {
    errorMsg.value = (err as Error).message || '保存失败';
  }
}

async function onFetchModels(): Promise<void> {
  aiError.value = '';
  if (!apiBase.value.trim() || !apiKey.value.trim()) {
    aiError.value = '请先填写 API 地址和 Key';
    return;
  }
  fetching.value = true;
  try {
    const list = await chat.fetchModels(apiBase.value, apiKey.value);
    if (!list.length) {
      aiError.value = '未能获取到模型列表，请手动输入';
      return;
    }
    modelsHints.value = list;
  } catch (err) {
    aiError.value = '获取模型失败: ' + (err as Error).message;
  } finally {
    fetching.value = false;
  }
}

function openMcpHub(): void {
  void router.push('/mcp-hub');
}

function onAiSubmit(e: Event): void {
  e.preventDefault();
  aiError.value = '';
  const cleanBase = apiBase.value.trim().replace(/\/$/, '');
  if (!cleanBase) {
    aiError.value = 'API 基础地址不能为空';
    return;
  }
  try { new URL(cleanBase); } catch {
    aiError.value = 'API 基础地址格式不正确';
    return;
  }
  chat.saveConfig({
    apiBase: cleanBase,
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
  });
  notify.success('AI 配置已保存');
}

function isSecurityMode(value: string): value is SecurityMode {
  return SECURITY_MODES.includes(value as SecurityMode);
}

async function loadSecuritySettings(): Promise<void> {
  if (securitySettingsLoaded.value || securityLoading.value) return;
  securityError.value = '';
  securityLoading.value = true;
  try {
    const res = await requestJson<SecuritySettingsResponse>('/api/security/settings');
    const modes = Array.isArray(res.modes) ? res.modes.filter(isSecurityMode) : [];
    if (modes.length) securityModes.value = modes;
    if (res.settings) applySecuritySettings(res.settings);
    securitySettingsLoaded.value = true;
  } catch (err) {
    securityError.value = (err as Error).message || '加载安全设置失败';
  } finally {
    securityLoading.value = false;
  }
}

function applySecuritySettings(settings: SecuritySettings): void {
  securityMode.value = isSecurityMode(settings.securityMode) ? settings.securityMode : 'strict';
  agentPrivilegeIsolation.value = settings.agentPrivilegeIsolation === true;
  agentUser.value = settings.agentUser || 'oneshell-agent';
}

async function onSecuritySubmit(e: Event): Promise<void> {
  e.preventDefault();
  securityError.value = '';
  if (agentPrivilegeIsolation.value && !agentUser.value.trim()) {
    securityError.value = '启用 Agent 权限隔离时必须填写普通用户';
    return;
  }
  securitySaving.value = true;
  try {
    const res = await requestJson<SecuritySettingsResponse>('/api/security/settings', {
      method: 'PUT',
      body: JSON.stringify({
        securityMode: securityMode.value,
        agentPrivilegeIsolation: agentPrivilegeIsolation.value,
        agentUser: agentUser.value.trim() || 'oneshell-agent',
      }),
    });
    if (res.settings) applySecuritySettings(res.settings);
    notify.success('安全设置已保存');
  } catch (err) {
    securityError.value = (err as Error).message || '保存安全设置失败';
  } finally {
    securitySaving.value = false;
  }
}

async function onInitAgentUser(): Promise<void> {
  securityError.value = '';
  initResult.value = '';
  if (!agentUser.value.trim()) {
    securityError.value = '请先填写 Agent 普通用户';
    return;
  }
  initLoading.value = true;
  try {
    const res = await requestJson<AgentUserInitResponse>('/api/security/agent-user/init', {
      method: 'POST',
      body: JSON.stringify({ hostId: initHostId.value.trim() || 'local', agentUser: agentUser.value.trim() }),
    });
    initResult.value = [
      `exitCode=${res.exitCode ?? 0}`,
      res.stdout ? `stdout:\n${res.stdout}` : '',
      res.stderr ? `stderr:\n${res.stderr}` : '',
    ].filter(Boolean).join('\n');
    if (res.ok) notify.success('Agent 普通用户初始化完成');
    else securityError.value = '初始化未成功，请查看输出';
  } catch (err) {
    securityError.value = (err as Error).message || '初始化失败';
  } finally {
    initLoading.value = false;
  }
}

// ── 两步验证（2FA）逻辑 ──

async function loadTwofaStatus(): Promise<void> {
  twofaError.value = '';
  try {
    twofaStatus.value = await requestJson<TwoFaStatus>('/api/auth/2fa/status');
  } catch (err) {
    twofaError.value = (err as Error).message || '加载 2FA 状态失败';
  }
}

async function onTwofaSetup(): Promise<void> {
  twofaError.value = '';
  twofaBusy.value = true;
  twofaRecoveryCodes.value = [];
  try {
    const res = await requestJson<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    twofaSetup.value = res;
    twofaCode.value = '';
    twofaQrDataUrl.value = await QRCode.toDataURL(res.otpauthUrl, { width: 180, margin: 1 });
  } catch (err) {
    twofaError.value = (err as Error).message || '生成 2FA 密钥失败';
  } finally {
    twofaBusy.value = false;
  }
}

async function onTwofaEnable(): Promise<void> {
  twofaError.value = '';
  if (!twofaCode.value.trim()) {
    twofaError.value = '请输入认证器中的 6 位验证码';
    return;
  }
  twofaBusy.value = true;
  try {
    const res = await requestJson<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ code: twofaCode.value.trim() }),
    });
    twofaRecoveryCodes.value = res.recoveryCodes || [];
    twofaSetup.value = null;
    twofaQrDataUrl.value = '';
    twofaCode.value = '';
    notify.success('两步验证已开启');
    await loadTwofaStatus();
  } catch (err) {
    twofaError.value = (err as Error).message || '开启失败';
  } finally {
    twofaBusy.value = false;
  }
}

async function onTwofaDisable(): Promise<void> {
  twofaError.value = '';
  if (!twofaDisableCode.value.trim()) {
    twofaError.value = '请输入验证码或恢复码以确认关闭';
    return;
  }
  twofaBusy.value = true;
  try {
    await requestJson('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ code: twofaDisableCode.value.trim() }),
    });
    twofaDisableCode.value = '';
    twofaRecoveryCodes.value = [];
    notify.success('两步验证已关闭');
    await loadTwofaStatus();
  } catch (err) {
    twofaError.value = (err as Error).message || '关闭失败';
  } finally {
    twofaBusy.value = false;
  }
}

function copyRecoveryCodes(): void {
  if (!twofaRecoveryCodes.value.length) return;
  navigator.clipboard?.writeText(twofaRecoveryCodes.value.join('\n')).then(() => {
    notify.success('恢复码已复制，请妥善保存');
  }).catch(() => {
    notify.error('复制失败，请手动抄录');
  });
}

async function loadDesktopSettings(force = false): Promise<void> {
  const bridge = window.oneshellDesktop;
  desktopAvailable.value = Boolean(bridge?.isDesktop);
  if (!bridge?.isDesktop) {
    desktopSettings.value = null;
    desktopSettingsLoaded.value = true;
    desktopError.value = '';
    return;
  }
  if (!force && (desktopSettingsLoaded.value || desktopLoading.value)) return;
  desktopError.value = '';
  desktopLoading.value = true;
  try {
    desktopSettings.value = await bridge.getSettings();
    desktopAvailable.value = true;
    desktopSettingsLoaded.value = true;
  } catch (err) {
    desktopError.value = (err as Error).message || '加载桌面设置失败';
  } finally {
    desktopLoading.value = false;
  }
}

async function onDesktopToggle(key: DesktopBooleanKey, event: Event): Promise<void> {
  const bridge = window.oneshellDesktop;
  const checked = (event.target as HTMLInputElement).checked;
  if (!bridge?.isDesktop || !desktopSettings.value) return;
  const previous = { ...desktopSettings.value };
  desktopSettings.value = { ...desktopSettings.value, [key]: checked };
  desktopSaving.value = true;
  desktopError.value = '';
  try {
    desktopSettings.value = await bridge.updateSettings({ [key]: checked });
    notify.success('桌面设置已保存');
  } catch (err) {
    desktopSettings.value = previous;
    desktopError.value = (err as Error).message || '保存桌面设置失败';
  } finally {
    desktopSaving.value = false;
  }
}
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <!-- 顶栏 -->
    <header class="shrink-0 h-14 flex items-center justify-between px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">
          <AppIcon name="cog" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200">系统设置</div>
          <div class="text-[11px] text-slate-400">账号 · 安全 · 访问控制 · AI · 桌面版</div>
        </div>
      </div>
      <button
        type="button"
        class="h-8 px-3 rounded-lg bg-cyan-500 text-white text-xs font-semibold hover:bg-cyan-600 transition-all cursor-pointer"
        @click="openMcpHub"
      >MCP 与远程接入 →</button>
    </header>

    <!-- 主体：左导航 + 右内容 -->
    <div class="flex-1 min-h-0 flex gap-2">
      <!-- 左侧分区导航 -->
      <nav class="shrink-0 w-56 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm p-2 flex flex-col gap-1">
        <button
          v-for="item in TAB_ITEMS"
          :key="item.key"
          type="button"
          class="settings-nav-item cursor-pointer"
          :class="{ 'settings-nav-item--active': tab === item.key }"
          @click="switchTab(item.key)"
        >
          <span class="settings-nav-icon">
            <AppIcon :name="item.icon" :size="17" />
          </span>
          <span class="min-w-0 text-left">
            <span class="block text-[13px] font-semibold leading-tight">{{ item.label }}</span>
            <span class="block text-[10.5px] opacity-70 leading-tight mt-0.5 truncate">{{ item.desc }}</span>
          </span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <section class="flex-1 min-w-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-y-auto">
        <div class="max-w-2xl px-6 py-5">
          <!-- 账号设置 -->
          <form v-if="tab === 'account'" class="flex flex-col gap-4" autocomplete="off" @submit="onSubmit">
            <div class="settings-section-title">账号设置</div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">用户名</label>
              <input
                v-model="username"
                type="text"
                placeholder="admin"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">新访问口令</label>
              <input
                v-model="password"
                type="password"
                placeholder="留空表示不修改"
                autocomplete="new-password"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">确认新访问口令</label>
              <input
                v-model="passwordConfirm"
                type="password"
                placeholder="再次输入新口令"
                autocomplete="new-password"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ errorMsg }}</div>
              <button
                type="submit"
                class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all cursor-pointer"
              >保存设置</button>
            </div>
          </form>

          <!-- IP 访问控制 -->
          <template v-else-if="tab === 'ipfilter'">
            <div class="settings-section-title">IP 访问控制</div>
            <div class="-mx-5 -mb-5">
              <IpFilterTab />
            </div>
          </template>

          <!-- AI 配置 -->
          <form v-else-if="tab === 'aiconfig'" class="flex flex-col gap-4" autocomplete="off" @submit="onAiSubmit">
            <div class="settings-section-title">AI 配置</div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">API 基础地址</label>
              <input
                v-model="apiBase"
                type="text"
                placeholder="https://api.openai.com/v1"
                required
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
              <div class="text-[11px] text-slate-400">不含 /chat/completions 的完整地址</div>
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">API Key</label>
              <input
                v-model="apiKey"
                type="password"
                placeholder="sk-..."
                autocomplete="off"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">模型名称</label>
              <div class="flex gap-2">
                <input
                  v-model="model"
                  type="text"
                  placeholder="gpt-4o"
                  list="settings-ai-model-list"
                  class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
                <button
                  type="button"
                  class="h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all whitespace-nowrap disabled:opacity-50 cursor-pointer"
                  :disabled="fetching"
                  @click="onFetchModels"
                >{{ fetching ? '获取中…' : '获取模型' }}</button>
              </div>
              <datalist id="settings-ai-model-list">
                <option v-for="m in modelsHints" :key="m" :value="m" />
              </datalist>
              <div class="text-[11px] text-slate-400">点击"获取模型"自动填充，也可手动输入</div>
            </div>
            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ aiError }}</div>
              <button
                type="submit"
                class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all cursor-pointer"
              >保存配置</button>
            </div>
          </form>

          <!-- 安全设置 -->
          <form v-else-if="tab === 'security'" class="flex flex-col gap-4" autocomplete="off" @submit="onSecuritySubmit">
            <div class="settings-section-title">安全</div>
            <div v-if="securityLoading" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-400">
              正在加载安全设置…
            </div>

            <!-- 两步验证（2FA） -->
            <div class="rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-[#1e293b] dark:bg-white/[0.03]">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">两步验证（2FA）</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">使用 Google Authenticator 等 TOTP 认证器，为登录增加第二道保护。</div>
                </div>
                <span
                  class="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold"
                  :class="twofaStatus?.enabled
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
                    : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300'"
                >{{ twofaStatus?.enabled ? '已开启' : '未开启' }}</span>
              </div>

              <!-- 未开启：生成密钥 → 扫码 → 输入验证码确认 -->
              <template v-if="twofaStatus && !twofaStatus.enabled">
                <div v-if="!twofaSetup" class="mt-3">
                  <button
                    type="button"
                    class="h-9 px-4 rounded-lg border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-600 hover:bg-blue-100 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200 disabled:opacity-50 cursor-pointer"
                    :disabled="twofaBusy"
                    @click="onTwofaSetup"
                  >{{ twofaBusy ? '生成中…' : '开启两步验证' }}</button>
                </div>
                <div v-else class="mt-3 flex flex-col gap-3">
                  <div class="flex items-start gap-4">
                    <img v-if="twofaQrDataUrl" :src="twofaQrDataUrl" alt="2FA QR Code" class="w-[140px] h-[140px] rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white p-1" />
                    <div class="flex-1 text-xs text-slate-500 dark:text-slate-400">
                      <p>1. 用 Google Authenticator 等认证器应用扫描二维码；</p>
                      <p class="mt-1">2. 无法扫码时手动输入密钥：</p>
                      <code class="mt-1 block break-all rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-[#0b1324] dark:text-slate-200">{{ twofaSetup.secret }}</code>
                      <p class="mt-1">3. 输入认证器显示的 6 位验证码完成开启。</p>
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <input
                      v-model="twofaCode"
                      type="text"
                      inputmode="numeric"
                      maxlength="6"
                      placeholder="6 位验证码"
                      class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm tracking-widest outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                    />
                    <button
                      type="button"
                      class="h-9 px-4 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                      :disabled="twofaBusy"
                      @click="onTwofaEnable"
                    >{{ twofaBusy ? '验证中…' : '确认开启' }}</button>
                  </div>
                </div>
              </template>

              <!-- 刚开启：一次性展示恢复码 -->
              <div v-if="twofaRecoveryCodes.length" class="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-xs font-semibold text-amber-700 dark:text-amber-200">一次性恢复码（仅显示这一次，请立即保存）</div>
                  <button
                    type="button"
                    class="h-7 px-2.5 rounded-lg border border-amber-300 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-500/30 dark:text-amber-200 cursor-pointer"
                    @click="copyRecoveryCodes"
                  >复制全部</button>
                </div>
                <div class="mt-2 grid grid-cols-2 gap-1 font-mono text-[11px] text-amber-800 dark:text-amber-100">
                  <span v-for="c in twofaRecoveryCodes" :key="c">{{ c }}</span>
                </div>
                <div class="mt-2 text-[11px] text-amber-700/80 dark:text-amber-200/80">每个恢复码只能使用一次，用于丢失认证器时登录或关闭 2FA。</div>
              </div>

              <!-- 已开启：剩余恢复码 + 关闭入口 -->
              <template v-if="twofaStatus?.enabled">
                <div class="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  剩余可用恢复码：{{ twofaStatus.remainingRecoveryCodes ?? 0 }} 个
                  <template v-if="twofaStatus.enabledAt">（开启于 {{ new Date(twofaStatus.enabledAt).toLocaleString() }}）</template>
                </div>
                <div class="mt-2 flex gap-2">
                  <input
                    v-model="twofaDisableCode"
                    type="text"
                    placeholder="验证码或恢复码"
                    class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                  />
                  <button
                    type="button"
                    class="h-9 px-4 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-600 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300 disabled:opacity-50 cursor-pointer"
                    :disabled="twofaBusy"
                    @click="onTwofaDisable"
                  >{{ twofaBusy ? '处理中…' : '关闭两步验证' }}</button>
                </div>
                <div class="mt-1 text-[11px] text-slate-400">关闭后可重新开启以重置密钥和恢复码（即"重置 2FA"）。</div>
              </template>

              <div v-if="twofaError" class="mt-2 text-xs text-red-500">{{ twofaError }}</div>
            </div>

            <div class="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              安全默认兼顾个人使用体验和高风险操作保护；如果你要保持当前权限体验，可以关闭 Agent 权限隔离或切到"信任直通"。降级会写入审计。
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">安全档位</label>
              <select
                v-model="securityMode"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              >
                <option v-for="m in securityModes" :key="m" :value="m">{{ SECURITY_MODE_LABELS[m] }}</option>
              </select>
              <div class="text-[11px] text-slate-400">strict：高危需审批/关键风险阻断；trusted：回到更自由的个人使用体验，但灾难命令仍保留红线。</div>
            </div>

            <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
              <input v-model="agentPrivilegeIsolation" type="checkbox" class="mt-1" />
              <span>
                <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">启用 Agent 权限隔离</span>
                <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">AI 命令会包裹为普通用户执行。关闭后恢复目前 root/当前用户直通权限水平。</span>
              </span>
            </label>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">Agent 普通用户</label>
              <input
                v-model="agentUser"
                type="text"
                placeholder="oneshell-agent"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
              <div class="text-[11px] text-slate-400">启用前请先在目标 Linux 主机初始化该用户；下方按钮会创建用户并写入只读 sudo 白名单。</div>
            </div>

            <div class="rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-[#1e293b] dark:bg-white/[0.03]">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">初始化 Agent 普通用户</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">在目标 Linux 主机上创建用户并写入只读 sudo 白名单。需要当前连接用户具备 root 权限。</div>
                </div>
              </div>
              <div class="mt-3 flex gap-2">
                <input
                  v-model="initHostId"
                  type="text"
                  placeholder="local 或主机 ID"
                  class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
                <button
                  type="button"
                  class="h-9 px-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200 disabled:opacity-50 cursor-pointer"
                  :disabled="initLoading"
                  @click="onInitAgentUser"
                >{{ initLoading ? '初始化中…' : '初始化' }}</button>
              </div>
              <pre v-if="initResult" class="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{{ initResult }}</pre>
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ securityError }}</div>
              <button
                type="submit"
                class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                :disabled="securitySaving"
              >{{ securitySaving ? '保存中…' : '保存安全设置' }}</button>
            </div>
          </form>

          <!-- 桌面版设置 -->
          <div v-else-if="tab === 'desktop'" class="flex flex-col gap-4">
            <div class="settings-section-title">桌面版</div>
            <div v-if="desktopLoading" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-400">
              正在加载桌面设置…
            </div>

            <div v-else-if="!desktopAvailable" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-300">
              仅桌面版可配置。当前浏览器模式不会启用开机自启和窗口关闭后的后台运行。
            </div>

            <template v-else-if="desktopSettings">
              <div class="rounded-xl border border-cyan-200 bg-cyan-50/70 px-3 py-3 dark:border-cyan-500/20 dark:bg-cyan-500/10">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-sm font-semibold text-cyan-800 dark:text-cyan-200">本地服务</div>
                    <div class="mt-1 text-xs text-cyan-700/75 dark:text-cyan-200/75">MCP 与 API 继续通过本机 HTTP 端口提供。</div>
                  </div>
                  <div class="shrink-0 rounded-lg bg-white/70 px-2.5 py-1 text-xs font-semibold text-cyan-700 dark:bg-white/10 dark:text-cyan-200">
                    {{ desktopSettings.serviceRunning ? '运行中' : '未运行' }}
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-1 gap-2 text-xs text-cyan-800 dark:text-cyan-100">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-cyan-700/70 dark:text-cyan-200/70">端口</span>
                    <span class="font-mono">{{ desktopSettings.port }}</span>
                  </div>
                  <div class="flex items-start justify-between gap-3">
                    <span class="shrink-0 text-cyan-700/70 dark:text-cyan-200/70">地址</span>
                    <span class="break-all font-mono text-right">{{ desktopSettings.url }}</span>
                  </div>
                </div>
              </div>

              <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  :checked="desktopSettings.startAtLogin"
                  :disabled="desktopSaving"
                  @change="onDesktopToggle('startAtLogin', $event)"
                />
                <span>
                  <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">开机自启</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">登录系统后自动启动 1Shell 桌面版。</span>
                </span>
              </label>

              <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  :checked="desktopSettings.backgroundOnClose"
                  :disabled="desktopSaving"
                  @change="onDesktopToggle('backgroundOnClose', $event)"
                />
                <span>
                  <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">关闭窗口后后台运行</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">关闭主窗口时隐藏到托盘，本地 MCP/API 服务继续保留。</span>
                </span>
              </label>

              <div class="rounded-xl border border-slate-200 bg-white/70 px-3 py-3 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-white/[0.03] dark:text-slate-400">
                <div class="flex items-start justify-between gap-3">
                  <span class="shrink-0 font-semibold text-slate-600 dark:text-slate-300">数据目录</span>
                  <span class="break-all text-right font-mono">{{ desktopSettings.dataDir }}</span>
                </div>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <span class="shrink-0 font-semibold text-slate-600 dark:text-slate-300">环境文件</span>
                  <span class="break-all text-right font-mono">{{ desktopSettings.envFile }}</span>
                </div>
              </div>
            </template>

            <div v-else class="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
              {{ desktopError || '桌面设置不可用' }}
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ desktopError }}</div>
              <button
                type="button"
                class="h-9 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                :disabled="desktopLoading || desktopSaving"
                @click="loadDesktopSettings(true)"
              >刷新</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-section-title {
  font-size: 15px;
  font-weight: 700;
  color: #334155;
}
:global(html.dark) .settings-section-title {
  color: #e2e8f0;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  color: #64748b;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.settings-nav-item:hover {
  background: rgba(59, 130, 246, 0.06);
  color: #2563eb;
}
.settings-nav-item--active {
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.25);
  color: #2563eb;
}
:global(html.dark) .settings-nav-item {
  color: #94a3b8;
}
:global(html.dark) .settings-nav-item:hover {
  background: rgba(56, 189, 248, 0.08);
  color: #7dd3fc;
}
:global(html.dark) .settings-nav-item--active {
  background: rgba(56, 189, 248, 0.12);
  border-color: rgba(56, 189, 248, 0.3);
  color: #7dd3fc;
}

.settings-nav-icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(100, 116, 139, 0.08);
}
.settings-nav-item--active .settings-nav-icon {
  background: rgba(59, 130, 246, 0.14);
}
:global(html.dark) .settings-nav-icon {
  background: rgba(148, 163, 184, 0.08);
}
:global(html.dark) .settings-nav-item--active .settings-nav-icon {
  background: rgba(56, 189, 248, 0.15);
}
</style>
