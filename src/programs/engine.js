'use strict';

/**
 * Program Engine — 长驻程序调度与 L1 确定性执行。
 */

const cron = require('node-cron');
const { checkVerify, DEFAULT_STEP_TIMEOUT_MS } = require('./program-schema');
const { collectSecretValues, redactKnownSecrets, redactCredentialPatterns, redactObjectSecretValues } = require('../../lib/secret-redaction');

function createProgramEngine({
  registry,
  stateService,
  bridgeService,
  hostService,
  aiService,
  auditService,
  logger,
  io,
  skillRegistry,
  harness,
  probeService,
}) {
  const scheduledTasks = new Map();
  const runningInstances = new Map();
  const activeRuns = new Map();
  let started = false;

  function start() {
    if (started) return;
    started = true;
    scheduleAll();
    logger?.info?.('[program-engine] started', {
      programs: registry.list().length,
      scheduled: totalScheduled(),
    });
  }

  function stop() {
    for (const tasks of scheduledTasks.values()) {
      for (const t of tasks) { try { t.stop(); } catch { /* ignore */ } }
    }
    scheduledTasks.clear();
    for (const run of activeRuns.values()) run.cancelled = true;
    started = false;
  }

  function reload() {
    stop();
    const result = registry.reload();
    start();
    return result;
  }

  function totalScheduled() {
    let n = 0;
    for (const tasks of scheduledTasks.values()) n += tasks.length;
    return n;
  }

  function scheduleAll() {
    for (const program of registry.list()) scheduleProgram(program);
  }

  function scheduleProgram(program) {
    if (!program.enabled) return;
    const tasks = [];
    const hostIds = resolveHosts(program);

    for (const trigger of program.triggers) {
      if (trigger.type !== 'cron') continue;
      for (const hostId of hostIds) {
        if (!stateService.isEnabled(program.id, hostId)) continue;
        const task = cron.schedule(trigger.schedule, () => {
          runInstance(program, hostId, trigger, { triggerType: 'cron' })
            .catch((err) => logger?.error?.('[program-engine] cron run error', {
              programId: program.id, hostId, triggerId: trigger.id, error: err.message,
            }));
        }, { scheduled: true, timezone: process.env.TZ });
        tasks.push(task);
      }
    }

    if (tasks.length > 0) scheduledTasks.set(program.id, tasks);
  }

  function resolveHosts(program) {
    if (program.hosts === 'all') {
      const all = hostService.listHosts?.() || [];
      return all.map((h) => h.id);
    }
    return program.hosts;
  }

  function inputDefsForAction(program, action) {
    return [...(program.inputs || []), ...(action.inputs || [])];
  }

  function normalizeRunInputs(program, action, rawInputs) {
    const source = rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs) ? rawInputs : {};
    const result = {};
    for (const input of inputDefsForAction(program, action)) {
      const rawValue = source[input.name];
      const hasValue = rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '';
      if (!hasValue && input.required) throw new Error(`缺少必填输入: ${input.label || input.name}`);
      if (!hasValue) {
        result[input.name] = input.default ?? '';
        continue;
      }
      if (input.type === 'number') {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) throw new Error(`${input.label || input.name} 必须是数字`);
        if (input.min !== null && value < Number(input.min)) throw new Error(`${input.label || input.name} 必须 >= ${input.min}`);
        if (input.max !== null && value > Number(input.max)) throw new Error(`${input.label || input.name} 必须 <= ${input.max}`);
        result[input.name] = String(value);
      } else if (input.type === 'boolean') {
        result[input.name] = rawValue === true || rawValue === 'true' || rawValue === '1' ? 'true' : 'false';
      } else if (input.type === 'select') {
        const value = String(rawValue);
        if (!input.options.some((option) => option.value === value)) throw new Error(`${input.label || input.name} 不是允许的选项`);
        result[input.name] = value;
      } else {
        result[input.name] = String(rawValue);
      }
    }
    return result;
  }

  function escapeDoubleQuotedShell(value) {
    return String(value ?? '').replace(/[\\"`$]/g, (ch) => `\\${ch}`).replace(/\r?\n/g, ' ');
  }

  function renderInputTemplates(command, inputs) {
    return String(command || '').replace(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => escapeDoubleQuotedShell(inputs[name] ?? ''));
  }

  function secretValuesForAction(program, action, inputs) {
    return collectSecretValues(inputDefsForAction(program, action), inputs);
  }

  function redactRunText(runState, value) {
    return redactKnownSecrets(value, runState?.secretValues || []);
  }

  function redactCommandResult(runState, result) {
    return {
      ...result,
      stdout: redactRunText(runState, redactCredentialPatterns(result?.stdout || '')),
      stderr: redactRunText(runState, redactCredentialPatterns(result?.stderr || '')),
    };
  }

  async function triggerManual({ programId, hostId, triggerId, actionName, inputs, wait = false }) {
    const program = registry.get(programId);
    if (!program) throw new Error(`Program 不存在: ${programId}`);

    let trigger;
    if (triggerId) {
      trigger = program.triggers.find((t) => t.id === triggerId);
      if (!trigger) throw new Error(`Trigger 不存在: ${triggerId}`);
    } else if (actionName) {
      if (!program.actions[actionName]) throw new Error(`Action 不存在: ${actionName}`);
      trigger = { id: `manual:${actionName}`, type: 'manual', action: actionName };
    } else {
      trigger = program.triggers.find((t) => t.type === 'manual') || program.triggers[0];
    }

    const action = program.actions[trigger.action];
    const preparedInputs = normalizeRunInputs(program, action, inputs || {});
    const hostIds = hostId === 'all' ? resolveHosts(program) : [hostId || resolveHosts(program)[0]];
    const runIds = [];
    const pending = [];
    for (const hid of hostIds) {
      const runPromise = runInstance(program, hid, trigger, {
        triggerType: 'manual',
        inputs: preparedInputs,
        onStarted: (runId) => runIds.push(runId),
      });
      pending.push(runPromise);
      runPromise.catch((err) => logger?.error?.('[program-engine] manual run error', {
        programId: program.id,
        hostId: hid,
        triggerId: trigger.id,
        error: err.message,
      }));
    }
    if (wait) await Promise.allSettled(pending);
    return runIds;
  }

  async function runInstance(program, hostId, trigger, { triggerType, inputs = {}, onStarted = null }) {
    const lockKey = `${program.id}::${hostId}`;
    if (runningInstances.has(lockKey)) {
      logger?.warn?.('[program-engine] instance busy, skip', { programId: program.id, hostId });
      return null;
    }

    const action = program.actions[trigger.action];
    if (!action) {
      logger?.error?.('[program-engine] action missing', { programId: program.id, action: trigger.action });
      return null;
    }

    const runId = stateService.recordRunStart({
      programId: program.id,
      hostId,
      triggerId: trigger.id,
      triggerType,
      action: trigger.action,
    });
    runningInstances.set(lockKey, runId);
    if (typeof onStarted === 'function') onStarted(runId);

    const runState = {
      cancelled: false,
      runId,
      programId: program.id,
      hostId,
      stepOutputs: new Map(),
      renderPayloads: [],
      aiResults: [],
      aiCommandResults: [],
      aiResultDraft: null,
      workflow: createWorkflowState(action),
      inputs,
      secretValues: secretValuesForAction(program, action, inputs),
    };
    activeRuns.set(runId, runState);

    emitProgramPhase({ runId, programId: program.id, hostId, phase: 'run-started', stepId: null, reason: trigger.id });
    io?.emit?.('program:run-started', {
      runId, programId: program.id, hostId, triggerId: trigger.id, action: trigger.action, triggerType, workflow: runState.workflow,
    });
    emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
    auditService?.log?.({
      action: 'program_run_start',
      source: 'program',
      hostId,
      hostName: hostService.findHost?.(hostId)?.name || hostId,
      details: JSON.stringify({ programId: program.id, triggerId: trigger.id, actionName: trigger.action }),
    });

    let status = 'success';
    let error = null;
    let stepsCompleted = 0;

    try {
      for (const step of action.steps) {
        if (runState.cancelled) { status = 'cancelled'; break; }

        updateWorkflowStep(runState, step.id, 'running');
        emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
        io?.emit?.('program:step-started', { runId, stepId: step.id });

        if (step.type === 'render') {
          const payload = buildProgramRenderPayload(step, runState.stepOutputs);
          runState.renderPayloads.push({ stepId: step.id, payload });
          io?.emit?.('program:render', { runId, programId: program.id, hostId, stepId: step.id, payload });
          updateWorkflowStep(runState, step.id, 'done');
          emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
          io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'rendered', durationMs: 0 });
          stepsCompleted++;
          continue;
        }

        if (step.type === 'ai') {
          const startedAt = Date.now();
          try {
            emitProgramPhase({ runId, programId: program.id, hostId, phase: 'ai', stepId: step.id, reason: step.label });
            const result = await runAiStep(program, action, step, hostId, runState);
            const resultText = redactRunText(runState, result.text);
            runState.stepOutputs.set(step.id, { stdout: resultText, stderr: '', exitCode: 0, durationMs: Date.now() - startedAt });
            runState.aiResults.push({ stepId: step.id, label: step.label, result: resultText });
            runState.workflow.result = resultText;
            updateWorkflowStep(runState, step.id, 'done', resultText);
            emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
            io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'done', durationMs: Date.now() - startedAt });
            stepsCompleted++;
            continue;
          } catch (err) {
            const reason = err.message || 'AI 步骤未完成';
            if (runState.aiResultDraft?.content) {
              const draft = runState.aiResultDraft.content;
              runState.stepOutputs.set(step.id, { stdout: draft, stderr: reason, exitCode: 0, durationMs: Date.now() - startedAt });
              runState.aiResults.push({ stepId: step.id, label: step.label, result: draft });
              runState.workflow.result = draft;
              updateWorkflowStep(runState, step.id, 'done', 'AI Provider 中断，已保留运行过程中生成的报告');
              emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
              emitProgramPhase({ runId, programId: program.id, hostId, phase: 'result_preserved', stepId: step.id, status: 'done', reason: '已保留增量报告' });
              io?.emit?.('program:step-ended', { runId, stepId: step.id, status: 'done', durationMs: Date.now() - startedAt, reason: 'preserved-incremental-result' });
              stepsCompleted++;
              continue;
            }
            updateWorkflowStep(runState, step.id, 'failed', reason);
            emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
            io?.emit?.('program:step-ended', { runId, stepId: step.id, status: step.optional ? 'skipped' : 'failed', durationMs: Date.now() - startedAt, reason });
            if (step.optional || action.on_fail === 'ignore') { stepsCompleted++; continue; }
            status = 'failed';
            error = `AI 步骤 "${step.id}" 未完成：${reason}`;
            break;
          }
        }

        emitProgramPhase({ runId, programId: program.id, hostId, phase: 'exec', stepId: step.id, reason: step.label });
        const result = await execStep(step, hostId, runState.inputs, runState);
        runState.stepOutputs.set(step.id, redactCommandResult(runState, result));

        const verdict = checkVerify(step.verify, result);
        const stepStatus = verdict.ok ? 'done' : (step.optional ? 'skipped' : 'failed');
        updateWorkflowStep(runState, step.id, stepStatus, verdict.ok ? '' : verdict.reason);
        emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });
        io?.emit?.('program:step-ended', {
          runId,
          stepId: step.id,
          status: verdict.ok ? 'verified' : (step.optional ? 'skipped' : 'failed'),
          durationMs: result.durationMs,
          reason: verdict.ok ? null : verdict.reason,
        });

        if (verdict.ok) { stepsCompleted++; continue; }
        if (step.optional) { stepsCompleted++; continue; }
        if (action.on_fail === 'ignore') { stepsCompleted++; continue; }

        status = 'failed';
        error = `step "${step.id}" 失败：${verdict.reason}`;
        break;
      }
    } catch (err) {
      status = 'error';
      error = err.message;
      logger?.error?.('[program-engine] run exception', { runId, programId: program.id, hostId, error: err.message });
    } finally {
      runningInstances.delete(lockKey);
      activeRuns.delete(runId);
    }

    appendFinalRenderIfNeeded({
      runState,
      runId,
      programId: program.id,
      hostId,
      status,
      error,
      stepsTotal: action.steps.length,
      stepsCompleted,
    });

    runState.workflow.status = status;
    emitWorkflow({ runId, programId: program.id, hostId, workflow: runState.workflow });

    stateService.recordRunEnd(runId, {
      status,
      stepsTotal: action.steps.length,
      stepsCompleted,
      rescueCount: 0,
      details: { workflow: runState.workflow },
      error,
      renders: runState.renderPayloads,
    });

    io?.emit?.('program:run-ended', {
      runId, programId: program.id, hostId, status, error,
      stepsTotal: action.steps.length, stepsCompleted,
    });
    auditService?.log?.({
      action: 'program_run_end',
      source: 'program',
      hostId,
      hostName: hostService.findHost?.(hostId)?.name || hostId,
      exit_code: status === 'success' ? 0 : 1,
      error,
      details: JSON.stringify({ programId: program.id, status, stepsCompleted }),
    });

    return runId;
  }

  async function execStep(step, hostId, inputs = {}, runState = null) {
    const timeout = step.timeout || DEFAULT_STEP_TIMEOUT_MS;
    const run = renderInputTemplates(step.run, inputs);
    const auditCommand = redactRunText(runState, run);
    try {
      const result = await bridgeService.execOnHost(hostId, run, timeout, { source: 'program-l1', auditCommand });
      if (hostId !== 'local' && result.exitCode !== 0 && result.durationMs < 150) {
        await new Promise((r) => setTimeout(r, 200));
        try { return await bridgeService.execOnHost(hostId, run, timeout, { source: 'program-l1-retry', auditCommand }); }
        catch (err) { return { stdout: '', stderr: redactRunText(runState, err.message), exitCode: 1, durationMs: 0 }; }
      }
      return result;
    } catch (err) {
      return { stdout: '', stderr: redactRunText(runState, err.message), exitCode: 1, durationMs: 0 };
    }
  }

  async function runAiStep(program, action, step, hostId, runState) {
    if (!aiService?.requestProgramWorkflowStep) {
      throw new Error('AI workflow runner 未配置');
    }
    let runtimeSkillBody = '';
    try { runtimeSkillBody = (skillRegistry?.getSkillBody?.('program-runtime') || '').trim(); } catch { /* ignore */ }
    const baseHost = hostService.findHost?.(hostId) || { id: hostId, name: hostId };
    // OS 感知：把探针采集到的目标机 OS/平台（发行版 / 架构 / 内核）作为上下文喂给 AI，
    // 让 AI 一上来就知道目标机是什么系统，据此选包管理器和命令，无需先花一轮自己探测。
    let platform = null;
    try {
      const snapshot = probeService?.getLatestSnapshot?.();
      platform = hostService.getHostPlatformText?.(hostId, snapshot) || null;
    } catch { /* ignore */ }
    const host = platform ? { ...baseHost, platform } : baseHost;
    recordTraceEvent('instruction', 'instruction_received', {
      source: 'program-ai-workflow',
      runId: runState.runId,
      hostId,
      toolName: 'program_instruction',
      summary: `${program.name || program.id || 'Program'} / ${step.label || step.id || 'AI step'}: ${step.goal || step.result || action.label || action.name || ''}`,
      secrets: runState.secretValues || [],
    });
    return aiService.requestProgramWorkflowStep({
      program,
      action: { name: action.name, label: action.label },
      step,
      host,
      inputs: redactObjectSecretValues(runState.inputs, inputDefsForAction(program, action)),
      previousResults: runState.aiResults.map((item) => ({ ...item, result: redactRunText(runState, item.result) })),
      systemPrompt: runtimeSkillBody,
      executeCommand: async ({ command, timeout, finalResult }) => {
        if (!command) return { content: '[ERROR] command 参数为空', is_error: true };
        const redactedCommand = redactRunText(runState, command);
        const resolvedTimeout = timeout || 120000;
        recordTraceEvent('reasoning', 'tool_decision', {
          source: 'program-ai-workflow',
          runId: runState.runId,
          hostId,
          toolName: 'execute_command',
          summary: `AI 决定执行命令：${redactedCommand}`,
          secrets: runState.secretValues || [],
        });

        // 经 harness 统一边界：guard（capability + 灾难拦截）→ 人审(此路关闭) → 执行 → 打码 → 轨迹
        if (harness?.dispatch) {
          const ctx = harness.buildContext('program-ai-workflow', {
            hostId,
            capabilities: Array.isArray(step.capabilities) && step.capabilities.length ? step.capabilities : undefined,
            allowApproval: false,
            secrets: runState.secretValues || [],
            auditCommand: redactedCommand,
            runId: runState.runId,
          });
          const dispatched = await harness.dispatch('execute_command', { command, hostId, timeout: resolvedTimeout }, ctx);
          // guard 拦截/拒绝时无 raw —— 把拦截原因作为 tool_result 喂回，AI 自行换方案
          if (!dispatched.raw) {
            recordAiCommandResult({ runState, runId: runState.runId, programId: program.id, hostId, stepId: step.id, command: redactedCommand, result: { stdout: '', stderr: dispatched.content, exitCode: 126, durationMs: 0 }, finalResult });
            return { content: dispatched.content, is_error: true };
          }
          const redactedResult = redactCommandResult(runState, dispatched.raw);
          recordAiCommandResult({ runState, runId: runState.runId, programId: program.id, hostId, stepId: step.id, command: redactedCommand, result: redactedResult, finalResult });
          if (finalResult) {
            const stdout = String(redactedResult.stdout || '').trim();
            const stderr = String(redactedResult.stderr || '').trim();
            return { content: stdout || stderr || `(命令退出码 ${redactedResult.exitCode}，无输出)`, is_error: redactedResult.exitCode !== 0 };
          }
          return { content: formatAiCommandResult(redactedResult), is_error: redactedResult.exitCode !== 0 };
        }

        // fallback：harness 未注入时保持旧路径
        const result = await bridgeService.execOnHost(hostId, command, resolvedTimeout, { source: 'program-ai-workflow', auditCommand: redactedCommand });
        const redactedResult = redactCommandResult(runState, result);
        recordAiCommandResult({ runState, runId: runState.runId, programId: program.id, hostId, stepId: step.id, command: redactedCommand, result: redactedResult, finalResult });
        if (finalResult) {
          const stdout = String(redactedResult.stdout || '').trim();
          const stderr = String(redactedResult.stderr || '').trim();
          return { content: stdout || stderr || `(命令退出码 ${redactedResult.exitCode}，无输出)`, is_error: redactedResult.exitCode !== 0 };
        }
        return { content: formatAiCommandResult(redactedResult), is_error: redactedResult.exitCode !== 0 };
      },
      reportPhase: async ({ phase, status, message }) => {
        recordTraceEvent('reasoning', 'phase_decision', {
          source: 'program-ai-workflow',
          runId: runState.runId,
          hostId,
          toolName: 'report_phase',
          summary: `${phase || 'phase'} ${status || 'running'} ${message || ''}`.trim(),
          secrets: runState.secretValues || [],
        });
        emitProgramPhase({
          runId: runState.runId,
          programId: program.id,
          hostId,
          phase,
          stepId: step.id,
          status: status || 'running',
          reason: message || '',
        });
      },
      updateResult: async ({ title, status, content, final }) => {
        recordTraceEvent(final ? 'result' : 'reasoning', final ? 'final_result' : 'reasoning_summary', {
          source: 'program-ai-workflow',
          runId: runState.runId,
          hostId,
          toolName: final ? 'publish_result' : 'update_result',
          summary: `${title || program.name || step.label || 'AI 执行结果'} ${status || ''}`.trim(),
          resultSummary: redactRunText(runState, content),
          secrets: runState.secretValues || [],
        });
        emitAiResultDraft({
          runState,
          runId: runState.runId,
          programId: program.id,
          hostId,
          stepId: step.id,
          title: title || program.name || step.label || 'AI 执行结果',
          status,
          content: redactRunText(runState, content),
          final,
        });
      },
    });
  }

  function emitWorkflow(payload) {
    io?.emit?.('program:workflow', payload);
  }

  function recordTraceEvent(stage, eventType, payload = {}) {
    try {
      harness?.recordEvent?.({ stage, eventType, ...payload });
    } catch { /* trace must not block Program execution */ }
  }

  function setInstanceEnabled(programId, hostId, enabled) {
    stateService.setEnabled(programId, hostId, enabled);
    reload();
  }

  function cancelRun(runId) {
    const run = activeRuns.get(runId);
    if (run) run.cancelled = true;
  }

  function listActive() {
    return [...activeRuns.entries()].map(([runId, s]) => ({
      runId, programId: s.programId, hostId: s.hostId, cancelled: s.cancelled, workflow: s.workflow,
    }));
  }

  function emitAiResultDraft({ runState, runId, programId, hostId, stepId, title, status, content, final = false }) {
    const text = String(content || '').trim();
    if (!text) return;
    const payload = {
      format: 'message',
      title: title || 'AI 执行结果',
      subtitle: `状态：${status || (final ? 'final' : 'running')}`,
      level: status === 'failed' ? 'error' : (status === 'warning' ? 'warning' : 'success'),
      content: text,
      result: text,
      output: text,
      items: [
        { key: '生成方式', value: final ? '最终结果' : '运行中增量结果' },
      ],
    };
    runState.aiResultDraft = { content: text, final: final === true };
    runState.renderPayloads = runState.renderPayloads.filter((entry) => entry.stepId !== '__ai_live_result__');
    runState.renderPayloads.push({ stepId: '__ai_live_result__', payload });
    io?.emit?.('program:render', { runId, programId, hostId, stepId: '__ai_live_result__', payload });
    emitProgramPhase({ runId, programId, hostId, phase: 'result_update', stepId, status: final ? 'done' : 'running', reason: final ? '最终结果已生成' : '结果草稿已更新' });
  }

  function recordAiCommandResult({ runState, runId, programId, hostId, stepId, command, result, finalResult = false }) {
    const item = {
      title: finalResult ? '最终输出命令' : `采集命令 ${runState.aiCommandResults.length + 1}`,
      command: compactText(command, 500),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: compactText(result.stdout || '', 3000),
      stderr: compactText(result.stderr || '', 1200),
      finalResult: finalResult === true,
    };
    runState.aiCommandResults.push(item);
    const failedCount = runState.aiCommandResults.filter((entry) => entry.exitCode !== 0).length;
    const payload = {
      format: 'message',
      title: finalResult ? '最终输出已生成' : '采集结果已更新',
      subtitle: finalResult ? 'Program 正在输出命令生成的结果' : 'Program 正在运行',
      level: failedCount > 0 ? 'warning' : 'info',
      content: finalResult
        ? '最终报告已由 Program 命令生成，正在写入结果区。'
        : `已采集 ${runState.aiCommandResults.length} 组命令结果${failedCount ? `，其中 ${failedCount} 组返回非零退出码` : ''}。`,
      output: {
        status: finalResult ? 'final_result' : 'collecting',
        summary: finalResult ? '最终报告由 Program 命令直接输出。' : `已采集 ${runState.aiCommandResults.length} 组命令结果。`,
        collectedCommands: runState.aiCommandResults,
      },
    };
    runState.renderPayloads = runState.renderPayloads.filter((entry) => entry.stepId !== '__collected__');
    runState.renderPayloads.push({ stepId: '__collected__', payload });
    io?.emit?.('program:render', { runId, programId, hostId, stepId: '__collected__', payload });
    emitProgramPhase({ runId, programId, hostId, phase: 'collect', stepId, status: 'running', reason: `已采集 ${runState.aiCommandResults.length} 组命令结果` });
  }

  function appendFinalRenderIfNeeded({
    runState,
    runId,
    programId,
    hostId,
    status,
    error,
    stepsTotal,
    stepsCompleted,
  }) {
    const aiResult = String(runState.workflow?.result || '').trim();
    const shouldEmitAiResult = status === 'success' && runState.aiResults.length > 0 && aiResult;
    if (status === 'success' && runState.renderPayloads.length > 0 && !shouldEmitAiResult) return;

    const collectedCommands = Array.isArray(runState.aiCommandResults) ? runState.aiCommandResults : [];
    const fallbackContent = error || `执行完成：${stepsCompleted}/${stepsTotal} 个步骤完成。`;
    const payload = shouldEmitAiResult ? {
      format: 'message',
      title: 'AI 执行结果',
      subtitle: `状态：${status}`,
      level: 'success',
      content: aiResult,
      result: aiResult,
      output: aiResult,
      items: [
        { key: '完成步骤', value: `${stepsCompleted}/${stepsTotal}` },
      ],
    } : {
      format: 'message',
      title: status === 'success' ? 'Program 执行结果' : 'Program 终态说明',
      subtitle: `状态：${status}`,
      level: status === 'success' ? 'success' : (status === 'warning' ? 'warning' : 'error'),
      content: fallbackContent,
      output: collectedCommands.length > 0 ? {
        status,
        summary: fallbackContent,
        collectedCommands,
      } : undefined,
      items: [
        { key: '完成步骤', value: `${stepsCompleted}/${stepsTotal}` },
        ...(collectedCommands.length > 0 ? [{ key: '已采集命令', value: `${collectedCommands.length} 组` }] : []),
      ],
    };

    const stepId = shouldEmitAiResult ? '__ai_result__' : '__final__';
    runState.renderPayloads.push({ stepId, payload });
    io?.emit?.('program:render', { runId, programId, hostId, stepId, payload });
  }


  function emitProgramPhase(payload) {
    io?.emit?.('program:phase', payload);
  }

  return { start, stop, reload, triggerManual, setInstanceEnabled, cancelRun, listActive };
}

