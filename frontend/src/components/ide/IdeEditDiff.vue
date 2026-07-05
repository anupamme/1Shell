<script setup lang="ts">
// 工具卡 diff 渲染（M3 IDE 壳）：claude Edit/MultiEdit 的 old_string → new_string
// 用 @codemirror/merge 的 unified 视图只读展示（删除行内联划出）。
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { minimalSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { isDarkTheme, languageExtensionForFile, watchDarkTheme } from '@/utils/codemirrorLang';

const props = withDefaults(defineProps<{
  oldText: string;
  newText: string;
  fileName?: string;
}>(), {
  fileName: '',
});

const hostEl = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const themeCompartment = new Compartment();
let stopThemeWatch: (() => void) | null = null;
let buildSeq = 0;

async function build(): Promise<void> {
  const seq = ++buildSeq;
  const langExt = props.fileName ? await languageExtensionForFile(props.fileName) : [];
  if (seq !== buildSeq || !hostEl.value) return;
  view.value?.destroy();
  view.value = new EditorView({
    state: EditorState.create({
      doc: props.newText,
      extensions: [
        minimalSetup,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        unifiedMergeView({ original: props.oldText, mergeControls: false, gutter: true }),
        langExt,
        themeCompartment.of(isDarkTheme() ? oneDark : []),
      ],
    }),
    parent: hostEl.value,
  });
}

onMounted(() => {
  void build();
  stopThemeWatch = watchDarkTheme((dark) => {
    view.value?.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
  });
});

watch(() => [props.oldText, props.newText, props.fileName], () => { void build(); });

onBeforeUnmount(() => {
  stopThemeWatch?.();
  view.value?.destroy();
  view.value = null;
});
</script>

<template>
  <div ref="hostEl" class="ide-edit-diff rounded-lg border border-slate-200/70 dark:border-white/[0.05] overflow-hidden bg-slate-50 dark:bg-[#090d15]"></div>
</template>

<style scoped>
.ide-edit-diff :deep(.cm-editor) {
  font-size: 12px;
  max-height: 280px;
  background: transparent;
}

.ide-edit-diff :deep(.cm-editor.cm-focused) {
  outline: none;
}

.ide-edit-diff :deep(.cm-scroller) {
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  line-height: 1.55;
}
</style>
