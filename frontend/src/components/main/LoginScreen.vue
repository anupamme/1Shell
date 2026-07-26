<script setup lang="ts">
// 登录页 — 4.2 改版：整页深色终端风 + 2FA 两步登录
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useApiClient, ApiError } from '@/composables/useApiClient';
import { useAuthStore } from '@/stores/auth';

const emit = defineEmits<{
  'logged-in': [];
}>();

const { requestJson } = useApiClient();
const auth = useAuthStore();

const LAST_USER_KEY = '1shell.last-login-user';

const step = ref<'credentials' | 'twofactor'>('credentials');
const username = ref('');
const password = ref('');
const pendingToken = ref('');
const twoFactorCode = ref('');
const errorMsg = ref('');
const submitting = ref(false);
const usernameInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const codeInput = ref<HTMLInputElement | null>(null);
const capsLockOn = ref(false);
const passwordFocused = ref(false);

function detectCapsLock(e: KeyboardEvent): void {
  if (typeof e.getModifierState === 'function') {
    capsLockOn.value = e.getModifierState('CapsLock');
  }
}

onMounted(async () => {
  // 桌面版免登录自愈：窗口挂后台超过会话 TTL 再唤起会话过期撞到这里，
  // 先让 Electron 主进程凭本机 token 静默重签，成功则不打扰用户。
  const bridge = window.oneshellDesktop;
  if (bridge?.isDesktop && bridge.refreshLocalSession) {
    try {
      if (await bridge.refreshLocalSession()) {
        await finishLogin();
        if (auth.authenticated) return;
      }
    } catch { /* 静默失败回落到正常登录 */ }
  }

  try {
    const last = localStorage.getItem(LAST_USER_KEY);
    if (last) username.value = last;
  } catch {
    /* localStorage 不可用就算了 */
  }

  await nextTick();
  if (username.value) passwordInput.value?.focus();
  else usernameInput.value?.focus();

  window.addEventListener('keydown', detectCapsLock);
  window.addEventListener('keyup', detectCapsLock);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', detectCapsLock);
  window.removeEventListener('keyup', detectCapsLock);
});

async function finishLogin(): Promise<void> {
  const data = await requestJson<{ enabled?: boolean; authenticated?: boolean }>('/api/auth/status');
  auth.setEnabled(Boolean(data.enabled));
  auth.setAuthenticated(Boolean(data.authenticated));
  auth.setUser({ username: username.value });

  if (auth.authenticated) {
    try {
      // 桌面免登录路径 username 为空，不覆盖用户记住的最近用户名
      if (username.value) localStorage.setItem(LAST_USER_KEY, username.value);
    } catch {
      /* noop */
    }
    username.value = '';
    emit('logged-in');
  } else {
    errorMsg.value = '登录成功，但会话同步失败，请刷新页面重试。';
  }
}

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = '';
  submitting.value = true;

  try {
    const resp = await requestJson<{
      ok?: boolean;
      requiresTwoFactor?: boolean;
      pendingToken?: string;
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: username.value || '',
        password: password.value,
      }),
    });
    password.value = '';

    if (resp.requiresTwoFactor && resp.pendingToken) {
      pendingToken.value = resp.pendingToken;
      twoFactorCode.value = '';
      step.value = 'twofactor';
      await nextTick();
      codeInput.value?.focus();
      return;
    }

    await finishLogin();
  } catch (err) {
    errorMsg.value = (err as ApiError | Error).message || '登录失败';
  } finally {
    submitting.value = false;
  }
}

async function onSubmitTwoFactor(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = '';
  submitting.value = true;

  try {
    await requestJson('/api/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({
        pendingToken: pendingToken.value,
        code: twoFactorCode.value.trim(),
      }),
    });
    twoFactorCode.value = '';
    pendingToken.value = '';
    await finishLogin();
    step.value = 'credentials';
  } catch (err) {
    const message = (err as ApiError | Error).message || '验证失败';
    errorMsg.value = message;
    // 票据过期/失效 → 回到第一步重新登录
    if (/过期|重新登录/.test(message)) {
      backToCredentials();
    }
  } finally {
    submitting.value = false;
  }
}

