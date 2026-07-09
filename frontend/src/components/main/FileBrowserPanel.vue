<script setup lang="ts">
// FileBrowserPanel.vue — 文件浏览器面板
// 1:1 复刻 [public/file-browser.js](public/file-browser.js) + [public/index.html](public/index.html) #file-tree
// 自身容器内滚动,不外溢
import { computed, onBeforeUnmount, onMounted, toRef } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { isSupportedArchiveName, useFileBrowser, type DirItem } from '@/composables/useFileBrowser';

interface FileBrowserHostOption {
  id: string;
  name: string;
  meta?: string;
}

const props = withDefaults(defineProps<{
  hostId?: string | null;
  title?: string;
  hostOptions?: FileBrowserHostOption[];
}>(), {
  title: '文件浏览',
  hostOptions: () => [],
});

const emit = defineEmits<{
  hostChange: [hostId: string];
}>();

const fb = props.hostId === undefined
  ? useFileBrowser()
  : useFileBrowser({ hostId: toRef(props, 'hostId'), singleton: false });

onMounted(() => { fb.initialize(); });
onBeforeUnmount(() => { fb.closePreview(); });

// 显示项：showHidden 决定是否过滤 .开头，再按 sortBy/sortOrder 排序
const visibleItems = computed<DirItem[]>(() => {
  const list = fb.showHidden.value
    ? fb.items.value
    : fb.items.value.filter((i) => !i.name.startsWith('.'));
  return fb.sortItems(list);
});
const dirCount = computed(() => visibleItems.value.filter((i) => i.isDir).length);
const fileCount = computed(() => visibleItems.value.length - dirCount.value);
const selectedHostName = computed(() => props.hostOptions.find((host) => host.id === props.hostId)?.name || props.hostId || '当前主机');
const syncStatus = computed(() => {
  if (fb.operationLabel.value) return fb.operationLabel.value;
  if (fb.loading.value) return '进入中';
  if (fb.refreshing.value) return '更新中';
  if (fb.cacheStale.value) return '缓存';
  return '';
});
const syncTitle = computed(() => {
  if (!fb.lastLoadedAt.value) return '';
  return `上次加载 ${new Date(fb.lastLoadedAt.value).toLocaleString()}`;
});

// 面包屑分段（Windows / Linux 分别处理）
interface Crumb {
  label: string;
  path: string;
  active: boolean;
  isDrives?: boolean;
}
const crumbs = computed<Crumb[]>(() => {
  const path = fb.currentPath.value;
  if (path === '此电脑') {
    return [{ label: '此电脑', path: '__drives__', active: true }];
  }
  if (fb.isWindows.value) {
    const list: Crumb[] = [{ label: '此电脑', path: '__drives__', active: false, isDrives: true }];
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length) return list;
    let accumulated = parts[0] + '/';
    list.push({
      label: parts[0],
      path: accumulated.replace(/\//g, '\\'),
      active: parts.length === 1,
    });
    for (let i = 1; i < parts.length; i += 1) {
      accumulated += parts[i] + '/';
      list.push({
        label: parts[i],
        path: accumulated.replace(/\//g, '\\'),
        active: i === parts.length - 1,
      });
    }
    return list;
  }
  // Linux
  const parts = path.split('/').filter(Boolean);
  const list: Crumb[] = [{ label: '/', path: '/', active: parts.length === 0 }];
  let accumulated = '/';
  for (let i = 0; i < parts.length; i += 1) {
    accumulated += parts[i] + '/';
    list.push({
      label: parts[i],
      path: accumulated,
      active: i === parts.length - 1,
    });
  }
  return list;
});

function fileExtension(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ext && ext !== name.toLowerCase() ? ext : '';
}

function fileTone(item: DirItem): string {
  if (item.isDrive) return 'drive';
  if (item.isDir) return 'folder';
  const ext = fileExtension(item.name);
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return 'image';
  if (['zip', 'gz', 'tgz', 'tar', 'bz2', 'tbz2', 'xz', 'txz', 'rar', '7z'].includes(ext)) return 'archive';
  if (['env', 'pem', 'key', 'crt'].includes(ext)) return 'secret';
  if (['conf', 'cfg', 'ini', 'yml', 'yaml', 'json', 'xml'].includes(ext)) return 'config';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'html', 'css', 'sql'].includes(ext)) return 'code';
  if (['md', 'txt', 'log'].includes(ext)) return 'text';
  return 'file';
}

