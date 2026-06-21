export type UpstreamProtocol = 'openai' | 'anthropic';

export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  repo: string;
  icon: string;
  gradient?: string;
  status: CliStatus;
  supportedUpstream?: UpstreamProtocol[];
  supportedOS?: string[];
  install?: { command?: string; globalCommand?: string; executable?: string; args?: string[]; docsUrl?: string; hint?: string };
  binary?: {
    name?: string;
    candidates?: string[];
    path?: string;
    installed: boolean;
    version?: string;
    override?: boolean;
    managed?: boolean;
    attempted?: string[];
    error?: string;
  };
  sandbox?: {
    sandboxed: boolean;
    sandboxDir?: string;
    files?: Array<{ name: string; path: string; exists: boolean }>;
  };
  proxy?: {
    providerCount: number;
    activeProvider?: ProviderInfo;
  };
  readiness?: CliReadiness;
}

export type CliStatus = 'sandboxed' | 'detected' | 'missing';

export interface CliReadinessStep {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface CliReadiness {
  installed: boolean;
  providerReady: boolean;
  sandboxReady: boolean;
  bridgeTokenReady: boolean;
  mcpReady: boolean;
  launchReady: boolean;
  steps: CliReadinessStep[];
  issues: string[];
  warnings: string[];
  nextAction?: { id: string; label: string };
}

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high';

export interface ProviderInfo {
  id: string;
  name?: string;
  upstreamProtocol: UpstreamProtocol;
  apiBase?: string;
  apiKey?: string;
  apiKeySet: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  presetId?: string;
  enabled?: boolean;
}

export type PresetCategory = 'domestic' | 'overseas' | 'relay';

export interface ProviderPreset {
  id: string;
  name: string;
  apiBase: string;
  protocol: UpstreamProtocol;
  apiKeyField: string;
  models: string[];
  reasoningModels: string[];
  docsUrl?: string;
  category: PresetCategory;
  isTemplate?: boolean;
}

export const PRESET_CATEGORY_LABELS: Record<PresetCategory, string> = {
  domestic: '国内',
  overseas: '海外',
  relay: '中转模板',
};

export const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string; hint: string }> = [
  { value: 'auto',   label: '自动',  hint: '模型自决,不强制' },
  { value: 'low',    label: '低',    hint: 'Anthropic: 4k budget / OpenAI: low' },
  { value: 'medium', label: '中',    hint: 'Anthropic: 16k budget / OpenAI: medium' },
  { value: 'high',   label: '高',    hint: 'Anthropic: 64k budget / OpenAI: high' },
];

export interface ScanCounts {
  total: number;
  sandboxed: number;
  detected: number;
  missing: number;
}

export interface ScanResponse {
  ok: boolean;
  tools: ToolInfo[];
  counts: ScanCounts;
}

export interface EndpointsResponse {
  ok: boolean;
  endpoints: {
    bridge: { url: string; protocol: string };
    mcp: { url: string; protocol: string };
  };
  token: { masked: string; ready: boolean };
}

export interface DiagnosticsCheck {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
  error?: string;
}

export interface DiagnosticsResponse {
  ok: boolean;
  checks: DiagnosticsCheck[];
}

export interface CliDiagnosticsResponse {
  ok: boolean;
  cliId: string;
  tool: ToolInfo;
  checks: DiagnosticsCheck[];
}

export interface ProvidersResponse {
  ok: boolean;
  providers: ProviderInfo[];
  activeProviderId?: string;
}

export interface LaunchCommandResponse {
  ok: boolean;
  cliId: string;
  shell: string;
  command: string;
  vars?: Record<string, string>;
}

export interface SandboxOpResponse {
  ok: boolean;
  cliId?: string;
  sandboxDir?: string;
  error?: string;
}

export interface BinaryOverrideResponse {
  ok: boolean;
  cliId?: string;
  tool?: ToolInfo;
  error?: string;
}

export interface InstallCliResponse {
  ok: boolean;
  cliId: string;
  command?: string;
  installRoot?: string;
  stdout?: string;
  stderr?: string;
  installed?: boolean;
  binary?: ToolInfo['binary'];
  tool?: ToolInfo;
  error?: string;
  result?: {
    command?: string;
    installRoot?: string;
    stdout?: string;
    stderr?: string;
    installed?: boolean;
    binary?: ToolInfo['binary'];
    tool?: ToolInfo;
  } | null;
}

export const UPSTREAM_LABELS: Record<UpstreamProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
};

export interface StatusLabel {
  text: string;
  cls: string;
  icon: string;
}

export const STATUS_LABELS: Record<CliStatus, StatusLabel> = {
  sandboxed: { text: '沙箱就绪', cls: 'status-connected', icon: '●' },
  detected:  { text: '已检测',   cls: 'status-detected',  icon: '●' },
  missing:   { text: '未安装',   cls: 'status-missing',   icon: '○' },
};

export const FILTER_OPTIONS: Array<{ value: 'all' | CliStatus; label: string }> = [
  { value: 'all',       label: '全部' },
  { value: 'sandboxed', label: '沙箱就绪' },
  { value: 'detected',  label: '已检测' },
  { value: 'missing',   label: '未安装' },
];

export const SKILLS_SLOT_ID = 'skills';

export function detectShell(): 'powershell' | 'bash' {
  return navigator.platform.includes('Win') ? 'powershell' : 'bash';
}
