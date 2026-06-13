'use strict';

const { AGENT_EVENT_TYPES } = require('./constants');

function createAgentEvent(state, type, payload = {}, now = new Date()) {
  const eventType = normalizeEventType(type);
  return {
    type: eventType,
    runId: state?.runId || payload.runId || '',
    source: state?.source || payload.source || 'console',
    at: toIso(now),
    payload: normalizeObject(payload),
  };
}

function pushAgentEvent(state, type, payload = {}) {
  const event = createAgentEvent(state, type, payload);
  if (state && typeof state === 'object') {
    if (!Array.isArray(state.events)) state.events = [];
    state.events.push(event);
    state.updatedAt = event.at;
  }
  return event;
}

function normalizeEventType(type) {
  const text = String(type || '').trim();
  return AGENT_EVENT_TYPES.includes(text) ? text : 'agent:run-ended';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value || Date.now()).toISOString();
}

module.exports = {
  createAgentEvent,
  pushAgentEvent,
};
