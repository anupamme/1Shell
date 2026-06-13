import { bindIdeStreamHandlers, type IdeEventSocket, type IdeLegacyHandler } from '@/utils/ideStreamEvents';
import { createStreamDeltaBuffer, type StreamDeltaBuffer } from '@/utils/streaming';
import {
  appendAiLine,
  appendAiStreamDelta,
  appendAiToolLog,
  appendAiToolNote,
  finishAiToolCall,
  markAiAssistantStatus,
  startAiToolCall,
  summarizeToolValue,
  toolDisplayName,
  type AiAssistantTurn,
  type AiLineKind,
} from '@/utils/aiMessages';

export interface AiAgentSocketMessage {
  sessionId?: string;
  runId?: string;
}

export interface AiAgentNarrationEvent {
  runId?: string;
  payload?: {
    sessionId?: string;
    runId?: string;
    kind?: string;
    message?: string;
    text?: string;
    stage?: string;
    data?: {
      toolCallId?: string;
      providerToolUseId?: string;
      [key: string]: unknown;
    };
  };
}

export interface AiAgentApprovePayload extends AiAgentSocketMessage {
  requestId?: string;
  title?: string;
  toolName?: string;
  detail?: string;
}

export type AiAgentApproveRequest = AiAgentApprovePayload & { requestId: string };

export type AiAgentUserInputKind = 'ask_user' | 'request_secret';

export interface AiAgentUserInputPayload extends AiAgentSocketMessage {
  requestId?: string;
  title?: string;
  toolName?: string;
  detail?: string;
  question?: string;
  reason?: string;
  options?: string[];
  secretName?: string;
  label?: string;
  provider?: string;
  responseEvent?: string;
}

export type AiAgentUserInputRequest = AiAgentUserInputPayload & {
  requestId: string;
  kind: AiAgentUserInputKind;
  responseEvent: 'ide:ask-user-response' | 'ide:secret-response';
};

export interface AiAgentStreamController {
  readonly currentTextHadDelta: boolean;
  matchesCurrentRun(msg: AiAgentSocketMessage | null | undefined, options?: { allowStopped?: boolean; allowAfterStop?: boolean }): boolean;
  rememberStoppedRun(runId?: string | null): void;
  resetForNewRun(): void;
  resetForNewSession(): void;
  markStopRequested(): void;
  clearStopRequested(): void;
  setCurrentTextHadDelta(value: boolean): void;
}

export interface AiAgentStreamCallbacks {
  setStatus(text: string): void;
  finalize(): void;
  appendLine?: (kind: AiLineKind, text: string) => void;
  appendDelta?: (text: string) => void;
  flushDelta?: () => void;
  ensureAssistant?: () => AiAssistantTurn;
  getAssistant?: () => AiAssistantTurn | null;
  touchAssistant?: () => void;
  onToolStart?: (msg: AiAgentSocketMessage & { name?: string; toolUseId?: string; input?: unknown; phase?: string }) => void;
  onToolDelta?: (msg: AiAgentSocketMessage & { toolUseId?: string; stream?: string; text?: string }) => void;
  onToolEnd?: (msg: AiAgentSocketMessage & { result?: unknown; is_error?: boolean; toolUseId?: string }) => void;
  onDone?: (msg: AiAgentSocketMessage & { round?: number; taskStatus?: string }) => void;
  onError?: (msg: AiAgentSocketMessage & { error?: string }) => void;
  onCancelled?: (msg: AiAgentSocketMessage) => void;
  onApproveRequest?: (msg: AiAgentApproveRequest) => void;
  onUserInputRequest?: (msg: AiAgentUserInputRequest) => void;
  onNarration?: (msg: AiAgentSocketMessage & { kind?: AiLineKind; message?: string; stage?: string; toolUseId?: string }) => void;
}

function normalizeNarrationLineKind(kind: string | undefined): AiLineKind {
  if (kind === 'error' || kind === 'success' || kind === 'info' || kind === 'thought') return kind;
  return 'thought';
}

