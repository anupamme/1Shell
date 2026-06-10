// useFileBrowser.ts — MainConsole 刀 3 阶段 2 · 文件浏览器
// 1:1 复刻 [public/file-browser.js](public/file-browser.js)（599 行）
// 单例：currentPath / items / 缓存 60s/50 LRU / 预览 + 编辑 / 上传 multipart / 下载 a.href / 写入

import { reactive, ref, watch, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useConfirm } from '@/composables/useConfirm';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';

export interface DirItem {
  name: string;
  path: string;
  isDir: boolean;
  isDrive?: boolean;
  size?: number;
  mtime?: number;
}

export type FileSortBy = 'name' | 'mtime' | 'size';
export type FileSortOrder = 'asc' | 'desc';

export interface DirListResponse {
  items: DirItem[];
  path: string;
  parent?: string;
  isRoot?: boolean;
  itemTotal?: number;
  source?: 'agent' | 'sftp';
}

interface ReadFileResponse {
  content: string;
  size: number;
}

interface CacheEntry {
  data: DirListResponse;
  ts: number;
}

const DIR_CACHE_TTL_MS = 60_000;
const DIR_CACHE_MAX = 50;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];

export interface PreviewState {
  open: boolean;
  filePath: string;
  fileName: string;
  isImage: boolean;
  loading: boolean;
  content: string;
  imageUrl: string;
  error: string;
  mode: 'view' | 'edit';
  editValue: string;
  saving: boolean;
  saveError: string;
}

export interface FileBrowserApi {
  readonly currentPath: Ref<string>;
  readonly items: Ref<DirItem[]>;
  readonly parent: Ref<string>;
  readonly isRoot: Ref<boolean>;
  readonly isWindows: Ref<boolean>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string>;
  readonly showHidden: Ref<boolean>;
  readonly hiddenCount: Ref<number>;
  readonly sortBy: Ref<FileSortBy>;
  readonly sortOrder: Ref<FileSortOrder>;
  readonly preview: PreviewState;

  initialize(): void;
  loadDir(path: string, opts?: { skipCache?: boolean }): Promise<void>;
  navigate(path: string): void;
  goBack(): void;
  refreshCurrent(): void;
  toggleHidden(): void;
  setSortBy(by: FileSortBy): void;
  toggleSortOrder(): void;
  sortItems(items: DirItem[]): DirItem[];
  showUploadDialog(): void;
  createDirectory(): Promise<void>;
  createFile(): Promise<void>;
  renameItem(item: DirItem): Promise<void>;
  deleteItem(item: DirItem): Promise<void>;
  downloadFile(filePath: string): void;
  openPreview(filePath: string): Promise<void>;
  closePreview(): void;
  copyPreviewPath(): void;
  startEdit(): void;
  cancelEdit(): void;
  saveEdit(): Promise<void>;
}

interface FileBrowserOptions {
  hostId?: Ref<string | null | undefined>;
  singleton?: boolean;
}

let _instance: FileBrowserApi | null = null;

export function useFileBrowser(options: FileBrowserOptions = {}): FileBrowserApi {
  if (options.singleton === false || options.hostId) return create(options);
  if (!_instance) _instance = create(options);
  return _instance;
}

