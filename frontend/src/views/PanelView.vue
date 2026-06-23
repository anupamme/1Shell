<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppSidebar from '@/components/AppSidebar.vue';
</script>

<template>
  <div class="panel-shell flex h-full">
    <AppSidebar />
    <div class="panel-content flex-1 min-w-0 overflow-hidden">
      <RouterView v-slot="{ Component, route }">
        <KeepAlive>
          <component :is="Component" :key="route.name" />
        </KeepAlive>
      </RouterView>
    </div>
  </div>
</template>