function normalizeNarrationEvent(raw: unknown): (AiAgentSocketMessage & { kind?: AiLineKind; message?: string; stage?: string; toolUseId?: string }) | null {
  const event = raw as AiAgentNarrationEvent;
  const payload = event?.payload || {};
  const message = String(payload.message || payload.text || '').trim();
  if (!message) return null;
  return {
    sessionId: payload.sessionId,
    runId: payload.runId || event.runId || undefined,
    kind: normalizeNarrationLineKind(payload.kind),
    message,
    stage: payload.stage,
    toolUseId: String(payload.data?.providerToolUseId || payload.data?.toolCallId || '').trim() || undefined,
  };
}

function suppressStandaloneNarration(stage: string | undefined): boolean {
  return stage === 'approval' || stage === 'recover';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

function compactText(value: unknown, maxLength = 160): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function isPreparingToolInput(msg: { phase?: string; input?: unknown }): boolean {
  return msg.phase === 'preparing_input' || msg.input === null;
}

function isToolPreparationDelta(text: string): boolean {
  return /参数已生成|正在准备\s+\S+\s+参数|prepar(?:e|ing).{0,30}(argument|input)/i.test(text);
}

function commandIntent(command: string): string {
  const cmd = command.toLowerCase();
  if (/os-release|whoami|pwd|uname|docker\s+--version|docker\s+compose\s+version/.test(cmd)) return '我先确认目标主机的系统、用户和运行环境。';
  if (/git\s+clone|git\s+-c|git\s+fetch|git\s+reset|git\s+pull/.test(cmd)) return '我在准备项目代码，并确认仓库当前状态。';
  if (/readme|deploy|compose|dockerfile|\.env|grep|sed\s+-n|find\s+\./.test(cmd)) return '我在读取项目文档和部署配置，确认应该采用哪种部署方式。';
  if (/docker\s+compose\s+(config|ps|logs)/.test(cmd)) return '我在检查 Compose 配置和服务状态。';
  if (/docker\s+compose\s+up|docker\s+compose\s+pull|docker\s+compose\s+build/.test(cmd)) return '我开始按项目配置启动服务，并会继续观察启动结果。';
  if (/curl|wget|ss\s+|netstat|lsof|systemctl\s+status/.test(cmd)) return '我在验证服务是否真的可访问，以及端口和进程状态是否正确。';
  if (/mkdir|cp\s+|cat\s+>|tee\s+|chmod|chown|touch/.test(cmd)) return '我在准备运行目录和配置文件，后面会验证这些改动是否生效。';
  return '我准备执行下一步操作，并会根据输出继续判断。';
}

function narrativeForToolStart(name = '', input: unknown): string {
  const tool = String(name || '').trim();
  const record = asRecord(input);
  if (tool === 'execute_command' || tool === 'host_exec') {
    return commandIntent(textField(record, 'command'));
  }
  if (tool === 'list_hosts') return '我先确认当前可以操作哪些主机。';
  if (tool === 'get_probe' || tool === 'query_probe') return '我在读取探针数据，先用事实判断主机状态。';
  if (tool === 'read_remote_file' || tool === 'read_file') return '我在读取相关文件内容，确认真实配置。';
  if (tool === 'list_remote_dir') return '我在查看目标目录结构，确认下一步从哪里入手。';
  if (tool === 'verify_outcome') return '我开始验证结果是否真的成立。';
  if (tool === 'ask_user') return '我需要先补齐一个关键条件，再继续执行。';
  if (tool === 'request_secret') return '这一步需要使用凭据引用，我会等待你选择已保存的 Secret。';
  if (tool === 'create_task' || tool === 'write_task' || tool === 'package_agent_run') return '我在整理这次执行证据，准备形成任务草稿。';
  return `我准备使用 ${toolDisplayName(tool)}。`;
}

function summarizeFailure(result: unknown): string {
  const text = summarizeToolValue(result, 2000);
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/shell connection closed/i.test(normalized)) return '远程 shell 连接中断';
  if (/timeout|超时/i.test(normalized)) return compactText(normalized.match(/(?:命令执行超时|timeout)[^。;]*/i)?.[0] || normalized, 120);
  if (/approval denied|用户拒绝/i.test(normalized)) return '操作未获批准';
  if (/harness|拦截|blocked/i.test(normalized)) return compactText(normalized, 140);
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return compactText(firstLine || normalized || '工具返回错误', 140);
}

