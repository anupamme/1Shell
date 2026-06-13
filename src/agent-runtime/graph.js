'use strict';

const AGENT_NODE_NAMES = Object.freeze([
  'queued',
  'understand',
  'observe',
  'plan',
  'decide',
  'act',
  'verify',
  'recover',
  'ask_user',
  'request_secret',
  'request_approval',
  'interrupted',
  'finalize',
  'block',
  'blocked',
  'cancelled',
]);

const DEFAULT_AGENT_GRAPH = Object.freeze({
  name: 'default-agent-run-graph',
  start: 'understand',
  terminal: ['finalize', 'blocked', 'cancelled'],
  edges: Object.freeze({
    queued: ['understand', 'cancelled'],
    understand: ['observe', 'plan', 'decide', 'interrupted', 'blocked'],
    observe: ['plan', 'decide', 'verify', 'recover', 'finalize', 'interrupted', 'blocked'],
    plan: ['decide', 'act', 'verify', 'recover', 'ask_user', 'request_secret', 'request_approval', 'finalize', 'block', 'interrupted', 'blocked'],
    decide: ['plan', 'act', 'verify', 'recover', 'ask_user', 'request_secret', 'request_approval', 'finalize', 'block', 'interrupted', 'blocked'],
    act: ['observe', 'verify', 'recover', 'interrupted', 'blocked'],
    verify: ['observe', 'recover', 'finalize', 'blocked'],
    recover: ['plan', 'decide', 'act', 'ask_user', 'request_secret', 'request_approval', 'block', 'blocked'],
    ask_user: ['interrupted', 'observe', 'blocked'],
    request_secret: ['interrupted', 'observe', 'blocked'],
    request_approval: ['interrupted', 'observe', 'blocked'],
    interrupted: ['observe', 'plan', 'decide', 'blocked', 'cancelled'],
    block: ['blocked'],
    finalize: [],
    blocked: [],
    cancelled: [],
  }),
});

function normalizeAgentNodeName(value, fallback = DEFAULT_AGENT_GRAPH.start) {
  const text = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (text === 'continue') return 'decide';
  if (text === 'done' || text === 'finish' || text === 'final') return 'finalize';
  if (text === 'approval') return 'request_approval';
  if (text === 'secret') return 'request_secret';
  if (text === 'ask' || text === 'question') return 'ask_user';
  if (AGENT_NODE_NAMES.includes(text)) return text;
  return fallback;
}

function validateAgentTransition({ from = '', to = '' } = {}, graph = DEFAULT_AGENT_GRAPH) {
  const normalizedFrom = normalizeAgentNodeName(from, graph.start);
  const normalizedTo = normalizeAgentNodeName(to, graph.start);
  if (normalizedFrom === normalizedTo) {
    return { ok: true, from: normalizedFrom, to: normalizedTo, reason: 'same_node' };
  }
  const allowed = Array.isArray(graph.edges?.[normalizedFrom]) ? graph.edges[normalizedFrom] : [];
  if (allowed.includes(normalizedTo)) {
    return { ok: true, from: normalizedFrom, to: normalizedTo, reason: '' };
  }
  return {
    ok: false,
    from: normalizedFrom,
    to: normalizedTo,
    reason: `invalid_transition:${normalizedFrom}->${normalizedTo}`,
    allowed,
  };
}

function summarizeAgentGraph(graph = DEFAULT_AGENT_GRAPH) {
  return {
    name: graph.name || DEFAULT_AGENT_GRAPH.name,
    start: graph.start || DEFAULT_AGENT_GRAPH.start,
    terminal: Array.isArray(graph.terminal) ? [...graph.terminal] : [...DEFAULT_AGENT_GRAPH.terminal],
    nodeCount: AGENT_NODE_NAMES.length,
  };
}

module.exports = {
  AGENT_NODE_NAMES,
  DEFAULT_AGENT_GRAPH,
  normalizeAgentNodeName,
  summarizeAgentGraph,
  validateAgentTransition,
};
