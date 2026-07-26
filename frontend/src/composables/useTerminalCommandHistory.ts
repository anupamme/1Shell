// useTerminalCommandHistory.ts — 终端输入镜像：追踪最近提交的命令
// 4.7.5 起 AI 行内补全（useTerminalAi / SuggestionBox / GhostOverlay）退役，
// 仅保留这条输入镜像链路：选区分析（useTerminalAnalyze）把最近命令作为上下文发给 AI。
// CSI 解析逻辑与老 terminal-ai.js splitControlSequence 一致（去掉 ghost 相关分支）。

import { useSessionTerminal } from '@/composables/useSessionTerminal';

interface ParsedInput {
  printableText: string;
  backspaceCount: number;
  submitted: boolean;
  cleared: boolean;
}

export interface TerminalCommandHistoryApi {
  initialize(): void;
  resetInputState(): void;
  getRecentCommands(): string[];
}

let _instance: TerminalCommandHistoryApi | null = null;

export function useTerminalCommandHistory(): TerminalCommandHistoryApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetTerminalCommandHistorySingleton(): void {
  _instance = null;
}

function splitControlSequence(data: string): ParsedInput {
  let printableText = '';
  let backspaceCount = 0;
  let submitted = false;
  let cleared = false;
  let inEsc = false;
  let inCsi = false;

  const chars = String(data || '');
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const code = chars.charCodeAt(i);

    if (inCsi) {
      if (code >= 0x40 && code <= 0x7E) inCsi = false;
      continue;
    }

    if (inEsc) {
      inEsc = false;
      if (char === '[') inCsi = true;
      continue;
    }

    if (code === 0x1B) {
      inEsc = true;
      continue;
    }

    if (char === '\r' || char === '\n') {
      submitted = true;
      continue;
    }

    // Ctrl+C / Ctrl+D / Ctrl+U 视为清行
    if (code === 0x03 || code === 0x04 || code === 0x15) {
      cleared = true;
      continue;
    }

    if (code === 0x7F) {
      backspaceCount += 1;
      continue;
    }

    if (code < 0x20) continue;

    printableText += char;
  }

  return { printableText, backspaceCount, submitted, cleared };
}

function create(): TerminalCommandHistoryApi {
  const sessionTerminal = useSessionTerminal();

  let initialized = false;
  let inputBuffer = '';
  let recentCommands: string[] = [];

  function rememberCommittedCommand(rawCommand: string): void {
    const command = String(rawCommand || '').trim();
    if (!command) return;
    recentCommands = [...recentCommands, command].slice(-5);
  }

  function resetInputState(): void {
    inputBuffer = '';
  }

  function handleInputMirror(data: string): void {
    if (!data) return;
    const parsed = splitControlSequence(data);
    if (parsed.cleared) inputBuffer = '';
    if (parsed.backspaceCount) inputBuffer = inputBuffer.slice(0, -parsed.backspaceCount);
    if (parsed.printableText) inputBuffer += parsed.printableText;
    if (parsed.submitted) {
      rememberCommittedCommand(inputBuffer);
      inputBuffer = '';
    }
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;
    sessionTerminal.onInput(({ data }) => handleInputMirror(String(data || '')));
    sessionTerminal.onLifecycle(({ type }) => {
      if (['clear', 'reset', 'session-change', 'host-switch-start', 'socket-disconnect', 'session-error'].includes(type)) {
        resetInputState();
      }
    });
  }

  return {
    initialize,
    resetInputState,
    getRecentCommands: () => [...recentCommands],
  };
}
