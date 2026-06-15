<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import {
  type IdeChatMessage,
  type IdeThinkingTimelineItem,
  type IdeTimelineItem,
  type IdeToolTimelineItem,
} from '@/composables/useIdeChat';
import { renderMarkdown } from '@/utils/markdown';

const props = withDefaults(defineProps<{
  items: IdeTimelineItem[];
  density?: 'full' | 'compact';
}>(), {
  density: 'full',
});

function isChatMessage(item: IdeTimelineItem): item is IdeChatMessage {
  return item.kind === 'user' || item.kind === 'assistant';
}

function isThinkingItem(item: IdeTimelineItem): item is IdeThinkingTimelineItem {
  return item.kind === 'thinking';
}

function isToolItem(item: IdeTimelineItem): item is IdeToolTimelineItem {
  return item.kind === 'tool';
}

function messageIcon(item: IdeChatMessage): string {
  return item.role === 'user' ? 'terminal' : 'robot';
}

function messageLabel(item: IdeChatMessage): string {
  return item.role === 'user' ? '你' : '1Shell AI';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readPath(record: Record<string, unknown> | null, path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    const next = asRecord(current);
    if (!next) return undefined;
    current = next[key];
  }
  return current;
}

function pickString(record: Record<string, unknown> | null, paths: string[][]): string {
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function shorten(text: string, maxLength = props.density === 'compact' ? 86 : 128): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function toolDisplayName(tool: IdeToolTimelineItem): string {
  const name = tool.name.toLowerCase();
  const exactNames: Record<string, string> = {
    create_directory: '创建目录',
    list_remote_dir: '列出目录',
    read_remote_file: '读取文件',
    write_remote_file: '写入文件',
    preview_ai_task: '预览任务',
    create_ai_task: '保存任务',
    update_ai_task: '更新任务',
    get_ai_task: '读取任务',
  };
  if (exactNames[name]) return exactNames[name];
  if (name.includes('execute') || name.includes('command') || name === 'shell') return '执行命令';
  if (name.includes('probe') || name.includes('metric') || name.includes('monitor')) return '读取探针数据';
  if (name.includes('host')) return '读取主机信息';
  if (name.includes('download')) return '下载文件';
  if (name.includes('upload')) return '上传文件';
  if (name.includes('read') && name.includes('file')) return '读取文件';
  if (name.includes('write') && name.includes('file')) return '写入文件';
  if (name.includes('create') && name.includes('dir')) return '创建目录';
  if (name.includes('list') || name.includes('dir')) return '列出目录';
  if (name.includes('approval')) return '请求确认';
  if (name.includes('secret')) return '请求密钥引用';
  if (name.includes('ask')) return '询问用户';
  if (name.includes('verify')) return '验证结果';
  if (name.includes('mcp')) return '调用 MCP 工具';
  return tool.name;
}

function toolRawName(tool: IdeToolTimelineItem): string {
  const display = toolDisplayName(tool);
  return display === tool.name ? '' : tool.name;
}

function toolIcon(tool: IdeToolTimelineItem): string {
  const name = tool.name.toLowerCase();
  if (tool.status === 'error') return 'alert';
  if (name.includes('execute') || name.includes('command') || name === 'shell') return 'terminal';
  if (name.includes('probe') || name.includes('metric') || name.includes('monitor')) return 'radio';
  if (name.includes('host') || name.includes('server')) return 'server';
  if (name.includes('download')) return 'download';
  if (name.includes('upload')) return 'cloud';
  if (name.includes('file') || name.includes('dir') || name.includes('list')) return 'folder';
  if (name.includes('approval') || name.includes('permission')) return 'shield';
  if (name.includes('secret')) return 'lock';
  if (name.includes('verify')) return 'check';
  return tool.status === 'done' ? 'check' : 'wrench';
}

function toolStatusLabel(tool: IdeToolTimelineItem): string {
  if (tool.status === 'preparing') return '准备参数';
  if (tool.status === 'running') return '执行中';
  if (tool.status === 'error') return '失败';
  return '完成';
}

function toolDuration(tool: IdeToolTimelineItem): string {
  if (tool.durationMs === undefined) return '';
  if (tool.durationMs < 1000) return `${tool.durationMs} ms`;
  return `${(tool.durationMs / 1000).toFixed(1)} s`;
}

function toolPurpose(tool: IdeToolTimelineItem): string {
  if (tool.workNote?.trim()) return shorten(tool.workNote);
  const input = asRecord(tool.input);
  const direct = pickString(input, [
    ['description'],
    ['summary'],
    ['reason'],
    ['query'],
    ['url'],
    ['path'],
    ['filePath'],
    ['filename'],
    ['hostId'],
    ['host'],
    ['command'],
    ['cmd'],
    ['args', 'description'],
    ['args', 'query'],
    ['args', 'path'],
    ['args', 'filePath'],
    ['args', 'hostId'],
    ['args', 'command'],
  ]);
  if (direct) return shorten(direct);

  const result = typeof tool.result === 'string' ? tool.result : '';
  const firstLine = result.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? shorten(firstLine, props.density === 'compact' ? 72 : 100) : '';
}

function toolMeta(tool: IdeToolTimelineItem): string[] {
  return [
    toolDuration(tool),
    toolRawName(tool),
  ].filter(Boolean);
}

function hasToolInput(tool: IdeToolTimelineItem): boolean {
  return tool.input !== undefined && tool.input !== null;
}

function hasToolResult(tool: IdeToolTimelineItem): boolean {
  return tool.result !== undefined && tool.result !== null && String(tool.result).trim() !== '';
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/(?:\uFFFD|\?)\[/g, '\x1b[')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '');
}

