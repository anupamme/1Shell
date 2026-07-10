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
    attempted?: string[];
    error?: string;
  };
  nativeConfig?: {
    configured: boolean;
    configDir?: string;
    mode?: 'host';
    meta?: {
      providerId?: string;
      activeModelId?: string;
      enabledBy?: string;
      updatedAt?: string;
    } | null;
    files?: Array<{ name: string; path: string; exists: boolean }>;
  };
  proxy?: {
    providerCount: number;
    activeProvider?: ProviderInfo;
  };
  readiness?: CliReadiness;
}

export type CliStatus = 'configured' | 'detected' | 'missing';

export interface CliReadinessStep {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface CliReadiness {
  installed: boolean;
  providerReady: boolean;
  configReady: boolean;
  bridgeTokenReady: boolean;
  mcpReady: boolean;
  launchReady: boolean;
  steps: CliReadinessStep[];
  issues: string[];
  warnings: string[];
  nextAction?: { id: string; label: string };
}

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';

export interface ProviderModelInfo {
  id: string;
  apiModel: string;
  displayName?: string;
  enabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
  requestParams?: Record<string, unknown> | null;
}

export interface ClaudeRoleModelInfo {
  model?: string;
  displayName?: string;
}

export interface ProviderRouteInfo {
  providerId?: string | null;
  modelId?: string | null;
}

export interface ProviderInfo {
  id: string;
  name?: string;
  upstreamProtocol: UpstreamProtocol;
  apiBase?: string;
  apiKey?: string;
  apiKeySet: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
  requestParams?: Record<string, unknown> | null;
  activeModelId?: string | null;
  routeModelId?: string | null;
  activeRoute?: ProviderRouteInfo | null;
  scope?: 'global' | 'local';
  models?: ProviderModelInfo[];
  claudeModels?: {
    sonnet?: ClaudeRoleModelInfo;
    opus?: ClaudeRoleModelInfo;
    fable?: ClaudeRoleModelInfo;
    haiku?: ClaudeRoleModelInfo;
  };
  presetId?: string;
  enabled?: boolean;
  nativeSource?: string;
  nativeProviderId?: string;
}

export interface NativeProviderImportInfo {
  found: boolean;
  imported: boolean;
  changed?: boolean;
  created?: boolean;
  id?: string | null;
  /** 当前本机原生配置由 1Shell 启用的方案写入时,记录该方案 id(此时不会自动导入) */
  managedProviderId?: string;
  error?: string;
  reason?: string;
  files?: Array<{ name: string; path: string; exists: boolean }>;
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
  reasoningEffort?: ReasoningEffort;
  claudeModels?: {
    sonnet?: ClaudeRoleModelInfo;
    opus?: ClaudeRoleModelInfo;
    fable?: ClaudeRoleModelInfo;
    haiku?: ClaudeRoleModelInfo;
  };
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
  { value: 'auto',   label: 'auto',   hint: '不写入固定档位,交给模型/CLI 默认策略' },
  { value: 'low',    label: 'low',    hint: 'Claude Code: effortLevel low / Codex: low' },
  { value: 'medium', label: 'medium', hint: 'Claude Code: effortLevel medium / Codex: medium' },
  { value: 'high',   label: 'high',   hint: 'Claude Code: effortLevel high / Codex: high' },
  { value: 'max',    label: 'max',    hint: 'Claude Code: CLAUDE_CODE_EFFORT_LEVEL=max' },
  { value: 'xhigh',  label: 'xhigh',  hint: 'Codex: model_reasoning_effort=xhigh' },
];

export interface ScanCounts {
  total: number;
  configured: number;
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
  activeRoute?: ProviderRouteInfo | null;
  nativeImport?: NativeProviderImportInfo;
}

export interface LaunchCommandResponse {
  ok: boolean;
  cliId: string;
  shell: string;
  command: string;
  vars?: Record<string, string>;
}

export interface NativeConfigOpResponse {
  ok: boolean;
  cliId?: string;
  configDir?: string;
  mode?: 'host';
  error?: string;
}

export interface AgentConfigFileInfo {
  name: string;
  path: string;
  exists: boolean;
  editable: boolean;
  overridden: boolean;
  enabled?: boolean;
  mergeStrategy?: string;
  content: string;
  preview?: boolean;
}

export interface AgentConfigFilesResponse {
  ok: boolean;
  cliId: string;
  files: AgentConfigFileInfo[];
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
  configured: { text: '配置就绪', cls: 'status-connected', icon: '●' },
  detected:  { text: '已检测',   cls: 'status-detected',  icon: '●' },
  missing:   { text: '未安装',   cls: 'status-missing',   icon: '○' },
};

export const FILTER_OPTIONS: Array<{ value: 'all' | CliStatus; label: string }> = [
  { value: 'all',       label: '全部' },
  { value: 'configured', label: '配置就绪' },
  { value: 'detected',  label: '已检测' },
  { value: 'missing',   label: '未安装' },
];

export const SKILLS_SLOT_ID = 'skills';

export function detectShell(): 'powershell' | 'bash' {
  return navigator.platform.includes('Win') ? 'powershell' : 'bash';
}
