export type AgentGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface AgentGoalState {
  objective: string;
  status: AgentGoalStatus;
  updatedAt: string;
}

export type AgentGoalCommand =
  | { kind: 'goal'; action: 'show' | 'pause' | 'resume' | 'clear' | 'edit' }
  | { kind: 'goal'; action: 'set'; objective: string };

export interface AgentGoalCommandResult {
  state: AgentGoalState;
  title: string;
  text: string;
  tone?: 'info' | 'success' | 'warning';
  needsEditor?: boolean;
}

export const AGENT_GOAL_MAX_OBJECTIVE_CHARS = 4000;
export const AGENT_GOAL_USAGE = '用法：/goal [<目标>|clear|edit|pause|resume]';

const STATUS_LABELS: Record<AgentGoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  usageLimited: '用量受限',
  budgetLimited: '预算受限',
  complete: '已完成',
};

export function emptyAgentGoalState(): AgentGoalState {
  return { objective: '', status: 'active', updatedAt: '' };
}

export function normalizeAgentGoalState(value: Partial<AgentGoalState> | string | null | undefined): AgentGoalState {
  if (typeof value === 'string') {
    return {
      objective: normalizeGoalObjective(value),
      status: 'active',
      updatedAt: value.trim() ? new Date().toISOString() : '',
    };
  }
  const objective = normalizeGoalObjective(value?.objective || '');
  return {
    objective,
    status: normalizeGoalStatus(value?.status),
    updatedAt: String(value?.updatedAt || '').trim(),
  };
}

export function normalizeGoalObjective(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

export function normalizeGoalStatus(value: unknown): AgentGoalStatus {
  const text = String(value || '').trim();
  if (text === 'paused' || text === 'blocked' || text === 'usageLimited' || text === 'budgetLimited' || text === 'complete') return text;
  return 'active';
}

export function hasAgentGoal(state: Partial<AgentGoalState> | null | undefined): boolean {
  return Boolean(normalizeGoalObjective(state?.objective || ''));
}

export function agentGoalObjective(state: Partial<AgentGoalState> | null | undefined): string {
  return normalizeGoalObjective(state?.objective || '');
}

export function serializeAgentGoal(state: Partial<AgentGoalState> | null | undefined): AgentGoalState | undefined {
  const normalized = normalizeAgentGoalState(state);
  if (!normalized.objective) return undefined;
  return normalized;
}

export function formatAgentGoalLabel(state: Partial<AgentGoalState> | null | undefined): string {
  const normalized = normalizeAgentGoalState(state);
  if (!normalized.objective) return '未设置目标';
  if (normalized.status === 'active') return normalized.objective;
  return `${STATUS_LABELS[normalized.status]}：${normalized.objective}`;
}

export function formatAgentGoalDetail(state: Partial<AgentGoalState> | null | undefined): string {
  const normalized = normalizeAgentGoalState(state);
  if (!normalized.objective) return `当前还没有设置目标。${AGENT_GOAL_USAGE}`;
  return [
    `目标：${normalized.objective}`,
    `状态：${STATUS_LABELS[normalized.status]}`,
    `命令：/goal edit、/goal pause、/goal resume、/goal clear`,
  ].join('\n');
}

export function parseAgentGoalCommand(value: string): AgentGoalCommand | null {
  const match = String(value || '').trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const arg = String(match[1] || '').trim();
  if (!arg) return { kind: 'goal', action: 'show' };

  const command = arg.toLowerCase();
  if (command === 'pause') return { kind: 'goal', action: 'pause' };
  if (command === 'resume') return { kind: 'goal', action: 'resume' };
  if (command === 'clear') return { kind: 'goal', action: 'clear' };
  if (command === 'edit') return { kind: 'goal', action: 'edit' };
  return { kind: 'goal', action: 'set', objective: arg };
}

export function reduceAgentGoalCommand(current: Partial<AgentGoalState> | null | undefined, command: AgentGoalCommand): AgentGoalCommandResult {
  const state = normalizeAgentGoalState(current);
  const now = new Date().toISOString();

  if (command.action === 'show') {
    return {
      state,
      title: '/goal',
      text: formatAgentGoalDetail(state),
      tone: state.objective ? 'info' : 'warning',
    };
  }

  if (command.action === 'edit') {
    return {
      state,
      title: '/goal',
      text: state.objective ? '正在编辑当前目标。' : `当前还没有目标。${AGENT_GOAL_USAGE}`,
      tone: state.objective ? 'info' : 'warning',
      needsEditor: Boolean(state.objective),
    };
  }

  if (command.action === 'clear') {
    if (!state.objective) {
      return {
        state,
        title: '/goal',
        text: '当前没有可清除的目标。',
        tone: 'info',
      };
    }
    return {
      state: emptyAgentGoalState(),
      title: '/goal',
      text: '目标已清除。',
      tone: 'success',
    };
  }

  if (command.action === 'pause' || command.action === 'resume') {
    if (!state.objective) {
      return {
        state,
        title: '/goal',
        text: `当前还没有目标。${AGENT_GOAL_USAGE}`,
        tone: 'warning',
      };
    }
    const status: AgentGoalStatus = command.action === 'pause' ? 'paused' : 'active';
    return {
      state: { ...state, status, updatedAt: now },
      title: '/goal',
      text: command.action === 'pause' ? '目标已暂停。使用 /goal resume 可继续。' : '目标已恢复为进行中。',
      tone: 'success',
    };
  }

  if (command.action !== 'set') {
    return {
      state,
      title: '/goal',
      text: AGENT_GOAL_USAGE,
      tone: 'warning',
    };
  }

  const objective = normalizeGoalObjective(command.objective);
  if (!objective) {
    return {
      state,
      title: '/goal',
      text: `目标不能为空。${AGENT_GOAL_USAGE}`,
      tone: 'warning',
    };
  }
  if (objective.length > AGENT_GOAL_MAX_OBJECTIVE_CHARS) {
    return {
      state,
      title: '/goal',
      text: `目标太长了，最多 ${AGENT_GOAL_MAX_OBJECTIVE_CHARS} 个字符。`,
      tone: 'warning',
    };
  }

  const replacing = Boolean(state.objective && state.objective !== objective);
  return {
    state: { objective, status: 'active', updatedAt: now },
    title: '/goal',
    text: replacing ? `目标已替换为：${objective}` : `目标已设置为：${objective}`,
    tone: 'success',
  };
}
