<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useApiClient } from '@/composables/useApiClient';

interface SecretInfo {
  id: string;
  name: string;
  type: string;
  created_at?: string;
  updated_at?: string;
}

interface SecretListResponse {
  secrets?: SecretInfo[];
}

interface SecretSaveResponse {
  secret?: SecretInfo;
}

interface Props {
  secretName?: string;
  label?: string;
  provider?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  submit: [secretRef: string];
}>();

const { requestJson } = useApiClient();

const secrets = ref<SecretInfo[]>([]);
const selectedSecretId = ref('');
const loading = ref(false);
const saving = ref(false);
const errorText = ref('');
const createOpen = ref(false);
const newName = ref('');
const newType = ref('generic');
const newValue = ref('');

const requestedLabel = computed(() => props.label || props.secretName || 'secret');

function normalizeSecretType(value: string): string {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'generic';
}

function resetCreateDefaults(): void {
  newName.value = String(props.secretName || props.label || '').trim() || 'secret';
  newType.value = normalizeSecretType(props.provider || 'generic');
  newValue.value = '';
}

async function loadSecrets(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await requestJson<SecretListResponse>('/api/secrets');
    secrets.value = data.secrets || [];
    if (!selectedSecretId.value && secrets.value.length > 0) {
      selectedSecretId.value = secrets.value[0].id;
    }
  } catch (err) {
    errorText.value = (err as Error).message || '加载凭据失败';
  } finally {
    loading.value = false;
  }
}

function submitSelected(): void {
  if (!selectedSecretId.value) {
    errorText.value = '请先选择一个已保存凭据。';
    return;
  }
  emit('submit', selectedSecretId.value);
}

async function saveAndSubmit(): Promise<void> {
  const name = newName.value.trim();
  const type = normalizeSecretType(newType.value);
  const value = newValue.value;
  if (!name) {
    errorText.value = '凭据名称不能为空。';
    return;
  }
  if (!value) {
    errorText.value = '凭据内容不能为空。';
    return;
  }
  saving.value = true;
  errorText.value = '';
  try {
    const data = await requestJson<SecretSaveResponse>('/api/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, type, value }),
    });
    if (!data.secret?.id) throw new Error('保存成功但未返回 secret ref');
    secrets.value = [data.secret, ...secrets.value.filter((item) => item.id !== data.secret?.id)];
    selectedSecretId.value = data.secret.id;
    newValue.value = '';
    emit('submit', data.secret.id);
  } catch (err) {
    errorText.value = (err as Error).message || '保存凭据失败';
  } finally {
    saving.value = false;
  }
}

watch(
  () => [props.secretName, props.label, props.provider],
  () => {
    selectedSecretId.value = '';
    createOpen.value = false;
    resetCreateDefaults();
    void loadSecrets();
  },
  { immediate: true },
);
</script>

<template>
  <div class="secret-ref-picker">
    <div class="secret-ref-picker-head">
      <span>Secret Manager</span>
      <button type="button" class="secret-ref-picker-link" :disabled="loading" @click="loadSecrets">
        {{ loading ? '加载中...' : '刷新' }}
      </button>
    </div>
    <div class="secret-ref-picker-hint">
      为 {{ requestedLabel }} 选择已保存凭据，或在这里保存新凭据；聊天和 AgentRun trace 只接收 secret ref。
    </div>

    <div class="secret-ref-picker-row">
      <select v-model="selectedSecretId" class="secret-ref-picker-select" :disabled="loading || secrets.length === 0">
        <option value="">{{ secrets.length ? '选择已保存凭据' : '暂无已保存凭据' }}</option>
        <option v-for="secret in secrets" :key="secret.id" :value="secret.id">
          {{ secret.type }}/{{ secret.name }} · {{ secret.id }}
        </option>
      </select>
      <button type="button" class="secret-ref-picker-primary" :disabled="!selectedSecretId" @click="submitSelected">
        使用
      </button>
    </div>

    <button type="button" class="secret-ref-picker-toggle" @click="createOpen = !createOpen">
      {{ createOpen ? '收起新建凭据' : '保存新凭据并使用' }}
    </button>

    <div v-if="createOpen" class="secret-ref-picker-create">
      <input v-model="newName" class="secret-ref-picker-input" type="text" placeholder="凭据名称，如 cloudflare_api_token" />
      <input v-model="newType" class="secret-ref-picker-input" type="text" placeholder="类型/平台，如 cloudflare" />
      <input v-model="newValue" class="secret-ref-picker-input" type="password" autocomplete="off" placeholder="粘贴密钥明文（仅发送到 Secret Manager 加密保存）" />
      <button type="button" class="secret-ref-picker-primary" :disabled="saving" @click="saveAndSubmit">
        {{ saving ? '保存中...' : '保存并使用' }}
      </button>
    </div>

    <div v-if="errorText" class="secret-ref-picker-error">{{ errorText }}</div>
  </div>
</template>

<style scoped>
.secret-ref-picker {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.06);
  font-size: 11px;
}

.secret-ref-picker-head,
.secret-ref-picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.secret-ref-picker-head {
  justify-content: space-between;
  font-weight: 700;
  color: #2563eb;
}

.secret-ref-picker-hint {
  margin: 5px 0 8px;
  color: #64748b;
  line-height: 1.45;
}

.secret-ref-picker-select,
.secret-ref-picker-input {
  min-width: 0;
  flex: 1;
  padding: 6px 8px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 8px;
  background: #fff;
  color: #0f172a;
  font-size: 11px;
}

.secret-ref-picker-create {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.secret-ref-picker-link,
.secret-ref-picker-toggle {
  border: 0;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
  font-size: 11px;
}

.secret-ref-picker-toggle {
  margin-top: 7px;
  padding: 0;
}

.secret-ref-picker-primary {
  flex: none;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

.secret-ref-picker-primary:disabled,
.secret-ref-picker-link:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.secret-ref-picker-error {
  margin-top: 6px;
  color: #dc2626;
}

:global(.dark) .secret-ref-picker {
  border-color: rgba(96, 165, 250, 0.28);
  background: rgba(30, 64, 175, 0.18);
}

:global(.dark) .secret-ref-picker-hint {
  color: #94a3b8;
}

:global(.dark) .secret-ref-picker-select,
:global(.dark) .secret-ref-picker-input {
  border-color: rgba(71, 85, 105, 0.9);
  background: #0f172a;
  color: #e2e8f0;
}
</style>
