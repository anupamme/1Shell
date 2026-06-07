<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { useAiChat } from '@/composables/useAiChat';
import IpFilterTab from '@/components/main/IpFilterTab.vue';

interface Props {
  open: boolean;
}

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

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

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

type Tab = 'account' | 'ipfilter' | 'aiconfig' | 'security' | 'desktop';
const tab = ref<Tab>('account');

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

type DesktopBooleanKey = 'startAtLogin' | 'backgroundOnClose';

const desktopAvailable = ref(false);
const desktopLoading = ref(false);
const desktopSaving = ref(false);
const desktopError = ref('');
const desktopSettingsLoaded = ref(false);
const desktopSettings = ref<OneShellDesktopSettings | null>(null);

watch(() => props.open, (v) => {
  if (v) {
    tab.value = 'account';
    username.value = '';
    password.value = '';
    passwordConfirm.value = '';
    errorMsg.value = '';
    securitySettingsLoaded.value = false;
    desktopSettingsLoaded.value = false;
    desktopError.value = '';
  }
});

watch(tab, (t) => {
  if (t === 'aiconfig') {
    apiBase.value = chat.config.value.apiBase;
    apiKey.value = chat.config.value.apiKey;
    model.value = chat.config.value.model;
    aiError.value = '';
    modelsHints.value = [];
  } else if (t === 'security') {
    void loadSecuritySettings();
  } else if (t === 'desktop') {
    void loadDesktopSettings();
  }
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
    emit('close');
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
  emit('close');
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
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div class="modal-box w-full max-w-lg bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-[#1e293b]">
        <div class="modal-header flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-[#1e293b]">
          <div class="modal-title text-base font-bold text-slate-700 dark:text-slate-200">系统设置</div>
          <button
            class="h-7 px-2.5 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 dark:text-slate-300 hover:text-red-500 hover:border-red-200 transition-all"
            type="button"
            @click="emit('close')"
          >关闭</button>
        </div>

        <!-- Tab 切换 -->
        <div class="flex flex-wrap gap-1 px-5 pt-4">
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'account' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'account'"
          >账号设置</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'ipfilter' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'ipfilter'"
          >IP 访问控制</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'aiconfig' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'aiconfig'"
          >AI 配置</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'security' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'security'"
          >安全</button>
          <button
            class="h-8 px-4 rounded-lg text-xs font-semibold transition-all"
            :class="tab === 'desktop' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500'"
            @click="tab = 'desktop'"
          >桌面版</button>
        </div>

        <div class="mx-5 mt-3 flex items-center justify-between gap-3 rounded-xl border border-cyan-200 bg-cyan-50/70 px-3 py-2 dark:border-cyan-500/20 dark:bg-cyan-500/10">
          <div>
            <div class="text-xs font-semibold text-cyan-700 dark:text-cyan-300">MCP 与远程接入</div>
            <div class="text-[11px] text-cyan-700/70 dark:text-cyan-200/70">连接外部 MCP、管理 1Shell MCP Server 与 VPS Remote MCP。</div>
          </div>
          <button
            type="button"
            class="h-8 px-3 rounded-lg bg-cyan-500 text-white text-xs font-semibold hover:bg-cyan-600 transition-all shrink-0"
            @click="openMcpHub"
          >打开 MCP Hub</button>
        </div>

        <!-- 账号设置 -->
        <form v-if="tab === 'account'" class="p-5 flex flex-col gap-4" autocomplete="off" @submit="onSubmit">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">用户名</label>
            <input
              v-model="username"
              type="text"
              placeholder="admin"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">新访问口令</label>
            <input
              v-model="password"
              type="password"
              placeholder="留空表示不修改"
              autocomplete="new-password"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">确认新访问口令</label>
            <input
              v-model="passwordConfirm"
              type="password"
              placeholder="再次输入新口令"
              autocomplete="new-password"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
          <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
            <div class="text-red-500 text-xs">{{ errorMsg }}</div>
            <button
              type="submit"
              class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all"
            >保存设置</button>
          </div>
        </form>

        <!-- IP 访问控制 -->
        <IpFilterTab v-else-if="tab === 'ipfilter'" />

        <!-- AI 配置 -->
        <form v-else-if="tab === 'aiconfig'" class="p-5 flex flex-col gap-4" autocomplete="off" @submit="onAiSubmit">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">API 基础地址</label>
            <input
              v-model="apiBase"
              type="text"
              placeholder="https://api.openai.com/v1"
              required
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
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
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
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
                class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
              <button
                type="button"
                class="h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all whitespace-nowrap disabled:opacity-50"
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
              class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all"
            >保存配置</button>
          </div>
        </form>

        <!-- 安全设置 -->
        <form v-else-if="tab === 'security'" class="p-5 flex flex-col gap-4" autocomplete="off" @submit="onSecuritySubmit">
          <div v-if="securityLoading" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-400">
            正在加载安全设置…
          </div>

          <div class="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            安全默认兼顾个人使用体验和高风险操作保护；如果你要保持当前权限体验，可以关闭 Agent 权限隔离或切到“信任直通”。降级会写入审计。
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">安全档位</label>
            <select
              v-model="securityMode"
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            >
              <option v-for="m in securityModes" :key="m" :value="m">{{ SECURITY_MODE_LABELS[m] }}</option>
            </select>
            <div class="text-[11px] text-slate-400">strict：高危需审批/关键风险阻断；trusted：回到更自由的个人使用体验，但灾难命令仍保留红线。</div>
          </div>

          <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324]">
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
              class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
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
                class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
              <button
                type="button"
                class="h-9 px-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200 disabled:opacity-50"
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
              class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50"
              :disabled="securitySaving"
            >{{ securitySaving ? '保存中…' : '保存安全设置' }}</button>
          </div>
        </form>

        <!-- 桌面版设置 -->
        <div v-else-if="tab === 'desktop'" class="p-5 flex flex-col gap-4">
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

            <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324]">
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

            <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324]">
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
              class="h-9 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50"
              :disabled="desktopLoading || desktopSaving"
              @click="loadDesktopSettings(true)"
            >刷新</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
