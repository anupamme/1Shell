<script setup lang="ts">
// ScriptInjectPanel.vue — 终端上方的脚本注入面板
// 参数框按脚本正文里扫描出的 {{变量}} 自动生成，没有类型/必填之分。
import { computed } from 'vue';
import { useScriptInject } from '@/composables/useScriptInject';

const script = useScriptInject();

const showParams = computed(() => script.placeholders.value.length > 0);
const showPreview = computed(() => Boolean(script.selectedScript.value));
</script>

<template>
  <div v-if="script.scriptOpen.value" class="inject-panel">
    <div class="inject-panel-row">
      <span class="inject-panel-title">📜 脚本注入</span>
      <select
        class="inject-select"
        :value="script.selectedScriptId.value"
        @change="script.onScriptChange(($event.target as HTMLSelectElement).value)"
      >
        <option value="">选择脚本…</option>
        <option v-for="s in script.scripts.value" :key="s.id" :value="s.id">
          {{ s.name }}
        </option>
      </select>
      <button type="button" class="inject-close-btn" @click="script.closeScriptPanel">✕</button>
    </div>

    <div v-if="showParams" class="inject-params-row">
      <label v-for="name in script.placeholders.value" :key="name" class="inject-param">
        <span class="inject-param-label">{{ name }}</span>
        <input
          type="text"
          class="inject-param-input inject-param-input-text"
          :value="script.params[name] ?? ''"
          :placeholder="name"
          @input="script.updateParam(name, ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <div v-if="showPreview" class="inject-preview-row">
      <pre class="inject-preview-code">{{ script.previewCommand.value || '（空）' }}</pre>
      <div class="inject-preview-actions">
        <button type="button" class="inject-primary-btn" @click="script.injectScript">注入终端</button>
        <button type="button" class="inject-secondary-btn" @click="script.copyScript">复制</button>
      </div>
    </div>
  </div>
</template>
