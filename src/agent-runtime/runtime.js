'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const { validateAgentTransition } = require('./graph');
const { createAgentCognitionState } = require('./cognition');
const { createRuntimeDecisionReviewState } = require('./decision-policy');
const { applyObservationToRuntimeState } = require('./observation-interpreter');
const { createRuntimePlanState, createRuntimeRecoveryState } = require('./planning');
const { applyReplayEvaluationToState, createReplayEvaluationState, evaluateAgentRunReplay } = require('./replay');
const { describeCommandSideEffects, evaluateAgentToolPolicy } = require('./tool-policy');
const { applyTrajectoryEvaluationToState, createTrajectoryEvaluationState, evaluateAgentTrajectory } = require('./trajectory');
const { normalizeVerifierRegistry } = require('./verifier-registry');
const { applyVerifierPlanToRuntimeState } = require('./verifiers');
const { canUseTool, createBudgetExceededResult, recordToolUsage } = require('./budget');
const { pushAgentEvent } = require('./events');
const { createInitialAgentState, setRunnerStatus, setTaskStatus, touch } = require('./state');
const { normalizeAgentStore } = require('./store');
const { buildHarnessContext, createToolCallEnvelope, normalizeToolResult } = require('./tools');
const { redactCredentialPatterns, redactPotentialSecrets } = require('../../lib/secret-redaction');

// Run GC：state 只用于执行期与 UI 回看，结束后按保留期删除，防止
// 内存 store 随消息量无限累积（长会话服务器的实际卡死来源）。
const RUN_GC_DEFAULT_RETENTION_MS = 15 * 60 * 1000;
const RUN_GC_DEFAULT_MAX_RUNS = 200;

