<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppConfigSidebar from '@/components/AppConfigSidebar.vue';
</script>

<template>
  <div class="panel-shell flex h-full">
    <AppConfigSidebar />
    <div class="panel-content flex-1 min-w-0 overflow-hidden">
      <RouterView />
    </div>
  </div>
</template>