function narrativeForToolSuccess(name = ''): string {
  const tool = String(name || '').trim();
  if (tool === 'list_hosts') return '已确认可用主机，继续检查目标环境。';
  if (tool === 'get_probe' || tool === 'query_probe') return '探针数据已读到，我会基于这些指标继续判断。';
  if (tool === 'verify_outcome') return '验证步骤已返回，我会根据证据决定是否收尾。';
  return '';
}

export function createAiAgentStreamController(getSessionId: () => string | null): AiAgentStreamController {
  let currentTextHadDelta = false;
  let activeRunId: string | null = null;
  let stopRequested = false;
  const stoppedRunIds = new Set<string>();

  function rememberStoppedRun(runId = activeRunId): void {
    if (!runId) return;
    stoppedRunIds.add(runId);
    if (stoppedRunIds.size > 20) {
      const firstStopped = stoppedRunIds.values().next().value;
      if (firstStopped) stoppedRunIds.delete(firstStopped);
    }
  }

  return {
    get currentTextHadDelta() { return currentTextHadDelta; },
    matchesCurrentRun(msg, options = {}) {
      if (!msg || msg.sessionId !== getSessionId()) return false;
      if (msg.runId) {
        if (stoppedRunIds.has(msg.runId) && !options.allowStopped) return false;
        if (activeRunId && msg.runId !== activeRunId) return false;
        activeRunId = msg.runId;
      }
      if (stopRequested && !options.allowAfterStop) return false;
      return true;
    },
    rememberStoppedRun,
    resetForNewRun() {
      activeRunId = null;
      stopRequested = false;
      currentTextHadDelta = false;
    },
    resetForNewSession() {
      activeRunId = null;
      stopRequested = false;
      currentTextHadDelta = false;
      stoppedRunIds.clear();
    },
    markStopRequested() { stopRequested = true; },
    clearStopRequested() { stopRequested = false; },
    setCurrentTextHadDelta(value) { currentTextHadDelta = value; },
  };
}

export function createAiAssistantDeltaBuffer(ensureAssistant: () => AiAssistantTurn, touchAssistant: () => void): StreamDeltaBuffer {
  return createStreamDeltaBuffer((flushed) => {
    appendAiStreamDelta(ensureAssistant(), flushed);
    touchAssistant();
  });
}

export function appendAiAssistantLine(
  deltaBuffer: StreamDeltaBuffer,
  ensureAssistant: () => AiAssistantTurn,
  touchAssistant: () => void,
  kind: AiLineKind,
  text: string,
): void {
  deltaBuffer.flushNow();
  appendAiLine(ensureAssistant(), kind, text);
  touchAssistant();
}

export function bindAiAgentStreamHandlers(
  socket: IdeEventSocket,
  controller: AiAgentStreamController,
  callbacks: AiAgentStreamCallbacks,
  extraHandlers: IdeLegacyHandler[] = [],
): () => void {
  const flushDelta = () => callbacks.flushDelta?.();
  const toolMeta = new Map<string, { name: string; input: unknown }>();
  const narratedKeys = new Set<string>();

  function rememberNarration(key: string): boolean {
    if (!key || narratedKeys.has(key)) return false;
    narratedKeys.add(key);
    if (narratedKeys.size > 200) {
      const first = narratedKeys.values().next().value;
      if (first) narratedKeys.delete(first);
    }
    return true;
  }

  function appendNarrationOnce(key: string, kind: AiLineKind, text: string): void {
    const normalized = text.trim();
    if (!normalized || !rememberNarration(key)) return;
    flushDelta();
    callbacks.appendLine?.(kind, normalized);
  }

  function appendToolNarrationOnce(key: string, toolUseId: string | undefined, kind: AiLineKind, text: string): void {
    const normalized = text.trim();
    if (!toolUseId) {
      appendNarrationOnce(key, kind, normalized);
      return;
    }
    const textKey = kind === 'error' ? '' : `tool-note:${kind}:${normalized.replace(/\s+/g, ' ')}`;
    if (!normalized || (textKey && narratedKeys.has(textKey)) || !rememberNarration(key)) return;
    if (textKey) rememberNarration(textKey);
    flushDelta();
    if (callbacks.onNarration) {
      callbacks.onNarration({ kind, message: normalized, toolUseId });
      return;
    }
    const assistant = callbacks.getAssistant?.();
    if (assistant && callbacks.touchAssistant && appendAiToolNote(assistant, toolUseId, kind, normalized)) {
      callbacks.touchAssistant();
    }
  }

  const handlers: IdeLegacyHandler[] = [
    ['agent:narration', (raw: unknown) => {
      const m = normalizeNarrationEvent(raw);
      if (!m || !controller.matchesCurrentRun(m)) return;
      if (!m.toolUseId && suppressStandaloneNarration(m.stage)) {
        callbacks.setStatus(m.stage === 'act' ? '执行中...' : '思考中...');
        return;
      }
      flushDelta();
      if (callbacks.onNarration) {
        callbacks.onNarration(m);
      } else if (m.toolUseId && callbacks.getAssistant && callbacks.touchAssistant) {
        const assistant = callbacks.getAssistant();
        if (assistant && appendAiToolNote(assistant, m.toolUseId, m.kind || 'thought', m.message || '')) {
          callbacks.touchAssistant();
        }
      } else if (!suppressStandaloneNarration(m.stage)) {
        callbacks.appendLine?.(m.kind || 'thought', m.message || '');
      }
      callbacks.setStatus(m.stage === 'act' ? '执行中...' : '思考中...');
    }],
    ['ide:thinking', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage;
      if (!controller.matchesCurrentRun(m)) return;
      controller.setCurrentTextHadDelta(false);
      callbacks.setStatus('思考中...');
    }],
    ['ide:text', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { text?: string };
      if (!controller.matchesCurrentRun(m) || !m.text || controller.currentTextHadDelta) return;
      callbacks.appendDelta?.(m.text);
    }],
    ['ide:text-delta', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { delta?: string };
      if (!controller.matchesCurrentRun(m) || !m.delta) return;
      controller.setCurrentTextHadDelta(true);
      callbacks.setStatus('生成中...');
      callbacks.appendDelta?.(m.delta);
    }],
    ['ide:tool-start', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { name?: string; toolUseId?: string; input?: unknown; phase?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (isPreparingToolInput(m)) {
        callbacks.setStatus('正在准备工具参数...');
        return;
      }
      if (m.toolUseId) toolMeta.set(m.toolUseId, { name: m.name || 'unknown', input: m.input });
      if (callbacks.onToolStart) {
        callbacks.onToolStart(m);
        appendToolNarrationOnce(`${m.runId || ''}:${m.toolUseId || ''}:tool-start`, m.toolUseId, 'thought', narrativeForToolStart(m.name || 'unknown', m.input));
        return;
      }
      if (!callbacks.ensureAssistant || !callbacks.touchAssistant) return;
      flushDelta();
      startAiToolCall(callbacks.ensureAssistant(), m.toolUseId || `tool-${Date.now()}`, m.name || 'unknown', m.input);
      callbacks.touchAssistant();
      appendToolNarrationOnce(`${m.runId || ''}:${m.toolUseId || ''}:tool-start`, m.toolUseId, 'thought', narrativeForToolStart(m.name || 'unknown', m.input));
      callbacks.setStatus(m.name ? `调用 ${m.name}...` : '调用工具...');
    }],
    ['ide:tool-delta', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { toolUseId?: string; stream?: string; text?: string };
      if (!controller.matchesCurrentRun(m) || !m.toolUseId || !m.text) return;
      if (isToolPreparationDelta(m.text)) {
        callbacks.setStatus('正在准备工具参数...');
        return;
      }
      if (callbacks.onToolDelta) {
        callbacks.onToolDelta(m);
        return;
      }
      const assistant = callbacks.getAssistant?.();
      if (!assistant || !callbacks.touchAssistant) return;
      flushDelta();
      if (appendAiToolLog(assistant, m.toolUseId, m.stream === 'stderr' ? 'stderr' : 'stdout', m.text)) {
        callbacks.touchAssistant();
        callbacks.setStatus('工具执行中...');
      }
    }],
    ['ide:tool-end', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { result?: unknown; is_error?: boolean; toolUseId?: string };
      if (!controller.matchesCurrentRun(m)) return;
      const meta = m.toolUseId ? toolMeta.get(m.toolUseId) : undefined;
      const narration = m.is_error
        ? `这一步失败了：${summarizeFailure(m.result)}。我会根据失败原因调整下一步。`
        : narrativeForToolSuccess(meta?.name || '');
      if (callbacks.onToolEnd) {
        callbacks.onToolEnd(m);
      } else {
        const assistant = callbacks.getAssistant?.();
        if (assistant && m.toolUseId && callbacks.touchAssistant && finishAiToolCall(assistant, m.toolUseId, Boolean(m.is_error), m.result)) {
          callbacks.touchAssistant();
        }
      }
      if (narration) {
        appendToolNarrationOnce(
          `${m.runId || ''}:${m.toolUseId || ''}:${m.is_error ? 'tool-error' : 'tool-success'}`,
          m.toolUseId,
          m.is_error ? 'error' : 'thought',
          narration,
        );
      }
      callbacks.setStatus(m.is_error ? '工具返回错误' : '思考中...');
      if (callbacks.onToolEnd) {
        if (m.toolUseId) toolMeta.delete(m.toolUseId);
        return;
      }
      if (m.toolUseId) toolMeta.delete(m.toolUseId);
    }],
    ['ide:done', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { round?: number; taskStatus?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (callbacks.onDone) {
        callbacks.onDone(m);
        return;
      }
      flushDelta();
      const assistant = callbacks.getAssistant?.();
      markAiAssistantStatus(assistant || null, 'done');
      callbacks.touchAssistant?.();
      callbacks.setStatus(`完成 (${m.round ?? 0} 轮)`);
      callbacks.finalize();
    }],
    ['ide:error', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage & { error?: string };
      if (!controller.matchesCurrentRun(m)) return;
      if (callbacks.onError) {
        callbacks.onError(m);
        return;
      }
      callbacks.setStatus('出错');
      callbacks.appendLine?.('error', `✘ ${m.error || '未知错误'}`);
      callbacks.finalize();
    }],
    ['ide:cancelled', (msg: unknown) => {
      const m = msg as AiAgentSocketMessage;
      if (!controller.matchesCurrentRun(m, { allowStopped: true, allowAfterStop: true })) return;
      const cancelKey = `cancelled:${m.runId || m.sessionId || 'current'}`;
      if (!rememberNarration(cancelKey)) return;
      if (callbacks.onCancelled) {
        callbacks.onCancelled(m);
        return;
      }
      flushDelta();
      const assistant = callbacks.getAssistant?.();
      markAiAssistantStatus(assistant || null, 'cancelled');
      callbacks.touchAssistant?.();
      controller.rememberStoppedRun(m.runId);
      callbacks.setStatus('已取消');
      callbacks.finalize();
    }],
    ['ide:approve-request', (msg: unknown) => {
      const m = msg as AiAgentApprovePayload;
      if (!controller.matchesCurrentRun(m) || !m.requestId) return;
      callbacks.onApproveRequest?.({ ...m, requestId: m.requestId });
    }],
    ['ide:ask-user', (msg: unknown) => {
      const m = msg as AiAgentUserInputPayload;
      if (!controller.matchesCurrentRun(m) || !m.requestId) return;
      callbacks.onUserInputRequest?.({
        ...m,
        requestId: m.requestId,
        kind: 'ask_user',
        responseEvent: 'ide:ask-user-response',
      });
    }],
    ['ide:secret-request', (msg: unknown) => {
      const m = msg as AiAgentUserInputPayload;
      if (!controller.matchesCurrentRun(m) || !m.requestId) return;
      callbacks.onUserInputRequest?.({
        ...m,
        requestId: m.requestId,
        kind: 'request_secret',
        responseEvent: 'ide:secret-response',
      });
    }],
    ...extraHandlers,
  ];

  return bindIdeStreamHandlers(socket, handlers);
}
