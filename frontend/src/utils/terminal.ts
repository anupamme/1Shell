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
  background: '#0f1729',
  foreground: '#dbeafe',
  cursor: '#4f8cff',
  selectionBackground: 'rgba(79, 140, 255, 0.28)',
  black: '#1f2937', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5eefc',
  brightBlack: '#4b5563', brightRed: '#fca5a5', brightGreen: '#86efac',
  brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9', brightWhite: '#f8fafc',
};

export const LIGHT_THEME: ITheme = {
  background: '#f8fafc',
  foreground: '#1e293b',
  cursor: '#3b82f6',
  selectionBackground: 'rgba(59, 130, 246, 0.18)',
  black: '#374151', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#7c3aed', cyan: '#0891b2', white: '#f8fafc',
  brightBlack: '#6b7280', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
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