function formatToolValue(value: unknown, maxLength = props.density === 'compact' ? 1800 : 3600): string {
  if (value === undefined || value === null) return '';
  const text = stripTerminalControl(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

function toolDefaultOpen(tool: IdeToolTimelineItem): boolean {
  return tool.status === 'preparing' || tool.status === 'running' || tool.status === 'error';
}

function toolAriaLabel(tool: IdeToolTimelineItem): string {
  const meta = toolMeta(tool).join('，');
  return `${toolDisplayName(tool)}，${toolStatusLabel(tool)}${meta ? `，${meta}` : ''}`;
}
</script>

<template>
  <div class="ide-agent-timeline" :class="`ide-agent-timeline--${density}`">
    <template v-for="item in items" :key="item.id">
      <article
        v-if="isChatMessage(item)"
        class="ide-agent-message"
        :class="item.role === 'user' ? 'ide-agent-message--user' : 'ide-agent-message--assistant'"
      >
        <div class="ide-agent-message-meta">
          <AppIcon :name="messageIcon(item)" :size="14" />
          <span>{{ messageLabel(item) }}</span>
        </div>
        <div class="ide-agent-bubble">
          <div
            v-if="item.text"
            class="markdown-body ide-agent-markdown"
            v-html="renderMarkdown(item.text)"
          ></div>
          <div v-else class="ide-agent-pending" role="status" aria-label="生成中">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </article>

      <article v-else-if="isThinkingItem(item)" class="ide-agent-thinking">
        <details class="ide-agent-thinking-card" open>
          <summary class="ide-agent-thinking-summary">
            <span class="ide-agent-thinking-icon">
              <AppIcon name="spark" :size="14" />
            </span>
            <span class="ide-agent-thinking-title">
              <span>工作笔记</span>
              <span>模型输出</span>
            </span>
            <AppIcon name="arrow-right" :size="13" class="ide-agent-chevron" />
          </summary>
          <div
            class="markdown-body ide-agent-thinking-markdown"
            v-html="renderMarkdown(item.text)"
          ></div>
        </details>
      </article>

      <article
        v-else-if="isToolItem(item)"
        class="ide-agent-tool"
        :class="`ide-agent-tool--${item.status}`"
        :aria-busy="item.status === 'preparing' || item.status === 'running'"
      >
        <details class="ide-agent-tool-card" :open="toolDefaultOpen(item)">
          <summary class="ide-agent-tool-summary" :aria-label="toolAriaLabel(item)">
            <span class="ide-agent-tool-icon">
              <AppIcon :name="toolIcon(item)" :size="15" />
            </span>
            <span class="ide-agent-tool-main">
              <span class="ide-agent-tool-headline">
                <span class="ide-agent-tool-name">{{ toolDisplayName(item) }}</span>
                <span class="ide-agent-tool-status">{{ toolStatusLabel(item) }}</span>
              </span>
              <span class="ide-agent-tool-subtitle">
                <span v-if="toolPurpose(item)">{{ toolPurpose(item) }}</span>
                <span v-for="meta in toolMeta(item)" :key="meta">{{ meta }}</span>
              </span>
            </span>
            <AppIcon name="arrow-right" :size="14" class="ide-agent-chevron" />
          </summary>

          <div class="ide-agent-tool-body">
            <div v-if="item.workNote" class="ide-agent-tool-section ide-agent-tool-section--note">
              <div class="ide-agent-tool-section-title">1Shell AI 的工作笔记</div>
              <p>{{ item.workNote }}</p>
            </div>

            <details v-if="hasToolInput(item)" class="ide-agent-tool-section">
              <summary>参数</summary>
              <pre>{{ formatToolValue(item.input) }}</pre>
            </details>

            <div v-if="item.logs.length" class="ide-agent-tool-section ide-agent-tool-section--logs">
              <div class="ide-agent-tool-section-title">输出</div>
              <div class="ide-agent-log-list">
                <div
                  v-for="(log, index) in item.logs"
                  :key="`${item.id}-log-${index}`"
                  class="ide-agent-log"
                  :class="log.stream === 'stderr' ? 'ide-agent-log--stderr' : 'ide-agent-log--stdout'"
                >
                  <span class="ide-agent-log-stream">{{ log.stream }}</span>
                  <pre>{{ log.text }}</pre>
                </div>
              </div>
            </div>

            <details v-if="hasToolResult(item)" class="ide-agent-tool-section" :open="item.status === 'error'">
              <summary>结果</summary>
              <pre>{{ formatToolValue(item.result) }}</pre>
            </details>
          </div>
        </details>
      </article>
    </template>
  </div>
</template>

<style scoped>
.ide-agent-timeline {
  display: grid;
  gap: 16px;
}

.ide-agent-timeline--compact {
  gap: 10px;
}

.ide-agent-message,
.ide-agent-thinking,
.ide-agent-tool {
  max-width: min(900px, 100%);
}

.ide-agent-message {
  display: grid;
  gap: 6px;
}

.ide-agent-message--user {
  margin-left: auto;
  justify-items: end;
}

.ide-agent-message--assistant,
.ide-agent-thinking,
.ide-agent-tool {
  margin-right: auto;
  justify-items: start;
}

.ide-agent-message-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #64748b;
}

:global(.dark) .ide-agent-message-meta {
  color: #94a3b8;
}

.ide-agent-bubble {
  max-width: 100%;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 8px;
  padding: 11px 13px;
  background: rgba(255, 255, 255, 0.88);
  color: #0f172a;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
}

.ide-agent-timeline--compact .ide-agent-bubble {
  padding: 9px 11px;
}

.ide-agent-message--user .ide-agent-bubble {
  background: #0f172a;
  color: #f8fafc;
  border-color: #0f172a;
}

:global(.dark) .ide-agent-bubble {
  background: rgba(15, 23, 42, 0.86);
  color: #e2e8f0;
  border-color: rgba(51, 65, 85, 0.85);
  box-shadow: none;
}

:global(.dark) .ide-agent-message--user .ide-agent-bubble {
  background: #e2e8f0;
  color: #0f172a;
  border-color: #e2e8f0;
}

.ide-agent-markdown {
  font-size: 13px;
  line-height: 1.62;
  word-break: break-word;
}

.ide-agent-timeline--compact .ide-agent-markdown {
  font-size: 12px;
  line-height: 1.55;
}

.ide-agent-thinking-card,
.ide-agent-tool-card {
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
}

.ide-agent-thinking-card {
  border: 1px solid rgba(148, 163, 184, 0.38);
  background: rgba(248, 250, 252, 0.74);
}

:global(.dark) .ide-agent-thinking-card {
  background: rgba(15, 23, 42, 0.62);
  border-color: rgba(71, 85, 105, 0.72);
}

.ide-agent-thinking-summary,
.ide-agent-tool-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  cursor: pointer;
  list-style: none;
}

