export interface McpInfo {
  id: string;
  name: string;
  // 远程
  url?: string;
  authTokenSet?: boolean;
  // 本地
  type?: 'local' | string;
  command?: string;
  installDir?: string;
  // 通用
  description?: string;
  tags?: string[];
  enabled?: boolean;
  autoStart?: boolean;
  exposeToIde?: boolean;
  runtimeStatus?: string;
  runtimeError?: string;
  toolCount?: number;
}

export interface McpServersResponse {
  servers: McpInfo[];
}

/** 输入框逗号串 → 去空 trim 数组 */
export function parseTags(raw: string): string[] {
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/** tags 数组 → 输入框逗号串展示 */
export function serializeTags(tags: string[] | undefined): string {
  return (tags || []).join(', ');
}
