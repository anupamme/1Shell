'use strict';

function createVerifierRegistry(resolvers = []) {
  const items = [];
  for (const resolver of resolvers) addResolver(resolver);

  function addResolver(resolver = {}) {
    if (!resolver || typeof resolver !== 'object' || Array.isArray(resolver)) return null;
    const id = String(resolver.id || resolver.name || '').trim();
    const resolve = resolver.resolve || resolver.buildAction || resolver.build_action;
    if (!id || typeof resolve !== 'function') return null;
    const item = {
      id,
      priority: Number.isFinite(Number(resolver.priority)) ? Number(resolver.priority) : 0,
      supports: typeof resolver.supports === 'function' ? resolver.supports : null,
      resolve,
    };
    const existingIndex = items.findIndex((current) => current.id === id);
    if (existingIndex >= 0) items[existingIndex] = item;
    else items.push(item);
    items.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    return item;
  }

  function resolveRequirement(state = {}, requirement = {}, options = {}) {
    const attempts = [];
    for (const resolver of items) {
      if (resolver.supports && resolver.supports({ state, requirement, options }) !== true) continue;
      try {
        const resolved = resolver.resolve({ state, requirement, options });
        attempts.push({ resolverId: resolver.id, matched: Boolean(resolved) });
        if (!resolved) continue;
        const actions = Array.isArray(resolved) ? resolved : [resolved];
        return {
          actions: actions.map((action) => normalizeVerifierAction(action, requirement, resolver.id)).filter(Boolean),
          resolverId: resolver.id,
          attempts,
        };
      } catch (err) {
        attempts.push({ resolverId: resolver.id, matched: false, error: err.message });
      }
    }
    return { actions: [], resolverId: '', attempts };
  }

  function listResolvers() {
    return items.map((item) => ({ id: item.id, priority: item.priority }));
  }

  return {
    addResolver,
    listResolvers,
    resolveRequirement,
  };
}

function createDefaultVerifierRegistry() {
  return createVerifierRegistry([
    createOutputContractResolver(),
    createSideEffectHintResolver(),
  ]);
}

function normalizeVerifierRegistry(value = null) {
  if (value && typeof value.resolveRequirement === 'function') return value;
  if (Array.isArray(value)) return createVerifierRegistry(value);
  return createDefaultVerifierRegistry();
}

function createOutputContractResolver() {
  return {
    id: 'output_contract',
    priority: 100,
    supports: ({ requirement }) => requirement?.source === 'output_contract',
    resolve: ({ state, requirement, options }) => buildActionFromVerifierSpec({
      state,
      requirement,
      verifier: normalizeObject(requirement.verifier),
      options,
    }),
  };
}

function createSideEffectHintResolver() {
  return {
    id: 'side_effect_hint',
    priority: 50,
    supports: ({ requirement }) => requirement?.source === 'side_effect' || requirement?.source === 'side_effect_ledger',
    resolve: ({ state, requirement, options }) => {
      const verifier = normalizeObject(requirement.verifier);
      const hinted = Object.keys(verifier).length > 0 ? verifier : findSideEffectVerifierHint(state, requirement);
      if (!hinted) return null;
      return buildActionFromVerifierSpec({ state, requirement, verifier: hinted, options });
    },
  };
}

function buildActionFromVerifierSpec({ state = {}, requirement = {}, verifier = {}, options = {} } = {}) {
  const type = normalizeVerifierType(verifier.type || requirement.type || 'command');
  const hostId = String(verifier.hostId || verifier.host_id || options.hostId || state?.spec?.context?.hostId || 'local').trim() || 'local';
  const base = {
    requirementId: String(requirement.id || ''),
    type,
    toolName: 'verify_outcome',
    hostId,
    target: requirement.summary || '',
    options: { capability: 'verify' },
  };

  if (type === 'command') {
    const command = renderCommand(verifier.run || verifier.command || '', options.inputs, options.renderTemplate);
    if (!command) return null;
    return {
      ...base,
      args: {
        type: 'command',
        reason: verifier.reason || requirement.summary || 'Verify command.',
        hostId,
        command,
        contains: verifier.contains || verifier.expect_contains || '',
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: `${hostId}: ${command.slice(0, 300)}`,
    };
  }

  if (type === 'http') {
    const url = renderCommand(verifier.url || '', options.inputs, options.renderTemplate);
    if (!url) return null;
    return {
      ...base,
      args: {
        type: 'http',
        reason: verifier.reason || requirement.summary || 'Verify HTTP endpoint.',
        url,
        method: verifier.method || 'GET',
        expectedStatus: verifier.expectedStatus || verifier.expected_status,
        contains: verifier.contains || '',
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: url,
    };
  }

  if (type === 'file_exists') {
    const filePath = renderCommand(verifier.path || verifier.file || '', options.inputs, options.renderTemplate);
    if (!filePath) return null;
    return {
      ...base,
      args: {
        type: 'file_exists',
        reason: verifier.reason || requirement.summary || 'Verify file exists.',
        hostId,
        path: filePath,
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: `${hostId}: ${filePath}`,
    };
  }

  if (type === 'port') {
    const port = Number(renderCommand(verifier.port || '', options.inputs, options.renderTemplate));
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      ...base,
      args: {
        type: 'port',
        reason: verifier.reason || requirement.summary || 'Verify TCP port.',
        hostId,
        host: verifier.host || '',
        port,
        timeout: toPositiveInt(verifier.timeout || verifier.timeout_ms, options.defaultTimeoutMs || 30000),
      },
      target: `${verifier.host || hostId}:${port}`,
    };
  }

  return null;
}

function findSideEffectVerifierHint(state = {}, requirement = {}) {
  const sideEffects = Array.isArray(state?.runtimeState?.worldState?.sideEffects)
    ? state.runtimeState.worldState.sideEffects
    : [];
  const id = String(requirement.id || '').replace(/^side-effect-/, '');
  const item = sideEffects.find((effect) => (
    String(effect.id || '') === id
    || String(effect.toolCallId || '') === id
    || String(effect.id || '') === String(requirement.sideEffectId || requirement.side_effect_id || '')
  ));
  const hint = item?.verifier || item?.verificationHint || item?.verification_hint || item?.data?.verifier || item?.data?.verificationHint || item?.data?.verification_hint;
  return hint && typeof hint === 'object' && !Array.isArray(hint) ? { ...hint } : null;
}

function normalizeVerifierAction(action = {}, requirement = {}, resolverId = '') {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const toolName = String(action.toolName || action.tool_name || 'verify_outcome').trim();
  if (!toolName) return null;
  return {
    requirementId: String(action.requirementId || action.requirement_id || requirement.id || ''),
    resolverId,
    type: String(action.type || requirement.type || 'unknown'),
    toolName,
    hostId: String(action.hostId || action.host_id || ''),
    target: String(action.target || requirement.summary || ''),
    args: normalizeObject(action.args),
    options: normalizeObject(action.options),
  };
}

function normalizeVerifierType(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function renderCommand(value, inputs, renderTemplate) {
  if (typeof renderTemplate === 'function') return String(renderTemplate(value, inputs) || '').trim();
  return String(value || '').replace(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => String(inputs?.[name] ?? '')).trim();
}

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

module.exports = {
  createDefaultVerifierRegistry,
  createVerifierRegistry,
  normalizeVerifierRegistry,
};
