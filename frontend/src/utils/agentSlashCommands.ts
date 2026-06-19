import type { IdeApprovalMode } from '@/composables/useIdeChat';

export type AgentSlashSurface = 'agent' | 'ide' | 'console' | 'fab';
export type AgentSlashCommandId =
  | '/model'
  | '/task'
  | '/goal'
  | '/host'
  | '/mode'
  | '/compact'
  | '/remind'
  | '/clear';

export interface AgentSlashCommand {
  cmd: AgentSlashCommandId;
  label: string;
  desc: string;
  icon: string;
  surfaces: AgentSlashSurface[];
}

export const AGENT_SLASH_COMMANDS: AgentSlashCommand[] = [
  { cmd: '/model', label: '选择模型', desc: '切换或记录本次 1Shell AI 的模型偏好', icon: 'spark', surfaces: ['agent', 'ide', 'console', 'fab'] },
  { cmd: '/task', label: '任务模式', desc: '只读探索目标并打包成可复用 AI 任务', icon: 'save', surfaces: ['agent', 'ide', 'console'] },
  { cmd: '/goal', label: '设置目标', desc: '设定本轮 1Shell AI 的长期工作目标', icon: 'target', surfaces: ['agent', 'ide', 'console'] },
  { cmd: '/host', label: '选择主机', desc: '限定 Agent 目标主机范围', icon: 'server', surfaces: ['agent'] },
  { cmd: '/mode', label: '审批模式', desc: '查看或切换人工审批、委托审批、完全权限', icon: 'shield', surfaces: ['agent', 'ide', 'console', 'fab'] },
  { cmd: '/compact', label: '压缩上下文', desc: '总结旧消息并保留最近上下文', icon: 'history', surfaces: ['agent', 'ide', 'console', 'fab'] },
  { cmd: '/remind', label: '回溯', desc: '列出或回到某次输入，并撤销之后的文件改动', icon: 'history', surfaces: ['agent', 'ide', 'console', 'fab'] },
  { cmd: '/clear', label: '清空时间线', desc: '重置当前 1Shell AI 对话', icon: 'close', surfaces: ['agent', 'ide', 'console', 'fab'] },
];

export function agentSlashCommandsForSurface(surface: AgentSlashSurface): AgentSlashCommand[] {
  return AGENT_SLASH_COMMANDS.filter((command) => command.surfaces.includes(surface));
}

export function filterAgentSlashCommands(value: string, commands: AgentSlashCommand[]): AgentSlashCommand[] {
  const text = String(value || '');
  if (!text.startsWith('/')) return [];
  const prefix = text.slice(1).trimStart().toLowerCase();
  if (!prefix) return commands;
  return commands.filter((command) => {
    const name = command.cmd.slice(1).toLowerCase();
    return name.includes(prefix) || command.label.toLowerCase().includes(prefix);
  });
}

export function parseAgentModelCommand(value: string): { arg: string } | null {
  const match = String(value || '').trim().match(/^\/model(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { arg: String(match[1] || '').trim() };
}

export function parseAgentTaskCommand(value: string): string | null {
  const match = String(value || '').trim().match(/^\/task(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return String(match[1] || '').trim();
}

export function parseAgentClearCommand(value: string): boolean {
  return /^\/clear(?:\s*)$/i.test(String(value || '').trim());
}

export function parseAgentModeCommand(value: string): { mode: IdeApprovalMode | null; raw: string } | null {
  const match = String(value || '').trim().match(/^\/mode(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const raw = String(match[1] || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!raw) return { mode: null, raw: '' };
  if (['manual', 'ask', 'approve', 'human', '人工', '人工审批'].includes(raw)) return { mode: 'manual', raw };
  if (['delegated', 'delegate', 'auto', 'agent', '委托', '委托审批'].includes(raw)) return { mode: 'delegated', raw };
  if (['full', 'full_access', 'danger', 'all', '完全', '完全权限', '完全访问'].includes(raw)) return { mode: 'full_access', raw };
  return { mode: null, raw };
}

export function approvalModeLabel(mode: IdeApprovalMode): string {
  if (mode === 'full_access') return '完全权限';
  if (mode === 'delegated') return '委托审批';
  return '人工审批';
}
