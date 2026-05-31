import { ref } from 'vue';

const open = ref(false);

export function useSettingsModal() {
  function openSettings(): void { open.value = true; }
  function closeSettings(): void { open.value = false; }
  return { open, openSettings, closeSettings };
}