function fileIconName(item: DirItem): string {
  const tone = fileTone(item);
  if (tone === 'drive') return 'server';
  if (tone === 'folder') return 'folder';
  if (tone === 'image') return 'image';
  if (tone === 'archive') return 'archive';
  if (tone === 'secret') return 'lock';
  return 'file';
}

function fileIconClass(item: DirItem): string {
  return `fb-file-icon-${fileTone(item)}`;
}

function fileBadge(item: DirItem): string {
  if (item.isDir || item.isDrive) return '';
  const ext = fileExtension(item.name);
  if (!ext) return '';
  return ext.slice(0, 4).toUpperCase();
}

function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes === 0) return '--';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatModified(value: number | undefined): string {
  if (!value) return '--';
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
}

function itemType(item: DirItem): string {
  if (item.isDrive) return '磁盘';
  if (item.isDir) return '目录';
  const ext = (item.name.split('.').pop() || '').trim();
  return ext ? ext.toUpperCase() : '文件';
}

function canExtract(item: DirItem): boolean {
  return !item.isDrive && !item.isDir && isSupportedArchiveName(item.name);
}

function onHostChange(event: Event): void {
  const hostId = (event.target as HTMLSelectElement).value;
  if (hostId && hostId !== props.hostId) emit('hostChange', hostId);
}

function onItemClick(item: DirItem): void {
  if (item.isDir || item.isDrive) {
    fb.navigate(item.path);
  } else {
    void fb.openPreview(item.path);
  }
}

function onDownloadClick(event: MouseEvent, item: DirItem): void {
  event.stopPropagation();
  fb.downloadFile(item.path);
}

function onRenameClick(event: MouseEvent, item: DirItem): void {
  event.stopPropagation();
  void fb.renameItem(item);
}

function onDeleteClick(event: MouseEvent, item: DirItem): void {
  event.stopPropagation();
  void fb.deleteItem(item);
}

function onCompressClick(event: MouseEvent, item: DirItem): void {
  event.stopPropagation();
  void fb.compressItem(item);
}

function onExtractClick(event: MouseEvent, item: DirItem): void {
  event.stopPropagation();
  void fb.extractItem(item);
}

function onMaskClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) fb.closePreview();
}

function onSortChange(event: Event): void {
  fb.setSortBy((event.target as HTMLSelectElement).value as 'name' | 'mtime' | 'size');
}
</script>

