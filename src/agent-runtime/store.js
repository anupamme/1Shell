'use strict';

function createMemoryAgentStore({ clone = false } = {}) {
  const runs = new Map();

  function maybeClone(value) {
    return clone ? cloneAgentState(value) : value;
  }

  return {
    getRun(runId) {
      return maybeClone(runs.get(runId) || null);
    },

    saveRun(state) {
      const normalized = normalizeStoredState(state);
      runs.set(normalized.runId, maybeClone(normalized));
      return maybeClone(runs.get(normalized.runId));
    },

    listRuns() {
      return Array.from(runs.values()).map(maybeClone);
    },

    deleteRun(runId) {
      return runs.delete(runId);
    },

    clear() {
      runs.clear();
    },
  };
}

function normalizeAgentStore(store = null) {
  const selected = store || createMemoryAgentStore();
  if (!selected || typeof selected !== 'object') throw new Error('Agent runtime store must be an object');
  if (typeof selected.getRun !== 'function') throw new Error('Agent runtime store.getRun is required');
  if (typeof selected.saveRun !== 'function') throw new Error('Agent runtime store.saveRun is required');
  if (typeof selected.listRuns !== 'function') throw new Error('Agent runtime store.listRuns is required');
  return selected;
}

function cloneAgentState(state) {
  if (!state) return state;
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

function normalizeStoredState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Agent state must be an object');
  const runId = String(state.runId || '').trim();
  if (!runId) throw new Error('Agent state.runId is required');
  return state;
}

module.exports = {
  cloneAgentState,
  createMemoryAgentStore,
  normalizeAgentStore,
};