function backToCredentials(): void {
  step.value = 'credentials';
  pendingToken.value = '';
  twoFactorCode.value = '';
  void nextTick(() => passwordInput.value?.focus());
}
</script>

<template>
  <div class="login-screen fixed inset-0 z-[9000] flex overflow-hidden">
    <!-- 左侧品牌区（窄屏隐藏） -->
    <div class="brand-panel hidden lg:flex flex-col flex-1 p-12 xl:p-16 select-none">
      <!-- 品牌头 -->
      <div class="flex items-center gap-3">
        <div class="brand-logo" aria-hidden="true">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="m5 7 5 5-5 5" />
            <path d="M13 17h6" />
          </svg>
        </div>
        <div class="text-xl font-bold tracking-tight text-slate-100">1Shell</div>
      </div>

      <!-- 中部：标语 + 终端窗口 -->
      <div class="flex flex-1 flex-col justify-center gap-10 py-10 max-w-xl">
        <div>
          <h1 class="text-[2.5rem] xl:text-5xl font-extrabold leading-tight tracking-tight text-white">
            One Shell to<br />rule them all<span class="text-emerald-400">.</span>
          </h1>
          <p class="mt-4 text-base text-slate-400">
            WebSSH<span class="brand-sep">·</span>VPS 管理中枢<span class="brand-sep">·</span>MCP Server
          </p>
        </div>

        <!-- 模拟终端 -->
        <div class="terminal-window" aria-hidden="true">
          <div class="terminal-titlebar">
            <span class="terminal-dot bg-[#ff5f57]"></span>
            <span class="terminal-dot bg-[#febc2e]"></span>
            <span class="terminal-dot bg-[#28c840]"></span>
            <span class="terminal-title">1shell — ssh</span>
          </div>
          <div class="terminal-body">
            <div class="term-line" style="--i: 0">
              <span class="text-emerald-400">$</span> <span class="text-slate-200">ssh prod-web-01</span>
            </div>
            <div class="term-line" style="--i: 1">
              <span class="text-emerald-400">✓</span> <span class="text-slate-400">已连接 · 47ms · Ubuntu 24.04 LTS</span>
            </div>
            <div class="term-line" style="--i: 2">
              <span class="text-emerald-400">$</span> <span class="text-slate-200">1shell probe status</span>
            </div>
            <div class="term-line" style="--i: 3">
              <span class="text-emerald-400">●</span> <span class="text-slate-400">6/6 主机在线 · CPU 12% · 内存 38%</span>
            </div>
            <div class="term-line" style="--i: 4">
              <span class="text-sky-400">⇄</span> <span class="text-slate-400">Claude Code 经 1Shell MCP 接入</span>
            </div>
            <div class="term-line" style="--i: 5">
              <span class="text-emerald-400">$</span> <span class="terminal-cursor"></span>
            </div>
          </div>
        </div>

        <!-- 三条能力 -->
        <ul class="flex flex-col gap-3.5 text-sm text-slate-400">
          <li class="flex items-center gap-3">
            <span class="feature-icon">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="m7 9 3 3-3 3M13 15h4" />
              </svg>
            </span>
            <span>多主机 WebSSH 终端、SFTP 文件管理与脚本库，一个入口管理所有 VPS</span>
          </li>
          <li class="flex items-center gap-3">
            <span class="feature-icon">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </span>
            <span>探针监控、告警与审计留痕，主机状态可观察、操作可回溯</span>
          </li>
          <li class="flex items-center gap-3">
            <span class="feature-icon">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 8V4H8" />
                <rect x="4" y="8" width="16" height="12" rx="2" />
                <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
              </svg>
            </span>
            <span>标准 MCP Server，让 Claude Code、Codex 等 AI Agent 安全操控 VPS</span>
          </li>
        </ul>
      </div>

      <!-- 底部 -->
      <div class="text-xs text-slate-500">给人和 AI Agent 共用的多主机运维平台</div>
    </div>

    <!-- 右侧登录区 -->
    <div class="auth-panel w-full lg:w-[460px] xl:w-[500px] flex items-center justify-center p-6">
      <div class="w-full max-w-sm">
        <!-- 窄屏品牌头 -->
        <div class="lg:hidden mb-8 flex flex-col items-center">
          <div class="brand-logo brand-logo--lg" aria-hidden="true">
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="m5 7 5 5-5 5" />
              <path d="M13 17h6" />
            </svg>
          </div>
          <div class="mt-3 text-2xl font-extrabold tracking-tight text-slate-900">1Shell</div>
          <div class="mt-1 text-xs text-slate-500">One Shell to rule them all.</div>
        </div>

        <div class="auth-card">
        <!-- 第一步：账号密码 -->
        <template v-if="step === 'credentials'">
          <h2 class="text-2xl font-bold tracking-tight text-slate-900">登录</h2>
          <p class="mt-1.5 text-sm text-slate-500">进入你的多主机控制台</p>

          <form class="mt-7 flex flex-col gap-5" autocomplete="off" @submit="onSubmit">
            <div class="flex flex-col gap-1.5">
              <label for="login-username" class="text-[13px] font-medium text-slate-700">用户名</label>
              <input
                id="login-username"
                ref="usernameInput"
                v-model="username"
                type="text"
                autocomplete="username"
                placeholder="admin"
                required
                class="login-input"
              />
            </div>

            <div class="flex flex-col gap-1.5">
              <label for="login-password" class="text-[13px] font-medium text-slate-700">访问口令</label>
              <input
                id="login-password"
                ref="passwordInput"
                v-model="password"
                type="password"
                autocomplete="current-password"
                placeholder="输入访问口令"
                required
                class="login-input"
                @focus="passwordFocused = true"
                @blur="passwordFocused = false"
                @keydown="detectCapsLock"
              />
              <div
                v-if="passwordFocused && capsLockOn"
                class="flex items-center gap-1.5 text-xs text-amber-600"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m18 11-6-6-6 6M12 5v9" /><path d="M6 19h12" />
                </svg>
                <span>大写锁定已开启</span>
              </div>
            </div>

            <div v-if="errorMsg" role="alert" class="login-error">{{ errorMsg }}</div>

            <button type="submit" :disabled="submitting" class="login-submit cursor-pointer">
              <svg v-if="submitting" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span>{{ submitting ? '登录中…' : '登录' }}</span>
            </button>
          </form>
        </template>

        <!-- 第二步：两步验证 -->
        <template v-else>
          <div class="twofa-badge" aria-hidden="true">
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            </svg>
          </div>
          <h2 class="mt-4 text-2xl font-bold tracking-tight text-slate-900">两步验证</h2>
          <p class="mt-1.5 text-sm text-slate-500">
            输入认证器中的 6 位验证码；丢失认证器时可输入一次性恢复码
          </p>

          <form class="mt-7 flex flex-col gap-5" autocomplete="off" @submit="onSubmitTwoFactor">
            <div class="flex flex-col gap-1.5">
              <label for="login-2fa-code" class="text-[13px] font-medium text-slate-700">验证码 / 恢复码</label>
              <input
                id="login-2fa-code"
                ref="codeInput"
                v-model="twoFactorCode"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                placeholder="000000"
                required
                class="login-input login-input--code"
              />
            </div>

            <div v-if="errorMsg" role="alert" class="login-error">{{ errorMsg }}</div>

            <button type="submit" :disabled="submitting" class="login-submit cursor-pointer">
              <svg v-if="submitting" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span>{{ submitting ? '验证中…' : '验证并登录' }}</span>
            </button>

            <button
              type="button"
              class="self-center text-xs text-slate-500 hover:text-blue-600 transition-colors cursor-pointer"
              @click="backToCredentials"
            >← 返回重新登录</button>
          </form>
        </template>
        </div>

        <div class="mt-8 text-center text-[11px] text-slate-400 select-none">
          1Shell · 给人和 AI Agent 共用的多主机运维平台
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-screen {
  background: #0f172a;
}

