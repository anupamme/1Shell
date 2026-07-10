<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { ensureImageBlob } from '@/utils/imageBlob';

// 附件图片缩略图：/api/files/download 返回 octet-stream 且全局 nosniff，
// <img> 直连会被浏览器拦下，必须 fetch → blob URL（与 AgentFilePanel 同款）。
// 点击直接放大成全屏灯箱（复用同一个 blob URL，不二次请求）。
const props = withDefaults(defineProps<{
  path: string;
  hostId?: string;
  alt?: string;
}>(), { hostId: 'local', alt: '' });

const url = ref('');
const failed = ref(false);
const expanded = ref(false);
let blobUrl = '';
let loadSeq = 0;

function clearBlobUrl(): void {
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = '';
  }
}

async function load(): Promise<void> {
  const seq = ++loadSeq;
  failed.value = false;
  url.value = '';
  clearBlobUrl();
  if (!props.path) return;
  try {
    const params = new URLSearchParams({ hostId: props.hostId, path: props.path });
    const resp = await fetch(`/api/files/download?${params}`);
    if (!resp.ok) throw new Error('加载失败');
    const blob = ensureImageBlob(await resp.blob(), props.path);
    if (seq !== loadSeq) return;
    blobUrl = URL.createObjectURL(blob);
    url.value = blobUrl;
  } catch {
    if (seq === loadSeq) failed.value = true;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

function open(): void {
  if (!url.value) return;
  expanded.value = true;
  window.addEventListener('keydown', onKeydown);
}

function close(): void {
  expanded.value = false;
  window.removeEventListener('keydown', onKeydown);
}

watch(() => [props.path, props.hostId], () => { void load(); }, { immediate: true });
onBeforeUnmount(() => {
  close();
  clearBlobUrl();
});
</script>

<template>
  <button
    type="button"
    class="block rounded-lg border border-slate-200 dark:border-white/[0.08] overflow-hidden bg-slate-50 dark:bg-white/[0.03] hover:border-slate-300 dark:hover:border-white/[0.16] transition-colors cursor-zoom-in"
    :title="alt || path"
    @click="open"
  >
    <img v-if="url" :src="url" :alt="alt" class="block max-h-44 max-w-[240px] object-contain" loading="lazy" />
    <span v-else class="w-28 h-20 flex items-center justify-center text-slate-400 dark:text-slate-500">
      <AppIcon :name="failed ? 'alert' : 'image'" :size="16" />
    </span>
  </button>

  <!-- 点击放大：全屏灯箱，点任意处 / Esc 关闭 -->
  <Teleport to="body">
    <div
      v-if="expanded"
      class="fixed inset-0 z-[2300] flex items-center justify-center bg-slate-950/80 backdrop-blur-[2px] p-6 cursor-zoom-out"
      @click="close"
    >
      <img :src="url" :alt="alt" class="max-w-[94vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" />
      <div class="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[80vw] truncate px-3 py-1 rounded-full bg-black/50 text-[12px] text-white/90">{{ alt || path }}</div>
      <button
        type="button"
        class="absolute top-4 right-4 w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center cursor-pointer"
        title="关闭"
        @click.stop="close"
      >
        <AppIcon name="close" :size="16" />
      </button>
    </div>
  </Teleport>
</template>
