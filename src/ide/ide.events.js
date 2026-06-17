'use strict';

const LEGACY_EVENT_TYPES = {
  'ide:thinking': 'thinking',
  'ide:text': 'text',
  'ide:text-delta': 'text_delta',
  'ide:tool-start': 'tool_start',
  'ide:tool-end': 'tool_end',
  'ide:tool-delta': 'tool_delta',
  'ide:tool-call': 'tool_call',
  'ide:done': 'done',
  'ide:error': 'error',
  'ide:cancelled': 'cancelled',
  'ide:approve-request': 'approval_request',
  'ide:ask-user': 'ask_user',
  'ide:secret-request': 'secret_request',
  'ide:authoring-session': 'authoring_session',
  'ide:authoring-interaction': 'authoring_interaction',
  'ide:authoring-artifact': 'authoring_artifact',
  'ide:task-saved': 'task_saved',
  'ide:compact': 'compact',
  'ide:mcp-status': 'mcp_status',
};

function streamEventFromLegacy(event, payload = {}) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const type = LEGACY_EVENT_TYPES[event] || String(event || '').replace(/^ide:/, '').replace(/-/g, '_');
  const { sessionId, runId, ...eventPayload } = data;
  return {
    v: 1,
    type,
    sessionId: sessionId || '',
    runId: runId || null,
    payload: eventPayload,
    ts: Date.now(),
  };
}

function emitIdeEvent(target, event, payload = {}) {
  if (!target?.emit || !event) return;
  if (event !== 'ide:event' && String(event).startsWith('ide:')) {
    target.emit('ide:event', streamEventFromLegacy(event, payload));
  }
  target.emit(event, payload);
}

module.exports = {
  emitIdeEvent,
  streamEventFromLegacy,
};
