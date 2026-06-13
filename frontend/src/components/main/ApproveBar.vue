<script setup lang="ts">
// ApproveBar.vue — MainConsole · 1Shell AI Agent 审批条
// 1:1 复刻 [public/index.html:538-557](public/index.html#L538-L557) + [public/ide-panel.js:310-353](public/ide-panel.js#L310-L353)
// fixed bottom 4 + slide-up 动画；120s 倒计时由 useIdePanel 驱动
import { useIdePanel } from '@/composables/useIdePanel';
import SecretRefPicker from '@/components/SecretRefPicker.vue';

const ide = useIdePanel();

function onCustomKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ide.approveCustom();
  }
}

function onSecretRefSubmit(secretRef: string): void {
  ide.approveCustomText.value = secretRef;
  ide.approveCustom();
}
</script>

<template>
  <Transition name="approve-bar">
    <div v-if="ide.approveRequest.value" class="approve-bar">
      <div class="approve-bar-head">
        <span>🛡</span>
        <span class="approve-bar-title">{{ ide.approveRequest.value.title }}</span>
        <span class="approve-bar-countdown">{{ ide.approveRequest.value.countdown }}s</span>
      </div>
      <div class="approve-bar-body">
        <div class="approve-bar-desc">
          <template v-if="ide.approveRequest.value.mode === 'approval'">AI 要执行 {{ ide.approveRequest.value.toolName }}：</template>
          <template v-else-if="ide.approveRequest.value.mode === 'request_secret'">AI 需要 Secret 引用：</template>
          <template v-else>AI 需要你补充信息：</template>
        </div>
        <pre class="approve-bar-detail">{{ ide.approveRequest.value.detail }}</pre>
        <SecretRefPicker
          v-if="ide.approveRequest.value.mode === 'request_secret'"
          :secret-name="ide.approveRequest.value.secretName"
          :label="ide.approveRequest.value.label"
          :provider="ide.approveRequest.value.provider"
          @submit="onSecretRefSubmit"
        />
      </div>
      <div class="approve-bar-foot">
        <button type="button" class="approve-bar-deny" @click="ide.approveDeny">✕ 拒绝</button>
        <div class="approve-bar-custom">
          <input
            v-model="ide.approveCustomText.value"
            type="text"
            class="approve-bar-custom-input"
            :placeholder="ide.approveRequest.value.mode === 'request_secret' ? '填写 secret ref/id...' : '自定义回复...'"
            @keydown="onCustomKeydown"
          />
          <button type="button" class="approve-bar-custom-btn" @click="ide.approveCustom">回复</button>
        </div>
        <button v-if="ide.approveRequest.value.mode === 'approval'" type="button" class="approve-bar-allow" @click="ide.approveAllow">✓ 允许</button>
      </div>
    </div>
  </Transition>
</template>
