'use strict';

/**
 * 1Shell AI(skills 槽位)配置文件 — <dataDir>/1shell-ai.json
 *
 * "配置文件生成器"语义,与 native-cli-config 生成 CLI 原生文件对齐:
 *   - 表单/启用 = 生成器:活跃 provider 变化时自动生成写入(不会覆盖手工草稿)
 *   - 保存草稿 = 手工接管:直接写文件并立即生效,文件标记为 overridden
 *   - 恢复自动 = 丢弃手工内容,按当前活跃 provider 重新生成
 *   - 运行时:skills 代理每次请求都读此文件(mtime 缓存);文件缺失或损坏时
 *     回退 provider store(兼容从未用过生成器的存量用户)
 *
 * meta 侧车(1shell-ai.meta.json)记录最近一次自动生成内容的 hash——
 * 磁盘内容 hash ≠ autoHash 即视为手工草稿。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isReasoningModel, ANTHROPIC_BUDGET_TOKENS, OPENAI_EFFORT_VALUES } = require('./reasoning');
const { getPreset } = require('./provider-presets');

const FILE_NAME = '1shell-ai.json';
const META_NAME = '1shell-ai.meta.json';
const MAX_FILE_BYTES = 64 * 1024;

function hashText(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 旧的语义化 reasoning 档位 → 等效原始参数(保持存量配置生成文件后行为不变) */
function legacyEffortToRequestParams(provider) {
  const effort = String(provider?.reasoningEffort || '').trim().toLowerCase();
  if (!effort || effort === 'auto') return null;
  const protocol = provider?.upstreamProtocol === 'anthropic' ? 'anthropic' : 'openai';
  const extraPrefixes = provider?.presetId
    ? (getPreset(provider.presetId)?.reasoningModels || [])
    : [];
  if (!isReasoningModel(provider?.model, protocol, extraPrefixes)) return null;
  if (protocol === 'anthropic') {
    const budget = ANTHROPIC_BUDGET_TOKENS[effort];
    return budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : null;
  }
  const value = OPENAI_EFFORT_VALUES[effort];
  return value ? { reasoning_effort: value } : null;
}

function resolveRequestParams(provider) {
  const params = provider?.requestParams;
  // 显式 requestParams 优先并完全取代 legacy 语义档位(UI 设置 requestParams 时
  // 会把 reasoningEffort 归 auto,二者并存是 UI 阻止的非法态);仅当没有显式参数
  // 时,才把旧的 reasoningEffort 迁移成等效原始参数,保持存量配置行为不变。
  if (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length) {
    return params;
  }
  return legacyEffortToRequestParams(provider);
}

