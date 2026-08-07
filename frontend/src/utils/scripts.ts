export interface ScriptInfo {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  content: string;
  /** 从 content 扫描出的 {{变量}} 名单，服务端派生，只读 */
  placeholders?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ScriptsListResponse {
  ok: boolean;
  scripts: ScriptInfo[];
}

export interface RenderResponse {
  ok: boolean;
  renderedCommand: string;
  placeholders: string[];
  /** 渲染时用的 shell 转义风格，决定多行注入怎么包装 */
  shellStyle: 'bash' | 'powershell';
}

export function makeDraftScript(): ScriptInfo {
  return {
    id: '',
    name: '未命名脚本',
    description: '',
    tags: [],
    content: '#!/bin/bash\nset -e\n',
    placeholders: [],
  };
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delayMs: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

/**
 * 前端侧的占位符扫描，与后端 lib/script-placeholders.js 同一套规则。
 * 只用于编辑器里即时提示"这个脚本有哪些参数"——渲染和转义一律走服务端。
 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function extractPlaceholders(content: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let match = PLACEHOLDER_RE.exec(content || '');
  while (match) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
    match = PLACEHOLDER_RE.exec(content || '');
  }
  return names;
}