.ide-agent-thinking-summary::-webkit-details-marker,
.ide-agent-tool-summary::-webkit-details-marker {
  display: none;
}

.ide-agent-thinking-summary:focus-visible,
.ide-agent-tool-summary:focus-visible {
  outline: 2px solid rgba(14, 165, 233, 0.58);
  outline-offset: -2px;
}

.ide-agent-thinking-summary {
  min-height: 38px;
  gap: 8px;
  padding: 8px 11px;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.ide-agent-timeline--compact .ide-agent-thinking-summary {
  min-height: 34px;
  padding: 7px 9px;
}

:global(.dark) .ide-agent-thinking-summary {
  color: #94a3b8;
}

.ide-agent-thinking-title {
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
}

.ide-agent-thinking-title span:last-child {
  min-width: 0;
  border-radius: 999px;
  padding: 2px 6px;
  border: 1px solid rgba(14, 165, 233, 0.18);
  color: #0369a1;
  background: rgba(224, 242, 254, 0.58);
  font-size: 10px;
  font-weight: 700;
}

:global(.dark) .ide-agent-thinking-title span:last-child {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.22);
  background: rgba(14, 165, 233, 0.12);
}

.ide-agent-thinking-icon,
.ide-agent-tool-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
}

.ide-agent-thinking-icon {
  width: 24px;
  height: 24px;
  color: #0369a1;
  background: rgba(224, 242, 254, 0.86);
  border: 1px solid #bae6fd;
}

