// useScriptInject.ts — 终端页脚本注入
//
// 渲染（占位符替换 + shell 转义）走服务端 /api/scripts/:id/render，不在前端拼：
// 转义是防命令注入的关键，必须和 agent 执行走同一套实现。

import { computed, reactive, ref, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { ScriptInfo, RenderResponse } from '@/utils/scripts';

interface ScriptsListResponse { scripts?: ScriptInfo[] }

export interface ScriptInjectApi {
  readonly scriptOpen: Ref<boolean>;
  readonly scripts: Ref<ScriptInfo[]>;
  readonly selectedScriptId: Ref<string>;
  readonly selectedScript: Ref<ScriptInfo | null>;
  readonly placeholders: Ref<string[]>;
  readonly params: Record<string, string>;
  readonly previewCommand: Ref<string>;
  readonly previewError: Ref<boolean>;

  initialize(): void;
  openScriptPanel(): void;
  closeScriptPanel(): void;
  onScriptChange(id: string): void;
  updateParam(name: string, value: string): void;
  refreshPreview(): void;
  injectScript(): void;
  copyScript(): void;
}

let _instance: ScriptInjectApi | null = null;

export function useScriptInject(): ScriptInjectApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetScriptInjectSingleton(): void {
  _instance = null;
}

function create(): ScriptInjectApi {
  const { requestJson } = useApiClient();
  const hosts = useHostsStore();
  const sessionTerminal = useSessionTerminal();
  const notify = useNotifyStore();

  const scriptOpen = ref(false);
  const scripts = ref<ScriptInfo[]>([]);
  const selectedScriptId = ref('');
  const selectedScript = ref<ScriptInfo | null>(null);
  const params = reactive<Record<string, string>>({});
  const previewCommand = ref('');
  const previewError = ref(false);
  const shellStyle = ref<'bash' | 'powershell'>('bash');

  const placeholders = computed(() => selectedScript.value?.placeholders || []);

  let initialized = false;

  function getHostId(): string {
    return hosts.selected?.id || sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  }

  function injectToTerminal(command: string): boolean {
    const isMultiline = command.split('\n').filter((line) => line.trim() !== '').length > 1;
    // 多行 POSIX 脚本包 heredoc，避免逐行进 shell 时被历史/补全打断；
    // PowerShell 没有等价写法，原样送多行由它自己处理。
    const body = (isMultiline && shellStyle.value === 'bash')
      ? `bash << '__1SHELL_EOF__'\n${command}\n__1SHELL_EOF__`
      : command.trim();
    // PTY 的回车是 \r，不是 \n（与 AgentView 的注入保持一致）
    const payload = `${body.replace(/\r?\n/g, '\r')}\r`;

    if (!sessionTerminal.sendSessionInput(payload)) {
      notify.warn('注入失败，终端会话未就绪');
      return false;
    }
    return true;
  }

  function clearParams(): void {
    Object.keys(params).forEach((key) => { delete params[key]; });
  }

  async function loadScripts(): Promise<void> {
    try {
      const resp = await requestJson<ScriptsListResponse>('/api/scripts');
      scripts.value = resp.scripts || [];
    } catch {
      scripts.value = [];
    }
  }

  function onScriptChange(id: string): void {
    selectedScriptId.value = id;
    const script = scripts.value.find((item) => item.id === id) || null;
    selectedScript.value = script;
    clearParams();
    previewCommand.value = '';
    previewError.value = false;
    if (!script) return;
    // 每个占位符都建一个键（空串），服务端据此渲染
    (script.placeholders || []).forEach((name) => { params[name] = ''; });
    void refreshPreview();
  }

  function updateParam(name: string, value: string): void {
    params[name] = value;
    void refreshPreview();
  }

  async function refreshPreview(): Promise<void> {
    const script = selectedScript.value;
    if (!script) return;
    try {
      const resp = await requestJson<RenderResponse>(
        `/api/scripts/${encodeURIComponent(script.id)}/render`,
        {
          method: 'POST',
          body: JSON.stringify({ hostId: getHostId(), params: { ...params } }),
        },
      );
      previewCommand.value = resp.renderedCommand || '（空）';
      shellStyle.value = resp.shellStyle === 'powershell' ? 'powershell' : 'bash';
      previewError.value = false;
    } catch (err) {
      previewCommand.value = `渲染失败: ${(err as Error).message}`;
      previewError.value = true;
    }
  }

  function injectScript(): void {
    if (!previewCommand.value || previewError.value) return;
    if (injectToTerminal(previewCommand.value)) {
      closeScriptPanel();
      sessionTerminal.focusTerminal();
    }
  }

  function copyScript(): void {
    if (!previewCommand.value || previewError.value) return;
    navigator.clipboard?.writeText(previewCommand.value).then(() => {
      notify.success('命令已复制');
    }).catch(() => { /* ignore */ });
  }

  function openScriptPanel(): void {
    scriptOpen.value = true;
    if (!scripts.value.length) void loadScripts();
  }

  function closeScriptPanel(): void {
    scriptOpen.value = false;
    selectedScriptId.value = '';
    selectedScript.value = null;
    clearParams();
    previewCommand.value = '';
    previewError.value = false;
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;
  }

  return {
    scriptOpen,
    scripts,
    selectedScriptId,
    selectedScript,
    placeholders,
    params,
    previewCommand,
    previewError,
    initialize,
    openScriptPanel,
    closeScriptPanel,
    onScriptChange,
    updateParam,
    refreshPreview,
    injectScript,
    copyScript,
  };
}
