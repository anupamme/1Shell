'use strict';

const { getRuntimeElapsedMs } = require('./budget');
const { normalizeAgentCommand } = require('./commands');
const {
  buildDecisionCognitionUpdate,
  buildObservationCognitionUpdate,
  buildPreDecisionCognitionUpdate,
} = require('./cognition');
const { buildAgentDecisionContext, buildAgentDecisionSnapshot } = require('./decision-context');
const { evaluateAgentDecisionPolicy } = require('./decision-policy');
const { evaluateAgentFinalGate } = require('./final-gate');
const { normalizeModelResult, runModelAdapter } = require('./model-adapter');
const { evaluateAgentRunOutcome } = require('./outcome');
const {
  buildDecisionPlanUpdate,
  buildObservationPlanUpdate,
  buildPreDecisionPlan,
  buildRecoveryPolicyUpdate,
} = require('./planning');
const { evaluateVerifierPlan, runVerifierPlan } = require('./verifiers');

async function runAgentControllerLoop({
  runtime,
  runId,
  initial,
  modelAdapter,
  skills,
  skillPrompt,
  maxTurns = null,
  checkpointTurns = false,
  interruptOn = null,
  initialTurns = [],
  initialObservations = [],
  startTurn = 0,
  resume = null,
  dispatchOptionsForAction = null,
  additionalFinalGates = [],
} = {}) {
  if (!runtime?.getState || !runtime?.recordTurn) throw new Error('AgentRunController requires runtime state APIs');
  const turnLimit = resolveControllerTurnLimit(maxTurns);
  const startIndex = toNonNegativeInteger(startTurn, normalizeExistingTurns(initialTurns).length);
  const turns = normalizeExistingTurns(initialTurns);
  let observations = normalizeObservationArray(initialObservations);
  let result = null;
  let interrupt = null;
  let runnerStatus = '';
  let finalGate = null;
  let finalGateRepairCount = 0;

  recordTransition(runtime, runId, {
    from: runtime.getState?.(runId)?.runtimeState?.currentNode || 'queued',
    to: 'understand',
    status: 'running',
    reason: 'controller_loop_started',
  });

  for (let offset = 0; ; offset++) {
    const index = startIndex + offset;
    const turnNumber = index + 1;
    const state = runtime.getState?.(runId) || initial;
    const loopStop = evaluateControllerLoopStop(state, { offset, turnLimit });
    if (loopStop.stop) {
      finalGate = {
        shouldContinue: false,
        forcedStatus: 'blocked',
        reasons: uniqueStrings([loopStop.kind || 'runtime_policy_stop', loopStop.reason || 'runtime_policy_stop']),
      };
      recordTransition(runtime, runId, {
        from: state?.runtimeState?.currentNode || 'decide',
        to: 'blocked',
        turn: turnNumber,
        status: 'blocked',
        reason: finalGate.reasons.join(','),
        data: {
          kind: loopStop.kind || '',
          elapsedMs: loopStop.elapsedMs ?? null,
          maxRuntimeMs: loopStop.maxRuntimeMs ?? null,
          turnLimit,
        },
      });
      runtime.recordTurn(runId, {
        index,
        turn: turnNumber,
        status: 'completed',
        stage: 'blocked',
        metadata: {
          taskStatus: 'blocked',
          finalGateReasons: finalGate.reasons,
          controller: 'AgentRunController',
          budgetMode: turnLimit === null ? 'runtime_policy' : 'fixed_turns',
        },
      });
      recordRuntimePlan(runtime, runId, {
        status: 'blocked',
        intent: 'stop_by_runtime_policy',
        objective: state?.goal || state?.spec?.goal || '',
        turn: turnNumber,
        steps: [{
          id: `turn-${turnNumber}-runtime-policy-stop`,
          status: 'blocked',
          kind: loopStop.kind || 'runtime_policy',
          summary: loopStop.reason || 'runtime policy stopped the controller loop',
        }],
        blockers: finalGate.reasons,
      });
      break;
    }
    const observedBefore = observations.length;
    const currentNode = state?.runtimeState?.currentNode || 'understand';
    const entryNode = currentNode === 'recover'
      ? 'plan'
      : (observedBefore > 0 ? 'observe' : 'plan');

    recordTransition(runtime, runId, {
      from: currentNode,
      to: entryNode,
      turn: turnNumber,
      status: 'running',
      reason: currentNode === 'recover'
        ? 'recovery_context_available'
        : (observedBefore > 0 ? 'observations_available' : 'initial_decision'),
    });
    runtime.recordTurn(runId, {
      index,
      turn: turnNumber,
      status: 'running',
      stage: entryNode,
      metadata: {
        maxTurns: turnLimit,
        budgetMode: turnLimit === null ? 'runtime_policy' : 'fixed_turns',
        observationsBefore: observedBefore,
        controller: 'AgentRunController',
      },
    });

    let decisionState = runtime.getState?.(runId) || state;
    if (entryNode !== 'plan') {
      recordTransition(runtime, runId, {
        from: entryNode,
        to: 'plan',
        turn: turnNumber,
        status: 'running',
        reason: 'prepare_runtime_plan',
      });
    }
    recordRuntimePlan(runtime, runId, buildPreDecisionPlan(decisionState, {
      turn: turnNumber,
      observations,
    }));
    recordCognitionState(runtime, runId, buildPreDecisionCognitionUpdate(decisionState, {
      turn: turnNumber,
      observations,
    }));
    decisionState = runtime.getState?.(runId) || decisionState;
    recordTransition(runtime, runId, {
      from: 'plan',
      to: 'decide',
      turn: turnNumber,
      status: 'running',
      reason: 'request_model_decision',
    });
    decisionState = runtime.getState?.(runId) || decisionState;
    const rawResult = await runModelAdapter(modelAdapter, {
      runtime,
      runId,
      state: decisionState,
      spec: decisionState.spec,
      goal: decisionState.goal,
      context: decisionState.spec?.context || {},
      policy: decisionState.spec?.policy || {},
      skills,
      skillPrompt,
      turn: turnNumber,
      turnIndex: index,
      maxTurns: turnLimit,
      observations,
      previousTurns: turns,
      resume,
      runtimeContext: buildAgentDecisionContext(decisionState),
      runtimeStateSnapshot: buildAgentDecisionSnapshot(decisionState),
      commandProtocol: {
        owner: 'AgentRunController',
        commands: ['act', 'ask_user', 'request_secret', 'request_approval', 'verify', 'recover', 'finalize', 'block'],
      },
      dispatchTool: (toolName, args = {}, options = {}) => runtime.dispatchTool(runId, toolName, args, options),
    });

    result = normalizeModelResult(rawResult);
    let command = normalizeAgentCommand(result);
    const decisionReview = evaluateAgentDecisionPolicy(runtime.getState?.(runId) || decisionState, command, {
      result,
      turn: turnNumber,
    });
    recordDecisionReview(runtime, runId, decisionReview);
    if (decisionReview?.command && decisionReview.status !== 'accepted') {
      command = decisionReview.command;
    }
    recordRuntimePlan(runtime, runId, buildDecisionPlanUpdate(command, result, {
      turn: turnNumber,
      state: runtime.getState?.(runId) || decisionState,
    }));
    recordCognitionState(runtime, runId, buildDecisionCognitionUpdate(command, result, {
      turn: turnNumber,
      state: runtime.getState?.(runId) || decisionState,
      decisionReview,
    }));
    const turn = {
      index,
      turn: turnNumber,
      result: summarizeModelResult(result, command),
      command: summarizeCommand(command),
      toolCalls: command.actions.map(summarizeToolCall),
      observations: [],
    };
    turns.push(turn);

    const decisionNode = runtimeNodeForDecisionCommand(command);
    recordTransition(runtime, runId, {
      from: 'decide',
      to: decisionNode,
      turn: turnNumber,
      status: 'running',
      reason: command.type === 'finalize' ? 'model_finalization_proposed' : 'model_decision_normalized',
      command: summarizeCommand(command),
      data: {
        decisionReviewStatus: decisionReview?.status || '',
        decisionReviewKind: decisionReview?.kind || '',
        decisionReviewReasons: decisionReview?.reasons || [],
      },
    });
    runtime.recordTurn(runId, {
      index,
      turn: turnNumber,
      status: 'running',
      stage: decisionNode,
      decision: summarizeModelResult(result, command),
      actions: command.actions.map(summarizeToolCall),
      metadata: {
        commandType: command.type,
        decisionReviewStatus: decisionReview?.status || '',
        decisionReviewKind: decisionReview?.kind || '',
      },
    });

    const interruptRequest = await resolveInterruptRequest({ command, result, interruptOn, state, turn });
    if (interruptRequest) {
      interrupt = createRuntimeInterrupt(runtime, runId, interruptRequest, turnNumber);
      turn.interrupt = summarizeInterrupt(interrupt || interruptRequest);
      runnerStatus = ['approval', 'request_approval'].includes(interrupt?.type) ? 'waiting_approval' : 'interrupted';
      recordTransition(runtime, runId, {
        from: runtimeNodeForDecisionCommand(command),
        to: 'interrupted',
        turn: turnNumber,
        status: runnerStatus,
        reason: interrupt?.reason || interruptRequest.reason || 'interrupt_requested',
      });
      runtime.recordTurn(runId, {
        index,
        turn: turnNumber,
        status: 'interrupted',
        stage: 'observe',
        metadata: { interrupt: turn.interrupt },
      });
      createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { interrupt: turn.interrupt });
      break;
    }

    if (command.type === 'act') {
      observations = await dispatchControllerActions({
        runtime,
        runId,
        actions: command.actions,
        dispatchOptionsForAction,
        turn: turnNumber,
        turnIndex: index,
      });
      turn.observations = observations;
      recordRuntimePlan(runtime, runId, buildObservationPlanUpdate(observations, {
        turn: turnNumber,
        state: runtime.getState?.(runId) || decisionState,
      }));
      recordCognitionState(runtime, runId, buildObservationCognitionUpdate(observations, {
        turn: turnNumber,
        state: runtime.getState?.(runId) || decisionState,
      }));
      const observationStep = recordAgentControllerObservationStep({
        runtime,
        runId,
        turn: turnNumber,
        turnIndex: index,
        observations,
        metadata: { controllerLoop: true },
      });
      if (observationStep.action === 'interrupted') {
        interrupt = observationStep.interrupt;
        runnerStatus = interrupt?.type === 'request_approval' ? 'waiting_approval' : 'interrupted';
        turn.interrupt = interrupt;
        createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { interrupt });
        break;
      }
      if (observationStep.action === 'blocked') {
        finalGate = observationStep.finalGate || {
          shouldContinue: false,
          forcedStatus: 'blocked',
          reasons: ['recovery_attempt_budget_exhausted'],
        };
        observations = [observationStep.observation].filter(Boolean);
        turn.observations = observations;
        runtime.recordTurn(runId, {
          index,
          turn: turnNumber,
          status: 'completed',
          stage: 'finalize',
          observations,
          metadata: {
            taskStatus: 'blocked',
            finalGateReasons: finalGate.reasons,
            recovery: observationStep.recovery || null,
          },
        });
        createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { finalGate, recovery: observationStep.recovery });
        break;
      }
      if (observationStep.action === 'recover' && hasControllerTurnCapacityAfter(offset, turnLimit)) {
        observations = [observationStep.observation].filter(Boolean);
        turn.observations = observations;
        createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { recovery: observationStep.recovery });
        continue;
      }
      if (observationStep.action === 'recover') {
        finalGate = {
          shouldContinue: false,
          forcedStatus: 'blocked',
          reasons: ['recovery_required', 'turn_budget_exhausted'],
        };
        recordTransition(runtime, runId, {
          from: 'recover',
          to: 'blocked',
          turn: turnNumber,
          status: 'blocked',
          reason: finalGate.reasons.join(','),
          data: { recoveryType: observationStep.recovery?.recoveryType || '' },
        });
        runtime.recordTurn(runId, {
          index,
          turn: turnNumber,
          status: 'completed',
          stage: 'finalize',
          metadata: {
            taskStatus: 'blocked',
            finalGateReasons: finalGate.reasons,
          },
        });
        createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { finalGate, recovery: observationStep.recovery });
        break;
      }
      createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn);
      continue;
    }

    if (command.type === 'verify') {
      const verifierPlan = evaluateVerifierPlan(runtime.getState?.(runId) || state);
      const verifierResult = await runVerifierPlan({
        runtime,
        runId,
        hostId: state?.spec?.context?.hostId || '',
        inputs: state?.spec?.context?.inputs || {},
        reason: 'model_verify_command',
      });
      const verifyObservation = createRuntimeObservation(
        turnNumber,
        'verify',
        verifierResult?.attempted
          ? formatVerifierExecutorMessage(verifierResult)
          : 'Verification requested by model; controller found no executable verifier and will require concrete verifier/tool evidence before success.',
        {
          verifierPlan,
          verifierResult: verifierResult || null,
          requirements: verifierPlan.requirements || [],
        },
        {
          ok: verifierResult?.ok === true,
          isError: verifierResult?.ok !== true,
        },
      );
      observations = [verifyObservation];
      runtime.recordObservation?.(runId, verifyObservation);
      recordCognitionState(runtime, runId, buildObservationCognitionUpdate(observations, {
        turn: turnNumber,
        state: runtime.getState?.(runId) || decisionState,
      }));
      recordRuntimePlan(runtime, runId, buildObservationPlanUpdate(observations, {
        turn: turnNumber,
        state: runtime.getState?.(runId) || decisionState,
      }));
      recordTransition(runtime, runId, { from: 'verify', to: 'observe', turn: turnNumber, status: 'running', reason: 'verification_command_recorded' });
      if (!hasControllerTurnCapacityAfter(offset, turnLimit)) {
        finalGate = evaluateFinalGate(runtime, runId, result, finalGateRepairCount);
        if (finalGate.shouldContinue) {
          finalGate = {
            ...finalGate,
            shouldContinue: false,
            forcedStatus: 'blocked',
            reasons: uniqueStrings([...(finalGate.reasons || []), 'turn_budget_exhausted']),
          };
        }
        recordTransition(runtime, runId, {
          from: 'observe',
          to: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'finalize',
          turn: turnNumber,
          status: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'completed',
          reason: finalGate?.reasons?.join(',') || 'verification_completed',
        });
        runtime.recordTurn(runId, {
          index,
          turn: turnNumber,
          status: 'completed',
          stage: 'finalize',
          observations,
          metadata: {
            taskStatus: finalGate?.forcedStatus || '',
            finalGateReasons: finalGate?.reasons || [],
            verifyAtTurnBudget: true,
          },
        });
        recordRuntimePlan(runtime, runId, {
          status: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'finalized',
          intent: finalGate?.forcedStatus === 'blocked' ? 'stop_after_verification_budget' : 'finish_after_verification',
          objective: (runtime.getState?.(runId) || decisionState)?.goal || '',
          turn: turnNumber,
          steps: [{
            id: `turn-${turnNumber}-verify-finalize`,
            status: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'done',
            kind: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'finalize',
            summary: finalGate?.reasons?.join(',') || 'verification completed',
          }],
          blockers: finalGate?.reasons || [],
        });
        createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { verify: true, finalGate });
        break;
      }
      createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { verify: true });
      continue;
    }

    if (command.type === 'recover') {
      const recoverObservation = createRuntimeObservation(turnNumber, 'recover', command.text || 'Recovery requested; continue with concrete repair or block with evidence.');
      observations = [recoverObservation];
      runtime.recordObservation?.(runId, recoverObservation);
      recordRecoveryPolicy(runtime, runId, {
        status: 'in_progress',
        recoveryType: command.data?.recoveryType || command.data?.recovery_type || 'model_requested',
        reason: command.reason || command.text || 'model_recovery_command',
        strategy: command.text || 'continue recovery with concrete action or block with evidence',
        nextSteps: ['choose_repair_action', 'observe_repair_result', 'verify_if_needed'],
      });
      recordTransition(runtime, runId, { from: 'recover', to: 'decide', turn: turnNumber, status: 'running', reason: 'recovery_command_recorded' });
      if (!hasControllerTurnCapacityAfter(offset, turnLimit)) {
        finalGate = {
          shouldContinue: false,
          forcedStatus: 'blocked',
          reasons: uniqueStrings(['recovery_required', command.reason || '', 'turn_budget_exhausted']),
        };
        recordTransition(runtime, runId, {
          from: 'decide',
          to: 'blocked',
          turn: turnNumber,
          status: 'blocked',
          reason: finalGate.reasons.join(','),
        });
        runtime.recordTurn(runId, {
          index,
          turn: turnNumber,
          status: 'completed',
          stage: 'finalize',
          observations,
          metadata: {
            taskStatus: 'blocked',
            finalGateReasons: finalGate.reasons,
            recoverAtTurnBudget: true,
          },
        });
        recordRuntimePlan(runtime, runId, {
          status: 'blocked',
          intent: 'stop_recovery_at_turn_budget',
          objective: (runtime.getState?.(runId) || decisionState)?.goal || '',
          turn: turnNumber,
          steps: [{
            id: `turn-${turnNumber}-recover-budget`,
            status: 'blocked',
            kind: 'recover',
            summary: recoverObservation.content || '',
          }],
          blockers: finalGate.reasons,
        });
        createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { recover: true, finalGate });
        break;
      }
      createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { recover: true });
      continue;
    }

    finalGate = evaluateFinalGate(runtime, runId, result, finalGateRepairCount);
    finalGate = await runFinalGateVerifierIfNeeded({
      runtime,
      runId,
      finalGate,
      result,
      repairCount: finalGateRepairCount,
      dispatchOptionsForAction,
      turn: turnNumber,
      turnIndex: index,
      state,
    });
    if (!finalGate.shouldContinue && !finalGate.forcedStatus) {
      finalGate = evaluateAdditionalFinalGates(additionalFinalGates, {
        runtime,
        runId,
        state: runtime.getState?.(runId) || state,
        result,
        command,
        finalText: result.text || result.report || result.content || '',
        repairCount: finalGateRepairCount,
        metadata: { controllerLoop: true, turn: turnNumber },
      }, finalGate);
    }
    if (command.type === 'block') {
      finalGate = {
        ...(finalGate || {}),
        shouldContinue: false,
        forcedStatus: 'blocked',
        reasons: [...new Set([...(finalGate?.reasons || []), command.reason || 'model_blocked'])],
      };
    }
    if (finalGate.shouldContinue && hasControllerTurnCapacityAfter(offset, turnLimit)) {
      finalGateRepairCount += 1;
      const gateObservation = createRuntimeObservation(turnNumber, 'runtime_gate', finalGate.message, {
        reasons: finalGate.reasons,
        verifierPlan: finalGate.verifierPlan || null,
      });
      observations = [gateObservation];
      turn.observations = observations;
      runtime.recordObservation?.(runId, { ...gateObservation, stage: 'verify' });
      recordRuntimePlan(runtime, runId, {
        status: 'needs_more_work',
        intent: 'satisfy_final_gate',
        objective: (runtime.getState?.(runId) || decisionState)?.goal || '',
        turn: turnNumber,
        steps: [{
          id: `turn-${turnNumber}-final-gate`,
          status: 'failed',
          kind: 'runtime_gate',
          summary: finalGate.message || '',
        }],
        blockers: finalGate.reasons || [],
        evidenceNeeded: finalGate.verifierPlan?.required === true ? ['runtime_verification'] : [],
      });
      recordTransition(runtime, runId, {
        from: runtimeNodeForDecisionCommand(command),
        to: 'observe',
        turn: turnNumber,
        status: 'running',
        reason: 'final_gate_requires_more_work',
        data: { reasons: finalGate.reasons },
      });
      runtime.recordTurn(runId, {
        index,
        turn: turnNumber,
        status: 'completed',
        stage: 'verify',
        observations,
        metadata: { finalGateReasons: finalGate.reasons },
      });
      createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { finalGate });
      continue;
    }

    if (finalGate.shouldContinue) {
      finalGate = {
        ...finalGate,
        shouldContinue: false,
        forcedStatus: 'blocked',
        reasons: [...(finalGate.reasons || []), 'turn_budget_exhausted'],
      };
    }
    recordTransition(runtime, runId, {
      from: runtimeNodeForDecisionCommand(command),
      to: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'finalize',
      turn: turnNumber,
      status: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'completed',
      reason: finalGate?.reasons?.join(',') || 'finalized',
    });
    runtime.recordTurn(runId, {
      index,
      turn: turnNumber,
      status: 'completed',
      stage: 'finalize',
      metadata: {
        taskStatus: finalGate?.forcedStatus || command.status || '',
        finalGateReasons: finalGate?.reasons || [],
      },
    });
    recordRuntimePlan(runtime, runId, {
      status: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'finalized',
      intent: finalGate?.forcedStatus === 'blocked' ? 'stop_with_evidence' : 'finish_after_runtime_gates',
      objective: (runtime.getState?.(runId) || decisionState)?.goal || '',
      turn: turnNumber,
      steps: [{
        id: `turn-${turnNumber}-finalize`,
        status: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'done',
        kind: finalGate?.forcedStatus === 'blocked' ? 'blocked' : 'finalize',
        summary: finalGate?.reasons?.join(',') || 'finalized',
      }],
      blockers: finalGate?.reasons || [],
    });
    createTurnCheckpointIfNeeded(runtime, runId, checkpointTurns, turn, { finalGate });
    break;
  }

  return { result: result || { text: '' }, turns, observations, interrupt, runnerStatus, finalGate };
}