:global(.dark) .ide-agent-thinking-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.22);
}

.ide-agent-chevron {
  color: #94a3b8;
  transition: transform 160ms ease;
}

.ide-agent-thinking-card[open] .ide-agent-chevron,
.ide-agent-tool-card[open] .ide-agent-chevron {
  transform: rotate(90deg);
}

.ide-agent-thinking-markdown {
  border-top: 1px solid rgba(226, 232, 240, 0.82);
  padding: 9px 12px 11px;
  font-size: 12.5px;
  line-height: 1.62;
  color: #475569;
  word-break: break-word;
}

.ide-agent-timeline--compact .ide-agent-thinking-markdown {
  padding: 8px 10px 9px;
  font-size: 11.5px;
}

:global(.dark) .ide-agent-thinking-markdown {
  border-top-color: rgba(51, 65, 85, 0.72);
  color: #cbd5e1;
}

.ide-agent-tool-card {
  border: 1px solid rgba(148, 163, 184, 0.52);
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
}

:global(.dark) .ide-agent-tool-card {
  background: rgba(15, 23, 42, 0.82);
  border-color: rgba(71, 85, 105, 0.84);
  box-shadow: none;
}

.ide-agent-tool--running .ide-agent-tool-card,
.ide-agent-tool--preparing .ide-agent-tool-card {
  border-color: rgba(14, 165, 233, 0.42);
}

.ide-agent-tool--done .ide-agent-tool-card {
  border-color: rgba(16, 185, 129, 0.34);
}

.ide-agent-tool--error .ide-agent-tool-card {
  border-color: rgba(220, 38, 38, 0.44);
}

.ide-agent-tool-summary {
  min-height: 46px;
  gap: 10px;
  padding: 10px 12px;
}

.ide-agent-timeline--compact .ide-agent-tool-summary {
  min-height: 40px;
  gap: 8px;
  padding: 8px 10px;
}

.ide-agent-tool-icon {
  width: 28px;
  height: 28px;
  color: #0369a1;
  background: #e0f2fe;
  border: 1px solid #bae6fd;
}

.ide-agent-tool--done .ide-agent-tool-icon {
  color: #047857;
  background: #d1fae5;
  border-color: #a7f3d0;
}

.ide-agent-tool--error .ide-agent-tool-icon {
  color: #b91c1c;
  background: #fee2e2;
  border-color: #fecaca;
}

:global(.dark) .ide-agent-tool-icon {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(56, 189, 248, 0.25);
}

:global(.dark) .ide-agent-tool--done .ide-agent-tool-icon {
  color: #6ee7b7;
  background: rgba(16, 185, 129, 0.14);
  border-color: rgba(52, 211, 153, 0.24);
}

:global(.dark) .ide-agent-tool--error .ide-agent-tool-icon {
  color: #fecaca;
  background: rgba(127, 29, 29, 0.24);
  border-color: rgba(248, 113, 113, 0.3);
}

.ide-agent-tool-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.ide-agent-tool-headline {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ide-agent-tool-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}

.ide-agent-timeline--compact .ide-agent-tool-name {
  font-size: 12px;
}

.ide-agent-tool-status {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 7px;
  border: 1px solid rgba(14, 165, 233, 0.2);
  color: #0369a1;
  background: rgba(224, 242, 254, 0.68);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.35;
}

.ide-agent-tool--preparing .ide-agent-tool-status,
.ide-agent-tool--running .ide-agent-tool-status {
  color: #075985;
  background: rgba(224, 242, 254, 0.82);
}

.ide-agent-tool--done .ide-agent-tool-status {
  color: #047857;
  border-color: rgba(16, 185, 129, 0.18);
  background: rgba(209, 250, 229, 0.76);
}