function createWorkflowState(action) {
  return {
    status: 'running',
    result: '',
    steps: (action.steps || []).map((step) => ({
      id: step.id,
      label: step.label || step.goal || step.id,
      type: step.type,
      status: 'waiting',
      message: '',
    })),
  };
}

function updateWorkflowStep(runState, stepId, status, message = '') {
  const step = runState.workflow?.steps?.find((item) => item.id === stepId);
  if (!step) return;
  step.status = status;
  step.message = message || '';
}

function buildProgramRenderPayload(step, stepOutputs) {
  const base = {
    format: step.format || 'message',
    title: step.title,
    subtitle: step.subtitle,
    level: step.level || 'info',
  };

  if (step.format === 'keyvalue') {
    const items = [];
    if (Array.isArray(step.items)) items.push(...step.items);
    if (Array.isArray(step.items_from_steps)) {
      for (const it of step.items_from_steps) {
        const out = stepOutputs.get(it.value_from);
        if (!out) continue;
        let val = applyTransform((out.stdout || '').trim(), it.transform);
        val = `${it.prefix || ''}${val}${it.suffix || ''}`;
        items.push({ key: it.key, value: val });
      }
    }
    base.items = items;
  } else if (step.format === 'table') {
    base.columns = step.columns || [];
    if (step.rows_from_step) {
      const out = stepOutputs.get(step.rows_from_step);
      if (out) {
        const sep = step.row_separator || step.separator || null;
        base.rows = (out.stdout || '').split('\n')
          .map((l) => l.trim()).filter(Boolean)
          .map((l) => sep ? l.split(sep) : l.split(/\s{2,}|\t/));
      }
    } else {
      base.rows = step.rows || [];
    }
    if (Array.isArray(step.rowActions)) base.rowActions = step.rowActions;
    const rowSkill = step.rowActionSkill || step.row_action_skill;
    if (rowSkill) base.rowActionSkill = rowSkill;
    const rowKey = step.rowInputKey || step.row_input_key;
    if (rowKey) base.rowInputKey = rowKey;
  } else if (step.format === 'list') {
    base.listItems = step.listItems || [];
  } else if (step.format === 'message') {
    if (step.content_from) {
      const out = stepOutputs.get(step.content_from);
      base.content = out ? (out.stdout || '').trim() : '';
    } else {
      base.content = step.content || '';
    }
  }
  return base;
}