function formatVerifierExecutorMessage(result = {}) {
  const lines = [
    '[AGENT_VERIFIER_EXECUTED]',
    `status=${result.status || 'unknown'}`,
    `ok=${result.ok === true}`,
  ];
  if (Array.isArray(result.reasons) && result.reasons.length > 0) lines.push(`reasons=${result.reasons.join(',')}`);
  if (Array.isArray(result.actions) && result.actions.length > 0) {
    lines.push(`actions=${result.actions.map((item) => `${item.toolName}:${item.type}`).join(',')}`);
  }
  return lines.join('\n');
}

async function dispatchControllerActions({ runtime, runId, actions = [], dispatchOptionsForAction = null, turn = null, turnIndex = null } = {}) {
  if (!runtime?.dispatchTool) throw new Error('AgentRunController requires runtime.dispatchTool');
  const observations = [];
  for (const action of actions) {
    const extraOptions = typeof dispatchOptionsForAction === 'function'
      ? await dispatchOptionsForAction({ action, runId, runtime, turn, turnIndex })
      : normalizeObject(dispatchOptionsForAction);
    const dispatched = await runtime.dispatchTool(runId, action.toolName, action.args, mergeDispatchOptions(action.options, extraOptions));
    observations.push(normalizeToolObservation(action, dispatched));
  }
  return observations;
}

