<script setup lang="ts">
// 脚本详情/编辑。4.7.6 重构：只剩名称、描述、标签、正文四项，
// 正文用 CodeMirror（shell 高亮），参数从正文里的 {{变量}} 自动识别。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import AppIcon from '@/components/AppIcon.vue';
import { isDarkTheme, languageExtensionForFile, watchDarkTheme } from '@/utils/codemirrorLang';
import { extractPlaceholders, type ScriptInfo } from '@/utils/scripts';

interface Props {
  script: ScriptInfo | null;
  isNew: boolean;
  saving: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [draft: ScriptInfo];
  delete: [];
  copy: [content: string];
  new: [];
}>();

const draft = ref<ScriptInfo | null>(null);
const tagInput = ref('');
const nameInputRef = ref<HTMLInputElement | null>(null);
const editorEl = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const themeCompartment = new Compartment();
let unwatchTheme: (() => void) | null = null;
// 标记"正文变化来自编辑器自身"，避免 watch 回写时把光标顶回开头
let syncingFromEditor = false;

const placeholders = computed(() => extractPlaceholders(draft.value?.content || ''));

const headerMeta = computed(() => {
  if (!draft.value) return '';
  if (props.isNew) return '草稿（尚未保存）';
  return `更新于 ${draft.value.updatedAt || '-'}`;
});

function buildState(doc: string, langExt: Extension): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      langExt,
      themeCompartment.of(isDarkTheme() ? oneDark : []),
      EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true; } }]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || !draft.value) return;
        syncingFromEditor = true;
        draft.value.content = update.state.doc.toString();
        void nextTick(() => { syncingFromEditor = false; });
      }),
    ],
  });
}

async function mountEditor(): Promise<void> {
  if (!editorEl.value || view.value) return;
  // 用 .sh 匹配 language-data 里的 shell 模式，零新增依赖
  const langExt = await languageExtensionForFile('script.sh');
  view.value = new EditorView({
    state: buildState(draft.value?.content || '', langExt),
    parent: editorEl.value,
  });
}

function setEditorDoc(content: string): void {
  const v = view.value;
  if (!v || syncingFromEditor) return;
  if (v.state.doc.toString() === content) return;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
}

watch(() => props.script, async (s) => {
  draft.value = s ? { ...s, tags: [...(s.tags || [])] } : null;
  await nextTick();
  if (draft.value) {
    await mountEditor();
    setEditorDoc(draft.value.content || '');
  }
  if (props.isNew && draft.value) {
    nameInputRef.value?.focus();
    nameInputRef.value?.select();
  }
}, { immediate: true });

onMounted(() => {
  unwatchTheme = watchDarkTheme((dark) => {
    view.value?.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
  });
});

onBeforeUnmount(() => {
  unwatchTheme?.();
  view.value?.destroy();
  view.value = null;
});

// ── 标签 ──────────────────────────────────────────────
function onTagKeydown(e: KeyboardEvent): void {
  if (!draft.value) return;
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const v = tagInput.value.trim();
    if (v && !draft.value.tags.includes(v)) draft.value.tags.push(v);
    tagInput.value = '';
  } else if (e.key === 'Backspace' && tagInput.value === '' && draft.value.tags.length > 0) {
    draft.value.tags.pop();
  }
}

function removeTag(tag: string): void {
  if (!draft.value) return;
  draft.value.tags = draft.value.tags.filter((t) => t !== tag);
}

function onSave(): void {
  if (!draft.value) return;
  emit('save', {
    ...draft.value,
    name: draft.value.name.trim() || '未命名脚本',
    description: draft.value.description?.trim() || '',
  });
}
</script>

