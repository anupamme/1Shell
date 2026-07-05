<script setup lang="ts">
// 右栏文件面板（M3 IDE 壳）：CodeMirror 6 代码编辑 + 图片 / Markdown 预览。
// 读写与 rail 文件浏览器同一套 /api/files API；点击工具卡文件 chip 时打开。
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import { isDarkTheme, languageExtensionForFile, watchDarkTheme } from '@/utils/codemirrorLang';
import { renderMarkdown } from '@/utils/markdown';

const props = withDefaults(defineProps<{
  path: string;
  hostId?: string;
  line?: number;
  currentSessionId?: string;
}>(), {
  hostId: 'local',
  line: undefined,
  currentSessionId: '',
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'open-session', id: string): void;
}>();

const { requestJson } = useApiClient();
const notify = useNotifyStore();

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];

const loading = ref(false);
const error = ref('');
const dirty = ref(false);
const saving = ref(false);
const imageUrl = ref('');
const mdPreview = ref(false);
const mdPreviewHtml = ref('');
// 文件反查会话：哪些会话触碰过这个文件（当前会话除外）
interface RelatedSession {
  id: string;
  title: string;
  modelLabel?: string;
  updatedAt?: string;
}
const relatedSessions = ref<RelatedSession[]>([]);
const showSessions = ref(false);
const editorEl = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
let savedContent = '';
let lastBlobUrl = '';
let loadSeq = 0;

const fileName = computed(() => {
  const normalized = String(props.path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized.split('/').pop() || normalized;
});
const isImage = computed(() => IMAGE_EXTS.includes((fileName.value.split('.').pop() || '').toLowerCase()));
const isMarkdown = computed(() => /\.(md|markdown)$/i.test(fileName.value));

let stopThemeWatch: (() => void) | null = null;

function clearBlobUrl(): void {
  if (lastBlobUrl) {
    URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = '';
  }
}

function editorDoc(): string {
  return view.value ? view.value.state.doc.toString() : savedContent;
}

function buildEditorState(doc: string, langExt: Extension): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      keymap.of([{ key: 'Mod-s', run: () => { void save(); return true; } }]),
      languageCompartment.of(langExt),
      themeCompartment.of(isDarkTheme() ? oneDark : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) dirty.value = editorDoc() !== savedContent;
      }),
    ],
  });
}

function scrollToLine(line: number | undefined): void {
  const editor = view.value;
  if (!editor || !line || line < 1) return;
  const target = Math.min(line, editor.state.doc.lines);
  const pos = editor.state.doc.line(target).from;
  editor.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
}

