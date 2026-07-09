<script setup lang="ts">
// AnalyzeContextMenu.vue — 终端右键菜单
// position: fixed 全局浮层,挂在 AgentView（终端分栏宿主页）顶层
import { useTerminalAnalyze } from '@/composables/useTerminalAnalyze';

const analyze = useTerminalAnalyze();
</script>

<template>
  <div
    v-show="analyze.ctxVisible.value"
    class="analyze-ctx-menu"
    data-analyze-ctx
    :style="{ left: analyze.ctxLeft.value + 'px', top: analyze.ctxTop.value + 'px' }"
  >
    <button type="button" class="analyze-ctx-btn" @click="analyze.copySelectedText">
      复制选区
    </button>
    <button type="button" class="analyze-ctx-btn" @click="analyze.triggerAnalysis">
      AI 分析选区
    </button>
  </div>
</template>
