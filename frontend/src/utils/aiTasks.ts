export type AiTaskInputType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'secret' | 'host' | string;
export type AiTaskRunStatus = 'prepared' | 'running' | 'completed' | 'failed';

export interface AiTaskOption {
  value: string;
  label?: string;
}

export interface AiTaskInput {
  key: string;
  label: string;
  type: AiTaskInputType;
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  options?: AiTaskOption[];
}

export interface AiTaskStep {
  title: string;
  instruction: string;
}

export interface AiTaskInfo {
  id: string;
  name: string;
  description: string;
  inputs: AiTaskInput[];
  steps: AiTaskStep[];
  runCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AiTaskRun {
  id: number;
  taskId: string;
  taskName?: string;
  inputValues: Record<string, unknown>;
  preparedPrompt?: string;
  status: AiTaskRunStatus;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string;
}

export interface AiTasksListResponse {
  ok: boolean;
  tasks: AiTaskInfo[];
}

export interface AiTaskSaveResponse {
  ok: boolean;
  task: AiTaskInfo;
}

export interface AiTaskRunPrepareResponse {
  ok: boolean;
  run: AiTaskRun;
  preparedPrompt: string;
}

export interface AiTaskRunsResponse {
  ok: boolean;
  runs: AiTaskRun[];
  total: number;
}

export const INPUT_TYPE_OPTIONS: Array<{ value: AiTaskInputType; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '开关' },
  { value: 'select', label: '选项' },
  { value: 'secret', label: '凭据' },
  { value: 'host', label: '主机' },
];

export function makeDraftAiTask(): AiTaskInfo {
  return {
    id: '',
    name: '未命名任务',
    description: '',
    inputs: [
      { key: 'host', label: '目标主机', type: 'host', required: true },
    ],
    steps: [
      { title: '确认目标', instruction: '根据用户输入确认目标主机、服务或资源范围。' },
      { title: '执行检查', instruction: '使用 1Shell AI 的工具能力检查现场状态。' },
      { title: '处理并汇报', instruction: '按检查结果处理问题，并输出最终报告。' },
    ],
  };
}

export function cloneAiTask<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function inputOptionsToText(input: AiTaskInput): string {
  return (input.options || [])
    .map((option) => option.label && option.label !== option.value ? `${option.label}:${option.value}` : option.value)
    .join(', ');
}

export function textToInputOptions(text: string): AiTaskOption[] {
  return String(text || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const idx = item.indexOf(':');
      if (idx === -1) return { value: item, label: item };
      const label = item.slice(0, idx).trim();
      const value = item.slice(idx + 1).trim();
      return { value: value || label, label: label || value };
    });
}