.ide-agent-tool--error .ide-agent-tool-status {
  color: #b91c1c;
  border-color: rgba(220, 38, 38, 0.18);
  background: rgba(254, 226, 226, 0.8);
}

:global(.dark) .ide-agent-tool-status {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.2);
  background: rgba(14, 165, 233, 0.12);
}

:global(.dark) .ide-agent-tool--done .ide-agent-tool-status {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.22);
  background: rgba(16, 185, 129, 0.14);
}

:global(.dark) .ide-agent-tool--error .ide-agent-tool-status {
  color: #fecaca;
  border-color: rgba(248, 113, 113, 0.26);
  background: rgba(127, 29, 29, 0.24);
}

.ide-agent-tool-subtitle {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #64748b;
}

.ide-agent-tool-subtitle span {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ide-agent-tool-subtitle span + span::before {
  content: "";
  display: inline-block;
  width: 3px;
  height: 3px;
  margin: 0 8px 2px 0;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.45;
}

:global(.dark) .ide-agent-tool-subtitle {
  color: #94a3b8;
}

.ide-agent-tool-body {
  display: grid;
  gap: 10px;
  padding: 0 12px 12px;
}

.ide-agent-timeline--compact .ide-agent-tool-body {
  gap: 8px;
  padding: 0 10px 10px;
}

.ide-agent-tool-section {
  border-top: 1px solid rgba(226, 232, 240, 0.92);
  padding-top: 10px;
}

:global(.dark) .ide-agent-tool-section {
  border-top-color: rgba(51, 65, 85, 0.82);
}

.ide-agent-tool-section summary,
.ide-agent-tool-section-title {
  margin-bottom: 7px;
  color: #475569;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
}

.ide-agent-tool-section summary {
  cursor: pointer;
}

:global(.dark) .ide-agent-tool-section summary,
:global(.dark) .ide-agent-tool-section-title {
  color: #cbd5e1;
}

.ide-agent-tool-section--note p {
  margin: 0;
  border: 1px solid rgba(14, 165, 233, 0.18);
  border-radius: 8px;
  background: rgba(224, 242, 254, 0.54);
  color: #0f172a;
  padding: 9px 10px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

:global(.dark) .ide-agent-tool-section--note p {
  border-color: rgba(56, 189, 248, 0.2);
  background: rgba(14, 165, 233, 0.1);
  color: #dbeafe;
}

.ide-agent-tool-section pre,
.ide-agent-log pre {
  margin: 0;
  max-height: 340px;
  overflow-x: auto;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 8px;
  border: 1px solid rgba(203, 213, 225, 0.86);
  background: rgba(248, 250, 252, 0.92);
  color: #0f172a;
  padding: 9px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
}

.ide-agent-timeline--compact .ide-agent-tool-section pre,
.ide-agent-timeline--compact .ide-agent-log pre {
  max-height: 240px;
  padding: 8px;
  font-size: 11px;
}

:global(.dark) .ide-agent-tool-section pre,
:global(.dark) .ide-agent-log pre {
  border-color: rgba(71, 85, 105, 0.86);
  background: rgba(2, 6, 23, 0.66);
  color: #e2e8f0;
}

.ide-agent-log-list {
  display: grid;
  gap: 8px;
}

.ide-agent-log {
  display: grid;
  gap: 5px;
}

.ide-agent-log-stream {
  width: fit-content;
  border-radius: 6px;
  padding: 2px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 10px;
  font-weight: 700;
  color: #0369a1;
  background: rgba(14, 165, 233, 0.1);
}

.ide-agent-log--stderr .ide-agent-log-stream {
  color: #b91c1c;
  background: rgba(220, 38, 38, 0.1);
}

:global(.dark) .ide-agent-log-stream {
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.14);
}

:global(.dark) .ide-agent-log--stderr .ide-agent-log-stream {
  color: #fecaca;
  background: rgba(220, 38, 38, 0.18);
}

.ide-agent-pending {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 42px;
  min-height: 20px;
}

.ide-agent-pending span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #38bdf8;
  animation: ide-agent-dot 900ms ease-in-out infinite;
}

.ide-agent-pending span:nth-child(2) {
  animation-delay: 120ms;
}

.ide-agent-pending span:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes ide-agent-dot {
  0%, 80%, 100% { opacity: 0.35; }
  40% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .ide-agent-pending span {
    animation: none;
  }
}
</style>
