'use strict';

const { getAllManifests } = require('../cli-manifest');
const {
  AGENT_DEFAULT_PROVIDER,
} = require('../../config/env');

function createAgentProviders({ nativeCliConfig } = {}) {
  function createProviderFromManifest(manifest) {
    return {
      id: manifest.id,
      label: manifest.name,
      command({ useLocalEnv } = {}) {
        if (nativeCliConfig) {
          return nativeCliConfig.getLaunchCommand?.(manifest.id) || manifest.binary;
        }
        return manifest.binary;
      },
      args({ useLocalEnv } = {}) {
        return [...(manifest.launchArgs || [])];
      },
      env({ host, hostId, useLocalEnv } = {}) {
        return {
          FORCE_COLOR: '1',
          TERM: 'xterm-256color',
        };
      },
    };
  }

  const providers = getAllManifests().map(createProviderFromManifest);
  const providerMap = new Map(providers.map(p => [p.id, p]));

  function listProviders() {
    const scanById = new Map();
    if (nativeCliConfig?.getScanInfo) {
      for (const tool of nativeCliConfig.getScanInfo()) {
        scanById.set(tool.id, tool);
      }
    }
    return providers.map(p => {
      let configured = false;
      let activeProviderName = '';
      let upstreamProtocol = '';
      let model = '';
      let activeProviderId = '';
      let activeModelId = null;
      let models = [];
      const scan = scanById.get(p.id);
      if (nativeCliConfig) {
        const summary = nativeCliConfig.getProviderSummary?.(p.id) || {};
        configured = Boolean(summary.providerReady);
        activeProviderId = summary.activeProvider?.id || '';
        activeProviderName = summary.activeProvider?.name || '';
        upstreamProtocol = summary.activeProvider?.upstreamProtocol || '';
        model = summary.activeProvider?.model || '';
        activeModelId = summary.activeProvider?.activeModelId || summary.activeProvider?.activeRoute?.modelId || null;
        models = Array.isArray(summary.activeProvider?.models) ? summary.activeProvider.models : [];
      }
      return {
        id: p.id,
        label: p.label,
        isDefault: p.id === AGENT_DEFAULT_PROVIDER,
        installed: scan?.binary?.installed !== false,
        binaryPath: scan?.binary?.path || '',
        binaryVersion: scan?.binary?.version || '',
        configured,
        activeProviderId,
        activeProviderName,
        activeModelId,
        upstreamProtocol,
        model,
        models,
      };
    });
  }

  function getProvider(providerId = AGENT_DEFAULT_PROVIDER) {
    return providerMap.get(providerId)
      || providerMap.get(AGENT_DEFAULT_PROVIDER)
      || providers[0]
      || null;
  }

  return { getProvider, listProviders };
}

module.exports = { createAgentProviders };
