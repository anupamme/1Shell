'use strict';

const { Router } = require('express');
const { BRIDGE_TOKEN, PORT, PUBLIC_SERVER_URL } = require('../config/env');
const { getAllManifests, getManifest, UPSTREAM_LABELS } = require('../agents/cli-manifest');
const { getAllPresets, getPreset } = require('../agents/provider-presets');
const { getAllMcpPresets, getMcpPreset } = require('../agents/mcp-presets');

/**
 * Agent Setup Routes — 3.0 Sandbox
 *
 * GET  /api/agent/scan                            扫描所有 CLI（含沙箱状态）
 * GET  /api/agent/endpoints                       1Shell 端点信息
 * GET  /api/agent/diagnostics                     连通性诊断
 * GET  /api/agent/diagnostics/:cliId              单个 CLI 接入诊断
 * POST /api/agent/install/:cliId                  自动安装 CLI
 * PUT  /api/agent/binary/:cliId                   手动指定 CLI 可执行文件路径
 * DELETE /api/agent/binary/:cliId                 清除手动路径覆盖
 * POST /api/agent/sandbox/ensure/:cliId           确保沙箱就绪
 * POST /api/agent/sandbox/reset/:cliId            重置沙箱
 * GET  /api/agent/sandbox/status/:cliId           查询沙箱状态
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
function createAgentSetupRouter({ proxyConfigStore, cliSandbox, mcpPresetStore } = {}) {
  const router = Router();

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
    if (!cliSandbox) {
      return res.json({ ok: false, error: 'CLI 沙箱管理器未初始化' });
    }

    const tools = cliSandbox.getScanInfo();

    const counts = {
      total: tools.length,
      sandboxed: tools.filter(t => t.status === 'sandboxed').length,
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

  // ─── 沙箱管理 ──────────────────────────────────────────────────────────

  function requireSandbox(req, res) {
    if (!cliSandbox) {
      res.status(503).json({ ok: false, error: 'CLI 沙箱管理器未初始化' });
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

  function normalizeApiV1Base(apiBase) {
    const raw = String(apiBase || '').trim().replace(/\/+$/, '');
    if (!raw) throw new Error('apiBase 不能为空');
    // eslint-disable-next-line no-new
    new URL(raw);
    return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
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

    const base = normalizeApiV1Base(provider.apiBase);
    const signal = AbortSignal.timeout(10000);
    let url;
    let body;
    let headers;
    let probe;

    if (upstream === 'anthropic') {
      probe = 'anthropic.messages';
      url = `${base}/messages`;
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
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      return res.json({ ok: true, cliId, ...cliSandbox.getToolDiagnostics(cliId) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/install/:cliId', async (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const result = await cliSandbox.installCli(cliId);
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
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const tool = cliSandbox.setBinaryOverride(cliId, req.body?.path || req.body?.binaryPath || '');
      return res.json({ ok: true, cliId, tool });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/agent/binary/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;
    try {
      const tool = cliSandbox.clearBinaryOverride(cliId);
      return res.json({ ok: true, cliId, tool });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/sandbox/ensure/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    try {
      const dir = cliSandbox.ensureSandbox(cliId, { cwd: req.body?.cwd || process.cwd() });
      const status = cliSandbox.getSandboxStatus(cliId);
      return res.json({ ok: true, cliId, sandboxDir: dir, ...status });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/agent/sandbox/reset/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    const ok = cliSandbox.resetSandbox(cliId);
    return res.json({ ok, cliId });
  });

  router.get('/agent/sandbox/status/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    const status = cliSandbox.getSandboxStatus(cliId);
    return res.json({ ok: true, cliId, ...status });
  });

  router.get('/agent/launch-command/:cliId', (req, res) => {
    if (!requireSandbox(req, res)) return;
    const { cliId } = req.params;
    if (!validateManifestCli(cliId, res)) return;

    const shell = req.query.shell || (process.platform === 'win32' ? 'powershell' : 'bash');
    try {
      const env = cliSandbox.buildLaunchEnv(cliId);
      const command = redactLaunchCommand(cliSandbox.buildShellCommand(cliId, { shell }), env);
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
    const result = proxyConfigStore.listProviders(req.params.cliId);
    return res.json({ ok: true, ...result });
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
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/agent/providers/:cliId/:pid', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const ok = proxyConfigStore.deleteProvider(req.params.cliId, req.params.pid);
    if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
    return res.json({ ok: true });
  });

  router.put('/agent/providers/:cliId/:pid/activate', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const modelId = req.body?.modelId || req.body?.activeModelId || null;
    const ok = proxyConfigStore.setActive(req.params.cliId, req.params.pid, modelId);
    if (!ok) return res.status(404).json({ ok: false, error: 'Provider 不存在' });
    return res.json({ ok: true });
  });

  router.get('/agent/routes/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const result = proxyConfigStore.listProviders(req.params.cliId);
    return res.json({ ok: true, activeRoute: result.activeRoute || null, activeProviderId: result.activeProviderId || null });
  });

  router.put('/agent/routes/:cliId', (req, res) => {
    if (!validateCli(req.params.cliId, res)) return;
    const route = proxyConfigStore.setRoute(req.params.cliId, req.body || {});
    if (!route) return res.status(404).json({ ok: false, error: 'Route 指向的 Provider 不存在' });
    return res.json({ ok: true, activeRoute: route });
  });

  // ─── Provider Preset 库(只读)──────────────────────────────────────────
  router.get('/agent/provider-presets', (_req, res) => {
    return res.json({ ok: true, presets: getAllPresets() });
  });
  router.get('/agent/provider-presets/:id', (req, res) => {
    const preset = getPreset(req.params.id);
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
      // 立即重写沙箱 config(下次启动 CLI 时新 entry 即生效)
      try { cliSandbox?.ensureSandbox?.(body.cliId); } catch (err) {
        // 沙箱重写失败不应该阻塞 apply ── apply 已写入 store,下次 ensureSandbox 自动生效
        // (用户可能没有该 CLI 的有效配置,但仍可注册 preset 等待后续)
      }
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
    try { cliSandbox?.ensureSandbox?.(req.params.cliId); } catch {}
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAgentSetupRouter };
