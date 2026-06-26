export interface StructuredHost {
  id: string;
  name: string;
  host: string;
  port: number | null;
  address: string;
  type: string;
}

export interface HostListResult {
  ok: boolean | null;
  summary: string;
  hosts: StructuredHost[];
}

export interface StructuredProbe {
  hostId: string;
  name: string;
  hostname: string;
  online: boolean | null;
  stale: boolean;
  error: string;
  platform: string;
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
  load1: number | null;
  latencyMs: number | null;
  uptimeSec: number | null;
}

export interface ProbeListResult {
  ok: boolean | null;
  summary: string;
  generatedAt: string;
  sampleIntervalMs: number | null;
  probes: StructuredProbe[];
}

export interface ProxyAccessResult {
  host: string;
  httpPort: string;
  socks5Port: string;
  username: string;
  password: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cleanString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseJsonLike(value: unknown): unknown {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

function normalizePort(value: unknown, type: string): number | null {
  if (type === 'local') return null;
  if (value === undefined || value === null || value === '') return 22;
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? Math.trunc(port) : 22;
}

function normalizeHost(value: unknown): StructuredHost | null {
  const record = asRecord(value);
  if (!record) return null;

  const type = cleanString(record.type) || 'ssh';
  const id = cleanString(record.id);
  const name = cleanString(record.name) || id;
  const host = type === 'local'
    ? '127.0.0.1'
    : (cleanString(record.host) || cleanString(record.hostname) || cleanString(record.ip));
  const port = normalizePort(record.port, type);
  const address = cleanString(record.address) || (host ? (port ? `${host}:${port}` : host) : '');

  if (!id && !name && !host && !address) return null;
  return { id, name, host, port, address, type };
}

function cleanNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function platformText(record: Record<string, unknown>): string {
  const direct = cleanString(record.platform);
  if (direct) return direct;
  const info = asRecord(record.platformInfo);
  if (!info) return '';
  const pretty = cleanString(info.prettyName);
  if (pretty) return pretty;
  return [cleanString(info.distroId), cleanString(info.versionId)].filter(Boolean).join(' ')
    || cleanString(info.os);
}

function normalizeProbe(value: unknown): StructuredProbe | null {
  const record = asRecord(value);
  if (!record) return null;
  const hostId = cleanString(record.hostId) || cleanString(record.id);
  const name = cleanString(record.name) || hostId || cleanString(record.hostname);
  const hostname = cleanString(record.hostname);
  const error = cleanString(record.error);
  if (!hostId && !name && !hostname && !error) return null;
  return {
    hostId,
    name,
    hostname,
    online: cleanBoolean(record.online),
    stale: cleanBoolean(record.stale) === true,
    error,
    platform: platformText(record),
    cpuUsage: cleanNumber(record.cpuUsage),
    memoryUsage: cleanNumber(record.memoryUsage),
    diskUsage: cleanNumber(record.diskUsage),
    load1: cleanNumber(record.load1),
    latencyMs: cleanNumber(record.latencyMs),
    uptimeSec: cleanNumber(record.uptimeSec),
  };
}

export function parseHostListResult(value: unknown): HostListResult | null {
  const parsed = parseJsonLike(value);
  const root = asRecord(parsed);
  if (!root) return null;

  const data = asRecord(root.data);
  const hostsValue = Array.isArray(data?.hosts)
    ? data.hosts
    : (Array.isArray(root.hosts) ? root.hosts : null);
  if (!hostsValue) return null;

  const hosts = hostsValue.map(normalizeHost).filter((host): host is StructuredHost => Boolean(host));
  if (!hosts.length) return null;

  return {
    ok: typeof root.ok === 'boolean' ? root.ok : null,
    summary: cleanString(root.summary),
    hosts,
  };
}

export function parseProbeListResult(value: unknown): ProbeListResult | null {
  const parsed = parseJsonLike(value);
  const root = asRecord(parsed);
  if (!root) return null;

  const data = asRecord(root.data);
  const source = data && Array.isArray(data.probes) ? data : root;
  const probesValue = Array.isArray(source.probes) ? source.probes : null;
  if (!probesValue) return null;

  const probes = probesValue.map(normalizeProbe).filter((probe): probe is StructuredProbe => Boolean(probe));
  if (!probes.length) return null;

  return {
    ok: typeof root.ok === 'boolean' ? root.ok : null,
    summary: cleanString(root.summary),
    generatedAt: cleanString(source.generatedAt),
    sampleIntervalMs: cleanNumber(source.sampleIntervalMs),
    probes,
  };
}

export function hostAddressText(host: StructuredHost): string {
  return host.address || (host.port ? `${host.host}:${host.port}` : host.host);
}

const HOST_LIST_ASSISTANT_REFERENCE = '主机列表已在上方工具结果中按原始字段显示。需要查看状态或执行操作时，可以直接指定名称或 ID。';

function hasKind(value: unknown, kind: string): boolean {
  const record = asRecord(value);
  return cleanString(record?.kind) === kind;
}

function hostListResultFromTimelineItem(value: unknown): HostListResult | null {
  const record = asRecord(value);
  if (!record || cleanString(record.kind) !== 'tool' || cleanString(record.name) !== 'list_hosts') return null;
  return parseHostListResult(record.result);
}

function probeListResultFromTimelineItem(value: unknown): ProbeListResult | null {
  const record = asRecord(value);
  const name = cleanString(record?.name);
  if (!record || cleanString(record.kind) !== 'tool' || !['list_probes', 'query_probe'].includes(name)) return null;
  return parseProbeListResult(record.result);
}

function toolResultText(value: unknown): string {
  const record = asRecord(value);
  if (!record || cleanString(record.kind) !== 'tool') return '';
  const result = record.result;
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function cleanProxySecret(value: string): string {
  return value
    .trim()
    .replace(/^[`'"“”‘’]+|[`'"“”‘’，,。.;；]+$/g, '');
}

function decodeUrlComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePortText(value: unknown): string {
  const text = cleanString(value).replace(/[^\d]/g, '');
  const number = Number(text);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? String(number) : '';
}

function parseProxyUrl(urlText: string): Partial<ProxyAccessResult> | null {
  try {
    const url = new URL(urlText);
    const protocol = url.protocol.replace(/:$/, '').toLowerCase();
    if (!['http', 'https', 'socks5'].includes(protocol)) return null;
    const result: Partial<ProxyAccessResult> = {
      host: url.hostname,
      username: decodeUrlComponentSafe(url.username || ''),
      password: decodeUrlComponentSafe(url.password || ''),
    };
    const port = normalizePortText(url.port);
    if (protocol === 'socks5') result.socks5Port = port;
    else result.httpPort = port;
    return result.host && port ? result : null;
  } catch {
    return null;
  }
}

export function parseProxyAccessResult(value: unknown): ProxyAccessResult | null {
  const text = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value); } catch { return String(value || ''); }
  })();
  if (!/(GOST|SOCKS5?|HTTP|proxy|代理|curl\s+-x|端口|密码|用户)/i.test(text)) return null;

  const found: Partial<ProxyAccessResult> = {};
  const urlMatches = text.match(/\b(?:https?|socks5):\/\/[^\s`'"<>]+/gi) || [];
  for (const rawUrl of urlMatches) {
    const parsed = parseProxyUrl(rawUrl.replace(/[)\]，,。.;；]+$/g, ''));
    if (!parsed) continue;
    if (!found.host && parsed.host) found.host = parsed.host;
    if (!found.username && parsed.username) found.username = parsed.username;
    if (!found.password && parsed.password) found.password = parsed.password;
    if (!found.httpPort && parsed.httpPort) found.httpPort = parsed.httpPort;
    if (!found.socks5Port && parsed.socks5Port) found.socks5Port = parsed.socks5Port;
  }

  const endpointHost = String.raw`((?:\d{1,3}\.){3}\d{1,3}|localhost|[A-Za-z0-9.-]+\.[A-Za-z]{2,})`;
  const httpMatch = text.match(new RegExp(String.raw`\bHTTP\b[^\r\n]{0,100}?${endpointHost}\s*[:：]\s*(\d{2,5})`, 'i'));
  if (httpMatch) {
    if (!found.host) found.host = httpMatch[1];
    if (!found.httpPort) found.httpPort = normalizePortText(httpMatch[2]);
  }

  const socksMatch = text.match(new RegExp(String.raw`\bSOCKS5?\b[^\r\n]{0,100}?${endpointHost}\s*[:：]\s*(\d{2,5})`, 'i'));
  if (socksMatch) {
    if (!found.host) found.host = socksMatch[1];
    if (!found.socks5Port) found.socks5Port = normalizePortText(socksMatch[2]);
  }

  const userMatch = text.match(/(?:用户名|用户)\s*(?:[:：=]|为|是)?\s*[`'"“”‘’]?([A-Za-z0-9._@-]{1,80})|\b(?:username|user)\b\s*(?:(?:[:：=]|is)\s*|\s+)[`'"“”‘’]?([A-Za-z0-9._@-]{1,80})/i);
  if (!found.username && userMatch) found.username = cleanProxySecret(userMatch[1] || userMatch[2] || '');

  const passMatch = text.match(/密码\s*(?:[:：=]|为|是)?\s*[`'"“”‘’]?([^\s`'"|，,。；;]{1,160})|\b(?:password|passwd|pass)\b\s*(?:(?:[:：=]|is)\s*|\s+)[`'"“”‘’]?([^\s`'"|，,。；;]{1,160})/i);
  if (!found.password && passMatch) found.password = cleanProxySecret(passMatch[1] || passMatch[2] || '');

  if (!found.host || (!found.httpPort && !found.socks5Port)) return null;
  return {
    host: found.host || '',
    httpPort: found.httpPort || '',
    socks5Port: found.socks5Port || '',
    username: found.username || '',
    password: found.password || '',
  };
}

function previousProxyResult(items: readonly unknown[], index: number): ProxyAccessResult | null {
  let inspectedTools = 0;
  for (let i = index - 1; i >= 0 && inspectedTools < 12; i -= 1) {
    const item = items[i];
    if (!hasKind(item, 'tool')) continue;
    inspectedTools += 1;
    const parsed = parseProxyAccessResult(toolResultText(item));
    if (parsed) return parsed;
  }
  return null;
}

function mergeProxyResult(toolProxy: ProxyAccessResult | null, textProxy: ProxyAccessResult | null): ProxyAccessResult | null {
  if (!toolProxy && !textProxy) return null;
  const merged = {
    host: toolProxy?.host || textProxy?.host || '',
    httpPort: toolProxy?.httpPort || textProxy?.httpPort || '',
    socks5Port: toolProxy?.socks5Port || textProxy?.socks5Port || '',
    username: textProxy?.username || toolProxy?.username || '',
    password: textProxy?.password || toolProxy?.password || '',
  };
  return merged.host && (merged.httpPort || merged.socks5Port) ? merged : null;
}

function isGeneratedProxySummary(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith('搭建完成 - GOST 代理服务')
    && normalized.includes('```text')
    && normalized.includes('使用方式');
}

function previousToolResult(items: readonly unknown[], index: number): { kind: 'hosts'; result: HostListResult } | { kind: 'probes'; result: ProbeListResult } | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (hasKind(item, 'thinking') || hasKind(item, 'system')) continue;
    if (hasKind(item, 'tool')) {
      const probes = probeListResultFromTimelineItem(item);
      if (probes) return { kind: 'probes', result: probes };
      const hosts = hostListResultFromTimelineItem(item);
      if (hosts) return { kind: 'hosts', result: hosts };
      return null;
    }
    if (hasKind(item, 'assistant')) {
      const record = asRecord(item);
      if (!cleanString(record?.text)) continue;
    }
    return null;
  }
  return null;
}