export function _resetFileBrowserSingleton(): void {
  _instance = null;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function isImageFile(name: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function create(options: FileBrowserOptions = {}): FileBrowserApi {
  const { requestJson } = useApiClient();
  const sessionTerminal = useSessionTerminal();
  const notify = useNotifyStore();
  const { confirm } = useConfirm();

  const currentPath = ref('');
  const items = ref<DirItem[]>([]);
  const parent = ref('');
  const isRoot = ref(false);
  const isWindows = ref(false);
  const loading = ref(false);
  const error = ref('');
  const showHidden = ref(true);
  const hiddenCount = ref(0);
  const sortBy = ref<FileSortBy>('name');
  const sortOrder = ref<FileSortOrder>('asc');

  const preview = reactive<PreviewState>({
    open: false,
    filePath: '',
    fileName: '',
    isImage: false,
    loading: false,
    content: '',
    imageUrl: '',
    error: '',
    mode: 'view',
    editValue: '',
    saving: false,
    saveError: '',
  });

  let currentHostId = '';
  const dirCache = new Map<string, CacheEntry>();
  const hostSnapshots = new Map<string, DirListResponse>();
  let initialized = false;
  let escListener: ((e: KeyboardEvent) => void) | null = null;
  let lastBlobUrl = '';

  function cacheKey(hostId: string, path: string): string {
    return `${hostId}:${path || ''}`;
  }

  function getCached(hostId: string, path: string): DirListResponse | null {
    const entry = dirCache.get(cacheKey(hostId, path));
    if (!entry) return null;
    if (Date.now() - entry.ts > DIR_CACHE_TTL_MS) {
      dirCache.delete(cacheKey(hostId, path));
      return null;
    }
    return entry.data;
  }

  function setCached(hostId: string, path: string, data: DirListResponse): void {
    if (dirCache.size >= DIR_CACHE_MAX) {
      const oldest = dirCache.keys().next().value;
      if (oldest) dirCache.delete(oldest);
    }
    dirCache.set(cacheKey(hostId, path), { data, ts: Date.now() });
  }

  function invalidateHostCache(hostId: string): void {
    if (!hostId) return;
    for (const key of [...dirCache.keys()]) {
      if (key.startsWith(`${hostId}:`)) dirCache.delete(key);
    }
    hostSnapshots.delete(hostId);
  }

  function makeSnapshot(): DirListResponse {
    return {
      path: currentPath.value,
      parent: parent.value,
      isRoot: isRoot.value,
      items: items.value,
    };
  }

  function saveHostSnapshot(hostId: string): void {
    if (!hostId) return;
    hostSnapshots.set(hostId, makeSnapshot());
  }

  function restoreHostSnapshot(hostId: string): boolean {
    const snapshot = hostSnapshots.get(hostId);
    if (!snapshot) return false;
    applyData(snapshot);
    return true;
  }

  function applyData(data: DirListResponse): void {
    const path = data.path || '';
    currentPath.value = path;
    items.value = data.items || [];
    parent.value = data.parent || '';
    isRoot.value = Boolean(data.isRoot);
    isWindows.value = path.includes(':') || path.includes('\\') || path === '此电脑';
    error.value = '';

    // 计算隐藏文件数量
    const total = (data.items || []).length;
    const visible = showHidden.value
      ? total
      : (data.items || []).filter((i) => !i.name.startsWith('.')).length;
    hiddenCount.value = total - visible;
    if (currentHostId) hostSnapshots.set(currentHostId, data);
  }

  function getHostId(): string {
    return options.hostId?.value || sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  }

  async function loadDir(dirPath: string, opts: { skipCache?: boolean } = {}): Promise<void> {
    const hostId = getHostId();
    const requestPath = dirPath === '此电脑' ? '' : dirPath;
    currentHostId = hostId;

    if (!opts.skipCache && requestPath !== '__drives__') {
      const cached = getCached(hostId, requestPath);
      if (cached) {
        applyData(cached);
        return;
      }
    }

    loading.value = true;
    error.value = '';

    try {
      const params = new URLSearchParams({ hostId });
      if (requestPath && requestPath !== '__drives__') params.set('path', requestPath);
      const data = await requestJson<DirListResponse>(`/api/files/list?${params}`);
      if (currentHostId !== hostId) return;
      setCached(hostId, requestPath, data);
      applyData(data);
    } catch (err) {
      if (currentHostId !== hostId) return;
      error.value = (err as Error).message || '加载失败';
    } finally {
      if (currentHostId === hostId) loading.value = false;
    }
  }

  function navigate(path: string): void {
    void loadDir(path);
  }

  function goBack(): void {
    if (parent.value) void loadDir(parent.value);
  }

  function refreshCurrent(): void {
    invalidateHostCache(currentHostId);
    void loadDir(currentPath.value, { skipCache: true });
  }

  function switchHost(hostId: string, previousHostId = currentHostId): void {
    if (previousHostId && previousHostId !== hostId) saveHostSnapshot(previousHostId);
    currentHostId = hostId;
    closePreview();

    const restored = restoreHostSnapshot(hostId);
    if (!restored) {
      items.value = [];
      currentPath.value = '';
      parent.value = '';
      isRoot.value = false;
      isWindows.value = false;
      hiddenCount.value = 0;
      error.value = '';
    }

    void loadDir(restored ? currentPath.value : '');
  }

  function toggleHidden(): void {
    showHidden.value = !showHidden.value;
    // 重新计算隐藏计数
    const total = items.value.length;
    const visible = showHidden.value
      ? total
      : items.value.filter((i) => !i.name.startsWith('.')).length;
    hiddenCount.value = total - visible;
  }

  function downloadFile(filePath: string): void {
    if (!filePath) return;
    const hostId = getHostId();
    const params = new URLSearchParams({ hostId, path: filePath });
    const a = document.createElement('a');
    a.href = `/api/files/download?${params}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function showUploadDialog(): void {
    if (!currentPath.value || currentPath.value === '此电脑') {
      notify.warn('请先进入一个目录');
      return;
    }
    const hostId = getHostId();
    const dirPath = currentPath.value;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      if (!input.files || input.files.length === 0) return;
      for (const file of Array.from(input.files)) {
        try {
          const formData = new FormData();
          formData.append('hostId', hostId);
          formData.append('dirPath', dirPath);
          formData.append('file', file);
          const csrf = getCsrfToken();
          const resp = await fetch('/api/files/upload', {
            method: 'POST',
            headers: csrf ? { 'x-csrf-token': csrf } : {},
            body: formData,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error((err as { error?: string }).error || `上传失败 (${resp.status})`);
          }
          notify.success(`${file.name} 上传成功`);
        } catch (err) {
          notify.error(`${file.name} 上传失败: ${(err as Error).message}`);
        }
      }
      dirCache.delete(cacheKey(hostId, dirPath));
      void loadDir(dirPath, { skipCache: true });
    });
    input.click();
  }

  function setSortBy(by: FileSortBy): void {
    if (sortBy.value === by) return;
    sortBy.value = by;
    // 修改时间默认新的在前，名称/大小默认升序
    sortOrder.value = by === 'mtime' ? 'desc' : 'asc';
  }

  function toggleSortOrder(): void {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  }

  function sortItems(list: DirItem[]): DirItem[] {
    const dir = sortOrder.value === 'asc' ? 1 : -1;
    const by = sortBy.value;
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (by === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
      else if (by === 'size') cmp = (a.size || 0) - (b.size || 0);
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      return cmp * dir;
    });
  }

  function joinPath(dir: string, name: string): string {
    const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
    return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
  }

  function isValidEntryName(name: string): boolean {
    return Boolean(name) && name !== '.' && name !== '..' && !/[\\/]/.test(name);
  }

  function reloadCurrentDir(hostId: string): void {
    dirCache.delete(cacheKey(hostId, currentPath.value));
    void loadDir(currentPath.value, { skipCache: true });
  }

  async function createDirectory(): Promise<void> {
    if (!currentPath.value || currentPath.value === '此电脑') {
      notify.warn('请先进入一个目录');
      return;
    }
    const name = window.prompt('新建文件夹名称', '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!isValidEntryName(trimmed)) {
      notify.error('文件夹名称无效');
      return;
    }
    const hostId = getHostId();
    try {
      await requestJson('/api/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ hostId, path: joinPath(currentPath.value, trimmed) }),
      });
      notify.success(`已创建文件夹 ${trimmed}`);
      reloadCurrentDir(hostId);
    } catch (err) {
      notify.error(`创建失败: ${(err as Error).message}`);
    }
  }

  async function createFile(): Promise<void> {
    if (!currentPath.value || currentPath.value === '此电脑') {
      notify.warn('请先进入一个目录');
      return;
    }
    const name = window.prompt('新建文件名称（含后缀，如 app.conf）', '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!isValidEntryName(trimmed)) {
      notify.error('文件名称无效');
      return;
    }
    const hostId = getHostId();
    try {
      await requestJson('/api/files/touch', {
        method: 'POST',
        body: JSON.stringify({ hostId, path: joinPath(currentPath.value, trimmed) }),
      });
      notify.success(`已创建文件 ${trimmed}`);
      reloadCurrentDir(hostId);
    } catch (err) {
      notify.error(`创建失败: ${(err as Error).message}`);
    }
  }

  async function renameItem(item: DirItem): Promise<void> {
    if (item.isDrive) return;
    const newName = window.prompt('重命名为', item.name);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (trimmed === item.name) return;
    if (!isValidEntryName(trimmed)) {
      notify.error('名称无效');
      return;
    }
    const hostId = getHostId();
    try {
      await requestJson('/api/files/rename', {
        method: 'POST',
        body: JSON.stringify({ hostId, path: item.path, newPath: joinPath(currentPath.value, trimmed) }),
      });
      notify.success(`已重命名为 ${trimmed}`);
      reloadCurrentDir(hostId);
    } catch (err) {
      notify.error(`重命名失败: ${(err as Error).message}`);
    }
  }

  async function deleteItem(item: DirItem): Promise<void> {
    if (item.isDrive) return;
    const ok = await confirm({
      title: '删除确认',
      message: item.isDir
        ? `确定删除目录 "${item.name}" 吗？目录内的全部内容将被递归删除，此操作不可恢复。`
        : `确定删除文件 "${item.name}" 吗？此操作不可恢复。`,
      okText: '删除',
    });
    if (!ok) return;
    const hostId = getHostId();
    try {
      await requestJson('/api/files/delete', {
        method: 'POST',
        body: JSON.stringify({ hostId, path: item.path }),
      });
      notify.success(`已删除 ${item.name}`);
      reloadCurrentDir(hostId);
    } catch (err) {
      notify.error(`删除失败: ${(err as Error).message}`);
    }
  }

  function clearBlobUrl(): void {
    if (lastBlobUrl) {
      URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = '';
    }
  }

  function copyPreviewPath(): void {
    if (!preview.filePath) return;
    navigator.clipboard?.writeText(preview.filePath).then(() => {
      notify.success('路径已复制');
    }).catch(() => { /* 静默 */ });
  }

  async function openPreview(filePath: string): Promise<void> {
    closePreview();
    const hostId = getHostId();
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const isImg = isImageFile(fileName);
    preview.open = true;
    preview.filePath = filePath;
    preview.fileName = fileName;
    preview.isImage = isImg;
    preview.loading = true;
    preview.content = '';
    preview.imageUrl = '';
    preview.error = '';
    preview.mode = 'view';
    preview.editValue = '';
    preview.saving = false;
    preview.saveError = '';

    try {
      if (isImg) {
        const params = new URLSearchParams({ hostId, path: filePath });
        const resp = await fetch(`/api/files/download?${params}`);
        if (!resp.ok) throw new Error('加载失败');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        lastBlobUrl = url;
        preview.imageUrl = url;
      } else {
        const params = new URLSearchParams({ hostId, path: filePath });
        const data = await requestJson<ReadFileResponse>(`/api/files/read?${params}`);
        preview.content = data.content || '';
      }
    } catch (err) {
      preview.error = (err as Error).message || '读取失败';
    } finally {
      preview.loading = false;
    }
  }

  function closePreview(): void {
    preview.open = false;
    preview.filePath = '';
    preview.fileName = '';
    preview.content = '';
    preview.imageUrl = '';
    preview.error = '';
    preview.mode = 'view';
    preview.editValue = '';
    preview.saveError = '';
    clearBlobUrl();
  }

  function startEdit(): void {
    if (preview.isImage || preview.loading) return;
    preview.mode = 'edit';
    preview.editValue = preview.content;
    preview.saveError = '';
  }

  function cancelEdit(): void {
    preview.mode = 'view';
    preview.editValue = '';
    preview.saveError = '';
  }

  async function saveEdit(): Promise<void> {
    if (preview.saving) return;
    const hostId = getHostId();
    preview.saving = true;
    preview.saveError = '';
    try {
      await requestJson('/api/files/write', {
        method: 'POST',
        body: JSON.stringify({ hostId, path: preview.filePath, content: preview.editValue }),
      });
      preview.content = preview.editValue;
      preview.mode = 'view';
      if (currentPath.value) {
        dirCache.delete(cacheKey(hostId, currentPath.value));
      }
      notify.success('保存成功');
    } catch (err) {
      preview.saveError = `保存失败: ${(err as Error).message}`;
    } finally {
      preview.saving = false;
    }
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;

    const source = options.hostId || sessionTerminal.activeHostId;
    watch(source, (newId, oldId) => {
      switchHost(newId || LOCAL_HOST_ID, oldId || currentHostId);
    }, { flush: 'post' });

    // ESC 关预览
    escListener = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && preview.open) closePreview();
    };
    document.addEventListener('keydown', escListener);

    // 首次加载
    void loadDir('');
  }

  return {
    currentPath,
    items,
    parent,
    isRoot,
    isWindows,
    loading,
    error,
    showHidden,
    hiddenCount,
    sortBy,
    sortOrder,
    preview,
    initialize,
    loadDir,
    navigate,
    goBack,
    refreshCurrent,
    toggleHidden,
    setSortBy,
    toggleSortOrder,
    sortItems,
    showUploadDialog,
    createDirectory,
    createFile,
    renameItem,
    deleteItem,
    downloadFile,
    openPreview,
    closePreview,
    copyPreviewPath,
    startEdit,
    cancelEdit,
    saveEdit,
  };
}
