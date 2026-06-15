export interface IdeStreamEvent {
  v?: number;
  type?: string;
  sessionId?: string;
  runId?: string | null;
  payload?: Record<string, unknown>;
  ts?: number;
}

export interface IdeEventSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener?: (...args: unknown[]) => void): unknown;
}

export type IdeLegacyHandler = [event: string, handler: (...args: unknown[]) => void];

const TYPE_TO_LEGACY_EVENT: Record<string, string> = {
  thinking: 'ide:thinking',
  text: 'ide:text',
  text_delta: 'ide:text-delta',
  tool_start: 'ide:tool-start',
  tool_end: 'ide:tool-end',
  tool_delta: 'ide:tool-delta',
  tool_call: 'ide:tool-call',
  done: 'ide:done',
  error: 'ide:error',
  cancelled: 'ide:cancelled',
  approval_request: 'ide:approve-request',
  ask_user: 'ide:ask-user',
  secret_request: 'ide:secret-request',
  authoring_session: 'ide:authoring-session',
  authoring_interaction: 'ide:authoring-interaction',
  authoring_artifact: 'ide:authoring-artifact',
  task_saved: 'ide:task-saved',
  mcp_status: 'ide:mcp-status',
};

function isIdeStreamEvent(value: unknown): value is IdeStreamEvent {
  return Boolean(value && typeof value === 'object' && typeof (value as IdeStreamEvent).type === 'string');
}

function eventPayload(event: IdeStreamEvent): Record<string, unknown> {
  return {
    ...(event.payload || {}),
    sessionId: event.sessionId,
    runId: event.runId || undefined,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(eventName: string, payload: unknown): string {
  try {
    return `${eventName}:${stableStringify(payload)}`;
  } catch {
    return `${eventName}:${String(payload)}`;
  }
}

export function bindIdeStreamHandlers(socket: IdeEventSocket, handlers: IdeLegacyHandler[]): () => void {
  const handlerMap = new Map<string, Array<(...args: unknown[]) => void>>();
  const unifiedFingerprints = new Set<string>();
  const legacyTimers = new Set<ReturnType<typeof setTimeout>>();
  const fingerprintTimers = new Set<ReturnType<typeof setTimeout>>();
  const boundHandlers: IdeLegacyHandler[] = [];

  for (const [event, handler] of handlers) {
    if (!event.startsWith('ide:')) continue;
    const list = handlerMap.get(event) || [];
    list.push(handler);
    handlerMap.set(event, list);
  }

  function rememberUnified(key: string): void {
    unifiedFingerprints.add(key);
    const timer = setTimeout(() => {
      fingerprintTimers.delete(timer);
      unifiedFingerprints.delete(key);
    }, 250);
    fingerprintTimers.add(timer);
  }

  const onUnified = (raw: unknown) => {
    if (!isIdeStreamEvent(raw)) return;
    const eventName = TYPE_TO_LEGACY_EVENT[raw.type || ''];
    const eventHandlers = eventName ? handlerMap.get(eventName) : undefined;
    if (!eventName || !eventHandlers?.length) return;
    const payload = eventPayload(raw);
    rememberUnified(fingerprint(eventName, payload));
    for (const handler of eventHandlers) handler(payload);
  };

  socket.on('ide:event', onUnified);
  boundHandlers.push(['ide:event', onUnified]);

  for (const [eventName, handler] of handlers) {
    if (!eventName.startsWith('ide:')) {
      socket.on(eventName, handler);
      boundHandlers.push([eventName, handler]);
      continue;
    }

    const legacyFallback = (...args: unknown[]) => {
      const payload = args[0];
      const key = fingerprint(eventName, payload);
      const timer = setTimeout(() => {
        legacyTimers.delete(timer);
        if (!unifiedFingerprints.has(key)) handler(...args);
      }, 75);
      legacyTimers.add(timer);
    };
    socket.on(eventName, legacyFallback);
    boundHandlers.push([eventName, legacyFallback]);
  }

  return () => {
    for (const timer of legacyTimers) clearTimeout(timer);
    for (const timer of fingerprintTimers) clearTimeout(timer);
    legacyTimers.clear();
    fingerprintTimers.clear();
    unifiedFingerprints.clear();
    for (const [event, handler] of boundHandlers) socket.off?.(event, handler);
  };
}