<template>
  <div v-if="!draft" class="flex-1 flex flex-col items-center justify-center gap-2.5 px-8 text-center">
    <span class="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500 flex items-center justify-center">
      <AppIcon name="terminal" :size="26" />
    </span>
    <div class="text-sm font-medium text-slate-500 dark:text-slate-400">从左侧选择一个脚本，或新建一个</div>
    <div class="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed">脚本保存后，在终端页用「脚本注入」把它送进当前会话</div>
    <button
      type="button"
      class="mt-2 h-8 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
      @click="emit('new')"
    >新建脚本</button>
  </div>

  <div v-else class="flex-1 flex flex-col min-h-0">
    <!-- 头部 -->
    <div class="shrink-0 px-5 py-3 border-b border-slate-100 dark:border-[#1e293b] flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <span class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 flex items-center justify-center shrink-0">
          <AppIcon name="terminal" :size="15" />
        </span>
        <div class="min-w-0 flex-1">
          <input
            ref="nameInputRef"
            v-model="draft.name"
            type="text"
            placeholder="脚本名称"
            class="min-w-0 w-full text-[15px] font-semibold text-slate-800 dark:text-slate-100 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
          />
          <div class="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500 truncate">{{ headerMeta }}</div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-transparent text-xs text-slate-600 dark:text-slate-300 hover:border-slate-300 hover:text-slate-800 dark:hover:text-slate-100 transition-colors"
          @click="emit('copy', draft.content)"
        >复制</button>
        <button
          type="button"
          class="h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-transparent text-xs text-slate-600 dark:text-slate-300 hover:border-red-200 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          @click="emit('delete')"
        >{{ isNew ? '丢弃草稿' : '删除' }}</button>
        <button
          type="button"
          :disabled="saving"
          class="h-8 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-medium shadow-sm disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          @click="onSave"
        >{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>

    <!-- 表单 -->
    <div class="flex-1 min-h-0 flex flex-col p-5 gap-4">
      <div class="shrink-0 flex flex-col gap-1.5">
        <label class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">描述</label>
        <input
          v-model="draft.description"
          type="text"
          placeholder="一句话说明这个脚本做什么…"
          class="h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-xs text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 transition-shadow"
        />
      </div>

      <div class="shrink-0 flex flex-col gap-1.5">
        <label class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">标签</label>
        <div class="flex items-center gap-1.5 flex-wrap p-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] min-h-[40px] focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10 transition-shadow">
          <span
            v-for="tag in draft.tags"
            :key="tag"
            class="h-6 px-2.5 rounded-md border border-blue-200 bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:border-blue-500/30 dark:text-blue-300 text-[10px] font-medium flex items-center gap-1.5"
          >
            {{ tag }}
            <button type="button" class="text-blue-400 hover:text-red-500 transition-colors" @click="removeTag(tag)">✕</button>
          </span>
          <input
            v-model="tagInput"
            type="text"
            placeholder="输入标签后按 Enter…"
            class="flex-1 min-w-[100px] h-6 px-2 bg-transparent text-[11px] text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none border-none"
            @keydown="onTagKeydown"
          />
        </div>
      </div>

      <!-- 正文 -->
      <div class="flex-1 min-h-0 flex flex-col gap-1.5">
        <div class="flex items-center justify-between shrink-0">
          <label class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">脚本内容</label>
          <span class="text-[10px] text-slate-400 dark:text-slate-500">
            用
            <code class="font-mono text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/10 px-1 py-px rounded" v-text="'{{变量名}}'"></code>
            声明参数，注入时会让你填
          </span>
        </div>
        <div
          ref="editorEl"
          class="flex-1 min-h-0 overflow-hidden rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10 transition-shadow"
        ></div>
        <div class="shrink-0 flex items-center gap-1.5 flex-wrap text-[10px] min-h-[18px]">
          <template v-if="placeholders.length > 0">
            <span class="text-slate-500 dark:text-slate-400">识别到 {{ placeholders.length }} 个参数：</span>
            <code
              v-for="p in placeholders"
              :key="p"
              class="font-mono px-1.5 py-px rounded-md bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"
            >{{ p }}</code>
          </template>
          <span v-else class="text-slate-400 dark:text-slate-500">无参数</span>
        </div>
      </div>
    </div>
  </div>
</template>