function mergeDispatchOptions(base = {}, extra = {}) {
  const normalizedBase = normalizeObject(base);
  const normalizedExtra = normalizeObject(extra);
  return {
    ...normalizedBase,
    ...normalizedExtra,
    scope: {
      ...normalizeObject(normalizedBase.scope),
      ...normalizeObject(normalizedExtra.scope),
    },
  };
}

function recordAgentControllerDecision({
  runtime,
  runId,
  turn,
  turnIndex = null,
  rawResult = {},
  metadata = {},
} = {}) {
  if (!runtime?.recordTurn) throw new Error('AgentRunController requires runtime.recordTurn');
  const turnNumber = toPositiveInteger(turn, 1);
  const index = toNonNegativeInteger(turnIndex, turnNumber - 1);
  const result = normalizeModelResult(rawResult);
  let command = normalizeAgentCommand(result);
  const decisionReview = evaluateAgentDecisionPolicy(runtime.getState?.(runId), command, {
    result,
    turn: turnNumber,
  });
  recordDecisionReview(runtime, runId, decisionReview);
  if (decisionReview?.command && decisionReview.status !== 'accepted') {
    command = decisionReview.command;
  }
  recordCognitionState(runtime, runId, buildDecisionCognitionUpdate(command, result, {
    turn: turnNumber,
    state: runtime.getState?.(runId),
    decisionReview,
  }));
  const actions = command.actions.map(summarizeToolCall);

  const decisionNode = runtimeNodeForDecisionCommand(command);
  recordTransition(runtime, runId, {
    from: 'decide',
    to: decisionNode,
    turn: turnNumber,
    status: 'running',
    reason: command.type === 'finalize' ? 'model_finalization_proposed' : 'model_decision_normalized',
    command: summarizeCommand(command),
    data: {
      bridge: metadata.bridge || '',
      toolCallCount: actions.length,
      decisionReviewStatus: decisionReview?.status || '',
      decisionReviewKind: decisionReview?.kind || '',
      decisionReviewReasons: decisionReview?.reasons || [],
    },
  });
  runtime.recordTurn(runId, {
    index,
    turn: turnNumber,
    status: 'running',
    stage: decisionNode,
    decision: summarizeModelResult(result, command),
    actions,
      metadata: {
        ...normalizeObject(metadata),
        commandType: command.type,
        decisionReviewStatus: decisionReview?.status || '',
        decisionReviewKind: decisionReview?.kind || '',
        controller: 'AgentRunController',
      },
    });
  return {
    result,
    command,
    decisionReview,
    actions,
    turn: {
      index,
      turn: turnNumber,
      result: summarizeModelResult(result, command),
      command: summarizeCommand(command),
      toolCalls: actions,
      observations: [],
    },
  };
}

