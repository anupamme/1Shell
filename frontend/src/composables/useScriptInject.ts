// useScriptInject.ts — MainConsole 脚本快捷注入

import { reactive, ref, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useHostsStore } from '@/stores/hosts';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';
import type { ScriptInfo, PreviewResponse } from '@/utils/scripts';

interface ScriptsListResponse { scripts?: ScriptInfo[] }

export interface ScriptInjectApi {
  readonly scriptOpen: Ref<boolean>;
  readonly scripts: Ref<ScriptInfo[]>;
  readonly selectedScriptId: Ref<string>;
  readonly selectedScript: Ref<ScriptInfo | null>;
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

  let initialized = false;

  function getHostId(): string {
    return hosts.selected?.id || sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  }

  function injectToTerminal(command: string): boolean {
    const lines = command.split('\n').filter((line) => line.trim() !== '');
    const payload = lines.length <= 1
      ? `${command.trim()}\n`
      : `bash << '__1SHELL_EOF__'\n${command}\n__1SHELL_EOF__\n`;

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
    (script.parameters || []).forEach((def) => {
      params[def.name] = def.default !== undefined && def.default !== null ? String(def.default) : '';
    });
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
      const resp = await requestJson<PreviewResponse>(
        `/api/scripts/${encodeURIComponent(script.id)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({ hostId: getHostId(), params: { ...params } }),
        },
      );
      previewCommand.value = resp.renderedCommand || '（空）';
      previewError.value = false;
    } catch (err) {
      previewCommand.value = `预览失败: ${(err as Error).message}`;
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
