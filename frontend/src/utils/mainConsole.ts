// mainConsole.ts — MainConsole 主控台共享类型
// 与老 [public/app.js](public/app.js) + [public/hosts.js](public/hosts.js) + [public/auth.js](public/auth.js) + [public/layout.js](public/layout.js) 字段 1:1 对应

/* ───── 主机（扩展自 stores/hosts.ts 的 Host） ────────── */

export interface HostLink {
  id?: string;
  name: string;
  url: string;
  description?: string;
}

export interface OsInfo {
  os?: string | null;
  distroId?: string | null;
  versionId?: string | null;
  prettyName?: string | null;
  arch?: string | null;
  kernel?: string | null;
  source?: string | null;
  detectedAt?: string | null;
}

export type HostAuthType = 'password' | 'privateKey';
export type HostType = 'local' | 'ssh';
export type HostRole = 'primary' | 'project' | 'probe' | 'proxy' | 'relay' | 'test' | 'archive';

export interface HostPreference {
  hostId: string;
  showInConsole: boolean;
  consoleOrder: number;
  repositoryOrder: number;
  pinned: boolean;
  role: HostRole | null;
  tags: string[];
  archived: boolean;
  updatedAt: string | null;
}

export interface MainHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  type?: HostType;
  authType?: HostAuthType;
  proxyHostId?: string | null;
  links?: HostLink[];
  status?: string;
  tags?: string[];
  osInfo?: OsInfo | null;
  preference?: HostPreference;
}

/** MainHost 的轻量投影，供只需要 id/name/host 的消费方使用。 */
export interface HostInfo {
  id: string;
  name: string;
  host?: string;
}

export interface HostFormPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: HostAuthType;
  proxyHostId: string | null;
  links: HostLink[];
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface LocalHostConfigPayload {
  name: string;
  links: HostLink[];
}

/* ───── 登录态 ────────────────────────────────────── */

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

/* ───── IP 访问控制 ───────────────────────────────── */

export interface IpFilterRule {
  id: string;
  type: 'allow' | 'deny';
  cidr: string;
  note?: string;
}

export interface IpFilterConfig {
  allowlistEnabled: boolean;
  denylistEnabled: boolean;
  rules: IpFilterRule[];
}

/* ───── 常量 ────────────────────────────────────── */

export const LOCAL_HOST_ID = 'local';
export const AUTH_TOKEN_KEY = 'auth_token'; // 向下兼容旧 useAuthStore key

/* ───── 帮手 ────────────────────────────────────── */

function cleanText(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  return text && text !== '--' ? text : null;
}

export function formatOsInfo(osInfo: OsInfo | null | undefined, fallbackPlatform: string | null | undefined = null): string {
  const prettyName = cleanText(osInfo?.prettyName);
  const distro = cleanText(osInfo?.distroId);
  const version = cleanText(osInfo?.versionId);
  const arch = cleanText(osInfo?.arch);
  const kernel = cleanText(osInfo?.kernel);
  const fallback = cleanText(fallbackPlatform);
  const base = prettyName || [distro, version].filter(Boolean).join(' ') || cleanText(osInfo?.os) || fallback || '未知';
  const extras = [arch, kernel].filter(Boolean);
  return extras.length ? `${base} · ${extras.join(' / ')}` : base;
}

export function formatHostMeta(host: MainHost | null | undefined): string {
  if (!host) return '';
  if (host.type === 'local' || host.id === LOCAL_HOST_ID) return '部署节点 / 本地 Shell';
  return `${host.username || 'root'}@${host.host}:${host.port || 22}`;
}

export function isLocalHost(host: MainHost | null | undefined): boolean {
  return host?.id === LOCAL_HOST_ID || host?.type === 'local';
}