function recordAgentControllerObservationStep({
  runtime,
  runId,
  turn,
  turnIndex = null,
  toolCalls = [],
  toolResults = [],
  observations = [],
  metadata = {},
} = {}) {
  if (!runtime?.recordTurn) throw new Error('AgentRunController requires runtime.recordTurn');
  const turnNumber = toPositiveInteger(turn, 1);
  const index = toNonNegativeInteger(turnIndex, turnNumber - 1);
  const normalizedObservations = normalizeObservationArray(observations).length > 0
    ? normalizeObservationArray(observations)
    : normalizeModelToolResultObservations({ toolCalls, toolResults, turn: turnNumber });
  recordCognitionState(runtime, runId, buildObservationCognitionUpdate(normalizedObservations, {
    turn: turnNumber,
    state: runtime.getState?.(runId),
  }));
  const pendingInterrupt = findPendingInterrupt(runtime.getState?.(runId));
  const currentNode = runtime.getState?.(runId)?.runtimeState?.currentNode || 'act';

  recordTransition(runtime, runId, {
    from: currentNode,
    to: pendingInterrupt ? 'interrupted' : 'observe',
    turn: turnNumber,
    status: pendingInterrupt ? 'interrupted' : 'running',
    reason: pendingInterrupt ? (pendingInterrupt.reason || 'tool_policy_interrupt') : 'tool_results_observed',
    data: {
      ...normalizeObject(metadata),
      observationCount: normalizedObservations.length,
    },
  });

  if (pendingInterrupt) {
    const interrupt = summarizeInterrupt(pendingInterrupt);
    runtime.recordTurn(runId, {
      index,
      turn: turnNumber,
      status: 'interrupted',
      stage: 'observe',
      observations: normalizedObservations,
      metadata: {
        ...normalizeObject(metadata),
        interrupt,
        controller: 'AgentRunController',
      },
    });
    return {
      action: 'interrupted',
      shouldContinue: false,
      interrupt,
      observations: normalizedObservations,
      message: '',
    };
  }

  runtime.recordTurn(runId, {
    index,
    turn: turnNumber,
    status: 'completed',
    stage: 'observe',
    observations: normalizedObservations,
    metadata: {
      ...normalizeObject(metadata),
      controller: 'AgentRunController',
    },
  });

  const recovery = evaluateRecoveryDirective(normalizedObservations, {
    state: runtime.getState?.(runId),
  });
  if (recovery.shouldRecover) {
    recordRuntimePlan(runtime, runId, buildObservationPlanUpdate(normalizedObservations, {
      turn: turnNumber,
      state: runtime.getState?.(runId),
    }));
    recordRecoveryPolicy(runtime, runId, buildRecoveryPolicyUpdate(recovery, {
      state: runtime.getState?.(runId),
    }));
    const recoveryObservation = {
      ...recovery.observation,
      turn: turnNumber,
      stage: 'recover',
    };
    runtime.recordObservation?.(runId, recoveryObservation);
    if (recovery.recoveryExhausted) {
      const reasons = uniqueStrings([
        recovery.reason || 'recovery_attempt_budget_exhausted',
        recovery.repeatedFailureExhausted ? 'repeated_failure_budget_exhausted' : '',
        recovery.recoveryExhausted && !recovery.repeatedFailureExhausted ? 'recovery_attempt_budget_exhausted' : '',
      ]);
      recordRuntimePlan(runtime, runId, {
        status: 'blocked',
        intent: 'stop_recovery_loop',
        objective: (runtime.getState?.(runId) || {})?.goal || '',
        turn: turnNumber,
        steps: [{
          id: `turn-${turnNumber}-recovery-budget`,
          status: 'blocked',
          kind: 'recover',
          summary: recoveryObservation.content || '',
        }],
        blockers: reasons,
      });
      recordTransition(runtime, runId, {
        from: 'observe',
        to: 'blocked',
        turn: turnNumber,
        status: 'blocked',
        reason: reasons.join(','),
        data: {
          ...normalizeObject(metadata),
          failedToolNames: recovery.failedToolNames || [],
          recoveryType: recovery.recoveryType || 'tool_failure',
          maxAttempts: recovery.maxAttempts ?? null,
        },
      });
      return {
        action: 'blocked',
        shouldContinue: false,
        message: recoveryObservation.content || '',
        observation: recoveryObservation,
        observations: normalizedObservations,
        recovery,
        finalGate: {
          shouldContinue: false,
          forcedStatus: 'blocked',
          reasons,
        },
      };
    }
    recordTransition(runtime, runId, {
      from: 'observe',
      to: 'recover',
      turn: turnNumber,
      status: 'running',
      reason: recovery.reason || 'failed_observation_requires_recovery',
      data: {
        ...normalizeObject(metadata),
        failedToolNames: recovery.failedToolNames || [],
        recoveryType: recovery.recoveryType || 'tool_failure',
      },
    });
    return {
      action: 'recover',
      shouldContinue: true,
      message: recoveryObservation.content || '',
      observation: recoveryObservation,
      observations: normalizedObservations,
      recovery,
    };
  }

  return {
    action: 'observe',
    shouldContinue: true,
    observations: normalizedObservations,
    message: '',
  };
}

