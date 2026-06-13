'use strict';

function createCallbackModelAdapter(runTurn) {
  if (typeof runTurn !== 'function') throw new Error('runTurn must be a function');
  return { runTurn };
}

async function runModelAdapter(adapter, request = {}) {
  if (adapter?.runAgentTask) {
    return adapter.runAgentTask(request);
  }
  if (adapter?.runTurn) {
    return adapter.runTurn(request);
  }
  if (typeof adapter === 'function') {
    return adapter(request);
  }
  throw new Error('Agent model adapter is not configured');
}

function normalizeModelResult(result) {
  if (result && typeof result === 'object') return result;
  return { text: String(result || '') };
}

module.exports = {
  createCallbackModelAdapter,
  normalizeModelResult,
  runModelAdapter,
};
