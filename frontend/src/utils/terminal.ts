// terminal.ts — MainConsole 刀 2 终端相关共享类型
// 与老 [public/session-terminal.js](public/session-terminal.js) + [public/terminal-ai.js](public/terminal-ai.js) 1:1 对应

import type { ITheme } from '@xterm/xterm';

/* ───── 会话 ─────────────────────────────────────────── */

export type SessionStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

export interface SessionInfo {
  id: string;
  hostId: string;
  hostName?: string;
  status: SessionStatus;
  warning?: string;
  lastError?: string;
  cols?: number;
  rows?: number;
  createdAt?: number;
}

export interface SessionInputMeta {
  source?: string;
  [key: string]: unknown;
}

export interface SessionOutputPayload {
  sessionId: string;
  data: string;
}

export type LifecycleType =
  | 'host-switch-start'
  | 'session-change'
  | 'session-status'
  | 'session-error'
  | 'socket-connect'
  | 'socket-disconnect'
  | 'socket-error'
  | 'clear'
  | 'reset';

export interface LifecyclePayload {
  type: LifecycleType | string;
  hostId?: string;
  sessionId?: string;
  status?: SessionStatus;
  error?: string;
  reason?: string;
  forceReconnect?: boolean;
}

/* ───── xterm 主题（与老 session-terminal.js DARK_THEME/LIGHT_THEME 1:1） ───── */

export const DARK_THEME: ITheme = {
  background: '#0b101c',
  foreground: '#e2e8f0',
  cursor: '#38bdf8',
  selectionBackground: 'rgba(56, 189, 248, 0.28)',
  black: '#1e293b', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
  blue: '#38bdf8', magenta: '#c084fc', cyan: '#22d3ee', white: '#f8fafc',
  brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#6ee7b7',
  brightYellow: '#fde047', brightBlue: '#7dd3fc', brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

export const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#0f172a',
  cursor: '#0284c7',
  selectionBackground: 'rgba(2, 132, 199, 0.18)',
  black: '#1e293b', red: '#dc2626', green: '#059669', yellow: '#d97706',
  blue: '#0284c7', magenta: '#7c3aed', cyan: '#0891b2', white: '#f8fafc',
  brightBlack: '#64748b', brightRed: '#ef4444', brightGreen: '#10b981',
  brightYellow: '#f59e0b', brightBlue: '#0ea5e9', brightMagenta: '#8b5cf6',
  brightCyan: '#06b6d4', brightWhite: '#ffffff',
};

/* ───── 缓冲/超时常量 ─────────────────────────────────── */

/** 单会话历史缓冲上限,与老 session-terminal.js .slice(-200000) 一致 */
export const SESSION_BUFFER_LIMIT = 200_000;

/** 重连指数退避起点 ms */
export const RECONNECT_DELAY_MIN = 1000;
/** 重连指数退避上限 ms */
export const RECONNECT_DELAY_MAX = 10_000;

/* ───── 终端区按钮 emit 类型(辅助) ───────────────── */

export interface TerminalAreaEmits {
  (e: 'host-change', hostId: string): void;
  (e: 'host-close', hostId: string): void;
  (e: 'fullscreen-toggle', value: boolean): void;
  (e: 'open-script-inject'): void;
}