/* ===== 左侧品牌区：终端永远是深色的 ===== */
.brand-panel {
  position: relative;
  background:
    radial-gradient(ellipse 80% 60% at 20% 0%, rgba(37, 99, 235, 0.18), transparent 65%),
    radial-gradient(ellipse 60% 50% at 90% 100%, rgba(16, 185, 129, 0.07), transparent 70%),
    #0f172a;
}
.brand-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgba(148, 163, 184, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.05) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(ellipse 90% 80% at 35% 40%, #000 30%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 90% 80% at 35% 40%, #000 30%, transparent 75%);
  pointer-events: none;
}
.brand-panel > * {
  position: relative;
}

.brand-sep {
  margin: 0 0.55em;
  color: #475569;
}

.brand-logo {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #38bdf8, #2563eb);
  box-shadow: 0 4px 16px rgba(37, 99, 235, 0.4);
}
.brand-logo--lg {
  width: 48px;
  height: 48px;
  border-radius: 13px;
}

/* ===== 模拟终端 ===== */
.terminal-window {
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(2, 6, 23, 0.72);
  box-shadow:
    0 24px 48px -16px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(2, 6, 23, 0.4);
  overflow: hidden;
  backdrop-filter: blur(6px);
}
.terminal-titlebar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(15, 23, 42, 0.6);
}
.terminal-dot {
  width: 11px;
  height: 11px;
  border-radius: 9999px;
}
.terminal-title {
  margin-left: 8px;
  font-size: 11px;
  color: #64748b;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
}
.terminal-body {
  padding: 16px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  font-size: 12.5px;
  line-height: 1.5;
}
.term-line {
  opacity: 0;
  transform: translateY(4px);
  animation: term-line-in 360ms ease-out forwards;
  animation-delay: calc(420ms + var(--i) * 460ms);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@keyframes term-line-in {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.terminal-cursor {
  display: inline-block;
  width: 8px;
  height: 15px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: #34d399;
  animation: cursor-blink 1.1s steps(1) infinite;
}
@keyframes cursor-blink {
  50% {
    opacity: 0;
  }
}

.feature-icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #7dd3fc;
  background: rgba(56, 189, 248, 0.09);
  border: 1px solid rgba(56, 189, 248, 0.18);
}

/* ===== 右侧登录区 ===== */
.auth-panel {
  background:
    radial-gradient(ellipse 90% 60% at 50% -10%, rgba(56, 132, 255, 0.07), transparent 70%),
    linear-gradient(180deg, #f4f7fb, #eef2f8);
  border-left: 1px solid rgba(148, 163, 184, 0.22);
  animation: panel-in 420ms ease-out both;
}

.auth-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 28px 26px;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 12px 32px -12px rgba(15, 23, 42, 0.12);
}

.login-input {
  width: 100%;
  height: 42px;
  padding: 0 13px;
  border-radius: 9px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #0f172a;
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.login-input::placeholder {
  color: #94a3b8;
}
.login-input:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}

.login-input--code {
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  font-size: 16px;
  letter-spacing: 0.35em;
  text-align: center;
}

.login-error {
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid rgba(220, 38, 38, 0.25);
  background: rgba(220, 38, 38, 0.05);
  color: #dc2626;
  font-size: 12.5px;
  line-height: 1.5;
}

.login-submit {
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 9px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1);
}
.login-submit:hover:not(:disabled) {
  background: #1d4ed8;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
}
.login-submit:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.login-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.twofa-badge {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #2563eb;
  background: rgba(37, 99, 235, 0.08);
  border: 1px solid rgba(37, 99, 235, 0.18);
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-panel {
    animation: none;
  }
  .term-line {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .terminal-cursor {
    animation: none;
  }
}
</style>