function looksLikeProxyRestatement(text: string, proxy: ProxyAccessResult): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (!/(GOST|SOCKS5?|\bHTTP\b|curl\s+-x|代理|浏览器|端口|密码|用户|\busername\b|\buser\b|\bpassword\b|\bpasswd\b|\bpass\b)/i.test(normalized)) return false;
  return [proxy.host, proxy.httpPort, proxy.socks5Port, proxy.username]
    .filter(Boolean)
    .some((part) => normalized.includes(part))
    || /\b(?:https?|socks5):\/\//i.test(normalized);
}

function proxyAuthPrefix(proxy: ProxyAccessResult): string {
  if (!proxy.username || !proxy.password) return '';
  return `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
}

function proxyAccessSummary(proxy: ProxyAccessResult): string {
  const details = [
    proxy.httpPort ? `HTTP   ${proxy.host}:${proxy.httpPort}` : '',
    proxy.socks5Port ? `SOCKS5 ${proxy.host}:${proxy.socks5Port}` : '',
    proxy.username ? `用户   ${proxy.username}` : '',
    proxy.password ? `密码   ${proxy.password}` : '',
  ].filter(Boolean).join('\n');
  const auth = proxyAuthPrefix(proxy);
  const examples = [
    proxy.httpPort ? `curl -x http://${auth}${proxy.host}:${proxy.httpPort} https://example.com` : '',
    proxy.socks5Port ? `curl -x socks5://${auth}${proxy.host}:${proxy.socks5Port} https://example.com` : '',
  ].filter(Boolean).join('\n');
  return [
    '搭建完成 - GOST 代理服务',
    '',
    '```text',
    details,
    '```',
    examples ? '' : '',
    examples ? '使用方式' : '',
    examples ? '' : '',
    examples ? '```bash' : '',
    examples,
    examples ? '```' : '',
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n');
}