function evaluateAgentControllerFinalization({
  runtime,
  runId,
  turn,
  turnIndex = null,
  result = {},
  command = null,
  finalText = '',
  repairCount = 0,
  additionalGates = [],
  metadata = {},
} = {}) {
  if (!runtime?.recordTurn) throw new Error('AgentRunController requires runtime.recordTurn');
  const turnNumber = toPositiveInteger(turn, 1);
  const index = toNonNegativeInteger(turnIndex, turnNumber - 1);
  const normalizedResult = normalizeModelResult(result);
  const effectiveCommand = command || normalizeAgentCommand(normalizedResult);
  const text = String(finalText || normalizedResult.text || normalizedResult.report || normalizedResult.content || '').trim();
  let finalGate = evaluateFinalGate(runtime, runId, { ...normalizedResult, text }, repairCount);
  if (effectiveCommand.type === 'block') {
    finalGate = {
      ...(finalGate || {}),
      shouldContinue: false,
      forcedStatus: 'blocked',
      reasons: uniqueStrings([...(finalGate?.reasons || []), effectiveCommand.reason || 'model_blocked']),
    };
  }
  if (!finalGate.shouldContinue && !finalGate.forcedStatus) {
    finalGate = evaluateAdditionalFinalGates(additionalGates, {
      runtime,
      runId,
      state: runtime.getState?.(runId) || null,
      result: normalizedResult,
      command: effectiveCommand,
      finalText: text,
      repairCount,
      metadata,
    }, finalGate);
  }

  if (finalGate.shouldContinue) {
    const observation = createRuntimeObservation(turnNumber, 'runtime_gate', finalGate.message, {
      reasons: finalGate.reasons || [],
      verifierPlan: finalGate.verifierPlan || null,
    });
    runtime.recordObservation?.(runId, { ...observation, stage: 'verify' });
    recordRuntimePlan(runtime, runId, {
      status: 'needs_more_work',
      intent: 'satisfy_final_gate',
      objective: (runtime.getState?.(runId) || {})?.goal || '',
      turn: turnNumber,
      steps: [{
        id: `turn-${turnNumber}-final-gate`,
        status: 'failed',
        kind: 'runtime_gate',
        summary: finalGate.message || '',
      }],
      blockers: finalGate.reasons || [],
      evidenceNeeded: finalGate.verifierPlan?.required === true ? ['runtime_verification'] : [],
    });
    recordTransition(runtime, runId, {
      from: runtimeNodeForDecisionCommand(effectiveCommand),
      to: 'observe',
      turn: turnNumber,
      status: 'running',
      reason: 'final_gate_requires_more_work',
      data: { reasons: finalGate.reasons || [], bridge: metadata.bridge || '' },
    });
    runtime.recordTurn(runId, {
      index,
      turn: turnNumber,
      status: 'completed',
      stage: 'verify',
      observations: [observation],
      metadata: {
        ...normalizeObject(metadata),
        finalGateReasons: finalGate.reasons || [],
        controller: 'AgentRunController',
      },
    });
    return {
      action: 'continue',
      shouldContinue: true,
      message: finalGate.message || '',
      finalGate,
      forcedStatus: '',
    };
  }

  const forcedStatus = finalGate.forcedStatus || '';
  recordTransition(runtime, runId, {
    from: runtimeNodeForDecisionCommand(effectiveCommand),
    to: forcedStatus === 'blocked' ? 'blocked' : 'finalize',
    turn: turnNumber,
    status: forcedStatus === 'blocked' ? 'blocked' : 'completed',
    reason: finalGate.reasons?.join(',') || 'finalized',
    data: { bridge: metadata.bridge || '' },
  });
  runtime.recordTurn(runId, {
    index,
    turn: turnNumber,
    status: 'completed',
    stage: 'finalize',
    metadata: {
      ...normalizeObject(metadata),
      taskStatus: forcedStatus,
      finalGateReasons: finalGate.reasons || [],
      controller: 'AgentRunController',
    },
  });
  recordRuntimePlan(runtime, runId, {
    status: forcedStatus === 'blocked' ? 'blocked' : 'finalized',
    intent: forcedStatus === 'blocked' ? 'stop_with_evidence' : 'finish_after_runtime_gates',
    objective: (runtime.getState?.(runId) || {})?.goal || '',
    turn: turnNumber,
    steps: [{
      id: `turn-${turnNumber}-finalize`,
      status: forcedStatus === 'blocked' ? 'blocked' : 'done',
      kind: forcedStatus === 'blocked' ? 'blocked' : 'finalize',
      summary: forcedStatus || 'finalized',
    }],
    blockers: finalGate.reasons || [],
  });
  return {
    action: forcedStatus === 'blocked' ? 'blocked' : 'finalize',
    shouldContinue: false,
    message: '',
    finalGate,
    forcedStatus,
  };
}

