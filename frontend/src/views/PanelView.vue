<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppSidebar from '@/components/AppSidebar.vue';
</script>

<template>
  <div class="flex h-full">
    <AppSidebar />
    <div class="flex-1 min-w-0 overflow-hidden">
      <RouterView />
    </div>
  </div>
</template>