function looksLikeHostListRestatement(text: string, hostList: HostListResult): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  if (/(^|\n)\s*\|?\s*(ID|id)\s*(\||\s{2,}|名称|name)/.test(text)) return true;
  if (/(^|\n)\s*[-*]\s+.*(vip|VPS|SSH|本机|local|host_)/i.test(text)) return true;
  if (/(当前|目前|现在|一共有|共有).{0,24}(主机|机器|VPS|远程).{0,24}\d+\s*台/.test(normalized)) return true;
  if (/(除了|除).{0,24}本机/.test(normalized) && /(远程|VPS|SSH|节点)/i.test(normalized)) return true;

  const ipMentions = normalized.match(/\b\d{1,3}(?:\.\d{1,3}){2,3}(?::\d{1,5})?\b/g)?.length || 0;
  const hostIdMentions = normalized.match(/\bhost_[0-9a-f-]{6,}\b/gi)?.length || 0;
  const nameMentions = hostList.hosts.filter((host) => {
    const name = host.name.trim();
    return name && name.length >= 2 && normalized.includes(name);
  }).length;
  const hostListWords = /(主机|机器|地址|端口|远程|节点|VPS|SSH|host|address|port)/i.test(normalized);

  return (ipMentions + hostIdMentions >= 2)
    || (hostListWords && ipMentions >= 1)
    || (hostListWords && nameMentions >= 2);
}