function evaluateFinalGate(runtime, runId, result, repairCount) {
  const gate = evaluateAgentFinalGate(runtime.getState?.(runId) || {}, {
    result,
    finalText: result.text || result.report || result.content || '',
    repairCount,
  });
  if (gate?.trajectoryEvaluation) recordTrajectoryEvaluation(runtime, runId, gate.trajectoryEvaluation);
  return gate;
}

async function runFinalGateVerifierIfNeeded({
  runtime,
  runId,
  finalGate = null,
  result = {},
  repairCount = 0,
  dispatchOptionsForAction = null,
  turn = null,
  turnIndex = null,
  state = null,
} = {}) {
  if (!finalGate?.shouldContinue || finalGate?.verifierPlan?.required !== true || finalGate?.verifierPlan?.ok === true) return finalGate;
  const verifierStatus = String(finalGate.verifierPlan.status || '');
  if (verifierStatus !== 'missing') return finalGate;

  const syntheticAction = {
    id: `runtime-final-gate-verifier-${turn || Date.now()}`,
    toolName: 'verify_outcome',
    args: {},
    options: {},
  };
  const extraOptions = typeof dispatchOptionsForAction === 'function'
    ? await dispatchOptionsForAction({ action: syntheticAction, runId, runtime, turn, turnIndex, verifier: true })
    : normalizeObject(dispatchOptionsForAction);
  const verifierResult = await runVerifierPlan({
    runtime,
    runId,
    hostId: state?.spec?.context?.hostId || '',
    inputs: state?.spec?.context?.inputs || {},
    executeTool: extraOptions.executeTool,
    requestApproval: extraOptions.requestApproval,
    signal: extraOptions.signal,
    reason: 'final_gate_requires_verification',
  });
  if (!verifierResult?.attempted) return finalGate;

  const updatedGate = evaluateFinalGate(runtime, runId, result, repairCount);
  return {
    ...updatedGate,
    verifierResult,
    verifierAttemptedByRuntime: true,
    reasons: updatedGate.reasons || [],
  };
}

function evaluateAdditionalFinalGates(gates = [], payload = {}, fallback = { shouldContinue: false, reasons: [] }) {
  const items = Array.isArray(gates) ? gates : [];
  for (const gate of items) {
    if (typeof gate !== 'function') continue;
    const result = gate(payload);
    if (!result || typeof result !== 'object') continue;
    if (result.shouldContinue || result.forcedStatus || (Array.isArray(result.reasons) && result.reasons.length > 0)) return result;
  }
  return fallback;
}

