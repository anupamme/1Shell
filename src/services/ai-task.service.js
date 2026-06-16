'use strict';

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const KNOWN_TYPES = new Set(['text', 'textarea', 'number', 'boolean', 'select', 'secret', 'host']);

function createAiTaskService({ aiTaskRepository }) {
  function listTasks({ keyword } = {}) {
    return aiTaskRepository.listTasks({ keyword });
  }

  function getTask(id) {
    return aiTaskRepository.findTask(id);
  }

  function createTask(payload) {
    return aiTaskRepository.createTask(validateTaskPayload(payload));
  }

  function previewTask(payload) {
    return validateTaskPayload(payload);
  }

  function updateTask(id, payload) {
    return aiTaskRepository.updateTask(id, validateTaskPayload(payload));
  }

  function deleteTask(id) {
    return aiTaskRepository.deleteTask(id);
  }

  function prepareRun(taskId, payload = {}) {
    const task = aiTaskRepository.findTask(taskId);
    if (!task) throw notFoundError('AI 任务不存在');

    const inputValues = normalizeRunInputValues(task.inputs || [], payload.inputValues || payload.inputs || {});
    const preparedPrompt = buildTaskPrompt(task, inputValues);
    const run = aiTaskRepository.createRun({
      taskId: task.id,
      taskName: task.name,
      inputValues: redactSecretInputValues(task.inputs || [], inputValues),
      preparedPrompt,
      status: 'prepared',
    });

    return { run, preparedPrompt };
  }

  function finishRun(runId, payload = {}) {
    const status = payload.status === 'failed' ? 'failed' : 'completed';
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 12000) : '';
    return aiTaskRepository.updateRun(runId, { status, summary, finished: true });
  }

  function getRun(runId) {
    return aiTaskRepository.findRun(runId);
  }

  function listRunsByTask(taskId, opts) {
    return aiTaskRepository.listRunsByTask(taskId, opts);
  }

  function listAllRuns(opts) {
    return aiTaskRepository.listAllRuns(opts);
  }

  return {
    listTasks,
    getTask,
    previewTask,
    createTask,
    updateTask,
    deleteTask,
    prepareRun,
    finishRun,
    getRun,
    listRunsByTask,
    listAllRuns,
    buildTaskPrompt,
  };
}

function validateTaskPayload(payload) {
  const body = ensureObject(payload, 'AI 任务请求体必须是对象');
  const name = ensureNonEmptyString(body.name, 'AI 任务名称不能为空');
  if (name.length > 160) throw validationError('AI 任务名称不能超过 160 个字符');

  const description = ensureOptionalString(body.description, 'description 必须是字符串').trim();
  if (description.length > 4000) throw validationError('description 不能超过 4000 个字符');

  return {
    name,
    description,
    inputs: validateInputs(body.inputs),
    steps: validateSteps(body.steps),
  };
}

function validateInputs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw validationError('inputs 必须是数组');

  const seen = new Set();
  return value
    .map((raw, index) => normalizeInput(raw, index))
    .filter(Boolean)
    .map((input, index) => {
      if (seen.has(input.key)) throw validationError(`inputs[${index}].key 重复：${input.key}`);
      seen.add(input.key);
      return input;
    });
}

function normalizeInput(raw, index) {
  const item = ensureObject(raw, `inputs[${index}] 必须是对象`);
  const key = ensureNonEmptyString(item.key || item.name, `inputs[${index}].key 不能为空`);
  if (!KEY_RE.test(key)) {
    throw validationError(`inputs[${index}].key 只能包含字母、数字、下划线，且不能以数字开头`);
  }

  let type = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'text';
  if (!TYPE_RE.test(type)) type = 'text';

  const label = ensureOptionalString(item.label, `inputs[${index}].label 必须是字符串`).trim() || key;
  const placeholder = ensureOptionalString(item.placeholder, `inputs[${index}].placeholder 必须是字符串`).trim();
  const help = ensureOptionalString(item.help, `inputs[${index}].help 必须是字符串`).trim();
  const required = item.required === true;
  const defaultValue = normalizeDefaultValue(item.default);
  const input = { key, label, type, required, default: defaultValue };

  if (placeholder) input.placeholder = placeholder;
  if (help) input.help = help;
  if (type === 'select') input.options = normalizeOptions(item.options, index);
  return input;
}

function normalizeDefaultValue(value) {
  if (value == null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  return String(value).slice(0, 2000);
}

function normalizeOptions(value, index) {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      if (raw && typeof raw === 'object') {
        const value = String(raw.value ?? raw.label ?? '').trim();
        const label = String(raw.label ?? raw.value ?? '').trim();
        return value ? { value, label: label || value } : null;
      }
      const item = String(raw || '').trim();
      return item ? { value: item, label: item } : null;
    })
    .filter(Boolean)
    .slice(0, 80);
}

