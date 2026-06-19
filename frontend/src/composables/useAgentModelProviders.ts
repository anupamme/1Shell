import { computed, ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';

export interface AgentModelProvider {
  id: string;
  name: string;
  apiBase?: string;
  apiKeySet?: boolean;
  model: string;
  upstreamProtocol?: string;
  enabled?: boolean;
}

export function useAgentModelProviders() {
  const { requestJson } = useApiClient();
  const providers = ref<AgentModelProvider[]>([]);
  const activeProviderId = ref<string | null>(null);
  const modelPreference = ref('默认模型');
  const loading = ref(false);

  const enabledProviders = computed(() => providers.value.filter((provider) => provider.enabled !== false));

  async function loadProviders(): Promise<void> {
    loading.value = true;
    try {
      const resp = await requestJson<{ ok: boolean; providers: AgentModelProvider[]; activeProviderId: string | null }>('/api/agent/providers/skills');
      if (!resp.ok) return;
      providers.value = resp.providers || [];
      activeProviderId.value = resp.activeProviderId || null;
      const active = providers.value.find((provider) => provider.id === activeProviderId.value);
      modelPreference.value = active?.model || '默认模型';
    } finally {
      loading.value = false;
    }
  }

  async function selectProvider(providerId: string | null): Promise<string> {
    if (!providerId) {
      modelPreference.value = '默认模型';
      return modelPreference.value;
    }

    const provider = providers.value.find((item) => item.id === providerId);
    const nextModel = provider?.model || '默认模型';
    modelPreference.value = nextModel;
    if (providerId !== activeProviderId.value) {
      await requestJson(`/api/agent/providers/skills/${providerId}/activate`, { method: 'PUT' });
      activeProviderId.value = providerId;
    }
    return nextModel;
  }

  return {
    providers,
    enabledProviders,
    activeProviderId,
    modelPreference,
    loading,
    loadProviders,
    selectProvider,
  };
}