function evaluateRecoveryDirective(observations = [], options = {}) {
  const failed = observations.filter((item) => item?.isError === true || item?.ok === false);
  if (failed.length === 0) return { shouldRecover: false };
  const failedToolNames = failed.map((item) => item.toolName).filter(Boolean);
  const state = options.state || {};
  const maxAttempts = resolveMaxRecoveryAttempts(state);
  const currentAttempts = Number(state?.runtimeState?.recovery?.attemptCount || 0);
  const maxRepeatedFailures = resolveMaxRepeatedFailures(state);
  const failureSignature = buildFailureSignature(failed);
  const currentRecovery = state?.runtimeState?.recovery || {};
  const repeatFailureCount = failureSignature && currentRecovery.lastFailureSignature === failureSignature
    ? Number(currentRecovery.repeatFailureCount || 0) + 1
    : 1;
  const repeatedFailureExhausted = maxRepeatedFailures !== null && repeatFailureCount >= maxRepeatedFailures;
  const attemptBudgetExhausted = maxAttempts !== null && currentAttempts >= maxAttempts;
  const recoveryExhausted = attemptBudgetExhausted || repeatedFailureExhausted;
  const exhaustedReason = repeatedFailureExhausted ? 'repeated_failure_budget_exhausted' : 'recovery_attempt_budget_exhausted';
  const failedVerification = failed.find((item) => item.toolName === 'verify_outcome' || /\[verification:/i.test(String(item.content || item.error || '')));
  if (failedVerification) {
    const outcome = evaluateAgentRunOutcome(state, { fallbackTaskStatus: 'unverified' });
    const verifierPlan = evaluateVerifierPlan(state);
    const reasons = verifierPlan.reasons.length
      ? verifierPlan.reasons
      : (Array.isArray(outcome.reasons) && outcome.reasons.length ? outcome.reasons : ['verification_failed']);
    const evidence = compactText(failedVerification.content || failedVerification.error || '', 2000);
    return {
      shouldRecover: true,
      recoveryExhausted,
      maxAttempts,
      maxRepeatedFailures,
      repeatedFailureExhausted,
      repeatFailureCount,
      failureSignature,
      recoveryType: 'verification_repair',
      reason: recoveryExhausted ? exhaustedReason : 'verification_failed_requires_recovery',
      failedToolNames,
      observations: failed,
      observation: {
        id: `runtime-recovery-${Date.now()}`,
        kind: 'runtime_recovery',
        toolName: 'agent_recovery_planner',
        ok: false,
        isError: true,
        content: [
          '[AGENT_VERIFY_RECOVERY_REQUIRED]',
          attemptBudgetExhausted ? `recovery_attempts_exhausted=${currentAttempts}/${maxAttempts}` : '',
          repeatFailureCount > 1 ? `repeated_failure_count=${repeatFailureCount}/${maxRepeatedFailures ?? 'unbounded'}` : '',
          `reasons=${reasons.join(',')}`,
          verifierPlan.required ? `verifier_status=${verifierPlan.status}` : '',
          verifierPlan.requirements.length ? `verifier_requirements=${verifierPlan.requirements.map((item) => item.id || item.source || item.type).filter(Boolean).join(',')}` : '',
          'The verifier did not accept the outcome. Continue by repairing the failed condition, collecting missing input/secret/approval, running verification again, or ending as failed/blocked/unverified with evidence.',
          evidence ? `Verification evidence:\n${evidence}` : '',
        ].filter(Boolean).join('\n'),
        data: { failedToolNames, outcome, verifierPlan, recoveryType: 'verification_repair', recoveryExhausted, maxAttempts, maxRepeatedFailures, repeatedFailureExhausted, repeatFailureCount, failureSignature },
      },
    };
  }
  return {
    shouldRecover: true,
    recoveryExhausted,
    maxAttempts,
    maxRepeatedFailures,
    repeatedFailureExhausted,
    repeatFailureCount,
    failureSignature,
    recoveryType: 'tool_failure',
    reason: recoveryExhausted ? exhaustedReason : 'failed_observation_requires_recovery',
    failedToolNames,
    observations: failed,
    observation: {
      id: `runtime-recovery-${Date.now()}`,
      kind: 'runtime_recovery',
      toolName: 'agent_recovery_planner',
      ok: false,
      isError: true,
      content: [
        '[AGENT_RECOVERY_REQUIRED]',
        attemptBudgetExhausted ? `recovery_attempts_exhausted=${currentAttempts}/${maxAttempts}` : '',
        repeatFailureCount > 1 ? `repeated_failure_count=${repeatFailureCount}/${maxRepeatedFailures ?? 'unbounded'}` : '',
        `failed_tools=${failedToolNames.join(',') || 'unknown'}`,
        'A tool observation failed. Continue by diagnosing the failure, repairing it, asking for missing input/approval, or ending as failed/blocked/unverified with evidence.',
      ].filter(Boolean).join('\n'),
      data: { failedToolNames, recoveryExhausted, maxAttempts, maxRepeatedFailures, repeatedFailureExhausted, repeatFailureCount, failureSignature },
    },
  };
}

function resolveMaxRecoveryAttempts(state = {}) {
  const policy = state?.spec?.policy && typeof state.spec.policy === 'object' ? state.spec.policy : {};
  const raw = policy.maxRecoveryAttempts ?? policy.max_recovery_attempts ?? policy.recoveryMaxAttempts ?? policy.recovery_max_attempts;
  if (raw === undefined || raw === null || raw === false || raw === 'none' || raw === 'unbounded') return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function resolveMaxRepeatedFailures(state = {}) {
  const policy = state?.spec?.policy && typeof state.spec.policy === 'object' ? state.spec.policy : {};
  const raw = policy.maxRepeatedFailures ?? policy.max_repeated_failures ?? policy.repeatedFailureMaxAttempts ?? policy.repeated_failure_max_attempts ?? 3;
  if (raw === null || raw === false || raw === 'none') return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 1) return 3;
  return Math.floor(number);
}

function buildFailureSignature(failed = []) {
  return failed
    .map((item) => [
      String(item?.toolName || 'unknown').trim(),
      Number.isFinite(Number(item?.exitCode)) ? Number(item.exitCode) : '',
      compactText(normalizeFailureText(item), 300),
    ].join(':'))
    .filter(Boolean)
    .join('|');
}

function normalizeFailureText(item = {}) {
  return String(item.error || item.stderr || item.stderrExcerpt || item.content || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<time>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveInterruptRequest({ command = {}, result = {}, interruptOn = null, state = null, turn = null } = {}) {
  if (command.interrupt) return command.interrupt;
  if (['ask_user', 'request_secret', 'request_approval'].includes(command.type)) {
    return {
      type: command.type,
      reason: command.reason || command.type,
      message: command.text || command.reason || '',
      payload: command.data || {},
    };
  }
  if (typeof interruptOn === 'function') {
    const requested = await interruptOn({ result, command, state, turn });
    if (requested) return requested;
  }
  return null;
}

function createRuntimeInterrupt(runtime, runId, request, turn) {
  if (!request) return null;
  if (!runtime?.createInterrupt) return { ...request, turn };
  return runtime.createInterrupt(runId, { ...request, turn });
}

function findPendingInterrupt(state = {}) {
  const interrupts = Array.isArray(state?.interrupts) ? state.interrupts : [];
  return [...interrupts].reverse().find((item) => item?.status === 'pending') || null;
}

function createRuntimeObservation(turn, kind, content, data = {}, options = {}) {
  const ok = options.ok === true;
  const isError = options.isError === undefined ? !ok : options.isError === true;
  return {
    id: `${kind}-${turn}-${Date.now()}`,
    kind,
    toolName: kind === 'runtime_gate' ? 'agent_final_gate' : 'agent_controller',
    ok,
    isError,
    turn,
    content,
    data,
  };
}

function recordTransition(runtime, runId, transition = {}) {
  if (!runtime?.recordRuntimeTransition) return null;
  return runtime.recordRuntimeTransition(runId, transition);
}

function recordRuntimePlan(runtime, runId, update = {}) {
  if (!runtime?.recordRuntimePlan) return null;
  return runtime.recordRuntimePlan(runId, update);
}

function recordCognitionState(runtime, runId, update = {}) {
  if (!runtime?.recordCognitionState) return null;
  return runtime.recordCognitionState(runId, update);
}

function recordDecisionReview(runtime, runId, review = {}) {
  if (!runtime?.recordDecisionReview) return null;
  return runtime.recordDecisionReview(runId, review);
}

function recordRecoveryPolicy(runtime, runId, update = {}) {
  if (!runtime?.recordRecoveryPolicy) return null;
  return runtime.recordRecoveryPolicy(runId, update);
}

function recordTrajectoryEvaluation(runtime, runId, evaluation = {}) {
  if (!runtime?.recordTrajectoryEvaluation) return null;
  return runtime.recordTrajectoryEvaluation(runId, evaluation);
}

function normalizeToolObservation(action, result = {}) {
  const raw = result?.raw && typeof result.raw === 'object' ? result.raw : {};
  const exitCode = typeof raw.exitCode === 'number'
    ? raw.exitCode
    : (typeof result.exitCode === 'number' ? result.exitCode : undefined);
  const isError = result.is_error === true || (typeof exitCode === 'number' && exitCode !== 0);
  return {
    id: action.id,
    toolName: action.toolName,
    ok: !isError,
    isError,
    exitCode,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : (typeof result.durationMs === 'number' ? result.durationMs : 0),
    content: compactText(result.content || raw.stdout || raw.stderr || '', 4000),
    stdout: compactText(raw.stdout || result.stdout || '', 4000),
    stderr: compactText(raw.stderr || result.stderr || '', 2000),
    data: normalizeObject(result.data),
  };
}

function normalizeModelToolResultObservations({ toolCalls = [], toolResults = [], turn = null } = {}) {
  const toolNamesById = new Map((Array.isArray(toolCalls) ? toolCalls : [])
    .map((tool) => [String(tool?.id || '').trim(), String(tool?.name || tool?.toolName || tool?.tool_name || '').trim()])
    .filter(([id]) => Boolean(id)));
  return (Array.isArray(toolResults) ? toolResults : [])
    .filter((item) => item && typeof item === 'object' && item.type !== 'text')
    .map((item, index) => {
      const toolCallId = String(item.tool_use_id || item.toolCallId || item.id || '').trim();
      const toolName = String(item.toolName || item.tool_name || toolNamesById.get(toolCallId) || '').trim();
      const content = stringifyToolResultContent(item.content);
      return {
        id: toolCallId || `turn-${turn || 'unknown'}-tool-result-${index + 1}`,
        kind: 'model_tool_result',
        toolCallId,
        toolName,
        turn,
        ok: item.is_error !== true && item.isError !== true,
        isError: item.is_error === true || item.isError === true,
        content: compactText(content, 1000),
      };
    });
}

function stringifyToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((block) => {
    if (!block || typeof block !== 'object') return String(block || '');
    if (block.type === 'text') return String(block.text || '');
    if (block.type === 'image') return '[image]';
    try { return JSON.stringify(block); } catch { return String(block); }
  }).join('\n');
}

function summarizeModelResult(result = {}, command = {}) {
  return {
    title: result.title || '',
    status: result.status || command.status || '',
    text: compactText(result.text || result.report || result.content || '', 1000),
    final: command.final === true,
    commandType: command.type || '',
  };
}

function summarizeCommand(command = {}) {
  return {
    type: command.type || '',
    final: command.final === true,
    status: command.status || '',
    reason: command.reason || '',
    actionCount: Array.isArray(command.actions) ? command.actions.length : 0,
  };
}

function runtimeNodeForDecisionCommand(command = {}) {
  const type = String(command?.type || '').trim();
  if (type === 'finalize') return 'verify';
  if (type === 'continue') return 'decide';
  if (!type) return 'decide';
  return type;
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function summarizeToolCall(action) {
  return {
    id: action.id,
    toolName: action.toolName,
    args: action.args,
    options: action.options,
  };
}

function summarizeInterrupt(interrupt = {}) {
  return {
    id: interrupt.id || '',
    type: interrupt.type || 'manual',
    status: interrupt.status || 'pending',
    reason: interrupt.reason || '',
    message: interrupt.message || '',
    turn: interrupt.turn ?? null,
  };
}

function createTurnCheckpointIfNeeded(runtime, runId, enabled, turn, data = {}) {
  if (!enabled || !runtime?.createCheckpoint) return null;
  return runtime.createCheckpoint(runId, {
    reason: 'turn',
    label: `turn-${turn.turn}`,
    turn: turn.turn,
    data: {
      turn: {
        index: turn.index,
        turn: turn.turn,
        result: turn.result,
        command: turn.command,
        toolCalls: turn.toolCalls,
        observations: turn.observations,
      },
      ...normalizeObject(data),
    },
  });
}

function normalizeCheckpointTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const index = toNonNegativeInteger(value.index, toNonNegativeInteger(Number(value.turn) - 1, 0));
  const turn = toPositiveInteger(value.turn, index + 1);
  return {
    index,
    turn,
    result: normalizeObject(value.result),
    command: normalizeObject(value.command),
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.map(normalizePlainObject).filter(Boolean) : [],
    observations: normalizeObservationArray(value.observations),
  };
}

function normalizeExistingTurns(value) {
  return Array.isArray(value) ? value.map(normalizeCheckpointTurn).filter(Boolean) : [];
}

function normalizeObservationArray(value) {
  return Array.isArray(value) ? value.map(normalizePlainObject).filter(Boolean) : [];
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function compactText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function resolveControllerTurnLimit(value) {
  if (value === undefined || value === null || value === false) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || ['none', 'unbounded', 'runtime_policy', 'runtime-policy', 'long_running'].includes(text)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function hasControllerTurnCapacityAfter(offset, turnLimit) {
  if (turnLimit === null) return true;
  return offset < turnLimit - 1;
}

function evaluateControllerLoopStop(state = {}, { offset = 0, turnLimit = null } = {}) {
  if (turnLimit !== null && offset >= turnLimit) {
    return {
      stop: true,
      kind: 'max_turns',
      reason: `Controller turn limit reached (${turnLimit})`,
    };
  }
  const budget = state?.budget || {};
  const maxRuntimeMs = Number(budget.maxRuntimeMs || 0);
  if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) {
    const elapsedMs = getRuntimeElapsedMs(state);
    if (elapsedMs > maxRuntimeMs) {
      return {
        stop: true,
        kind: 'max_runtime_ms',
        reason: `Runtime budget exceeded (${elapsedMs}/${maxRuntimeMs} ms)`,
        elapsedMs,
        maxRuntimeMs,
      };
    }
  }
  return { stop: false };
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

module.exports = {
  dispatchControllerActions,
  evaluateRecoveryDirective,
  evaluateAgentControllerFinalization,
  recordAgentControllerObservationStep,
  recordAgentControllerDecision,
  runAgentControllerLoop,
};