function probeStatusSummary(probeList: ProbeListResult): string {
  const total = probeList.probes.length;
  const online = probeList.probes.filter((probe) => probe.online === true && !probe.error).length;
  const errors = probeList.probes.filter((probe) => probe.error || probe.online === false).length;
  if (errors > 0) return `探针数据已在上方工具结果中按原始字段显示。当前 ${online}/${total} 台在线，${errors} 台存在离线或错误。`;
  if (online === total) return `探针数据已在上方工具结果中按原始字段显示。当前 ${total} 台全部在线。`;
  return `探针数据已在上方工具结果中按原始字段显示。当前 ${online}/${total} 台在线。`;
}

function looksLikeProbeListRestatement(text: string, probeList: ProbeListResult): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  if (/(^|\n)\s*\|/.test(text) && /(主机|状态|系统|CPU|内存|磁盘|运行中服务|探针)/i.test(text)) return true;
  if (/(环境概况|探针|监控|状态).{0,16}(如下|表|列表)/i.test(normalized)) return true;

  const metricWords = /(CPU|内存|磁盘|load|负载|在线|离线|Ubuntu|Debian|CentOS|Linux|Windows)/i.test(normalized);
  const nameMentions = probeList.probes.filter((probe) => {
    const name = probe.name.trim();
    return name && name.length >= 2 && normalized.includes(name);
  }).length;
  const metricMentions = normalized.match(/\b\d+(?:\.\d+)?%/g)?.length || 0;

  return metricWords && (nameMentions >= 2 || metricMentions >= 3);
}

export function displayAssistantTextAfterToolResult(items: readonly unknown[], index: number, text: string): string {
  const raw = cleanString(text);
  if (!raw) return text;

  const toolProxy = previousProxyResult(items, index);
  const textProxy = isGeneratedProxySummary(raw) ? null : parseProxyAccessResult(raw);
  const proxy = mergeProxyResult(toolProxy, textProxy);
  if (proxy && looksLikeProxyRestatement(text, proxy)) {
    return proxyAccessSummary(proxy);
  }

  const previous = previousToolResult(items, index);
  if (!previous) return text;

  if (previous.kind === 'hosts' && looksLikeHostListRestatement(text, previous.result)) {
    return HOST_LIST_ASSISTANT_REFERENCE;
  }
  if (previous.kind === 'probes' && looksLikeProbeListRestatement(text, previous.result)) {
    return probeStatusSummary(previous.result);
  }
  return text;
}