async function loadFile(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = '';
  dirty.value = false;
  mdPreview.value = false;
  mdPreviewHtml.value = '';
  imageUrl.value = '';
  clearBlobUrl();

  try {
    if (isImage.value) {
      const params = new URLSearchParams({ hostId: props.hostId, path: props.path });
      const resp = await fetch(`/api/files/download?${params}`);
      if (!resp.ok) throw new Error('加载失败');
      const blob = await resp.blob();
      if (seq !== loadSeq) return;
      lastBlobUrl = URL.createObjectURL(blob);
      imageUrl.value = lastBlobUrl;
      return;
    }
    const params = new URLSearchParams({ hostId: props.hostId, path: props.path });
    const data = await requestJson<{ content?: string }>(`/api/files/read?${params}`);
    if (seq !== loadSeq) return;
    savedContent = data.content || '';
    const langExt = await languageExtensionForFile(fileName.value);
    if (seq !== loadSeq) return;
    if (view.value) {
      view.value.setState(buildEditorState(savedContent, langExt));
    }
    // Markdown 默认进预览态（阅读优先），一键切回编辑
    if (isMarkdown.value) {
      mdPreviewHtml.value = renderMarkdown(savedContent, { tables: 'safe' });
      mdPreview.value = true;
    }
    scrollToLine(props.line);
  } catch (err) {
    if (seq === loadSeq) error.value = (err as Error).message || '读取失败';
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function loadRelatedSessions(): Promise<void> {
  const seq = loadSeq;
  relatedSessions.value = [];
  showSessions.value = false;
  try {
    const params = new URLSearchParams({ path: props.path });
    const data = await requestJson<{ sessions?: RelatedSession[] }>(`/api/agent/sessions/by-file?${params}`);
    if (seq !== loadSeq) return;
    relatedSessions.value = (data.sessions || []).filter((s) => s.id && s.id !== props.currentSessionId);
  } catch {
    // 反查是辅助信息，失败静默
  }
}

function openSession(id: string): void {
  showSessions.value = false;
  emit('open-session', id);
}

function sessionTimeLabel(value: string | undefined): string {
  if (!value) return '';
  const t = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString();
}

async function save(): Promise<void> {
  if (saving.value || isImage.value || loading.value) return;
  const content = editorDoc();
  saving.value = true;
  try {
    await requestJson('/api/files/write', {
      method: 'POST',
      body: JSON.stringify({ hostId: props.hostId, path: props.path, content }),
    });
    savedContent = content;
    dirty.value = false;
    notify.success('保存成功');
  } catch (err) {
    notify.error(`保存失败: ${(err as Error).message}`);
  } finally {
    saving.value = false;
  }
}

function toggleMdPreview(): void {
  if (!isMarkdown.value) return;
  if (!mdPreview.value) {
    mdPreviewHtml.value = renderMarkdown(editorDoc(), { tables: 'safe' });
    mdPreview.value = true;
  } else {
    mdPreview.value = false;
  }
}

function copyPath(): void {
  navigator.clipboard?.writeText(props.path).then(() => {
    notify.success('路径已复制');
  }).catch(() => { /* 静默 */ });
}

onMounted(() => {
  if (editorEl.value) {
    view.value = new EditorView({ state: buildEditorState('', []), parent: editorEl.value });
  }
  stopThemeWatch = watchDarkTheme((dark) => {
    view.value?.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
  });
  void loadFile();
  void loadRelatedSessions();
});

watch(() => [props.path, props.hostId], () => {
  void loadFile();
  void loadRelatedSessions();
});
watch(() => props.line, (line) => {
  if (!loading.value && !isImage.value) scrollToLine(line);
});

onBeforeUnmount(() => {
  stopThemeWatch?.();
  view.value?.destroy();
  view.value = null;
  clearBlobUrl();
});
</script>

<template>
  <aside class="agent-file-panel flex flex-col min-w-0 min-h-0 h-full bg-white/90 dark:bg-[#0d111b]/95">
    <!-- header -->
    <div class="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-slate-200/80 dark:border-white/[0.06] select-none">
      <AppIcon name="file" :size="14" class="shrink-0 text-slate-400 dark:text-slate-500" />
      <button
        class="min-w-0 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:text-sky-600 dark:hover:text-sky-300 transition-colors cursor-pointer"
        :title="`${path}（点击复制路径）`"
        @click="copyPath"
      >
        <span class="truncate">{{ fileName }}</span>
        <span v-if="dirty" class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="有未保存修改"></span>
      </button>
      <div class="ml-auto flex items-center gap-1 shrink-0">
        <div v-if="relatedSessions.length" class="relative">
          <button
            type="button"
            class="h-7 px-2 rounded-md text-[11px] border border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-300 hover:border-sky-300 dark:hover:border-sky-400/30 transition-colors cursor-pointer inline-flex items-center gap-1"
            title="触碰过此文件的其它会话"
            @click="showSessions = !showSessions"
          >
            <AppIcon name="message-circle" :size="11" />
            会话 {{ relatedSessions.length }}
          </button>
          <div v-if="showSessions" class="absolute top-full right-0 mt-1.5 w-64 max-h-72 overflow-y-auto bg-white dark:bg-[#161b2a] border border-slate-200 dark:border-white/[0.08] rounded-lg shadow-xl z-30 py-1">
            <button
              v-for="s in relatedSessions"
              :key="s.id"
              type="button"
              class="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-white/[0.04] cursor-pointer"
              @click="openSession(s.id)"
            >
              <div class="text-xs text-slate-700 dark:text-slate-200 truncate">{{ s.title || '未命名会话' }}</div>
              <div class="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-600">
                <span v-if="s.modelLabel" class="truncate">{{ s.modelLabel }}</span>
                <span v-if="sessionTimeLabel(s.updatedAt)" class="shrink-0">{{ sessionTimeLabel(s.updatedAt) }}</span>
              </div>
            </button>
          </div>
        </div>
        <button
          v-if="isMarkdown"
          type="button"
          class="h-7 px-2 rounded-md text-[11px] border transition-colors cursor-pointer"
          :class="mdPreview
            ? 'border-sky-300 dark:border-sky-400/30 text-sky-600 dark:text-sky-300 bg-sky-50 dark:bg-sky-400/10'
            : 'border-slate-200 dark:border-white/[0.08] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'"
          :title="mdPreview ? '切换到编辑' : '预览 Markdown'"
          @click="toggleMdPreview"
        >{{ mdPreview ? '编辑' : '预览' }}</button>
        <button
          v-if="!isImage"
          type="button"
          class="h-7 px-2 rounded-md text-[11px] border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          :class="dirty
            ? 'border-amber-300 dark:border-amber-400/30 text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/10 hover:bg-amber-100 dark:hover:bg-amber-400/15'
            : 'border-slate-200 dark:border-white/[0.08] text-slate-400 dark:text-slate-500'"
          :disabled="!dirty || saving"
          title="保存 (Ctrl+S)"
          @click="save"
        >{{ saving ? '保存中…' : '保存' }}</button>
        <button
          type="button"
          class="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          title="关闭文件面板"
          @click="emit('close')"
        >
          <AppIcon name="close" :size="14" />
        </button>
      </div>
    </div>

    <!-- body -->
    <div class="flex-1 min-h-0 relative">
      <div v-if="error" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center bg-white/95 dark:bg-[#0d111b]/95">
        <AppIcon name="alert" :size="20" class="text-red-400" />
        <div class="text-xs font-semibold text-slate-700 dark:text-slate-200">文件加载失败</div>
        <div class="text-[11px] text-slate-400 dark:text-slate-500 break-all">{{ error }}</div>
      </div>
      <div v-else-if="loading" class="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-[#0d111b]/70">
        <span class="text-xs text-slate-400 dark:text-slate-500 animate-pulse">加载中…</span>
      </div>

      <!-- 三个容器都常驻（v-show）：编辑器依赖 onMounted 时 editorEl 存在 -->
      <div v-show="isImage" class="h-full overflow-auto flex items-center justify-center p-4 bg-slate-50/60 dark:bg-[#090d15]">
        <img v-if="imageUrl" :src="imageUrl" :alt="fileName" class="max-w-full max-h-full object-contain rounded-md shadow-sm" />
      </div>
      <div
        v-show="!isImage && mdPreview"
        class="h-full overflow-y-auto px-5 py-4 markdown-body agent-file-md text-sm leading-relaxed text-slate-700 dark:text-slate-200"
        v-html="mdPreviewHtml"
      ></div>
      <div v-show="!isImage && !mdPreview" ref="editorEl" class="agent-file-editor h-full min-h-0"></div>
    </div>
  </aside>
</template>

<style scoped>
.agent-file-editor :deep(.cm-editor) {
  height: 100%;
  font-size: 12.5px;
  background: transparent;
}

.agent-file-editor :deep(.cm-editor.cm-focused) {
  outline: none;
}

.agent-file-editor :deep(.cm-scroller) {
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  line-height: 1.6;
}

.agent-file-editor :deep(.cm-gutters) {
  background: transparent;
  border-right: 1px solid rgba(148, 163, 184, 0.18);
}

.agent-file-md {
  word-break: break-word;
  overflow-wrap: anywhere;
}
</style>