function createOneshellAiConfig({ dataDir, proxyConfigStore, logger = console } = {}) {
  if (!dataDir) throw new Error('createOneshellAiConfig 需要 dataDir');
  const filePath = path.join(dataDir, FILE_NAME);
  const metaPath = path.join(dataDir, META_NAME);
  let runtimeCache = { mtimeMs: -1, size: -1, config: null };
  let warnedKey = '';

  function readMeta() {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return meta && typeof meta === 'object' ? meta : null;
    } catch {
      return null;
    }
  }

  function writeFileAtomic(target, text) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target); // rename 是原子的:读者只会看到旧全量或新全量,绝无截断
  }

  function writeAuto(content) {
    fs.mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(filePath, content);
    writeFileAtomic(metaPath, JSON.stringify({ autoHash: hashText(content), updatedAt: new Date().toISOString() }, null, 2));
    runtimeCache = { mtimeMs: -1, size: -1, config: null };
  }

  function readDisk() {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 与 proxy store 的 projectActiveModel 对齐:草稿带 models[] 时以活跃模型
   * 档案的字段为准(store 投影过的 provider 再投影一次是幂等的)。
   */
  function projectSourceModel(source) {
    const models = Array.isArray(source?.models)
      ? source.models.filter((model) => model && typeof model === 'object')
      : [];
    if (!models.length) return source;
    // store 的 normalizeProviderModels 在 activeModelId 失效时取"第一个 enabled"
    // 模型,而非无脑 models[0];此处对齐,否则 models[0] 被禁用时文件生成器与
    // 运行时 store 选中不同模型。
    const active = models.find((model) => model.id && model.id === source.activeModelId)
      || models.find((model) => model.enabled !== false)
      || models[0];
    const projected = { ...source };
    projected.model = String(active.apiModel ?? active.model ?? '').trim();
    projected.reasoningEffort = active.reasoningEffort || 'auto';
    for (const key of ['contextTokenLimit', 'maxOutputTokens', 'requestParams']) {
      if (Object.prototype.hasOwnProperty.call(active, key)) projected[key] = active[key];
      else delete projected[key];
    }
    return projected;
  }

  /** 生成配置文件内容(来源:provider 记录或表单草稿) */
  function buildContent(provider) {
    const source = projectSourceModel(provider && typeof provider === 'object' ? provider : {});
    const config = {
      name: String(source.name || '1Shell AI').trim() || '1Shell AI',
      upstreamProtocol: source.upstreamProtocol === 'anthropic' ? 'anthropic' : 'openai',
      apiBase: String(source.apiBase || '').trim(),
      apiKey: String(source.apiKey || '').trim(),
      model: String(source.model || '').trim(),
    };
    const maxOutputTokens = Number(source.maxOutputTokens);
    if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) config.maxOutputTokens = maxOutputTokens;
    const contextTokenLimit = Number(source.contextTokenLimit);
    if (Number.isInteger(contextTokenLimit) && contextTokenLimit > 0) config.contextTokenLimit = contextTokenLimit;
    const requestParams = resolveRequestParams(source);
    if (requestParams) config.requestParams = requestParams;
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  function getActiveSkillsProvider() {
    try {
      return proxyConfigStore?.getActiveProvider?.('skills') || null;
    } catch {
      return null;
    }
  }

  /** 磁盘内容是否是手工草稿(≠ 最近一次自动生成) */
  function isManualOverride() {
    const disk = readDisk();
    if (disk == null) return false;
    const meta = readMeta();
    if (meta?.autoHash) return hashText(disk) !== meta.autoHash;
    // meta 缺失(外部创建,或 config 写入后、meta 写入前崩溃)。无脑判手工会把
    // 崩溃残留的自动文件永久锁死停更;先与当前活跃 provider 的自动内容对账——
    // 内容相符即自动生成的残留,回填 meta 自愈;不符才是真手工草稿。
    const provider = getActiveSkillsProvider();
    if (provider && disk === buildContent(provider)) {
      try { writeFileAtomic(metaPath, JSON.stringify({ autoHash: hashText(disk), updatedAt: new Date().toISOString() }, null, 2)); } catch { /* 忽略:下次再补 */ }
      return false;
    }
    return true;
  }

  function fileEntry(content, { preview = false } = {}) {
    const disk = readDisk();
    return {
      name: FILE_NAME,
      path: filePath,
      exists: disk != null,
      editable: true,
      overridden: isManualOverride(),
      enabled: disk != null && disk === String(content ?? ''),
      mergeStrategy: 'overwrite',
      content: String(content ?? ''),
      ...(preview ? { preview: true } : {}),
    };
  }

  /** 生成器实时预览(表单草稿驱动) */
  function previewFiles({ activeProvider = undefined } = {}) {
    const provider = activeProvider ?? getActiveSkillsProvider() ?? {};
    return [fileEntry(buildContent(provider), { preview: true })];
  }

  /** 列表视图:磁盘内容优先,没有文件时展示按活跃 provider 生成的内容 */
  function listFiles() {
    const disk = readDisk();
    const content = disk != null ? disk : buildContent(getActiveSkillsProvider() || {});
    return [fileEntry(content)];
  }

  function assertFileName(fileName) {
    if (String(fileName || '').trim() !== FILE_NAME) {
      throw new Error(`未知或不可编辑配置文件: ${fileName}`);
    }
  }

  function validateContent(content) {
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`${FILE_NAME} 过大(上限 64KB)`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text || '{}');
    } catch (err) {
      throw new Error(`${FILE_NAME} 不是合法 JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${FILE_NAME} 必须是 JSON 对象`);
    }
    if (parsed.apiBase != null && String(parsed.apiBase).trim()) {
      let url;
      try {
        url = new URL(String(parsed.apiBase).trim());
      } catch {
        throw new Error('apiBase 必须是合法 URL,例如 https://api.example.com');
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('apiBase 只允许 http 或 https');
    }
    if (parsed.requestParams != null && (typeof parsed.requestParams !== 'object' || Array.isArray(parsed.requestParams))) {
      throw new Error('requestParams 必须是 JSON 对象(键值对)');
    }
    return text;
  }

  /** 保存手工草稿:直接写文件,立即生效(meta 不更新 → overridden=true) */
  function writeFile(fileName, content) {
    assertFileName(fileName);
    const text = validateContent(content);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, text);
    runtimeCache = { mtimeMs: -1, size: -1, config: null };
    return listFiles();
  }

  /** 恢复自动:按当前活跃 provider 重新生成(没有活跃 provider 时删除文件) */
  function clearOverride(fileName) {
    assertFileName(fileName);
    const provider = getActiveSkillsProvider();
    if (provider) {
      writeAuto(buildContent(provider));
    } else {
      try { fs.rmSync(filePath, { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(metaPath, { force: true }); } catch { /* 忽略 */ }
      runtimeCache = { mtimeMs: -1, size: -1, config: null };
    }
    return listFiles();
  }

  /**
   * 表单保存/启用/路由切换后同步:按活跃 provider 重新生成。
   * 手工草稿在位时跳过(不覆盖用户接管的内容),与原生 CLI 草稿语义一致。
   * 活跃 provider 已不存在时清掉自动生成的文件,让运行时回退 provider store。
   */
  function syncFromActiveProvider() {
    const provider = getActiveSkillsProvider();
    if (isManualOverride()) return { synced: false, reason: 'manual-override' };
    if (!provider) {
      if (readDisk() == null) return { synced: false, reason: 'no-active-provider' };
      try { fs.rmSync(filePath, { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(metaPath, { force: true }); } catch { /* 忽略 */ }
      runtimeCache = { mtimeMs: -1, size: -1, config: null };
      return { synced: true, reason: 'removed-no-active-provider' };
    }
    writeAuto(buildContent(provider));
    return { synced: true };
  }

  /** 运行时读取(skills 代理每次请求调用;mtime+size 缓存) */
  function readRuntimeConfig() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (runtimeCache.mtimeMs === stat.mtimeMs && runtimeCache.size === stat.size) {
      return runtimeCache.config;
    }
    let config = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed;
      } else {
        throw new Error('配置文件必须是 JSON 对象');
      }
    } catch (err) {
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (warnedKey !== key) {
        warnedKey = key;
        logger?.warn?.(`1shell-ai.json 解析失败,已回退 provider 配置: ${err.message}`);
      }
    }
    runtimeCache = { mtimeMs: stat.mtimeMs, size: stat.size, config };
    return config;
  }

  return {
    FILE_NAME,
    filePath,
    buildContent,
    previewFiles,
    listFiles,
    writeFile,
    clearOverride,
    syncFromActiveProvider,
    readRuntimeConfig,
    isManualOverride,
  };
}

module.exports = { createOneshellAiConfig, FILE_NAME };
