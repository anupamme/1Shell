import { computed, ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';

export interface AgentModelProfile {
  id: string;
  apiModel: string;
  displayName?: string;
  enabled?: boolean;
  reasoningEffort?: string;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
}

export interface AgentModelProvider {
  id: string;
  name: string;
  apiBase?: string;
  apiKeySet?: boolean;
  model: string;
  upstreamProtocol?: string;
  reasoningEffort?: string;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
  activeModelId?: string | null;
  routeModelId?: string | null;
  models?: AgentModelProfile[];
  enabled?: boolean;
}

export interface AgentModelRoute {
  providerId?: string | null;
  modelId?: string | null;
}

export interface AgentModelOption {
  key: string;
  providerId: string;
  modelId: string | null;
  providerName: string;
  label: string;
  apiModel: string;
  reasoningEffort?: string;
  contextTokenLimit?: number | null;
  maxOutputTokens?: number | null;
}

function modelKey(providerId: string | null | undefined, modelId: string | null | undefined): string {
  return providerId ? `${providerId}::${modelId || ''}` : '';
}

function providerModelProfiles(provider: AgentModelProvider): AgentModelProfile[] {
  const models = (provider.models || []).filter((model) => model.enabled !== false);
  if (models.length > 0) return models;
  return [{
    id: provider.routeModelId || provider.activeModelId || 'default',
    apiModel: provider.model || '',
    displayName: provider.model || '',
    enabled: true,
    reasoningEffort: provider.reasoningEffort,
    contextTokenLimit: provider.contextTokenLimit,
    maxOutputTokens: provider.maxOutputTokens,
  }];
}

export function useAgentModelProviders() {
  const { requestJson } = useApiClient();
  const providers = ref<AgentModelProvider[]>([]);
  const activeProviderId = ref<string | null>(null);
  const activeModelId = ref<string | null>(null);
  const modelPreference = ref('默认模型');
  const loading = ref(false);

  const enabledProviders = computed(() => providers.value.filter((provider) => provider.enabled !== false));
  const modelOptions = computed<AgentModelOption[]>(() => enabledProviders.value.flatMap((provider) => (
    providerModelProfiles(provider).map((model) => ({
      key: modelKey(provider.id, model.id),
      providerId: provider.id,
      modelId: model.id || null,
      providerName: provider.name || '未命名渠道',
      label: model.displayName || model.apiModel || provider.model || '未指定模型',
      apiModel: model.apiModel || provider.model || '',
      reasoningEffort: model.reasoningEffort || provider.reasoningEffort,
      contextTokenLimit: model.contextTokenLimit ?? provider.contextTokenLimit ?? null,
      maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens ?? null,
    }))
  )));
  const activeModelKey = computed(() => modelKey(activeProviderId.value, activeModelId.value));

  function findOption(providerId: string | null, modelId: string | null = null): AgentModelOption | null {
    if (!providerId) return null;
    return modelOptions.value.find((option) => option.providerId === providerId && option.modelId === modelId)
      || modelOptions.value.find((option) => option.providerId === providerId)
      || null;
  }

  function applyLocalRoute(providerId: string | null, modelId: string | null): AgentModelOption | null {
    activeProviderId.value = providerId;
    activeModelId.value = modelId;
    const option = findOption(providerId, modelId);
    modelPreference.value = option?.label || '默认模型';
    if (option) {
      const provider = providers.value.find((item) => item.id === option.providerId);
      if (provider) {
        provider.routeModelId = option.modelId;
        provider.activeModelId = option.modelId;
        provider.model = option.apiModel;
        provider.reasoningEffort = option.reasoningEffort;
        provider.contextTokenLimit = option.contextTokenLimit ?? null;
        provider.maxOutputTokens = option.maxOutputTokens ?? null;
      }
    }
    return option;
  }

  async function loadProviders(): Promise<void> {
    loading.value = true;
    try {
      const resp = await requestJson<{ ok: boolean; providers: AgentModelProvider[]; activeProviderId: string | null; activeRoute?: AgentModelRoute | null }>('/api/agent/providers/skills');
      if (!resp.ok) return;
      providers.value = resp.providers || [];
      activeProviderId.value = resp.activeRoute?.providerId || resp.activeProviderId || null;
      const active = providers.value.find((provider) => provider.id === activeProviderId.value);
      activeModelId.value = resp.activeRoute?.modelId || active?.routeModelId || active?.activeModelId || null;
      const option = findOption(activeProviderId.value, activeModelId.value);
      if (option) modelPreference.value = option.label;
      else modelPreference.value = active?.model || '默认模型';
    } finally {
      loading.value = false;
    }
  }

  async function selectProvider(providerId: string | null, modelId: string | null = null): Promise<string> {
    if (!providerId) {
      modelPreference.value = '默认模型';
      return modelPreference.value;
    }

    const option = findOption(providerId, modelId);
    const nextModelId = option?.modelId || modelId || null;
    const nextModel = option?.label || '默认模型';
    modelPreference.value = nextModel;
    if (providerId !== activeProviderId.value || nextModelId !== activeModelId.value) {
      await requestJson(`/api/agent/providers/skills/${providerId}/activate`, {
        method: 'PUT',
        body: JSON.stringify(nextModelId ? { modelId: nextModelId } : {}),
      });
    }
    applyLocalRoute(providerId, nextModelId);
    return nextModel;
  }

  return {
    providers,
    enabledProviders,
    modelOptions,
    activeProviderId,
    activeModelId,
    activeModelKey,
    modelPreference,
    loading,
    loadProviders,
    selectProvider,
  };
}