function formatAiCommandResult({ stdout = '', stderr = '', exitCode = 0, durationMs = 0 }) {
  const parts = [];
  const stdoutSummary = summarizeCommandOutput(stdout, 1400);
  const stderrSummary = summarizeCommandOutput(stderr, 400);
  if (stdoutSummary) parts.push(`[stdout_summary]\n${stdoutSummary}`);
  if (stderrSummary) parts.push(`[stderr_summary]\n${stderrSummary}`);
  if (parts.length === 0) parts.push('[stdout_summary] (空)');
  parts.push(`[exitCode] ${exitCode}`);
  parts.push(`[durationMs] ${durationMs}`);
  parts.push('注意：这是命令输出摘要，原始输出已由 1Shell 保存到调试详情；请基于摘要直接调用 publish_result 生成最终报告。');
  return parts.join('\n\n');
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...(已截断，原 ${text.length} 字符)`;
}

function summarizeCommandOutput(value, maxLength) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const scored = lines.map((line, index) => ({ line: maskSensitiveText(line), index, score: scoreDiagnosticLine(line) }));
  const important = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 18)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.line);
  const head = scored.slice(0, 12).map((item) => item.line);
  const tail = scored.slice(-8).map((item) => item.line);
  const merged = [...new Set([...head, ...important, ...tail])].join('\n');
  return compactTextMiddle(merged, maxLength);
}

function scoreDiagnosticLine(line) {
  const text = String(line || '');
  let score = 0;
  if (/\b(error|failed|fail|critical|panic|oom|killed|denied|timeout|unreachable|segfault|warning|warn)\b/i.test(text)) score += 8;
  if (/\b(mem|memory|swap|rss|load|cpu|disk|inode|listen|tcp|udp|service|systemd|docker|nginx|mysql|redis|node|pm2)\b/i.test(text)) score += 4;
  if (/\b(total|used|free|available|size|use%|pid|user|command|state)\b/i.test(text)) score += 2;
  if (/^===|^-{3,}|^filesystem|^pid\s+/i.test(text)) score += 3;
  if (text.length > 220) score -= 2;
  return score;
}

function maskSensitiveText(value) {
  return String(value || '')
    .replace(/(authorization|cookie|token|password|passwd|secret|api[_-]?key|private[_-]?key)=\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

function compactTextMiddle(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  const headLength = Math.floor(maxLength * 0.7);
  const tailLength = maxLength - headLength;
  return `${text.slice(0, headLength)}\n...(中间已截断，原 ${text.length} 字符)...\n${text.slice(-tailLength)}`;
}

function applyTransform(value, transform) {
  const t = String(transform || 'trim').trim();
  if (!t || t === 'trim') return value.trim();
  if (t === 'first_line') return value.split('\n')[0].trim();
  if (t === 'last_line') {
    const lines = value.trim().split('\n');
    return lines[lines.length - 1] || '';
  }
  if (t.startsWith('kv:')) {
    const key = t.slice(3);
    const found = value.split('|').find((part) => part.startsWith(`${key}=`));
    return found ? found.slice(key.length + 1) : '';
  }
  return value.trim();
}

module.exports = { createProgramEngine };