<template>
  <div class="file-browser">
    <div class="fb-toolbar">
      <div class="fb-toolbar-main">
        <div class="fb-host-picker">
          <span class="fb-host-label">VPS</span>
          <select
            v-if="props.hostOptions.length"
            class="fb-host-select"
            :value="props.hostId || ''"
            @change="onHostChange"
          >
            <option v-for="host in props.hostOptions" :key="host.id" :value="host.id">{{ host.name }}</option>
          </select>
          <span v-else class="fb-host-current">{{ selectedHostName }}</span>
        </div>

        <div v-if="fb.currentPath.value" class="fb-breadcrumb">
          <template v-for="(c, i) in crumbs" :key="i">
            <span
              v-if="c.active"
              class="fb-crumb fb-crumb-active"
            >{{ c.label }}</span>
            <button
              v-else
              type="button"
              class="fb-crumb fb-crumb-link"
              @click="fb.navigate(c.path)"
            >{{ c.label }}</button>
            <span v-if="i < crumbs.length - 1" class="fb-crumb-sep">›</span>
          </template>
        </div>
      </div>
      <div class="fb-toolbar-actions">
        <span
          v-if="syncStatus"
          class="fb-sync-status"
          :class="{ 'fb-sync-status-stale': fb.cacheStale.value && !fb.refreshing.value }"
          :title="syncTitle"
        >{{ syncStatus }}</span>
        <select
          class="fb-sort-select"
          title="排序方式"
          :value="fb.sortBy.value"
          @change="onSortChange"
        >
          <option value="name">名称</option>
          <option value="mtime">时间</option>
          <option value="size">大小</option>
        </select>
        <button
          type="button"
          class="fb-mini-btn"
          :title="fb.sortOrder.value === 'asc' ? '当前升序，点击切换降序' : '当前降序，点击切换升序'"
          @click="fb.toggleSortOrder"
        >{{ fb.sortOrder.value === 'asc' ? '↑' : '↓' }}</button>
        <button
          type="button"
          class="fb-mini-btn"
          :class="{ active: fb.showHidden.value }"
          title="显示/隐藏隐藏文件"
          @click="fb.toggleHidden"
        >.*</button>
        <button
          type="button"
          class="fb-mini-btn"
          title="刷新当前目录"
          @click="fb.refreshCurrent"
        >⟳</button>
        <button
          type="button"
          class="fb-mini-btn fb-action-btn"
          title="新建文件夹"
          @click="fb.createDirectory"
        ><AppIcon name="folder" :size="14" /><span>新建目录</span></button>
        <button
          type="button"
          class="fb-mini-btn fb-action-btn"
          title="新建文件"
          @click="fb.createFile"
        ><AppIcon name="file-plus" :size="14" /><span>新建文件</span></button>
        <button
          type="button"
          class="fb-mini-btn"
          title="上传文件到当前目录"
          @click="fb.showUploadDialog"
        ><AppIcon name="arrow-up" :size="14" /></button>
      </div>
    </div>
    <div v-if="fb.loading.value || fb.refreshing.value || fb.operationLabel.value" class="fb-top-progress">
      <span></span>
    </div>

    <div class="fb-body">
      <div v-if="fb.loading.value && !visibleItems.length" class="fb-loading">加载中...</div>

      <template v-else-if="fb.error.value">
        <div class="fb-error">
          <span class="fb-error-icon">❌</span>
          <span class="fb-error-msg">{{ fb.error.value }}</span>
          <span class="fb-error-hint">请检查主机 SSH/SFTP 连接、端口和认证配置。</span>
          <div class="fb-error-actions">
            <button
              type="button"
              class="fb-back-btn"
              @click="fb.refreshCurrent"
            >重试</button>
            <button
              v-if="fb.parent.value"
              type="button"
              class="fb-back-btn"
              @click="fb.goBack"
            >返回上级</button>
            <button
              v-if="fb.currentPath.value"
              type="button"
              class="fb-back-btn"
              @click="fb.navigate('')"
            >回到根目录</button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="fb-table" :class="{ 'fb-table-refreshing': fb.loading.value || fb.refreshing.value }">
          <div class="fb-table-head">
            <span>名称</span>
            <span>类型</span>
            <span>大小</span>
            <span>修改时间</span>
            <span>操作</span>
          </div>

          <button
            v-if="fb.parent.value && fb.parent.value !== fb.currentPath.value"
            type="button"
            class="fb-row fb-row-up"
            @click="fb.goBack"
          >
            <span class="fb-cell-name">
              <span class="fb-file-icon fb-file-icon-up">
                <AppIcon name="arrow-up" :size="14" />
              </span>
              <span class="fb-item-name">..</span>
            </span>
            <span class="fb-cell-muted">上级目录</span>
            <span class="fb-cell-muted">--</span>
            <span class="fb-cell-muted">--</span>
            <span></span>
          </button>

          <div v-if="!visibleItems.length && !fb.parent.value" class="fb-empty">空目录</div>

          <ul class="fb-list">
            <li v-for="item in visibleItems" :key="item.path">
              <div
                class="fb-row"
                :class="{ 'fb-item-dir': item.isDir || item.isDrive, 'fb-item-file': !item.isDir && !item.isDrive }"
                @click="onItemClick(item)"
              >
                <span class="fb-cell-name">
                  <span class="fb-file-icon" :class="fileIconClass(item)">
                    <AppIcon :name="fileIconName(item)" :size="15" />
                    <span v-if="fileBadge(item)" class="fb-file-badge">{{ fileBadge(item) }}</span>
                  </span>
                  <span class="fb-item-name">{{ item.name }}</span>
                </span>
                <span class="fb-cell-type">{{ itemType(item) }}</span>
                <span class="fb-cell-size">{{ item.isDir || item.isDrive ? '--' : formatSize(item.size) }}</span>
                <span class="fb-cell-time">{{ item.isDrive ? '--' : formatModified(item.mtime) }}</span>
                <span class="fb-cell-actions">
                  <button
                    v-if="!item.isDir && !item.isDrive"
                    type="button"
                    class="fb-download-btn"
                    title="下载"
                    @click="onDownloadClick($event, item)"
                  ><AppIcon name="download" :size="13" /></button>
                  <button
                    v-if="canExtract(item)"
                    type="button"
                    class="fb-download-btn"
                    title="解压"
                    @click="onExtractClick($event, item)"
                  ><AppIcon name="archive-extract" :size="13" /></button>
                  <button
                    v-if="!item.isDrive"
                    type="button"
                    class="fb-download-btn"
                    title="压缩"
                    @click="onCompressClick($event, item)"
                  ><AppIcon name="archive" :size="13" /></button>
                  <button
                    v-if="!item.isDrive"
                    type="button"
                    class="fb-download-btn"
                    title="重命名"
                    @click="onRenameClick($event, item)"
                  ><AppIcon name="pen" :size="13" /></button>
                  <button
                    v-if="!item.isDrive"
                    type="button"
                    class="fb-download-btn fb-delete-btn"
                    title="删除"
                    @click="onDeleteClick($event, item)"
                  ><AppIcon name="trash" :size="13" /></button>
                </span>
              </div>
            </li>
          </ul>
        </div>

        <div class="fb-footer">
          <template v-if="fb.currentPath.value === '此电脑'">
            {{ visibleItems.length }} 个磁盘
          </template>
          <template v-else>
            {{ dirCount }} 目录 / {{ fileCount }} 文件
            <template v-if="fb.hiddenCount.value > 0"> / {{ fb.hiddenCount.value }} 隐藏</template>
          </template>
        </div>
      </template>
    </div>

    <!-- 文件预览 modal（fixed,ESC/点遮罩关） -->
    <div v-if="fb.preview.open" class="fb-preview-mask" @click="onMaskClick">
      <div class="fb-preview-card">
        <div class="fb-preview-header">
          <div class="fb-preview-title">
            <span class="fb-preview-icon">
              <AppIcon :name="fb.preview.isImage ? 'image' : 'file'" :size="16" />
            </span>
            <span class="fb-preview-name">{{ fb.preview.fileName }}</span>
          </div>
          <div class="fb-preview-actions">
            <button type="button" class="fb-preview-action" title="复制路径" @click="fb.copyPreviewPath">路径</button>
            <button type="button" class="fb-preview-action" title="下载文件" @click="fb.downloadFile(fb.preview.filePath)">下载</button>
            <button
              v-if="!fb.preview.isImage"
              type="button"
              class="fb-preview-action"
              :class="{ 'fb-preview-action-active': fb.preview.mode === 'edit' }"
              :disabled="fb.preview.loading || Boolean(fb.preview.error)"
              title="编辑文件"
              @click="fb.startEdit"
            >{{ fb.preview.mode === 'edit' ? '编辑中' : '编辑' }}</button>
            <button type="button" class="fb-preview-close" @click="fb.closePreview">×</button>
          </div>
        </div>
        <div class="fb-preview-path">{{ fb.preview.filePath }}</div>
        <div class="fb-preview-body">
          <div v-if="fb.preview.loading" class="fb-preview-loading">加载中...</div>
          <div v-else-if="fb.preview.error" class="fb-preview-error">{{ fb.preview.error }}</div>

          <template v-else-if="fb.preview.isImage">
            <div class="fb-preview-image-wrap">
              <img :src="fb.preview.imageUrl" :alt="fb.preview.fileName" class="fb-preview-image" />
            </div>
          </template>

          <template v-else-if="fb.preview.mode === 'view'">
            <pre class="fb-preview-text">{{ fb.preview.content }}</pre>
          </template>

          <template v-else>
            <textarea
              v-model="fb.preview.editValue"
              class="fb-preview-textarea"
              spellcheck="false"
            />
            <div class="fb-preview-edit-footer">
              <span class="fb-preview-edit-status">{{ fb.preview.saveError }}</span>
              <div class="fb-preview-edit-actions">
                <button type="button" class="fb-edit-cancel" :disabled="fb.preview.saving" @click="fb.cancelEdit">取消</button>
                <button type="button" class="fb-edit-save" :disabled="fb.preview.saving" @click="fb.saveEdit">{{ fb.preview.saving ? '保存中…' : '保存' }}</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
