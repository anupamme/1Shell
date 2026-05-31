'use strict';

/**
 * Program Schema — data/programs/<id>/program.yaml
 *
 * Program 保留 cron/manual 调度、输入、exec/render/ai action 与 UI artifact 契约。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cron = require('node-cron');

const DEFAULT_STEP_TIMEOUT_MS = 30000;

function loadProgram(programDir) {
  const programPath = path.join(programDir, 'program.yaml');
  if (!fs.existsSync(programPath)) return null;

  let raw;
  try { raw = fs.readFileSync(programPath, 'utf8'); } catch { return null; }

  let doc;
  try { doc = yaml.load(raw); }
  catch (err) { throw new Error(`program.yaml 解析失败: ${err.message}`); }

  resolvePromptFiles(doc, programDir);

  const id = path.basename(programDir);
  return normalizeProgram(doc, id, programPath);
}

function resolvePromptFiles(doc, programDir) {
  if (!doc || typeof doc !== 'object' || !doc.actions || typeof doc.actions !== 'object') return;
  for (const action of Object.values(doc.actions)) {
    if (!action || !Array.isArray(action.steps)) continue;
    for (const step of action.steps) {
      if (!step || typeof step !== 'object') continue;
      const promptFile = typeof step.prompt_file === 'string' ? step.prompt_file.trim() : '';
      if (!promptFile) continue;
      const promptPath = path.resolve(programDir, promptFile);
      let text;
      try { text = fs.readFileSync(promptPath, 'utf8'); }
      catch (err) { throw new Error(`step "${step.id || '?'}" prompt_file 读取失败: ${err.message}`); }
      if (!step.prompt && !step.goal && !step.task) step.prompt = text;
    }
  }
}

function normalizeProgram(doc, id, sourcePath = 'program.yaml') {
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${sourcePath}: 根节点必须是对象`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`${sourcePath}: program id "${id}" 不合法（必须 kebab-case）`);
  }

  const name = String(doc.name || id).trim();
  const description = doc.description ? String(doc.description) : '';
  const enabled = doc.enabled !== false;
  const hosts = normalizeHosts(doc.hosts, sourcePath);
  const inputs = normalizeInputs(doc.inputs || [], `${sourcePath} inputs`);

  const rawActions = doc.actions || {};
  if (!rawActions || typeof rawActions !== 'object' || Array.isArray(rawActions)) {
    throw new Error(`${sourcePath}: actions 必须是对象`);
  }
  const actionNames = Object.keys(rawActions);
  if (actionNames.length === 0) throw new Error(`${sourcePath}: 至少需要定义一个 action`);

  const actions = {};
  for (const [actName, raw] of Object.entries(rawActions)) {
    actions[actName] = normalizeAction(raw, actName, sourcePath, inputs);
  }

  const rawTriggers = Array.isArray(doc.triggers) ? doc.triggers : [];
  if (rawTriggers.length === 0) throw new Error(`${sourcePath}: triggers 数组不能为空`);
  const seenTriggerIds = new Set();
  const triggers = rawTriggers.map((t, idx) => normalizeTrigger(t, idx, seenTriggerIds, actions, sourcePath));

  const ui = doc.ui && typeof doc.ui === 'object'
    ? normalizeUi(doc.ui, actions, sourcePath)
    : null;

  const program = {
    id,
    name,
    description,
    enabled,
    hosts,
    inputs,
    triggers,
    actions,
    ui,
  };
  return program;
}

function normalizeHosts(rawHosts, sourcePath) {
  if (rawHosts === 'all') return 'all';
  if (Array.isArray(rawHosts)) {
    const hosts = rawHosts.map(String).map((s) => s.trim()).filter(Boolean);
    if (hosts.length === 0) throw new Error(`${sourcePath}: hosts 数组不能为空（或用 'all'）`);
    return hosts;
  }
  if (typeof rawHosts === 'string' && rawHosts.trim()) return [rawHosts.trim()];
  throw new Error(`${sourcePath}: hosts 必须是字符串、数组或 'all'`);
}

function normalizeAction(raw, actName, sourcePath, rootInputs = []) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourcePath}: action "${actName}" 必须是对象`);
  }
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (rawSteps.length === 0) throw new Error(`${sourcePath}: action "${actName}" 必须至少有一个 step`);

  const seenIds = new Set();
  const steps = rawSteps.map((s, idx) => normalizeProgramStep(s, idx, seenIds, `${sourcePath} action="${actName}"`));

  const onFail = String(raw.on_fail || raw.on_failure || 'stop').trim();
  if (!['stop', 'ignore'].includes(onFail)) {
    throw new Error(`${sourcePath}: action "${actName}" on_fail 必须是 stop|ignore`);
  }
  const label = raw.label ? String(raw.label).trim() : '';
  const inputs = normalizeInputs(raw.inputs || [], `${sourcePath} action="${actName}" inputs`);
  validateInputReferences(steps, [...rootInputs, ...inputs], `${sourcePath} action="${actName}"`);
  return { name: raw.name ? String(raw.name) : actName, label, inputs, steps, on_fail: onFail };
}

function validateInputReferences(steps, inputs, sourcePath) {
  const known = new Set(inputs.map((input) => input.name));
  for (const step of steps) {
    if (step.type !== 'exec') continue;
    const run = String(step.run || '');
    for (const match of run.matchAll(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
      if (!known.has(match[1])) throw new Error(`${sourcePath}: step "${step.id}" 引用了未声明 input: ${match[1]}`);
    }
  }
}

function normalizeInputs(raw, sourcePath) {
  const items = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object'
      ? Object.entries(raw).map(([name, value]) => ({ ...(value && typeof value === 'object' ? value : {}), name }))
      : []);
  return items.map((item, idx) => normalizeInput(item, idx, sourcePath));
}

function normalizeInput(raw, idx, sourcePath) {
  if (!raw || typeof raw !== 'object') throw new Error(`${sourcePath}[${idx}] 必须是对象`);
  const name = String(raw.name || raw.id || '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`${sourcePath}[${idx}] name "${name}" 不合法（必须 snake_case）`);
  let type = String(raw.type || (raw.secret ? 'password' : 'string')).trim();
  if (type === 'textarea') type = 'text';
  if (!['string', 'number', 'boolean', 'select', 'password', 'text'].includes(type)) throw new Error(`${sourcePath}[${idx}] type "${type}" 未知`);
  const options = Array.isArray(raw.options)
    ? raw.options.map((option) => {
      if (option && typeof option === 'object') {
        const value = String(option.value ?? option.id ?? option.label ?? '').trim();
        return { value, label: String(option.label ?? value).trim(), description: option.description ? String(option.description) : '' };
      }
      const value = String(option ?? '').trim();
      return { value, label: value, description: '' };
    }).filter((option) => option.value)
    : [];
  if (type === 'select' && options.length === 0) throw new Error(`${sourcePath}[${idx}] select 类型必须提供 options`);
  return {
    name,
    label: String(raw.label || name).trim(),
    type,
    required: raw.required === true,
    secret: raw.secret === true || type === 'password',
    placeholder: raw.placeholder ? String(raw.placeholder) : '',
    description: raw.description ? String(raw.description) : '',
    default: raw.default ?? raw.defaultValue ?? null,
    min: raw.min ?? null,
    max: raw.max ?? null,
    options,
  };
}

function normalizeProgramStep(step, idx, seenIds, sourcePath) {
  return normalizeStep(step, idx, seenIds, sourcePath);
}

function normalizeStep(step, idx, seenIds, sourcePath) {
  if (!step || typeof step !== 'object') {
    throw new Error(`${sourcePath}: steps[${idx}] 必须是对象`);
  }

  const id = String(step.id || `step_${idx + 1}`).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(`${sourcePath}: steps[${idx}].id "${id}" 不合法，必须以字母或下划线开头、仅含字母数字下划线`);
  }
  if (seenIds.has(id)) throw new Error(`${sourcePath}: steps[${idx}].id "${id}" 重复`);
  seenIds.add(id);

  const type = step.type ? String(step.type).trim() : 'exec';
  if (type === 'exec') return normalizeExecStep(step, id, idx, sourcePath);
  if (type === 'render') return normalizeRenderStep(step, id, idx, sourcePath);
  if (type === 'ai') return normalizeAiStep(step, id, idx, sourcePath);
  if (type === 'skill') throw new Error(`${sourcePath}: step "${id}" 不再支持 skill 类型`);
  throw new Error(`${sourcePath}: steps[${idx}] 未知 type "${type}"（支持 exec | render | ai）`);
}

function normalizeAiStep(step, id, idx, sourcePath) {
  const goal = String(step.goal || step.task || step.prompt || step.label || '').trim();
  if (!goal) throw new Error(`${sourcePath}: steps[${idx}](${id}) 类型为 ai，必须有 goal 字段`);

  const out = {
    id,
    type: 'ai',
    label: String(step.label || step.name || id),
    goal,
    result: step.result ? String(step.result) : '',
    optional: step.optional === true || step.optional === 'true',
  };

  // capabilities：harness 最小授权声明（如 [read_only]）。
  // 未声明则不带该字段，引擎/harness 回退默认能力（向后兼容）。
  if (step.capabilities !== undefined) {
    if (!Array.isArray(step.capabilities)) {
      throw new Error(`${sourcePath}: steps[${idx}](${id}) capabilities 必须是数组`);
    }
    out.capabilities = step.capabilities.map((c) => String(c).trim()).filter(Boolean);
  }

  return out;
}

function normalizeExecStep(step, id, idx, sourcePath) {
  const run = String(step.run || '').trim();
  if (!run) throw new Error(`${sourcePath}: steps[${idx}](${id}) 类型为 exec，必须有 run 字段`);

  return {
    id,
    type: 'exec',
    label: String(step.label || id),
    run,
    timeout: clampInt(step.timeout, 1000, 600000, DEFAULT_STEP_TIMEOUT_MS),
    verify: normalizeVerify(step.verify),
    optional: step.optional === true || step.optional === 'true',
    capture_stdout: step.capture_stdout !== false,
  };
}

function normalizeRenderStep(step, id, idx, sourcePath) {
  const format = String(step.format || '').trim();
  if (!['table', 'keyvalue', 'list', 'message'].includes(format)) {
    throw new Error(`${sourcePath}: steps[${idx}](${id}) 类型为 render，format 必须是 table/keyvalue/list/message`);
  }

  const out = {
    id,
    type: 'render',
    label: String(step.label || id),
    format,
    title: step.title ? String(step.title) : '',
    subtitle: step.subtitle ? String(step.subtitle) : '',
    level: ['info', 'success', 'warning', 'error'].includes(step.level) ? step.level : 'info',
  };

  if (Array.isArray(step.items_from_steps)) {
    out.items_from_steps = step.items_from_steps.map((it) => ({
      key: String(it.key || ''),
      value_from: it.value_from ? String(it.value_from) : '',
      value: it.value != null ? String(it.value) : undefined,
      prefix: it.prefix ? String(it.prefix) : '',
      suffix: it.suffix ? String(it.suffix) : '',
      transform: it.transform ? String(it.transform) : '',
    }));
  }
  if (Array.isArray(step.items)) {
    out.items = step.items.map((it) => ({ key: String(it.key || ''), value: String(it.value || '') }));
  }

  if (Array.isArray(step.columns)) out.columns = step.columns.map(String);
  if (Array.isArray(step.rows)) out.rows = step.rows.map((r) => (Array.isArray(r) ? r.map(String) : []));
  if (step.rows_from_step) out.rows_from_step = String(step.rows_from_step);
  if (step.row_separator) out.row_separator = String(step.row_separator);
  if (step.separator) out.separator = String(step.separator);
  if (Array.isArray(step.rowActions)) {
    out.rowActions = step.rowActions.map((a) => ({ label: String(a.label || ''), value: String(a.value || '') }));
  }
  if (step.row_action_skill) out.row_action_skill = String(step.row_action_skill);
  if (step.rowActionSkill) out.rowActionSkill = String(step.rowActionSkill);
  if (step.row_input_key) out.row_input_key = String(step.row_input_key);
  if (step.rowInputKey) out.rowInputKey = String(step.rowInputKey);

  if (Array.isArray(step.listItems)) {
    out.listItems = step.listItems.map((it) => ({
      title: String(it.title || ''),
      description: String(it.description || ''),
    }));
  }

  if (step.content) out.content = String(step.content);
  if (step.content_from) out.content_from = String(step.content_from);

  return out;
}

function normalizeVerify(v) {
  if (!v || typeof v !== 'object') return { exit_code: 0 };

  const out = {};
  if (v.exit_code != null) {
    const n = Number(v.exit_code);
    if (Number.isInteger(n)) out.exit_code = n;
  } else {
    out.exit_code = 0;
  }
  if (v.stdout_match) out.stdout_match = String(v.stdout_match);
  if (v.stdout_contains) out.stdout_contains = String(v.stdout_contains);
  if (v.stderr_not_contains) out.stderr_not_contains = String(v.stderr_not_contains);
  if (v.min_duration_ms != null) out.min_duration_ms = Number(v.min_duration_ms) || 0;
  return out;
}

function checkVerify(verify, execResult) {
  const { exitCode, stderr = '', durationMs = 0 } = execResult;
  const stdout = (execResult.stdout || '').replace(/[\r\n\s]+$/, '');

  if (verify.exit_code != null && exitCode !== verify.exit_code) {
    return { ok: false, reason: `exit_code=${exitCode}，期望 ${verify.exit_code}` };
  }
  if (verify.stdout_match) {
    try {
      const re = new RegExp(verify.stdout_match);
      if (!re.test(stdout)) return { ok: false, reason: `stdout 不匹配正则 /${verify.stdout_match}/` };
    } catch {
      return { ok: false, reason: `verify.stdout_match 不是合法正则: ${verify.stdout_match}` };
    }
  }
  if (verify.stdout_contains && !stdout.includes(verify.stdout_contains)) {
    return { ok: false, reason: `stdout 未包含 "${verify.stdout_contains}"` };
  }
  if (verify.stderr_not_contains && stderr.includes(verify.stderr_not_contains)) {
    return { ok: false, reason: `stderr 含有禁止字串 "${verify.stderr_not_contains}"` };
  }
  if (verify.min_duration_ms && durationMs < verify.min_duration_ms) {
    return { ok: false, reason: `执行耗时 ${durationMs}ms < ${verify.min_duration_ms}ms，疑似未真正运行` };
  }
  return { ok: true };
}

function normalizeTrigger(raw, idx, seenIds, actions, sourcePath) {
  if (!raw || typeof raw !== 'object') throw new Error(`${sourcePath}: triggers[${idx}] 必须是对象`);
  const type = String(raw.type || 'manual').trim();
  if (!['cron', 'manual'].includes(type)) {
    throw new Error(`${sourcePath}: triggers[${idx}] type "${type}" 未知（支持 cron | manual）`);
  }

  const id = String(raw.id || (type === 'manual' ? 'manual' : `trigger_${idx + 1}`)).trim();
  if (seenIds.has(id)) throw new Error(`${sourcePath}: triggers[${idx}] id "${id}" 重复`);
  seenIds.add(id);

  const actionKeys = Object.keys(actions);
  const actionName = String(raw.action || (actionKeys.length === 1 ? actionKeys[0] : '')).trim();
  if (!actionName) throw new Error(`${sourcePath}: triggers[${idx}] 缺少 action 字段`);
  if (!actions[actionName]) throw new Error(`${sourcePath}: triggers[${idx}] action "${actionName}" 未在 actions{} 里定义`);

  const out = { id, type, action: actionName };
  if (type === 'cron') {
    const schedule = String(raw.schedule || '').trim();
    if (!schedule) throw new Error(`${sourcePath}: triggers[${idx}] cron 类型缺少 schedule`);
    if (!cron.validate(schedule)) throw new Error(`${sourcePath}: triggers[${idx}] schedule "${schedule}" 不是合法的 cron 表达式`);
    out.schedule = schedule;
  }
  return out;
}

function normalizeUi(raw, actions, sourcePath) {
  const result = {};
  if (Array.isArray(raw.instance_actions) && raw.instance_actions.length > 0) {
    const seenIds = new Set();
    result.instance_actions = raw.instance_actions.map((item, idx) => {
      if (!item || typeof item !== 'object') throw new Error(`${sourcePath}: ui.instance_actions[${idx}] 必须是对象`);
      const id = String(item.id || '').trim();
      if (!id) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] 缺少 id`);
      if (seenIds.has(id)) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] id "${id}" 重复`);
      seenIds.add(id);

      const label = String(item.label || id).trim();
      const action = String(item.action || '').trim();
      if (!action) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] 缺少 action`);
      if (!actions[action]) throw new Error(`${sourcePath}: ui.instance_actions[${idx}] action "${action}" 未在 actions{} 里定义`);

      const style = ['primary', 'success', 'danger', 'default'].includes(item.style) ? item.style : 'default';
      const confirm = item.confirm ? String(item.confirm) : null;
      return { id, label, action, style, confirm };
    });
  }
  return Object.keys(result).length > 0 ? result : null;
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = { loadProgram, normalizeProgram, checkVerify, DEFAULT_STEP_TIMEOUT_MS };
