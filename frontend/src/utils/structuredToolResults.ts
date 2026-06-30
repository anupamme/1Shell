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

export function displayAssistantTextAfterToolResult(_items: readonly unknown[], _index: number, text: string): string {
  return text;
}