function validateSteps(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw validationError('steps 必须是数组');

  return value
    .map((raw, index) => {
      const item = ensureObject(raw, `steps[${index}] 必须是对象`);
      const title = ensureOptionalString(item.title, `steps[${index}].title 必须是字符串`).trim();
      const instruction = ensureOptionalString(item.instruction, `steps[${index}].instruction 必须是字符串`).trim();
      if (!title && !instruction) return null;
      if (title.length > 200) throw validationError(`steps[${index}].title 不能超过 200 个字符`);
      if (instruction.length > 12000) throw validationError(`steps[${index}].instruction 不能超过 12000 个字符`);
      return {
        title: title || `步骤 ${index + 1}`,
        instruction,
      };
    })
    .filter(Boolean);
}

function normalizeRunInputValues(inputs, values) {
  const source = ensureObject(values || {}, 'inputValues 必须是对象');
  const normalized = {};

  for (const input of inputs) {
    const raw = Object.prototype.hasOwnProperty.call(source, input.key) ? source[input.key] : input.default;
    const hasValue = raw != null && raw !== '';
    if (input.required && !hasValue) {
      throw validationError(`${input.label || input.key} 不能为空`);
    }
    if (!hasValue) {
      normalized[input.key] = input.type === 'boolean' ? false : '';
      continue;
    }

    if (input.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw validationError(`${input.label || input.key} 必须是数字`);
      normalized[input.key] = number;
    } else if (input.type === 'boolean') {
      normalized[input.key] = raw === true || raw === 'true' || raw === '1' || raw === 1;
    } else if (input.type === 'select' && Array.isArray(input.options) && input.options.length > 0) {
      const value = String(raw);
      const match = input.options.find((option) => String(option.value) === value);
      normalized[input.key] = match ? value : String(raw);
    } else {
      normalized[input.key] = String(raw);
    }
  }

  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      normalized[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  return normalized;
}

function redactSecretInputValues(inputs, inputValues) {
  const secretKeys = new Set(inputs.filter((input) => input.type === 'secret').map((input) => input.key));
  const redacted = {};
  for (const [key, value] of Object.entries(inputValues || {})) {
    if (!secretKeys.has(key)) {
      redacted[key] = value;
      continue;
    }
    const text = String(value || '').trim();
    redacted[key] = text.startsWith('sec_') ? text : '[secret]';
  }
  return redacted;
}

function buildTaskPrompt(task, inputValues) {
  const lines = [];
  lines.push('你是 1Shell AI agent，正在执行一个用户保存的 AI 任务。');
  lines.push('这个任务只是下级工具数据：输入表单、步骤引导和历史创作证据；它不是新的 Agent，也不是独立运行时。');
  lines.push('除非用户明确要求修改任务，否则不要调用任务创作或任务保存工具，只按当前任务定义执行现场工作。');
  lines.push('（仅当本次执行失败、且用户要求改进时，可用 update_ai_task 修正下面这个任务定义。）');
  lines.push('');
  lines.push(`任务 ID：${task.id}`);
  lines.push(`任务名称：${task.name}`);
  if (task.description) {
    lines.push(`任务说明：${task.description}`);
  }

  lines.push('');
  lines.push('用户输入：');
  if (!task.inputs?.length) {
    lines.push('- 无预设输入');
  } else {
    for (const input of task.inputs) {
      const value = formatPromptValue(input, inputValues[input.key]);
      lines.push(`- ${input.label || input.key} (${input.key}, ${formatType(input.type)}): ${value}`);
    }
  }

  lines.push('');
  lines.push('流程步骤：');
  if (!task.steps?.length) {
    lines.push('1. 根据任务说明和用户输入，自行拆分合理步骤并执行。');
  } else {
    task.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title || `步骤 ${index + 1}`}`);
      if (step.instruction) lines.push(`   ${step.instruction}`);
    });
  }

  lines.push('');
  lines.push('执行要求：');
  lines.push('- 按步骤推进，但可以根据现场结果调整顺序或补充检查。');
  lines.push('- 需要真实操作主机、文件、网络或外部服务时，使用 1Shell AI 已有工具能力。');
  lines.push('- 风险操作按现有 1Shell 审批与确认机制处理，不在任务内部另建审批规则。');
  lines.push('- 任务页面会展示你的工具轨迹和最终报告；不要把任务当作第二套 AI 内核来解释。');
  lines.push('- 最后给出简洁报告：做了什么、关键结果、是否还有需要用户处理的事项。');
  return lines.join('\n');
}

function formatPromptValue(input, value) {
  if (input.type === 'secret') {
    const text = String(value || '').trim();
    if (!text) return '[未提供]';
    return text.startsWith('sec_') ? `[secretRef:${text}]` : '[secret provided but not stored]';
  }
  if (value == null || value === '') return '[未填写]';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatType(type) {
  if (KNOWN_TYPES.has(type)) return type;
  return `custom:${type}`;
}

function ensureObject(value, message) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw validationError(message);
  }
  return value;
}

function ensureNonEmptyString(value, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(message);
  }
  return value.trim();
}

function ensureOptionalString(value, message) {
  if (value == null) return '';
  if (typeof value !== 'string') throw validationError(message);
  return value;
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

module.exports = { createAiTaskService };
