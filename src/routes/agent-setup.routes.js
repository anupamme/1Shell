'use strict';

const { Router } = require('express');
const { BRIDGE_TOKEN, PORT, PUBLIC_SERVER_URL } = require('../config/env');
const { getAllManifests, getManifest, UPSTREAM_LABELS } = require('../agents/cli-manifest');
const { getAllPresets, getPreset, getPresetsForCli } = require('../agents/provider-presets');
const { getAllMcpPresets, getMcpPreset } = require('../agents/mcp-presets');

/**
 * Agent Setup Routes — native CLI config
 *
 * GET  /api/agent/scan                            扫描所有 CLI（含配置状态）
 * GET  /api/agent/endpoints                       1Shell 端点信息
 * GET  /api/agent/diagnostics                     连通性诊断
 * GET  /api/agent/diagnostics/:cliId              单个 CLI 接入诊断
 * POST /api/agent/install/:cliId                  自动安装 CLI
 * PUT  /api/agent/binary/:cliId                   手动指定 CLI 可执行文件路径
 * DELETE /api/agent/binary/:cliId                 清除手动路径覆盖
 * POST /api/agent/native-config/enable/:cliId     启用当前配置文件到原生 CLI 路径
 * POST /api/agent/native-config/reset/:cliId      重置 1Shell 配置状态
 * GET  /api/agent/native-config/status/:cliId     查询原生配置状态
 * GET  /api/agent/config-files/:cliId             查看 1Shell 配置草稿/生成结果
 * PUT  /api/agent/config-files/:cliId/:fileName   保存某个配置文件草稿
 * DELETE /api/agent/config-files/:cliId/:fileName/override  清除手动草稿并重新生成
 * GET  /api/agent/launch-command/:cliId           获取启动命令
 * GET  /api/agent/providers/:cliId                列出某 CLI 的所有 Provider
 * POST /api/agent/providers/:cliId                添加 Provider
 * POST /api/agent/providers/:cliId/:pid/copy      复制 Provider
 * POST /api/agent/providers/:cliId/:pid/test      测试 Provider
 * PUT  /api/agent/providers/:cliId/:pid            更新 Provider
 * DELETE /api/agent/providers/:cliId/:pid          删除 Provider
 * PUT  /api/agent/providers/:cliId/:pid/activate    设为活跃
 * PUT  /api/agent/routes/:cliId                   设置入口路由（Provider + Model）
 */