function createAgentRuntime({ harness, io, logger, store, verifierRegistry = null, runRetentionMs = RUN_GC_DEFAULT_RETENTION_MS, maxRetainedRuns = RUN_GC_DEFAULT_MAX_RUNS } = {}) {
  const agentStore = normalizeAgentStore(store);
  const emitter = new EventEmitter();
  const runtimeVerifierRegistry = normalizeVerifierRegistry(verifierRegistry);

  function saveState(state) {
    return agentStore.saveRun(state);
  }

  const runGcTimers = new Map();

  function cancelRunGc(runId) {
    const timer = runGcTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    runGcTimers.delete(runId);
  }

  function scheduleRunGc(runId) {
    if (!runId) return;
    cancelRunGc(runId);
    const timer = setTimeout(() => {
      runGcTimers.delete(runId);
      try { agentStore.deleteRun(runId); } catch { /* already removed */ }
    }, runRetentionMs);
    timer.unref?.();
    runGcTimers.set(runId, timer);
  }

  function evictExcessEndedRuns() {
    if (!Number.isFinite(maxRetainedRuns) || maxRetainedRuns <= 0) return;
    let excess = agentStore.listRuns().length - maxRetainedRuns;
    if (excess <= 0) return;
    for (const state of agentStore.listRuns()) {
      if (excess <= 0) break;
      if (!state || state.runnerStatus === 'running') continue;
      cancelRunGc(state.runId);
      try { agentStore.deleteRun(state.runId); } catch { /* ignore */ }
      excess -= 1;
    }
  }

  function emit(state, type, payload = {}) {
    const event = pushAgentEvent(state, type, payload);
    saveState(state);
    emitter.emit(type, event);
    emitter.emit('*', event);
    io?.emit?.(type, event);
    return event;
  }

  function recordTraceEvent(runId, event = {}) {
    const state = requireState(runId);
    const payload = {
      stage: String(event.stage || 'runtime'),
      eventType: String(event.eventType || event.event_type || 'trace'),
      summary: String(event.summary || '').slice(0, 4000),
      data: normalizeObject(event.data),
    };
    if (event.round !== undefined) payload.round = Number(event.round);
    if (event.toolName) payload.toolName = String(event.toolName);
    if (event.toolUseId) payload.toolUseId = String(event.toolUseId);
    if (event.hostId) payload.hostId = String(event.hostId);
    if (event.sessionId) payload.sessionId = String(event.sessionId);
    emit(state, 'agent:trace-event', payload);
    return payload;
  }

  function recordTurn(runId, turn = {}) {
    const state = requireState(runId);
    const item = upsertTurn(state, turn);
    emit(state, 'agent:turn-updated', { turn: summarizeTurn(item) });
    return item;
  }

  function recordObservation(runId, observation = {}) {
    const state = requireState(runId);
    const verifierPlanBefore = verifierPlanSignature(state);
    const item = appendObservation(state, observation);
    emit(state, 'agent:observation-recorded', { observation: item });
    emitVerifierPlanChanged(state, verifierPlanBefore, {
      reason: 'observation_recorded',
      observationId: item.id,
      toolName: item.toolName,
    });
    return item;
  }

  function recordVerification(runId, verification = {}) {
    const state = requireState(runId);
    const verifierPlanBefore = verifierPlanSignature(state);
    const item = normalizeVerificationRecord(state, verification);
    state.verification = item;
    ensureRuntimeMemory(state).verification = item;
    ensureRuntimeWorldState(state).verification = item;
    applyVerifierPlanToRuntimeState(state);
    touch(state);
    emit(state, 'agent:verification-recorded', { verification: item });
    emitVerifierPlanChanged(state, verifierPlanBefore, {
      reason: 'verification_recorded',
      verificationId: item.id,
      status: item.status,
    });
    return item;
  }

  function recordRuntimeTransition(runId, transition = {}) {
    const state = requireState(runId);
    const item = appendRuntimeTransition(state, transition);
    emit(state, 'agent:runtime-transition', { transition: item });
    return item;
  }

  function updateTaskStatus(runId, taskStatus, options = {}) {
    const state = requireState(runId);
    const normalized = normalizeTaskStatus(taskStatus);
    if (!normalized) throw new Error(`Unsupported agent outcome status: ${taskStatus}`);
    const previousTaskStatus = state.taskStatus || 'unknown';
    const runtimeState = ensureRuntimeState(state);
    const item = {
      previousTaskStatus,
      taskStatus: normalized,
      source: String(options.source || 'runtime'),
      reason: compactText(options.reason || '', 1000),
      data: normalizeObject(options.data),
      updatedAt: new Date().toISOString(),
    };
    if (!Array.isArray(runtimeState.statusHistory)) runtimeState.statusHistory = [];
    runtimeState.statusHistory.push(item);
    runtimeState.statusHistory = runtimeState.statusHistory.slice(-100);
    setTaskStatus(state, normalized);
    if (options.syncResult !== false && state.result && typeof state.result === 'object') {
      state.result = {
        ...state.result,
        status: normalized,
        taskStatus: normalized,
      };
    }
    touch(state);
    emit(state, 'agent:status-updated', item);
    return { state, ...item };
  }

  function recordToolCallStarted(runId, toolName, args = {}, options = {}) {
    const state = requireState(runId);
    recordToolUsage(state, toolName);
    const toolCall = createToolCallEnvelope({
      state,
      toolName,
      args,
      riskLevel: options.riskLevel || options.risk_level,
      capability: options.capability,
      scope: options.scope,
    });
    if (options.toolCallId || options.toolUseId || options.tool_use_id) {
      toolCall.id = String(options.toolCallId || options.toolUseId || options.tool_use_id);
    }
    toolCall.providerToolUseId = String(options.providerToolUseId || options.provider_tool_use_id || options.toolUseId || options.tool_use_id || '');
    toolCall.status = 'running';
    toolCall.startedAt = new Date().toISOString();
    state.toolCalls.push(toolCall);
    emit(state, 'agent:tool-call-started', { toolCall });
    return toolCall;
  }

  function recordToolCallEnded(runId, toolCallId, result = {}) {
    const state = requireState(runId);
    const id = String(toolCallId || '').trim();
    if (!id) throw new Error('toolCallId is required');
    const toolCall = state.toolCalls.find((item) => item.id === id || item.providerToolUseId === id);
    if (!toolCall) throw new Error(`Agent tool call not found: ${id}`);
    const verifierPlanBefore = verifierPlanSignature(state);
    const observation = finishToolCall(state, toolCall, normalizeToolResult(result));
    emit(state, 'agent:tool-call-ended', { toolCall });
    if (observation) emit(state, 'agent:observation-recorded', { observation });
    emitVerifierPlanChanged(state, verifierPlanBefore, {
      reason: 'tool_call_ended',
      observationId: observation?.id || '',
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
    });
    return toolCall;
  }

  function startRun(spec, options = {}) {
    const state = createInitialAgentState(spec, options);
    applyVerifierPlanToRuntimeState(state);
    setRunnerStatus(state, 'running');
    cancelRunGc(state.runId);
    saveState(state);
    evictExcessEndedRuns();
    emit(state, 'agent:run-started', { goal: state.goal, metadata: state.spec.metadata });
    return state;
  }

  function getState(runId) {
    return agentStore.getRun(runId) || null;
  }

  function listRuns() {
    return agentStore.listRuns();
  }

  function listCheckpoints(runId) {
    const state = requireState(runId);
    return Array.isArray(state.checkpoints) ? [...state.checkpoints] : [];
  }

  function getCheckpoint(runId, checkpointId = '') {
    const checkpoints = listCheckpoints(runId);
    const id = String(checkpointId || '').trim();
    if (id) return checkpoints.find((checkpoint) => checkpoint.id === id) || null;
    return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
  }

  function listInterrupts(runId, { status = '' } = {}) {
    const state = requireState(runId);
    const items = Array.isArray(state.interrupts) ? [...state.interrupts] : [];
    const wanted = String(status || '').trim();
    return wanted ? items.filter((interrupt) => interrupt.status === wanted) : items;
  }

  function getInterrupt(runId, interruptId = '') {
    const interrupts = listInterrupts(runId);
    const id = String(interruptId || '').trim();
    if (id) return interrupts.find((interrupt) => interrupt.id === id) || null;
    const pending = [...interrupts].reverse().find((interrupt) => interrupt.status === 'pending');
    return pending || (interrupts.length > 0 ? interrupts[interrupts.length - 1] : null);
  }

  function resumeRun(runId, { checkpointId = '', interruptId = '', resolution = {}, runnerStatus = 'running', taskStatus = null, data = {} } = {}) {
    const state = requireState(runId);
    cancelRunGc(runId);
    const checkpoint = findCheckpoint(state, checkpointId);
    if (checkpointId && !checkpoint) throw new Error(`Agent checkpoint not found: ${checkpointId}`);

    const interrupt = findInterrupt(state, interruptId);
    if (interruptId && !interrupt) throw new Error(`Agent interrupt not found: ${interruptId}`);
    let resolutionObservation = null;
    if (interrupt?.status === 'pending') {
      interrupt.status = String(resolution.status || 'resolved');
      interrupt.resolvedAt = new Date().toISOString();
      interrupt.resolution = normalizeObject(resolution);
      resolutionObservation = appendInterruptResolutionObservation(state, interrupt, interrupt.resolution, data);
      emit(state, 'agent:interrupt-resolved', { interrupt, resolution: interrupt.resolution, observation: resolutionObservation });
      emit(state, 'agent:observation-recorded', { observation: resolutionObservation });
    }

    const hasPending = state.interrupts.some((item) => item.status === 'pending');
    const resolutionOk = resolutionObservation ? resolutionObservation.ok === true : true;
    if (!hasPending) setRunnerStatus(state, resolutionOk ? (runnerStatus || 'running') : 'interrupted');
    if (taskStatus) setTaskStatus(state, taskStatus);
    else if (!resolutionOk) setTaskStatus(state, 'blocked');
    else if (!hasPending && state.taskStatus === 'blocked') setTaskStatus(state, 'unknown');
    const transition = recordInterruptRuntimeTransition(state, interrupt, resolutionOk ? 'observe' : 'blocked', {
      reason: resolutionOk ? 'interrupt_resolved_resume' : 'interrupt_resolution_blocked',
      status: resolutionOk ? state.runnerStatus : 'blocked',
      observationId: resolutionObservation?.id || '',
      data: {
        checkpointId: checkpoint?.id || '',
        resolutionStatus: resolutionObservation?.data?.status || resolution.status || '',
        resolutionOk,
      },
    });

    touch(state);
    if (transition) emit(state, 'agent:runtime-transition', { transition });
    emit(state, 'agent:run-resumed', {
      checkpoint,
      interrupt,
      resolution: normalizeObject(resolution),
      observation: resolutionObservation,
      data: normalizeObject(data),
    });
    return { state, checkpoint, interrupt, observation: resolutionObservation };
  }

  function cancelRun(runId, { reason = '', taskStatus = 'blocked', result = null, data = {} } = {}) {
    const state = requireState(runId);
    const message = String(reason || 'cancelled');
    setRunnerStatus(state, 'cancelled');
    if (taskStatus) setTaskStatus(state, taskStatus);
    if (result) {
      state.result = result;
    } else if (!state.result) {
      state.result = {
        title: '',
        status: state.taskStatus || 'blocked',
        summary: [],
        report: message,
        data: normalizeObject(data),
        publishedAt: new Date().toISOString(),
      };
    }
    touch(state);
    emit(state, 'agent:run-cancelled', {
      reason: message,
      runnerStatus: state.runnerStatus,
      taskStatus: state.taskStatus,
      result: state.result,
      data: normalizeObject(data),
    });
    scheduleRunGc(runId);
    return state;
  }

  function endRun(runId, { runnerStatus = 'completed', taskStatus = null, result = null, error = '' } = {}) {
    const state = requireState(runId);
    // trajectory / replay 仅作为 advisory：记录到 state 并通过事件上报供 UI 展示，
    // 但不再改写调用方报的 taskStatus（RFC：harness 不替模型下结论，结论以模型/校验为准）。
    const trajectory = evaluateAgentTrajectory(state, { result: result || state.result || {} });
    applyTrajectoryEvaluationToState(state, trajectory);
    setRunnerStatus(state, runnerStatus);
    if (taskStatus) setTaskStatus(state, taskStatus);
    if (result) state.result = result;
    emit(state, 'agent:trajectory-evaluated', { trajectory: state.runtimeState.trajectory });
    const replayEvaluation = evaluateAgentRunReplay(state, {
      result: state.result || result || {},
      fallbackTaskStatus: state.taskStatus || 'unverified',
    });
    const replay = applyReplayEvaluationToState(state, replayEvaluation);
    emit(state, 'agent:replay-evaluated', { replay, reason: 'end_run_final_audit' });
    emit(state, 'agent:run-ended', {
      runnerStatus: state.runnerStatus,
      taskStatus: state.taskStatus,
      result: state.result || result,
      error,
      trajectory: state.runtimeState.trajectory,
      replay: state.runtimeState.replay,
      appliedReplay: null,
    });
    scheduleRunGc(runId);
    return state;
  }

  function updatePhase(runId, phaseId, { status = 'running', message = '', evidence = [] } = {}) {
    const state = requireState(runId);
    const id = String(phaseId || '').trim();
    if (!id) throw new Error('phaseId is required');
    const phase = state.phases[id] || { id, label: id, required: false, status: 'pending', evidence: [] };
    const now = new Date().toISOString();
    if (status === 'running' && !phase.startedAt) phase.startedAt = now;
    if (['done', 'failed', 'skipped'].includes(status)) phase.endedAt = now;
    if (phase.startedAt && phase.endedAt) phase.durationMs = Math.max(0, Date.parse(phase.endedAt) - Date.parse(phase.startedAt));
    phase.status = status;
    phase.message = String(message || '').slice(0, 500);
    phase.evidence = [...(phase.evidence || []), ...normalizeStringArray(evidence)];
    state.phases[id] = phase;
    state.currentPhase = id;
    touch(state);
    emit(state, status === 'running' ? 'agent:phase-started' : 'agent:phase-ended', { phase });
    return phase;
  }

  function updateArtifact(runId, artifact) {
    const state = requireState(runId);
    const item = {
      id: artifact?.id || `artifact-${Date.now()}-${state.artifacts.length + 1}`,
      type: artifact?.type || 'report',
      title: artifact?.title || '',
      content: artifact?.content || '',
      data: artifact?.data && typeof artifact.data === 'object' ? artifact.data : {},
      updatedAt: new Date().toISOString(),
    };
    const idx = state.artifacts.findIndex((existing) => existing.id === item.id);
    if (idx >= 0) state.artifacts[idx] = item;
    else state.artifacts.push(item);
    touch(state);
    emit(state, 'agent:artifact-updated', { artifact: item });
    return item;
  }

  function publishResult(runId, result = {}) {
    const state = requireState(runId);
    state.result = {
      title: result.title || '',
      status: result.status || state.taskStatus || 'unknown',
      summary: Array.isArray(result.summary) ? result.summary : [],
      report: result.report || result.content || '',
      data: result.data && typeof result.data === 'object' ? result.data : {},
      publishedAt: new Date().toISOString(),
    };
    if (result.taskStatus) setTaskStatus(state, result.taskStatus);
    touch(state);
    emit(state, 'agent:result-published', { result: state.result });
    return state.result;
  }

  function createCheckpoint(runId, checkpoint = {}) {
    const state = requireState(runId);
    const now = new Date().toISOString();
    const item = {
      id: checkpoint.id || createAgentItemId('checkpoint'),
      runId: state.runId,
      reason: String(checkpoint.reason || 'manual'),
      label: String(checkpoint.label || checkpoint.reason || 'checkpoint'),
      turn: Number.isFinite(Number(checkpoint.turn)) ? Number(checkpoint.turn) : null,
      currentPhase: state.currentPhase || '',
      runnerStatus: state.runnerStatus,
      taskStatus: state.taskStatus,
      budget: { ...(state.budget || {}) },
      toolCalls: summarizeToolCalls(state.toolCalls),
      artifacts: summarizeArtifacts(state.artifacts),
      result: state.result ? { ...state.result } : null,
      data: checkpoint.data && typeof checkpoint.data === 'object' ? { ...checkpoint.data } : {},
      createdAt: now,
    };
    state.checkpoints.push(item);
    touch(state);
    emit(state, 'agent:checkpoint-created', { checkpoint: item });
    return item;
  }

  function createInterrupt(runId, interrupt = {}) {
    const state = requireState(runId);
    const now = new Date().toISOString();
    const type = String(interrupt.type || 'manual').trim() || 'manual';
    const item = {
      id: interrupt.id || createAgentItemId('interrupt'),
      runId: state.runId,
      type,
      status: 'pending',
      reason: String(interrupt.reason || interrupt.message || type),
      message: String(interrupt.message || interrupt.reason || ''),
      turn: Number.isFinite(Number(interrupt.turn)) ? Number(interrupt.turn) : null,
      scope: normalizeObject(interrupt.scope),
      payload: normalizeObject(interrupt.payload || interrupt.data),
      createdAt: now,
      resolvedAt: null,
      resolution: null,
    };
    state.interrupts.push(item);
    setTaskStatus(state, interrupt.taskStatus || 'blocked');
    setRunnerStatus(state, interrupt.runnerStatus || (['approval', 'request_approval'].includes(type) ? 'waiting_approval' : 'interrupted'));
    touch(state);
    const transition = recordInterruptRuntimeTransition(state, item, runtimeNodeForInterruptType(type), {
      reason: 'interrupt_created',
      status: state.runnerStatus,
      data: { interruptType: type },
    });
    if (transition) emit(state, 'agent:runtime-transition', { transition });
    emit(state, 'agent:interrupt-created', { interrupt: item });
    if (interrupt.checkpoint !== false) {
      createCheckpoint(runId, {
        reason: `interrupt:${type}`,
        label: `Interrupt: ${type}`,
        turn: item.turn,
        data: {
          interruptId: item.id,
          interruptType: type,
          interruptReason: item.reason,
        },
      });
    }
    return item;
  }

  function resolveInterrupt(runId, interruptId, resolution = {}) {
    const state = requireState(runId);
    const id = String(interruptId || '').trim();
    if (!id) throw new Error('interruptId is required');
    const item = state.interrupts.find((interrupt) => interrupt.id === id);
    if (!item) throw new Error(`Agent interrupt not found: ${id}`);
    let resolutionObservation = null;
    if (item.status === 'pending') {
      item.status = String(resolution.status || 'resolved');
      item.resolvedAt = new Date().toISOString();
      item.resolution = normalizeObject(resolution);
      resolutionObservation = appendInterruptResolutionObservation(state, item, item.resolution, {});
    }
    const hasPending = state.interrupts.some((interrupt) => interrupt.status === 'pending');
    const resolutionOk = resolutionObservation ? resolutionObservation.ok === true : true;
    if (!hasPending && ['waiting_approval', 'interrupted'].includes(state.runnerStatus)) {
      setRunnerStatus(state, resolutionOk ? 'running' : 'interrupted');
    }
    if (!resolutionOk) setTaskStatus(state, 'blocked');
    else if (!hasPending && state.taskStatus === 'blocked') setTaskStatus(state, 'unknown');
    const transition = recordInterruptRuntimeTransition(state, item, resolutionOk ? 'observe' : 'blocked', {
      reason: resolutionOk ? 'interrupt_resolved' : 'interrupt_resolution_blocked',
      status: resolutionOk ? state.runnerStatus : 'blocked',
      observationId: resolutionObservation?.id || '',
      data: {
        resolutionStatus: resolutionObservation?.data?.status || resolution.status || '',
        resolutionOk,
      },
    });
    touch(state);
    if (transition) emit(state, 'agent:runtime-transition', { transition });
    if (resolutionObservation) {
      emit(state, 'agent:interrupt-resolved', { interrupt: item, resolution: item.resolution, observation: resolutionObservation });
      emit(state, 'agent:approval-resolved', { interrupt: item, resolution: item.resolution, observation: resolutionObservation });
      emit(state, 'agent:observation-recorded', { observation: resolutionObservation });
    }
    return item;
  }

  async function dispatchTool(runId, toolName, args = {}, options = {}) {
    const state = requireState(runId);
    const approvalMode = runtimeApprovalMode(state, options);
    const budgetVerdict = canUseTool(state, toolName);
    if (!budgetVerdict.allow) {
      setTaskStatus(state, 'blocked');
      const observation = appendRejectedToolObservation(state, {
        kind: 'tool_budget_result',
        toolName,
        reason: budgetVerdict.reason,
        data: { kind: budgetVerdict.kind },
      });
      emit(state, 'agent:budget-exceeded', { toolName, reason: budgetVerdict.reason, kind: budgetVerdict.kind });
      emit(state, 'agent:observation-recorded', { observation });
      return createBudgetExceededResult(budgetVerdict.reason, budgetVerdict.kind);
    }

    const policyVerdict = evaluateAgentToolPolicy(state, toolName, args, options);
    const pendingToolUseId = String(options.providerToolUseId || options.provider_tool_use_id || options.toolUseId || options.tool_use_id || options.toolCallId || '').trim();
    if (!policyVerdict.allow) {
      let interrupt = null;
      if (policyVerdict.approvalRequired && policyVerdict.interrupt) {
        interrupt = createInterrupt(runId, {
          ...policyVerdict.interrupt,
          runnerStatus: 'waiting_approval',
          taskStatus: 'blocked',
        });
      } else {
        setTaskStatus(state, 'blocked');
      }
      const observation = appendRejectedToolObservation(state, {
        kind: 'tool_policy_result',
        toolName,
        reason: policyVerdict.reason,
        data: {
          kind: policyVerdict.kind,
          approvalRequired: policyVerdict.approvalRequired === true,
          interruptId: interrupt?.id || '',
          toolUseId: pendingToolUseId,
        },
      });
      emit(state, 'agent:tool-policy-denied', {
        toolName,
        reason: policyVerdict.reason,
        kind: policyVerdict.kind,
        approvalRequired: policyVerdict.approvalRequired === true,
        interruptId: interrupt?.id || '',
        toolUseId: pendingToolUseId,
        providerToolUseId: pendingToolUseId,
        toolCallId: pendingToolUseId,
      });
      emit(state, 'agent:observation-recorded', { observation });
      return {
        content: `[agent-runtime] ${policyVerdict.reason}`,
        is_error: true,
        error: policyVerdict.reason,
        kind: policyVerdict.kind,
        data: {
          approvalRequired: policyVerdict.approvalRequired === true,
          interruptId: interrupt?.id || '',
          toolUseId: pendingToolUseId,
        },
      };
    }

    const guardPreflight = runHarnessGuardPreflight({
      harness,
      state,
      toolName,
      args,
      options,
    });
    if (guardPreflight && guardPreflight.allow === false) {
      setTaskStatus(state, 'blocked');
      const observation = appendRejectedToolObservation(state, {
        kind: 'tool_guard_result',
        toolName,
        reason: guardPreflight.reason,
        data: {
          kind: guardPreflight.kind || 'harness_guard_blocked',
          guardBlocked: true,
          risk: normalizeObject(guardPreflight.risk),
          toolUseId: pendingToolUseId,
        },
      });
      emit(state, 'agent:tool-policy-denied', {
        toolName,
        reason: guardPreflight.reason,
        kind: guardPreflight.kind || 'harness_guard_blocked',
        approvalRequired: false,
        guardBlocked: true,
        providerToolUseId: pendingToolUseId,
        toolCallId: pendingToolUseId,
      });
      emit(state, 'agent:observation-recorded', { observation });
      return {
        content: `[agent-runtime] ${guardPreflight.reason}`,
        is_error: true,
        error: guardPreflight.reason,
        kind: guardPreflight.kind || 'harness_guard_blocked',
        data: {
          guardBlocked: true,
          risk: normalizeObject(guardPreflight.risk),
          toolUseId: pendingToolUseId,
        },
      };
    }

    const approvalVerdict = mergeToolApprovalVerdict(policyVerdict, guardPreflight, toolName, args, { approvalMode });
    let approvalGranted = false;
    if (approvalVerdict.approvalRequired === true) {
      if (isRuntimeApprovalPreApproved(state, options, approvalMode)) {
        approvalGranted = true;
      } else {
        emit(state, 'agent:approval-required', {
          toolName,
          reason: approvalVerdict.reason,
          summary: approvalVerdict.message || '',
          scope: options.scope || {},
        });
        const approved = await requestRuntimeApproval({
          options,
          toolName,
          args,
          context: buildPreToolApprovalContext(state, args, options),
          policyVerdict: approvalVerdict,
        });
        if (!approved) {
          setTaskStatus(state, 'blocked');
          const observation = appendRejectedToolObservation(state, {
            kind: 'tool_approval_result',
            toolName,
            reason: `Approval denied for ${toolName}: ${approvalVerdict.reason}`,
            data: { approvalDenied: true, policy: approvalVerdict.approvalPolicy || '', approvalMode },
          });
          emit(state, 'agent:observation-recorded', { observation });
          return {
            content: `[agent-runtime] Approval denied for ${toolName}: ${approvalVerdict.reason}`,
            is_error: true,
            error: approvalVerdict.reason,
            data: { approvalDenied: true, approvalMode },
          };
        }
        approvalGranted = true;
      }
    }

    recordToolUsage(state, toolName);
    const toolCall = createToolCallEnvelope({
      state,
      toolName,
      args,
      riskLevel: options.riskLevel || options.risk_level,
      capability: options.capability,
      scope: options.scope,
    });
    if (options.toolCallId || options.toolUseId || options.tool_use_id) {
      toolCall.id = String(options.toolCallId || options.toolUseId || options.tool_use_id);
    }
    toolCall.providerToolUseId = String(options.providerToolUseId || options.provider_tool_use_id || options.toolUseId || options.tool_use_id || toolCall.id || '');
    toolCall.status = 'running';
    toolCall.startedAt = new Date().toISOString();
    state.toolCalls.push(toolCall);
    emit(state, 'agent:tool-call-started', { toolCall });
    try { options.onToolCallStarted?.(toolCall); } catch { /* lifecycle hooks must not block execution */ }

    try {
      const dispatchOptions = approvalGranted ? { ...options, approvalGranted: true } : options;
      const context = buildHarnessContext({ harness, state, toolCall, overrides: dispatchOptions });
      const result = typeof options.executeTool === 'function'
        ? await options.executeTool({ toolName, args, context, toolCall, state })
        : (harness?.dispatch
          ? await harness.dispatch(toolName, args, context)
          : { content: '[agent-runtime] harness is not configured', is_error: true });
      const normalized = normalizeToolResult(result);
      const verifierPlanBefore = verifierPlanSignature(state);
      const observation = finishToolCall(state, toolCall, normalized);
      emit(state, 'agent:tool-call-ended', { toolCall });
      if (observation) emit(state, 'agent:observation-recorded', { observation });
      emitVerifierPlanChanged(state, verifierPlanBefore, {
        reason: 'tool_call_completed',
        observationId: observation?.id || '',
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
      });
      return result;
    } catch (err) {
      const normalized = normalizeToolResult({ content: `[ERROR] ${err.message}`, is_error: true, error: err.message });
      const verifierPlanBefore = verifierPlanSignature(state);
      const observation = finishToolCall(state, toolCall, normalized);
      emit(state, 'agent:tool-call-ended', { toolCall });
      if (observation) emit(state, 'agent:observation-recorded', { observation });
      emitVerifierPlanChanged(state, verifierPlanBefore, {
        reason: 'tool_call_failed',
        observationId: observation?.id || '',
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
      });
      logger?.warn?.(`[agent-runtime] tool dispatch failed: ${err.message}`);
      return { content: `[ERROR] ${err.message}`, is_error: true };
    }
  }

  function requireState(runId) {
    const state = getState(runId);
    if (!state) throw new Error(`Agent run not found: ${runId}`);
    return state;
  }

  function emitVerifierPlanChanged(state, beforeSignature = '', metadata = {}) {
    const afterSignature = verifierPlanSignature(state);
    if (beforeSignature && beforeSignature === afterSignature) return null;
    const verifierPlan = state?.runtimeState?.verifier || null;
    if (!verifierPlan) return null;
    return emit(state, 'agent:verifier-plan-updated', {
      verifierPlan,
      reason: String(metadata.reason || 'verifier_plan_updated'),
      observationId: String(metadata.observationId || ''),
      verificationId: String(metadata.verificationId || ''),
      toolCallId: String(metadata.toolCallId || ''),
      toolName: String(metadata.toolName || ''),
      status: String(metadata.status || verifierPlan.status || ''),
    });
  }

  return {
    cancelRun,
    createCheckpoint,
    createInterrupt,
    dispatchTool,
    emitter,
    endRun,
    getCheckpoint,
    getInterrupt,
    getState,
    listCheckpoints,
    listInterrupts,
    listRuns,
    off: emitter.off.bind(emitter),
    on: emitter.on.bind(emitter),
    publishResult,
    recordObservation,
    recordToolCallEnded,
    recordToolCallStarted,
    recordTraceEvent,
    recordTurn,
    recordRuntimeTransition,
    recordVerification,
    resolveInterrupt,
    resumeRun,
    startRun,
    updateTaskStatus,
    updateArtifact,
    updatePhase,
    verifierRegistry: runtimeVerifierRegistry,
  };
}

function normalizeTaskStatus(status = '') {
  const value = String(status || '').trim().toLowerCase();
  if (['verified', 'passed', 'validated'].includes(value)) return 'verified';
  if (['success', 'succeeded', 'done', 'completed', 'complete'].includes(value)) return 'success';
  if (['failed', 'failure', 'error'].includes(value)) return 'failed';
  if (['partial', 'warning', 'warn'].includes(value)) return 'partial';
  if (['blocked', 'waiting_approval', 'interrupted'].includes(value)) return 'blocked';
  if (['unverified', 'unknown'].includes(value)) return value;
  return '';
}

function finishToolCall(state, toolCall, result) {
  const endedAt = new Date().toISOString();
  toolCall.status = result.ok ? 'completed' : 'failed';
  toolCall.endedAt = endedAt;
  toolCall.durationMs = toolCall.startedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(toolCall.startedAt)) : null;
  toolCall.result = result;
  const observationData = buildToolObservationData(toolCall, result);
  const observation = appendObservation(state, {
    kind: 'tool_result',
    stage: 'observe',
    toolCallId: toolCall.id,
    providerToolUseId: toolCall.providerToolUseId || '',
    toolName: toolCall.toolName,
    turn: state.currentTurn,
    ok: result.ok,
    isError: result.ok !== true,
    exitCode: result.exitCode,
    durationMs: result.durationMs ?? toolCall.durationMs,
    content: result.content,
    stdoutExcerpt: result.stdoutExcerpt,
    stderrExcerpt: result.stderrExcerpt,
    evidence: result.evidence,
    data: observationData,
    error: result.error,
    auditId: result.auditId,
  });
  touch(state);
  return observation;
}

function buildToolObservationData(toolCall = {}, result = {}) {
  const data = normalizeObject(result.data);
  const toolInput = redactPotentialSecretsForRuntime(toolCall.args || {});
  const scope = normalizeObject(toolCall.scope);
  data.toolCall = {
    id: String(toolCall.id || ''),
    providerToolUseId: String(toolCall.providerToolUseId || ''),
    toolName: String(toolCall.toolName || ''),
    riskLevel: String(toolCall.riskLevel || ''),
    capability: String(toolCall.capability || ''),
    scope,
    startedAt: toolCall.startedAt || '',
    endedAt: toolCall.endedAt || '',
    durationMs: toolCall.durationMs ?? null,
  };
  data.toolInput = toolInput;
  data.scope = { ...normalizeObject(data.scope), ...scope };
  data.result = {
    ok: result.ok === true,
    exitCode: result.exitCode,
    durationMs: result.durationMs ?? toolCall.durationMs ?? null,
    auditId: result.auditId || '',
    truncated: result.truncated === true,
  };
  const verifier = normalizeVerifierHint(
    data.verifier
    || data.verificationHint
    || data.verification_hint
    || inferVerifierHintForToolCall(toolCall, result, data)
  );
  if (verifier) {
    data.verifier = verifier;
    data.verificationHint = verifier;
  }
  return data;
}

function inferVerifierHintForToolCall(toolCall = {}, result = {}, data = {}) {
  if (result?.ok !== true) return null;
  const toolName = String(toolCall.toolName || '').trim();
  const args = toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args) ? toolCall.args : {};
  const hostId = String(toolCall.scope?.hostId || data.scope?.hostId || args.hostId || args.host_id || 'local').trim() || 'local';
  return null;
}

function normalizeVerifierHint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = String(value.type || '').trim();
  if (!type) return null;
  return { ...value, type };
}

function firstWritableFilePath(files) {
  if (!Array.isArray(files)) return '';
  for (const file of files) {
    const pathValue = stringOr(file?.path || file?.file || file?.targetPath || file?.target_path, '');
    if (pathValue) return pathValue.replace(/^\/+/, '');
  }
  return '';
}

function runHarnessGuardPreflight({ harness, state, toolName = '', args = {}, options = {} } = {}) {
  if (!harness?.guard?.check) return null;
  try {
    const previewToolCall = createToolCallEnvelope({
      state,
      toolName,
      args,
      riskLevel: options.riskLevel || options.risk_level,
      capability: options.capability,
      scope: options.scope,
    });
    const context = buildHarnessContext({
      harness,
      state,
      toolCall: previewToolCall,
      overrides: {
        ...options,
        allowApproval: false,
        requestApproval: undefined,
      },
    });
    return normalizeHarnessGuardVerdict(harness.guard.check(toolName, args || {}, context));
  } catch (err) {
    return {
      allow: false,
      kind: 'harness_guard_error',
      reason: `安全检查异常，已停止执行：${err.message}`,
    };
  }
}

function normalizeHarnessGuardVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    return {
      allow: false,
      kind: 'harness_guard_error',
      reason: '安全检查没有返回有效结果，已停止执行。',
    };
  }
  return {
    ...verdict,
    allow: verdict.allow !== false,
    kind: verdict.kind || (verdict.allow === false ? 'harness_guard_blocked' : 'harness_guard_checked'),
    reason: humanizeHarnessGuardReason(verdict.reason || verdict.riskReason || ''),
  };
}

function normalizeRuntimeApprovalMode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['delegated', 'approve_for_me', 'auto_review', 'auto'].includes(text)) return 'delegated';
  if (['full_access', 'full', 'danger_full_access', 'unrestricted'].includes(text)) return 'full_access';
  return 'manual';
}

function runtimeApprovalMode(state = {}, options = {}) {
  return normalizeRuntimeApprovalMode(
    options.approvalMode
      || options.approval_mode
      || state?.spec?.policy?.approvalMode
      || state?.spec?.policy?.approval_mode,
  );
}

function isRuntimeApprovalPreApproved(state = {}, options = {}, approvalMode = '') {
  if (options.approvalGranted === true || options.preApproved === true) return true;
  return normalizeRuntimeApprovalMode(approvalMode || runtimeApprovalMode(state, options)) === 'full_access';
}

function mergeToolApprovalVerdict(policyVerdict = {}, guardVerdict = null, toolName = '', args = {}, options = {}) {
  const approvalMode = normalizeRuntimeApprovalMode(options.approvalMode || options.approval_mode);
  const guardNeedsApproval = guardVerdict
    && guardVerdict.allow !== false
    && (guardVerdict.needApproval === true || guardVerdict.approvalRequired === true);
  const guardRequiresApproval = guardVerdict
    && guardVerdict.allow !== false
    && guardVerdict.approvalRequired === true;
  if (policyVerdict.approvalRequired !== true && !guardNeedsApproval) return policyVerdict;

  if (!guardNeedsApproval) {
    return {
      ...policyVerdict,
      title: policyVerdict.title || approvalTitleForTool(toolName),
    };
  }

  const reason = humanizeGuardApprovalReason(toolName, guardVerdict, args);
  return {
    ...policyVerdict,
    approvalRequired: true,
    approvalPolicy: guardVerdict.approvalRequired ? 'harness_guard_required' : 'harness_guard_recommended',
    title: approvalTitleForTool(toolName),
    reason,
    message: summarizeApprovalArgs(toolName, args),
    guardVerdict,
  };
}

function humanizeGuardApprovalReason(toolName = '', guardVerdict = {}, args = {}) {
  const detail = humanizeHarnessGuardReason(guardVerdict.riskReason || guardVerdict.reason || '');
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const effects = describeCommandSideEffects(args?.command || '');
    const action = effects.length > 0 ? `这条命令会${effects.join('、')}，需要你确认。` : '这条命令可能会修改目标主机状态，需要你确认。';
    return detail ? `${action}检测到：${detail}` : action;
  }
  return detail
    ? `这一步会修改外部状态，需要你确认。检测到：${detail}`
    : '这一步会修改外部状态，需要你确认。';
}

function humanizeHarnessGuardReason(reason = '') {
  const text = String(reason || '').trim();
  if (!text) return '';
  return text
    .replace(/^Side-effect tool\s+([^\s]+)\s+requires approval by policy$/i, '该工具会产生副作用，需要审批')
    .replace(/^Tool\s+([^\s]+)\s+requires approval by policy$/i, '该工具需要审批')
    .replace(/^Tool\s+([^\s]+)\s+requested approval$/i, '该工具请求审批');
}

function approvalTitleForTool(toolName = '') {
  if (toolName === 'execute_command' || toolName === 'host_exec') return '执行命令需要确认';
  return '操作需要确认';
}

function summarizeApprovalArgs(toolName = '', args = {}) {
  if (toolName === 'execute_command' || toolName === 'host_exec') {
    const safeCommand = redactCredentialPatterns(String(args.command || ''));
    return [
      `主机：${String(args.hostId || args.host_id || 'local')}`,
      '命令：',
      safeCommand.slice(0, 1200),
    ].filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(redactApprovalArgs(args)).slice(0, 1200);
  } catch {
    return '';
  }
}

function redactApprovalArgs(value) {
  try {
    return JSON.parse(JSON.stringify(redactPotentialSecrets(value || {}), (key, item) => {
      if (/token|key|secret|password|auth|credential|sensitive|redact/i.test(key)) return '<redacted>';
      return item;
    }));
  } catch {
    return {};
  }
}

async function requestRuntimeApproval({ options = {}, toolName = '', args = {}, context = {}, policyVerdict = {} } = {}) {
  if (options.allowApproval !== true || typeof options.requestApproval !== 'function') return false;
  return await options.requestApproval(
    toolName,
    args,
    {
      title: policyVerdict.title || approvalTitleForTool(toolName),
      detail: policyVerdict.message || policyVerdict.reason || '',
    },
    policyVerdict.reason || '',
    context,
  ) === true;
}

function buildPreToolApprovalContext(state = {}, args = {}, options = {}) {
  const spec = state?.spec || {};
  const scope = normalizeObject(options.scope);
  const runContext = normalizeObject(spec.context);
  return {
    source: state?.source || spec.source || 'agent',
    runId: state?.runId || '',
    hostId: scope.hostId || args?.hostId || args?.host_id || runContext.hostId || runContext.host_id || 'local',
    hostScope: spec.policy?.hostScope,
    capabilities: options.capabilities !== undefined ? options.capabilities : spec.policy?.capabilities,
    approvalMode: options.approvalMode || options.approval_mode || spec.policy?.approvalMode || spec.policy?.approval_mode || '',
    allowApproval: options.allowApproval === true,
    secrets: Array.isArray(options.secrets) ? options.secrets : [],
  };
}

function appendRejectedToolObservation(state, { kind = 'tool_policy_result', toolName = '', reason = '', data = {} } = {}) {
  return appendObservation(state, {
    kind,
    stage: 'observe',
    toolName,
    ok: false,
    isError: true,
    content: `[agent-runtime] ${reason}`,
    error: reason,
    data,
  });
}

function appendInterruptResolutionObservation(state, interrupt = {}, resolution = {}, data = {}) {
  const status = String(resolution.status || interrupt.status || 'resolved').trim() || 'resolved';
  const ok = isPositiveInterruptResolution(status);
  const relatedFailureIds = ok ? findFailureObservationIdsForInterrupt(state, interrupt) : [];
  const observation = appendObservation(state, {
    id: createAgentItemId('interrupt-observation'),
    kind: 'interrupt_resolution',
    stage: 'observe',
    toolName: 'agent_interrupt',
    turn: interrupt.turn ?? state.currentTurn ?? null,
    ok,
    isError: !ok,
    content: formatInterruptResolutionContent(interrupt, resolution, ok),
    data: {
      interruptId: interrupt.id || '',
      interruptType: interrupt.type || '',
      status,
      recoversFailureIds: relatedFailureIds,
      resolution: redactPotentialSecretsForRuntime(resolution),
      resumeData: redactPotentialSecretsForRuntime(data),
    },
    error: ok ? '' : String(resolution.reason || interrupt.reason || status),
  });
  const memory = ensureRuntimeMemory(state);
  memory.interrupts.push({
    id: interrupt.id || '',
    type: interrupt.type || '',
    status,
    ok,
    observationId: observation.id,
    resolvedAt: interrupt.resolvedAt || observation.observedAt,
  });
  memory.interrupts = memory.interrupts.slice(-50);
  return observation;
}

function formatInterruptResolutionContent(interrupt = {}, resolution = {}, ok = true) {
  const lines = [
    'Interrupt resolution',
    `type=${String(interrupt.type || 'manual')}`,
    `status=${String(resolution.status || interrupt.status || 'resolved')}`,
    `ok=${ok === true}`,
  ];
  if (interrupt.reason) lines.push(`reason=${String(interrupt.reason).slice(0, 500)}`);
  if (resolution.reason) lines.push(`resolution_reason=${String(resolution.reason).slice(0, 500)}`);
  if (resolution.note) lines.push(`note=${String(resolution.note).slice(0, 500)}`);
  if (resolution.answers && typeof resolution.answers === 'object') {
    lines.push(`answers=${JSON.stringify(redactPotentialSecretsForRuntime(resolution.answers)).slice(0, 1000)}`);
  }
  if (Array.isArray(resolution.secretRefs) && resolution.secretRefs.length > 0) {
    lines.push(`secret_refs=${resolution.secretRefs.map((item) => String(item?.name || item?.ref || '').trim()).filter(Boolean).join(',')}`);
  }
  return lines.join('\n');
}

function findFailureObservationIdsForInterrupt(state = {}, interrupt = {}) {
  const interruptId = String(interrupt.id || '').trim();
  if (!interruptId) return [];
  const observations = Array.isArray(state.observations) ? state.observations : [];
  const worldFailures = Array.isArray(state.runtimeState?.worldState?.failures) ? state.runtimeState.worldState.failures : [];
  const failedObservationIds = observations
    .filter((item) => item?.isError === true || item?.ok === false)
    .filter((item) => String(item?.data?.interruptId || '').trim() === interruptId)
    .map((item) => item.id)
    .filter(Boolean);
  const worldFailureIds = worldFailures
    .filter((item) => item?.status !== 'recovered')
    .filter((item) => failedObservationIds.includes(item.id))
    .map((item) => item.id)
    .filter(Boolean);
  return Array.from(new Set([...failedObservationIds, ...worldFailureIds]));
}

function isPositiveInterruptResolution(status = '') {
  const text = String(status || '').trim().toLowerCase();
  return !['rejected', 'denied', 'cancelled', 'canceled', 'expired', 'failed', 'blocked'].includes(text);
}

function redactPotentialSecretsForRuntime(value) {
  try {
    return JSON.parse(JSON.stringify(redactPotentialSecrets(value || {}), (key, item) => {
      if (/token|key|secret|password|auth|credential|value|content|body|text|sensitive|redact/i.test(key)) return '<redacted>';
      if (typeof item === 'string' && item.length > 1000) return `${item.slice(0, 1000)}\n...[truncated ${item.length - 1000} chars]`;
      return item;
    }));
  } catch {
    return {};
  }
}

function verifierPlanSignature(state = {}) {
  const plan = state?.runtimeState?.verifier;
  if (!plan || typeof plan !== 'object') return '';
  return JSON.stringify({
    required: plan.required === true,
    status: String(plan.status || ''),
    ok: plan.ok === true,
    requirements: Array.isArray(plan.requirements)
      ? plan.requirements.map((item) => String(item?.id || item?.source || item?.type || '')).filter(Boolean)
      : [],
    missingRequirements: Array.isArray(plan.missingRequirements)
      ? plan.missingRequirements.map((item) => String(item?.id || item?.source || item?.type || '')).filter(Boolean)
      : [],
    failedRequirements: Array.isArray(plan.failedRequirements)
      ? plan.failedRequirements.map((item) => String(item?.id || item?.source || item?.type || '')).filter(Boolean)
      : [],
    verification: plan.verification ? {
      ok: plan.verification.ok === true,
      status: String(plan.verification.status || ''),
    } : null,
    reasons: Array.isArray(plan.reasons) ? plan.reasons.map((item) => String(item || '')).filter(Boolean) : [],
  });
}

function upsertTurn(state, turn = {}) {
  if (!Array.isArray(state.turns)) state.turns = [];
  const number = toPositiveInteger(turn.turn ?? turn.number, (state.turns.length || 0) + 1);
  const index = toNonNegativeInteger(turn.index, number - 1);
  const existing = state.turns.find((item) => item.turn === number || item.index === index);
  const now = new Date().toISOString();
  const item = existing || {
    id: `turn-${number}`,
    index,
    turn: number,
    status: 'running',
    stage: 'observe',
    startedAt: now,
    endedAt: null,
    durationMs: null,
    decision: null,
    actions: [],
    observations: [],
    metadata: {},
  };

  if (turn.status) item.status = String(turn.status);
  if (turn.stage) item.stage = String(turn.stage);
  if (turn.decision !== undefined) {
    item.decision = normalizeDecision(turn.decision);
    const memory = ensureRuntimeMemory(state);
    memory.decisions.push({
      turn: number,
      status: item.decision.status || '',
      final: item.decision.final === true,
      text: item.decision.text || '',
      recordedAt: now,
    });
    memory.decisions = memory.decisions.slice(-50);
    if (item.decision.commandType) {
      memory.commands.push({
        turn: number,
        type: item.decision.commandType,
        status: item.decision.status || '',
        final: item.decision.final === true,
        text: item.decision.text || '',
        recordedAt: now,
      });
      memory.commands = memory.commands.slice(-50);
    }
  }
  if (Array.isArray(turn.actions)) item.actions = turn.actions.map(normalizePlainObject).filter(Boolean);
  if (Array.isArray(turn.observations)) {
    item.observations = mergeById(item.observations, turn.observations.map(normalizePlainObject).filter(Boolean));
  }
  if (turn.metadata && typeof turn.metadata === 'object' && !Array.isArray(turn.metadata)) {
    item.metadata = { ...(item.metadata || {}), ...turn.metadata };
  }
  if (['completed', 'failed', 'interrupted', 'cancelled'].includes(item.status)) {
    item.endedAt = item.endedAt || now;
    item.durationMs = item.startedAt ? Math.max(0, Date.parse(item.endedAt) - Date.parse(item.startedAt)) : null;
  }
  if (!existing) state.turns.push(item);
  state.currentTurn = number;
  touch(state);
  return item;
}

function appendObservation(state, observation = {}) {
  if (!Array.isArray(state.observations)) state.observations = [];
  const now = new Date().toISOString();
  const item = {
    id: observation.id || createAgentItemId('observation'),
    runId: state.runId || '',
    turn: Number.isFinite(Number(observation.turn)) ? Number(observation.turn) : (state.currentTurn ?? null),
    stage: String(observation.stage || 'observe'),
    kind: String(observation.kind || observation.type || 'observation'),
    toolCallId: String(observation.toolCallId || observation.tool_call_id || ''),
    providerToolUseId: String(observation.providerToolUseId || observation.provider_tool_use_id || ''),
    toolName: String(observation.toolName || observation.tool_name || ''),
    ok: observation.ok === true,
    isError: observation.isError === true || observation.is_error === true || observation.ok === false,
    exitCode: Number.isFinite(Number(observation.exitCode)) ? Number(observation.exitCode) : undefined,
    durationMs: Number.isFinite(Number(observation.durationMs)) ? Number(observation.durationMs) : undefined,
    content: compactText(observation.content || '', 4000),
    stdoutExcerpt: compactText(observation.stdoutExcerpt || observation.stdout || '', 4000),
    stderrExcerpt: compactText(observation.stderrExcerpt || observation.stderr || '', 2000),
    evidence: normalizeStringArray(observation.evidence).slice(0, 20),
    data: normalizeObject(observation.data),
    error: compactText(observation.error || '', 1000),
    auditId: String(observation.auditId || observation.audit_id || ''),
    observedAt: observation.observedAt || now,
  };
  state.observations.push(item);
  state.observations = state.observations.slice(-200);
  const memory = ensureRuntimeMemory(state);
  memory.observations.push({
    id: item.id,
    turn: item.turn,
    kind: item.kind,
    toolName: item.toolName,
    ok: item.ok,
    exitCode: item.exitCode,
    content: compactText(item.content || item.stdoutExcerpt || item.stderrExcerpt || item.error || '', 1000),
    observedAt: item.observedAt,
  });
  memory.observations = memory.observations.slice(-80);
  if (item.isError || item.ok === false) {
    memory.failures.push({
      id: item.id,
      turn: item.turn,
      toolName: item.toolName,
      error: item.error || item.stderrExcerpt || item.content,
      observedAt: item.observedAt,
    });
    memory.failures = memory.failures.slice(-50);
  }
  try {
    applyObservationToRuntimeState(state, item);
    applyVerifierPlanToRuntimeState(state);
  } catch { /* observation interpretation must not block runtime */ }
  attachObservationToCurrentTurn(state, item);
  touch(state);
  return item;
}

function appendRuntimeTransition(state, transition = {}) {
  const runtimeState = ensureRuntimeState(state);
  const now = new Date().toISOString();
  const validation = validateAgentTransition({
    from: transition.from || runtimeState.currentNode || '',
    to: transition.to || transition.node || runtimeState.currentNode || 'understand',
  });
  const item = {
    id: transition.id || createAgentItemId('transition'),
    runId: state.runId || '',
    turn: Number.isFinite(Number(transition.turn)) ? Number(transition.turn) : (state.currentTurn ?? null),
    from: validation.from,
    to: validation.to,
    valid: validation.ok,
    status: String(transition.status || runtimeState.status || state.runnerStatus || 'running'),
    reason: compactText(transition.reason || validation.reason || '', 1000),
    command: normalizePlainObject(transition.command),
    data: {
      ...normalizeObject(transition.data),
      ...(validation.ok ? {} : { invalidTransition: validation.reason, allowed: validation.allowed || [] }),
    },
    at: transition.at || now,
  };
  runtimeState.previousNode = validation.from;
  runtimeState.currentNode = validation.to;
  runtimeState.status = item.status;
  runtimeState.transitionCount = Number(runtimeState.transitionCount || 0) + 1;
  if (item.command) runtimeState.lastCommand = item.command;
  if (!Array.isArray(runtimeState.transitions)) runtimeState.transitions = [];
  runtimeState.transitions.push(item);
  runtimeState.transitions = runtimeState.transitions.slice(-100);
  touch(state);
  return item;
}

function recordInterruptRuntimeTransition(state, interrupt = null, targetNode = 'interrupted', options = {}) {
  if (!state || typeof state !== 'object') return null;
  const runtimeState = ensureRuntimeState(state);
  const currentNode = runtimeState.currentNode || 'understand';
  const wanted = String(targetNode || 'interrupted').trim() || 'interrupted';
  let target = wanted;
  let validation = validateAgentTransition({ from: currentNode, to: target });
  if (!validation.ok && wanted !== 'interrupted') {
    const interruptedValidation = validateAgentTransition({ from: currentNode, to: 'interrupted' });
    if (interruptedValidation.ok) {
      target = 'interrupted';
      validation = interruptedValidation;
    }
  }
  if (!validation.ok && wanted !== 'blocked') {
    const blockedValidation = validateAgentTransition({ from: currentNode, to: 'blocked' });
    if (blockedValidation.ok) {
      target = 'blocked';
      validation = blockedValidation;
    }
  }
  if (!validation.ok) return null;
  return appendRuntimeTransition(state, {
    from: currentNode,
    to: target,
    status: options.status || state.runnerStatus || 'interrupted',
    reason: options.reason || 'interrupt_transition',
    data: {
      interruptId: interrupt?.id || '',
      interruptType: interrupt?.type || '',
      observationId: options.observationId || '',
      ...normalizeObject(options.data),
    },
  });
}

function runtimeNodeForInterruptType(type = '') {
  const value = String(type || '').trim();
  if (value === 'ask_user' || value === 'question') return 'ask_user';
  if (value === 'request_secret' || value === 'secret') return 'request_secret';
  if (value === 'request_approval' || value === 'approval') return 'request_approval';
  return 'interrupted';
}

function attachObservationToCurrentTurn(state, observation) {
  if (!observation || observation.turn == null || !Array.isArray(state.turns)) return;
  const turn = state.turns.find((item) => item.turn === observation.turn);
  if (!turn) return;
  turn.observations = mergeById(turn.observations || [], [summarizeObservation(observation)]);
}

function normalizeVerificationRecord(state, verification = {}) {
  const data = verification && typeof verification === 'object' && !Array.isArray(verification) ? verification : {};
  const status = String(data.status || (data.ok === true ? 'passed' : 'failed')).trim() || 'failed';
  return {
    id: data.id || createAgentItemId('verification'),
    runId: state?.runId || data.runId || '',
    turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : (state?.currentTurn ?? null),
    ok: data.ok === true || status === 'passed',
    status,
    taskStatus: String(data.taskStatus || data.task_status || ''),
    type: String(data.type || 'outcome'),
    target: String(data.target || ''),
    reasons: normalizeStringArray(data.reasons),
    checks: Array.isArray(data.checks) ? data.checks.map(normalizePlainObject).filter(Boolean) : [],
    evidence: compactText(data.evidence || data.content || '', 4000),
    data: normalizeObject(data.data),
    checkedAt: data.checkedAt || data.checked_at || new Date().toISOString(),
  };
}

function ensureRuntimeMemory(state) {
  if (!state.memory || typeof state.memory !== 'object' || Array.isArray(state.memory)) {
    state.memory = {};
  }
  if (!Array.isArray(state.memory.facts)) state.memory.facts = [];
  if (!Array.isArray(state.memory.plans)) state.memory.plans = [];
  if (!Array.isArray(state.memory.decisions)) state.memory.decisions = [];
  if (!Array.isArray(state.memory.commands)) state.memory.commands = [];
  if (!Array.isArray(state.memory.decisionReviews)) state.memory.decisionReviews = [];
  if (!Array.isArray(state.memory.interrupts)) state.memory.interrupts = [];
  if (!Array.isArray(state.memory.replayEvaluations)) state.memory.replayEvaluations = [];
  if (!Array.isArray(state.memory.trajectoryEvaluations)) state.memory.trajectoryEvaluations = [];
  if (!Array.isArray(state.memory.cognition)) state.memory.cognition = [];
  if (!Array.isArray(state.memory.observations)) state.memory.observations = [];
  if (!Array.isArray(state.memory.failures)) state.memory.failures = [];
  if (!Array.isArray(state.memory.recoveries)) state.memory.recoveries = [];
  if (state.memory.verification === undefined) state.memory.verification = null;
  return state.memory;
}

function ensureRuntimeState(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) {
    state.runtimeState = {};
  }
  const runtimeState = state.runtimeState;
  runtimeState.owner = runtimeState.owner || 'AgentRun';
  runtimeState.controller = runtimeState.controller || 'AgentRunController';
  runtimeState.currentNode = runtimeState.currentNode || 'understand';
  runtimeState.previousNode = runtimeState.previousNode || '';
  runtimeState.status = runtimeState.status || state.runnerStatus || 'queued';
  runtimeState.transitionCount = Number(runtimeState.transitionCount || 0);
  if (!Array.isArray(runtimeState.transitions)) runtimeState.transitions = [];
  if (!runtimeState.decisionReview || typeof runtimeState.decisionReview !== 'object' || Array.isArray(runtimeState.decisionReview)) {
    runtimeState.decisionReview = createRuntimeDecisionReviewState();
  }
  if (!Array.isArray(runtimeState.decisionReviewHistory)) runtimeState.decisionReviewHistory = [];
  if (!runtimeState.replay || typeof runtimeState.replay !== 'object' || Array.isArray(runtimeState.replay)) {
    runtimeState.replay = createReplayEvaluationState();
  }
  if (!Array.isArray(runtimeState.replayHistory)) runtimeState.replayHistory = [];
  if (!runtimeState.trajectory || typeof runtimeState.trajectory !== 'object' || Array.isArray(runtimeState.trajectory)) {
    runtimeState.trajectory = createTrajectoryEvaluationState();
  }
  if (!Array.isArray(runtimeState.trajectoryHistory)) runtimeState.trajectoryHistory = [];
  if (!runtimeState.plan || typeof runtimeState.plan !== 'object' || Array.isArray(runtimeState.plan)) {
    runtimeState.plan = createRuntimePlanState();
  }
  if (!Array.isArray(runtimeState.planHistory)) runtimeState.planHistory = [];
  if (!runtimeState.recovery || typeof runtimeState.recovery !== 'object' || Array.isArray(runtimeState.recovery)) {
    runtimeState.recovery = createRuntimeRecoveryState();
  }
  if (!Array.isArray(runtimeState.recoveryHistory)) runtimeState.recoveryHistory = [];
  if (!runtimeState.cognition || typeof runtimeState.cognition !== 'object' || Array.isArray(runtimeState.cognition)) {
    runtimeState.cognition = createAgentCognitionState();
  }
  if (!Array.isArray(runtimeState.cognitionHistory)) runtimeState.cognitionHistory = [];
  if (!runtimeState.verifier || typeof runtimeState.verifier !== 'object' || Array.isArray(runtimeState.verifier)) {
    runtimeState.verifier = {
      schemaVersion: 1,
      required: false,
      status: 'not_required',
      ok: true,
      requirements: [],
      missingRequirements: [],
      failedRequirements: [],
      verification: null,
      reasons: [],
      evaluatedAt: '',
    };
  }
  ensureRuntimeWorldState(state);
  return runtimeState;
}

function ensureRuntimeWorldState(state) {
  const runtimeState = ensureRuntimeStateShallow(state);
  const current = runtimeState.worldState && typeof runtimeState.worldState === 'object' && !Array.isArray(runtimeState.worldState)
    ? runtimeState.worldState
    : {};
  runtimeState.worldState = {
    facts: Array.isArray(current.facts) ? current.facts : [],
    openQuestions: Array.isArray(current.openQuestions) ? current.openQuestions : [],
    failures: Array.isArray(current.failures) ? current.failures : [],
    sideEffects: Array.isArray(current.sideEffects) ? current.sideEffects : [],
    verification: current.verification || null,
    verificationPlan: current.verificationPlan || null,
  };
  return runtimeState.worldState;
}

function ensureRuntimeStateShallow(state) {
  if (!state.runtimeState || typeof state.runtimeState !== 'object' || Array.isArray(state.runtimeState)) state.runtimeState = {};
  return state.runtimeState;
}

function summarizeTurn(turn = {}) {
  return {
    id: turn.id || '',
    index: turn.index ?? null,
    turn: turn.turn ?? null,
    status: turn.status || '',
    stage: turn.stage || '',
    startedAt: turn.startedAt || '',
    endedAt: turn.endedAt || '',
    decision: turn.decision || null,
    actionCount: Array.isArray(turn.actions) ? turn.actions.length : 0,
    observationCount: Array.isArray(turn.observations) ? turn.observations.length : 0,
  };
}

function summarizeObservation(observation = {}) {
  return {
    id: observation.id || '',
    kind: observation.kind || '',
    toolCallId: observation.toolCallId || '',
    toolName: observation.toolName || '',
    ok: observation.ok === true,
    exitCode: observation.exitCode,
    content: compactText(observation.content || observation.stdoutExcerpt || observation.stderrExcerpt || observation.error || '', 1000),
    observedAt: observation.observedAt || '',
  };
}

function normalizeDecision(decision = {}) {
  const data = decision && typeof decision === 'object' && !Array.isArray(decision) ? decision : { text: String(decision || '') };
  return {
    title: String(data.title || ''),
    status: String(data.status || ''),
    text: compactText(data.text || data.report || data.content || '', 2000),
    final: data.final === true,
    finishReason: String(data.finishReason || data.finish_reason || ''),
    commandType: String(data.commandType || data.command_type || ''),
  };
}

function mergeById(existing = [], incoming = []) {
  const out = Array.isArray(existing) ? [...existing] : [];
  for (const item of incoming) {
    if (!item) continue;
    const id = String(item.id || '').trim();
    if (id) {
      const index = out.findIndex((current) => current?.id === id);
      if (index >= 0) {
        out[index] = { ...out[index], ...item };
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

function findCheckpoint(state, checkpointId = '') {
  const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints : [];
  const id = String(checkpointId || '').trim();
  if (id) return checkpoints.find((checkpoint) => checkpoint.id === id) || null;
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
}

function findInterrupt(state, interruptId = '') {
  const interrupts = Array.isArray(state?.interrupts) ? state.interrupts : [];
  const id = String(interruptId || '').trim();
  if (id) return interrupts.find((interrupt) => interrupt.id === id) || null;
  const pending = [...interrupts].reverse().find((interrupt) => interrupt.status === 'pending');
  return pending || (interrupts.length > 0 ? interrupts[interrupts.length - 1] : null);
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function stringOr(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || String(fallback ?? '').trim();
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function createAgentItemId(prefix) {
  if (typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function summarizeToolCalls(toolCalls) {
  return Array.isArray(toolCalls)
    ? toolCalls.map((item) => ({
      id: item.id,
      toolName: item.toolName,
      status: item.status,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      durationMs: item.durationMs,
      result: item.result ? {
        ok: item.result.ok,
        exitCode: item.result.exitCode,
        error: item.result.error,
      } : null,
    }))
    : [];
}

function summarizeArtifacts(artifacts) {
  return Array.isArray(artifacts)
    ? artifacts.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      updatedAt: item.updatedAt,
    }))
    : [];
}

module.exports = { createAgentRuntime };