function createAgentSetupRouter({ proxyConfigStore, nativeCliConfig, mcpPresetStore, oneshellAiConfig } = {}) {
  const router = Router();

  // skills 槽位的 provider 变更(增/改/删/启用/切路由)后,把活跃配置
  // 重新生成写入 1shell-ai.json(配置文件生成器产物,运行时权威;
  // 手工草稿在位时模块内部会跳过,不覆盖用户接管的内容)。
  function syncOneshellAiFile(cliId) {
    if (cliId !== 'skills' || !oneshellAiConfig?.syncFromActiveProvider) return;
    try {
      oneshellAiConfig.syncFromActiveProvider();
    } catch {
      // 同步失败不阻塞 provider 操作本身;下次操作或恢复自动会重写
    }
  }

  function resolveServerUrl(reqBody, req) {
    if (reqBody?.serverUrl && typeof reqBody.serverUrl === 'string') {
      return reqBody.serverUrl.replace(/\/$/, '');
    }
    if (/^https?:\/\//i.test(PUBLIC_SERVER_URL)) return PUBLIC_SERVER_URL;
    const proto = String(req.headers['x-forwarded-proto'] || req.headers.origin?.split('://')[0] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.origin?.split('://')[1] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
    return `${proto}://${host}`;
  }

  function resolveLoopbackServerUrl() {
    return `http://127.0.0.1:${PORT}`;
  }

  function maskToken(token) {
    if (!token || token.length < 12) return '****';
    return token.substring(0, 6) + '…' + token.substring(token.length - 4);
  }

  function redactLaunchCommand(command, env) {
    let redacted = String(command || '');
    for (const [key, value] of Object.entries(env || {})) {
      if (!/(TOKEN|KEY|SECRET|PASSWORD)/i.test(key)) continue;
      const secret = String(value || '');
      if (!secret) continue;
      redacted = redacted.split(secret).join('****');
    }
    return redacted;
  }

  // ─── 扫描所有 CLI 工具 ────────────────────────────────────────────────
  router.get('/agent/scan', (req, res) => {
    if (!nativeCliConfig) {
      return res.json({ ok: false, error: 'CLI 配置管理器未初始化' });
    }

    const tools = nativeCliConfig.getScanInfo();

    const counts = {
      total: tools.length,
      configured: tools.filter(t => t.status === 'configured').length,
      detected: tools.filter(t => t.status === 'detected').length,
      missing: tools.filter(t => t.status === 'missing').length,
    };

    return res.json({ ok: true, tools, counts, upstreamLabels: UPSTREAM_LABELS });
  });

  // ─── 端点信息 ─────────────────────────────────────────────────────────
  router.get('/agent/endpoints', (req, res) => {
    const serverUrl = resolveServerUrl(null, req);
    return res.json({
      ok: true,
      endpoints: {
        bridge: { url: `${serverUrl}/api/bridge`, protocol: 'REST' },
        mcp: { url: `${serverUrl}/mcp/sse`, protocol: 'SSE' },
      },
      token: { masked: maskToken(BRIDGE_TOKEN), ready: Boolean(BRIDGE_TOKEN) },
    });
  });

  // ─── 诊断 ─────────────────────────────────────────────────────────────
  router.get('/agent/diagnostics', async (req, res) => {
    const serverUrl = resolveServerUrl(null, req);
    const checks = [];
    try {
      const start = Date.now();
      const resp = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      checks.push({ name: 'Bridge 端点响应', ok: resp.ok, ms: Date.now() - start });
    } catch (err) {
      checks.push({ name: 'Bridge 端点响应', ok: false, error: err.message });
    }
    try {
      const start = Date.now();
      const resp = await fetch(`${resolveLoopbackServerUrl()}/mcp/sse`, {
        headers: { 'X-Bridge-Token': BRIDGE_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
      checks.push({ name: 'MCP SSE 握手', ok: resp.ok || resp.status === 200, ms: Date.now() - start });
      try { resp.body?.cancel(); } catch { /* ignore */ }
    } catch (err) {
      checks.push({ name: 'MCP SSE 握手', ok: false, error: err.message });
    }
    checks.push({ name: 'Bridge Token', ok: Boolean(BRIDGE_TOKEN), detail: BRIDGE_TOKEN ? '已配置' : '未配置' });
    return res.json({ ok: true, checks });
  });

  // ─── 原生配置管理 ───────────────────────────────────────────────────────

  function requireNativeConfig(req, res) {
    if (!nativeCliConfig) {
      res.status(503).json({ ok: false, error: 'CLI 配置管理器未初始化' });
      return false;
    }
    return true;
  }

  function requireOneshellAiConfig(res) {
    if (!oneshellAiConfig) {
      res.status(503).json({ ok: false, error: '1Shell AI 配置文件管理器未初始化' });
      return false;
    }
    return true;
  }

  // 允许 CLI manifest 中的 ID + 'skills'（Skill 专用 API 槽位）
  const EXTRA_PROVIDER_SLOTS = ['skills'];

  // Skill 引擎（'skills' 槽位）不是 CLI，没有 manifest，但仍需要上游协议约束。
  // 通过 /api/proxy/skills/v1/messages 调 Anthropic Messages API，因此支持 anthropic；
  // 同时允许 openai 以便用户复用已有的 OpenAI 兼容端点。
  const EXTRA_MANIFESTS = {
    skills: { id: 'skills', name: 'Skill 引擎', supportedUpstream: ['anthropic', 'openai'] },
  };
  const resolveManifest = (cliId) => getManifest(cliId) || EXTRA_MANIFESTS[cliId] || null;

  function validateCli(cliId, res) {
    if (!getManifest(cliId) && !EXTRA_PROVIDER_SLOTS.includes(cliId)) {
      res.status(400).json({ ok: false, error: `未知 CLI: ${cliId}` });
      return false;
    }
    return true;
  }

  function validateManifestCli(cliId, res) {
    if (!getManifest(cliId)) {
      res.status(400).json({ ok: false, error: `未知 CLI: ${cliId}` });
      return false;
    }
    return true;
  }

  function validateProviderUpstream(cliId, upstream, res) {
    if (!upstream) return true;
    const cli = resolveManifest(cliId);
    const allowed = cli?.supportedUpstream || ['openai'];
    if (allowed.includes(upstream)) return true;
    const label = cli?.name || cliId;
    res.status(400).json({ ok: false, error: `${label} 不支持 ${upstream} 上游协议，可选: ${allowed.join(', ')}` });
    return false;
  }

  function scanNativeProviderForCli(cliId) {
    if (!getManifest(cliId) || !nativeCliConfig?.scanNativeProviderConfig) {
      return { found: false, imported: false };
    }
    const scan = nativeCliConfig.scanNativeProviderConfig(cliId);
    if (!scan?.found || !scan.provider) {
      return {
        found: false,
        imported: false,
        files: scan?.files || [],
        error: scan?.error || '',
        reason: scan?.reason || '',
      };
    }
    return {
      found: true,
      imported: false,
      id: null,
      files: scan.files || [],
      reason: '发现本机配置，可点击重新读取导入到 1Shell 表单',
    };
  }

  function importNativeProviderForCli(cliId) {
    if (!getManifest(cliId) || !nativeCliConfig?.scanNativeProviderConfig || !proxyConfigStore?.upsertNativeProvider) {
      return { found: false, imported: false };
    }
    const scan = nativeCliConfig.scanNativeProviderConfig(cliId);
    if (!scan?.found || !scan.provider) {
      return {
        found: false,
        imported: false,
        files: scan?.files || [],
        error: scan?.error || '',
        reason: scan?.reason || '',
      };
    }
    try {
      const result = proxyConfigStore.upsertNativeProvider(cliId, scan.provider);
      return {
        found: true,
        ...result,
        files: scan.files || [],
      };
    } catch (err) {
      return {
        found: true,
        imported: false,
        files: scan.files || [],
        error: err.message,
      };
    }
  }

  // 读取器+储存器：本机原生配置默认直接成为“已添加的配置方案”。
  // 但 enabled-meta 记录了 providerId 时说明当前盘上的配置是 1Shell「启用」写入的，
  // 此时跳过自动导入，避免把替换器刚写盘的方案镜像回列表、覆盖用户原始的本机配置条目。
  function autoImportNativeProviderForCli(cliId) {
    const managedProviderId = String(nativeCliConfig?.getNativeConfigStatus?.(cliId)?.meta?.providerId || '').trim();
    if (!managedProviderId) return importNativeProviderForCli(cliId);
    const scan = scanNativeProviderForCli(cliId);
    return {
      ...scan,
      managedProviderId,
      reason: scan.found ? '当前本机配置由 1Shell 启用的配置方案写入' : scan.reason,
    };
  }

  function normalizeApiBase(apiBase) {
    const raw = String(apiBase || '').trim().replace(/\/+$/, '');
    if (!raw) throw new Error('apiBase 不能为空');
    // eslint-disable-next-line no-new
    new URL(raw);
    return raw;
  }

  function truncateText(text, max = 500) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }

  async function readUpstreamError(resp) {
    const text = await resp.text().catch(() => '');
    if (!text) return resp.statusText || '上游未返回错误详情';
    try {
      const json = JSON.parse(text);
      return truncateText(json?.error?.message || json?.message || json?.error || text);
    } catch {
      return truncateText(text);
    }
  }

  async function testProviderConnection(cliId, provider) {
    const upstream = provider?.upstreamProtocol || 'openai';
    const model = String(provider?.model || '').trim();
    if (!provider?.apiBase) throw new Error('apiBase 不能为空');
    if (!provider?.apiKey) throw new Error('apiKey 不能为空');
    if (!model) throw new Error('模型不能为空');

    const base = normalizeApiBase(provider.apiBase);
    const signal = AbortSignal.timeout(10000);
    let url;
    let body;
    let headers;
    let probe;

    if (upstream === 'anthropic') {
      // Anthropic 协议 base 语义为 ANTHROPIC_BASE_URL，需补 /v1 到 /messages
      const anthropicBase = /\/v1$/i.test(base) ? base : `${base}/v1`;
      probe = 'anthropic.messages';
      url = `${anthropicBase}/messages`;
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      };
      body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    } else {
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      };
      if (cliId === 'codex') {
        probe = 'openai.responses';
        url = `${base}/responses`;
        body = { model, input: 'ping', max_output_tokens: 1, stream: false };
      } else {
        probe = 'openai.chat';
        url = `${base}/chat/completions`;
        body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false };
      }
    }

    const startedAt = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const ms = Date.now() - startedAt;
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        ms,
        probe,
        model,
        upstreamProtocol: upstream,
        error: `上游返回 ${resp.status}: ${await readUpstreamError(resp)}`,
      };
    }
    try { await resp.body?.cancel?.(); } catch { /* ignore */ }
    return { ok: true, status: resp.status, ms, probe, model, upstreamProtocol: upstream };
  }

  router.get('/agent/diagnostics/:cliId', (req, res) => {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      return res.json({ ok: true, cliId, ...nativeCliConfig.getToolDiagnostics(cliId) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/install/:cliId', async (req, res) => {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const result = await nativeCliConfig.installCli(cliId);
      return res.json({ ok: true, cliId, ...result });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        cliId,
        error: err.message,
        result: err.result || null,
      });
    }
  });

  router.put('/agent/binary/:cliId', (req, res) => {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const tool = nativeCliConfig.setBinaryOverride(cliId, req.body?.path || req.body?.binaryPath || '');
      return res.json({ ok: true, cliId, tool });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/agent/binary/:cliId', (req, res) => {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const tool = nativeCliConfig.clearBinaryOverride(cliId);
      return res.json({ ok: true, cliId, tool });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  function enableNativeConfig(req, res) {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    try {
      const dir = nativeCliConfig.enableNativeConfig(cliId, {
        cwd: req.body?.cwd || process.cwd(),
        files: Array.isArray(req.body?.files) ? req.body.files : null,
      });
      const status = nativeCliConfig.getNativeConfigStatus(cliId);
      return res.json({ ok: true, cliId, configDir: dir, ...status });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  function resetNativeConfig(req, res) {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    const ok = nativeCliConfig.resetNativeConfig(cliId);
    return res.json({ ok, cliId });
  }

  function getNativeConfigStatus(req, res) {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    const status = nativeCliConfig.getNativeConfigStatus(cliId);
    return res.json({ ok: true, cliId, ...status });
  }

  router.post('/agent/native-config/enable/:cliId', enableNativeConfig);
  router.post('/agent/native-config/ensure/:cliId', enableNativeConfig);
  router.post('/agent/native-config/reset/:cliId', resetNativeConfig);
  router.get('/agent/native-config/status/:cliId', getNativeConfigStatus);

  function buildConfigPreviewProvider(cliId, body = {}) {
    const draft = body.provider && typeof body.provider === 'object' ? body.provider : {};
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const modelId = draft.activeModelId || draft.routeModelId || null;
    const current = providerId && proxyConfigStore?.getProvider
      ? (proxyConfigStore.getProvider(cliId, providerId, modelId) || {})
      : {};
    const merged = { ...draft };
    if (!draft.apiKey && current.apiKey) merged.apiKey = current.apiKey;
    return merged;
  }

  router.post('/agent/config-preview/:cliId', (req, res) => {
    const { cliId } = req.params;
    if (cliId === 'skills') {
      if (!requireOneshellAiConfig(res)) return;
      const draft = req.body?.provider || {};
      if (!validateProviderUpstream(cliId, draft.upstreamProtocol || undefined, res)) return;
      try {
        const files = oneshellAiConfig.previewFiles({
          activeProvider: buildConfigPreviewProvider(cliId, req.body || {}),
        });
        return res.json({ ok: true, cliId, files });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    }
    if (!requireNativeConfig(req, res)) return;
    if (!validateManifestCli(cliId, res)) return;
    const draft = req.body?.provider || {};
    const upstream = draft.upstreamProtocol || undefined;
    if (!validateProviderUpstream(cliId, upstream, res)) return;
    try {
      const files = nativeCliConfig.previewConfigFiles(cliId, {
        cwd: req.body?.cwd || process.cwd(),
        activeProvider: buildConfigPreviewProvider(cliId, req.body || {}),
      });
      return res.json({ ok: true, cliId, files });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/agent/config-files/:cliId', (req, res) => {
    const { cliId } = req.params;
    if (cliId === 'skills') {
      if (!requireOneshellAiConfig(res)) return;
      try {
        return res.json({ ok: true, cliId, files: oneshellAiConfig.listFiles() });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    }
    if (!requireNativeConfig(req, res)) return;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const files = nativeCliConfig.listConfigFiles(cliId, { cwd: req.query.cwd || process.cwd() });
      return res.json({ ok: true, cliId, files });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/agent/config-files/:cliId/:fileName', (req, res) => {
    const { cliId, fileName } = req.params;
    if (cliId === 'skills') {
      if (!requireOneshellAiConfig(res)) return;
      try {
        return res.json({ ok: true, cliId, files: oneshellAiConfig.writeFile(fileName, req.body?.content || '') });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    }
    if (!requireNativeConfig(req, res)) return;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const files = nativeCliConfig.writeConfigFile(cliId, fileName, req.body?.content || '');
      return res.json({ ok: true, cliId, files });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/agent/config-files/:cliId/:fileName/override', (req, res) => {
    const { cliId, fileName } = req.params;
    if (cliId === 'skills') {
      if (!requireOneshellAiConfig(res)) return;
      try {
        return res.json({ ok: true, cliId, files: oneshellAiConfig.clearOverride(fileName) });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    }
    if (!requireNativeConfig(req, res)) return;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const files = nativeCliConfig.clearConfigFileOverride(cliId, fileName, { cwd: req.body?.cwd || process.cwd() });
      return res.json({ ok: true, cliId, files });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/agent/launch-command/:cliId', (req, res) => {
    if (!requireNativeConfig(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    const shell = req.query.shell || (process.platform === 'win32' ? 'powershell' : 'bash');
    try {
      const env = nativeCliConfig.buildLaunchEnv(cliId, { prepareNative: false, useLocalEnv: true });
      const command = redactLaunchCommand(nativeCliConfig.buildShellCommand(cliId, { shell, prepareNative: false, useLocalEnv: true }), env);
      return res.json({
        ok: true,
        cliId,
        shell,
        command,
        vars: Object.fromEntries(
          Object.entries(env)
            .filter(([k]) => k !== 'ONESHELL_MCP_TOKEN')
        ),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Per-CLI Provider CRUD ─────────────────────────────────────────────

  router.get('/agent/providers/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const nativeImport = autoImportNativeProviderForCli(req.params.cliId);
    const result = proxyConfigStore.listProviders(req.params.cliId);
    return res.json({ ok: true, ...result, nativeImport });
  });

  router.post('/agent/providers/:cliId/import-native', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const nativeImport = importNativeProviderForCli(req.params.cliId);
    const result = proxyConfigStore.listProviders(req.params.cliId);
    return res.json({ ok: !nativeImport.error, ...result, nativeImport });
  });

  router.post('/agent/providers/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const body = req.body || {};
    if (!body.apiBase || !body.apiKey) {
      return res.status(400).json({ ok: false, error: 'apiBase 和 apiKey 不能为空' });
    }
    const upstream = body.upstreamProtocol || 'openai';
    if (!validateProviderUpstream(req.params.cliId, upstream, res)) return;
    try {
      const id = proxyConfigStore.addProvider(req.params.cliId, body);
      syncOneshellAiFile(req.params.cliId);
      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/providers/:cliId/:pid/copy', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    try {
      const id = proxyConfigStore.copyProvider(req.params.cliId, req.params.pid);
      if (!id) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/providers/:cliId/:pid/test', async (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : null;
    const provider = proxyConfigStore.getProvider(req.params.cliId, req.params.pid, modelId);
    if (!provider) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
    if (!validateProviderUpstream(req.params.cliId, provider.upstreamProtocol, res)) return;
    try {
      const result = await testProviderConnection(req.params.cliId, provider);
      return res.json(result);
    } catch (err) {
      const isTimeout = err?.name === 'AbortError' || /aborted|timeout/i.test(err?.message || '');
      return res.json({
        ok: false,
        error: isTimeout ? '测试超时：10 秒内没有收到上游响应' : `测试失败: ${err.message}`,
      });
    }
  });

  router.put('/agent/providers/:cliId/:pid', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    if (!validateProviderUpstream(req.params.cliId, req.body?.upstreamProtocol, res)) return;
    try {
      const ok = proxyConfigStore.updateProvider(req.params.cliId, req.params.pid, req.body || {});
      if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
      syncOneshellAiFile(req.params.cliId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/agent/providers/:cliId/:pid', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    try {
      const ok = proxyConfigStore.deleteProvider(req.params.cliId, req.params.pid);
      if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
      syncOneshellAiFile(req.params.cliId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/agent/providers/:cliId/:pid/activate', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    try {
      const modelId = req.body?.modelId || req.body?.activeModelId || null;
      const ok = proxyConfigStore.setActive(req.params.cliId, req.params.pid, modelId);
      if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
      syncOneshellAiFile(req.params.cliId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/agent/routes/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const result = proxyConfigStore.listProviders(req.params.cliId);
    return res.json({ ok: true, activeRoute: result.activeRoute || null, activeProviderId: result.activeProviderId || null });
  });

  router.put('/agent/routes/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    try {
      const route = proxyConfigStore.setRoute(req.params.cliId, req.body || {});
      if (!route) return res.status(404).json({ ok: false, error: 'Route 指向的 Provider 不存在' });
      syncOneshellAiFile(req.params.cliId);
      return res.json({ ok: true, activeRoute: route });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ─── Provider Preset 库(只读)──────────────────────────────────────────
  router.get('/agent/provider-presets', (req, res) => {
    const cliId = typeof req.query.cliId === 'string' ? req.query.cliId : '';
    if (cliId && !resolveManifest(cliId)) {
      return res.status(400).json({ ok: false, error: `未知 CLI: ${cliId}` });
    }
    return res.json({ ok: true, presets: cliId ? getPresetsForCli(cliId) : getAllPresets() });
  });
  router.get('/agent/provider-presets/:id', (req, res) => {
    const cliId = typeof req.query.cliId === 'string' ? req.query.cliId : '';
    if (cliId && !resolveManifest(cliId)) {
      return res.status(400).json({ ok: false, error: `未知 CLI: ${cliId}` });
    }
    const preset = getPreset(req.params.id, cliId);
    if (!preset) return res.status(404).json({ ok: false, error: 'preset 不存在' });
    return res.json({ ok: true, preset });
  });

  // ─── MCP Preset 库 + applied 管理(v3 plan §4.1 F)──────────────────────
  router.get('/agent/mcp-presets', (_req, res) => {
    return res.json({ ok: true, presets: getAllMcpPresets() });
  });

  router.get('/agent/mcp-presets/applied/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    if (!mcpPresetStore) return res.json({ ok: true, applied: [] });
    return res.json({ ok: true, applied: mcpPresetStore.listApplied(req.params.cliId) });
  });

  // body: { cliId: 'codex', config: { githubToken: 'ghp_...' } }
  router.post('/agent/mcp-presets/:presetId/apply', (req, res) => {
    if (!mcpPresetStore) return res.status(503).json({ ok: false, error: 'MCP preset 存储未启用' });
    const { presetId } = req.params;
    const body = req.body || {};
    if (!body.cliId || !validateCli(body.cliId, res)) return;
    if (!getMcpPreset(presetId)) return res.status(404).json({ ok: false, error: `未知 MCP preset: ${presetId}` });
    try {
      mcpPresetStore.apply(body.cliId, presetId, body.config || {});
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/agent/mcp-presets/:presetId/apply/:cliId', (req, res) => {
    if (!mcpPresetStore) return res.status(503).json({ ok: false, error: 'MCP preset 存储未启用' });
    if (!validateCli(req.params.cliId, res)) return;
    const ok = mcpPresetStore.remove(req.params.cliId, req.params.presetId);
    if (!ok) return res.status(404).json({ ok: false, error: '该 CLI 未应用该 preset' });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAgentSetupRouter };
