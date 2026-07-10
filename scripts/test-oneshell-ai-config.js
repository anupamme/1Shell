'use strict';

/**
 * 1Shell AI 配置文件(<dataDir>/1shell-ai.json)"配置文件生成器"全链路测试。
 *
 * 设计语义(与 native-cli-config 生成 CLI 原生文件对齐):
 *   - 表单/启用 = 生成器:skills 槽位 provider 变更后自动重新生成写入
 *   - 保存草稿 = 手工接管:直接写文件立即生效,标记 overridden,表单不再覆盖
 *   - 恢复自动 = 按当前活跃 provider 重新生成;没有活跃 provider 时删除文件
 *   - 运行时:skills 代理每次请求先读此文件,缺失/损坏回退 provider store
 *
 * 覆盖:
 *   1. 模块语义:生成内容(models[] 投影/legacy effort 迁移)、手工接管判定、
 *      同步/清理生命周期、写入校验、损坏回退
 *   2. 路由 e2e:provider 增/改/启用/切路由/删 → 文件自动跟随;
 *      config-files 接口(列表/手工写入/恢复自动);preview 与落盘一致
 *   3. 代理运行时:文件优先于 store、损坏文件回退 store
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createOneshellAiConfig, FILE_NAME } = require('../src/agents/oneshell-ai-config');
const { createProxyRouter, createProxyConfigStore } = require('../src/routes/proxy.routes');
const { createAgentSetupRouter } = require('../src/routes/agent-setup.routes');
const { ANTHROPIC_BUDGET_TOKENS, OPENAI_EFFORT_VALUES } = require('../src/agents/reasoning');

assert.strictEqual(FILE_NAME, '1shell-ai.json');
const silentLogger = { warn() {} };

// ═══ 1. 模块语义(stub store)═══

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-ai-cfg-'));
  let active = null;
  const cfg = createOneshellAiConfig({
    dataDir: dir,
    proxyConfigStore: { getActiveProvider: () => active },
    logger: silentLogger,
  });
  const filePath = path.join(dir, FILE_NAME);

  // 1a. 无文件:列表展示生成内容但不落盘,运行时回退 null
  let files = cfg.listFiles();
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].name, FILE_NAME);
  assert.strictEqual(files[0].exists, false);
  assert.strictEqual(cfg.readRuntimeConfig(), null, '无文件时运行时应回退 null');

  // 1b. buildContent:models[] 活跃档案投影(与 store projectActiveModel 对齐)
  const projected = JSON.parse(cfg.buildContent({
    name: 'DeepSeek',
    upstreamProtocol: 'openai',
    apiBase: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    model: 'stale-top-level',
    maxOutputTokens: 1,
    activeModelId: 'm2',
    models: [
      { id: 'm1', apiModel: 'deepseek-chat' },
      {
        id: 'm2',
        apiModel: 'deepseek-reasoner',
        maxOutputTokens: 4096,
        contextTokenLimit: 64000,
        requestParams: { reasoning_effort: 'high' },
      },
    ],
  }));
  assert.strictEqual(projected.model, 'deepseek-reasoner', 'models[] 活跃档案的 apiModel 应提升为顶层 model');
  assert.strictEqual(projected.maxOutputTokens, 4096, '活跃档案的 maxOutputTokens 应进文件(顶层旧值作废)');
  assert.strictEqual(projected.contextTokenLimit, 64000);
  assert.deepStrictEqual(projected.requestParams, { reasoning_effort: 'high' });
  assert.strictEqual(projected.apiKey, 'sk-test');

  // 1c. legacy reasoning 档位 → 等效原始参数(requestParams 缺席时的兼容迁移)
  const legacyOpenai = JSON.parse(cfg.buildContent({
    upstreamProtocol: 'openai', apiBase: 'https://x.example', apiKey: 'k',
    model: 'deepseek-reasoner', reasoningEffort: 'high',
  }));
  assert.deepStrictEqual(
    legacyOpenai.requestParams,
    { reasoning_effort: OPENAI_EFFORT_VALUES.high },
    '旧 openai effort 档位应迁移为 reasoning_effort',
  );
  const legacyAnthropic = JSON.parse(cfg.buildContent({
    upstreamProtocol: 'anthropic', apiBase: 'https://x.example', apiKey: 'k',
    model: 'claude-opus-4-8', reasoningEffort: 'high',
  }));
  assert.deepStrictEqual(
    legacyAnthropic.requestParams,
    { thinking: { type: 'enabled', budget_tokens: ANTHROPIC_BUDGET_TOKENS.high } },
    '旧 anthropic effort 档位应迁移为 thinking 注入',
  );
  const explicitWins = JSON.parse(cfg.buildContent({
    upstreamProtocol: 'openai', apiBase: 'https://x.example', apiKey: 'k',
    model: 'deepseek-reasoner', reasoningEffort: 'high',
    requestParams: { temperature: 0.2 },
  }));
  assert.deepStrictEqual(explicitWins.requestParams, { temperature: 0.2 }, '显式 requestParams 应优先于 legacy 迁移');
  const autoNoParams = JSON.parse(cfg.buildContent({
    upstreamProtocol: 'openai', apiBase: 'https://x.example', apiKey: 'k',
    model: 'deepseek-chat', reasoningEffort: 'auto',
  }));
  assert.strictEqual(autoNoParams.requestParams, undefined, 'auto 档位不应产生 requestParams');

  // 1d. 同步:活跃 provider → 落盘;运行时读取
  active = { name: 'A', upstreamProtocol: 'openai', apiBase: 'https://a.example', apiKey: 'sk-a', model: 'model-a' };
  assert.deepStrictEqual(cfg.syncFromActiveProvider(), { synced: true });
  assert.ok(fs.existsSync(filePath), '同步后文件应落盘');
  assert.strictEqual(cfg.isManualOverride(), false);
  assert.strictEqual(cfg.readRuntimeConfig().apiKey, 'sk-a');
  files = cfg.listFiles();
  assert.strictEqual(files[0].exists, true);
  assert.strictEqual(files[0].overridden, false);
  assert.strictEqual(files[0].enabled, true);

  // 1e. 外部改写(hash ≠ autoHash)= 手工草稿:运行时立即生效,同步跳过
  fs.writeFileSync(filePath, `${JSON.stringify({
    upstreamProtocol: 'openai', apiBase: 'https://manual.example', apiKey: 'sk-manual', model: 'manual-m',
  }, null, 2)}\n`);
  assert.strictEqual(cfg.readRuntimeConfig().apiKey, 'sk-manual', '文件变更后运行时应读到新内容(mtime 缓存失效)');
  assert.strictEqual(cfg.isManualOverride(), true);
  active = { ...active, apiKey: 'sk-a2' };
  assert.deepStrictEqual(cfg.syncFromActiveProvider(), { synced: false, reason: 'manual-override' });
  assert.strictEqual(cfg.readRuntimeConfig().apiKey, 'sk-manual', '手工草稿不被表单同步覆盖');

  // 1f. 恢复自动:按当前活跃 provider 重写
  files = cfg.clearOverride(FILE_NAME);
  assert.strictEqual(files[0].overridden, false);
  assert.strictEqual(cfg.readRuntimeConfig().apiKey, 'sk-a2');

  // 1g. 活跃 provider 消失:同步清掉自动文件(运行时才能回退 store)
  active = null;
  assert.deepStrictEqual(cfg.syncFromActiveProvider(), { synced: true, reason: 'removed-no-active-provider' });
  assert.strictEqual(fs.existsSync(filePath), false, '无活跃 provider 时自动文件应被清除');
  assert.strictEqual(cfg.readRuntimeConfig(), null);
  assert.deepStrictEqual(cfg.syncFromActiveProvider(), { synced: false, reason: 'no-active-provider' });

  // 1h. 手工草稿不因 provider 消失被删
  cfg.writeFile(FILE_NAME, JSON.stringify({ apiBase: 'https://manual2.example', apiKey: 'k', model: 'm' }));
  assert.strictEqual(cfg.isManualOverride(), true, 'writeFile 即手工接管');
  assert.deepStrictEqual(cfg.syncFromActiveProvider(), { synced: false, reason: 'manual-override' });
  assert.ok(fs.existsSync(filePath), '手工草稿在 provider 消失时应保留');

  // 1i. 写入校验
  assert.throws(() => cfg.writeFile('evil.json', '{}'), /未知或不可编辑/);
  assert.throws(() => cfg.writeFile(FILE_NAME, 'not json'), /不是合法 JSON/);
  assert.throws(() => cfg.writeFile(FILE_NAME, '[1]'), /JSON 对象/);
  assert.throws(() => cfg.writeFile(FILE_NAME, JSON.stringify({ apiBase: 'not a url' })), /合法 URL/);
  assert.throws(() => cfg.writeFile(FILE_NAME, JSON.stringify({ apiBase: 'ftp://x.example' })), /http 或 https/);
  assert.throws(() => cfg.writeFile(FILE_NAME, JSON.stringify({ requestParams: [1] })), /requestParams 必须是 JSON 对象/);
  assert.throws(() => cfg.writeFile(FILE_NAME, `{"pad":"${'x'.repeat(65 * 1024)}"}`), /64KB/);

  // 1j. 损坏文件:运行时回退 null(不抛异常)
  fs.writeFileSync(filePath, '{broken');
  assert.strictEqual(cfg.readRuntimeConfig(), null, '损坏文件应回退 null');

  // clearOverride 无活跃 provider → 删文件
  cfg.clearOverride(FILE_NAME);
  assert.strictEqual(fs.existsSync(filePath), false);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ 2. 路由 e2e:provider 变更自动同步 + config-files 接口 ═══

async function runRoutesE2E() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-ai-cfg-routes-'));
  const store = createProxyConfigStore(dir);
  const cfg = createOneshellAiConfig({ dataDir: dir, proxyConfigStore: store, logger: silentLogger });
  const filePath = path.join(dir, FILE_NAME);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', createAgentSetupRouter({
    proxyConfigStore: store,
    nativeCliConfig: null,
    mcpPresetStore: null,
    oneshellAiConfig: cfg,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body) {
    const resp = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, json };
  }
  const readDisk = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // 2a. 添加首个 provider(自动设活跃)→ 文件自动生成
  const addA = await call('POST', '/api/agent/providers/skills', {
    name: 'Engine A',
    upstreamProtocol: 'openai',
    apiBase: 'https://a.example',
    apiKey: 'sk-aaa',
    models: [{ id: 'm-a', apiModel: 'model-a', enabled: true, reasoningEffort: 'auto', maxOutputTokens: 4096 }],
    activeModelId: 'm-a',
  });
  assert.strictEqual(addA.status, 200, JSON.stringify(addA.json));
  const pidA = addA.json.id;
  assert.ok(fs.existsSync(filePath), '添加首个 skills provider 后应自动生成 1shell-ai.json');
  assert.strictEqual(readDisk().apiKey, 'sk-aaa');
  assert.strictEqual(readDisk().model, 'model-a');
  assert.strictEqual(readDisk().maxOutputTokens, 4096, '模型档案的 maxOutputTokens 应进文件');

  // 2b. 更新活跃 provider → 文件跟随
  const putA = await call('PUT', `/api/agent/providers/skills/${pidA}`, {
    name: 'Engine A',
    upstreamProtocol: 'openai',
    apiBase: 'https://a.example',
    model: 'model-a2',
    models: [{
      id: 'm-a', apiModel: 'model-a2', enabled: true, reasoningEffort: 'auto',
      requestParams: { temperature: 0.7 },
    }],
    activeModelId: 'm-a',
    requestParams: { temperature: 0.7 },
  });
  assert.strictEqual(putA.status, 200, JSON.stringify(putA.json));
  assert.strictEqual(readDisk().model, 'model-a2', '更新 provider 后文件应重新生成');
  assert.strictEqual(readDisk().apiKey, 'sk-aaa', '未传 apiKey 的更新应保留旧 key');
  assert.deepStrictEqual(readDisk().requestParams, { temperature: 0.7 });

  // 2c. preview 与落盘一致(providerId 补 apiKey;models[] 投影同一套逻辑)
  const preview = await call('POST', '/api/agent/config-preview/skills', {
    providerId: pidA,
    provider: {
      name: 'Engine A',
      upstreamProtocol: 'openai',
      apiBase: 'https://a.example',
      model: 'model-a2',
      models: [{
        id: 'm-a', apiModel: 'model-a2', enabled: true, reasoningEffort: 'auto',
        requestParams: { temperature: 0.7 },
      }],
      activeModelId: 'm-a',
      requestParams: { temperature: 0.7 },
    },
  });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.json));
  assert.strictEqual(preview.json.files[0].name, FILE_NAME);
  assert.strictEqual(
    preview.json.files[0].content,
    fs.readFileSync(filePath, 'utf8'),
    'preview 内容必须与实际落盘内容一致(所见即所得)',
  );
  assert.strictEqual(preview.json.files[0].enabled, true, '磁盘已是该内容时 preview 应标记 enabled');

  // 2d. GET config-files
  const list = await call('GET', '/api/agent/config-files/skills');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.files[0].name, FILE_NAME);
  assert.strictEqual(list.json.files[0].overridden, false);

  // 2e. 手工写入 = 接管:立即生效,后续 provider 变更不覆盖
  const manualContent = JSON.stringify({
    upstreamProtocol: 'openai', apiBase: 'https://manual.example', apiKey: 'sk-manual', model: 'manual-m',
  }, null, 2);
  const write = await call('PUT', `/api/agent/config-files/skills/${FILE_NAME}`, { content: manualContent });
  assert.strictEqual(write.status, 200, JSON.stringify(write.json));
  assert.strictEqual(write.json.files[0].overridden, true, '手工写入后应标记 overridden');
  const badWrite = await call('PUT', `/api/agent/config-files/skills/${FILE_NAME}`, { content: 'not json' });
  assert.strictEqual(badWrite.status, 400, '非法 JSON 手工写入应 400');
  await call('PUT', `/api/agent/providers/skills/${pidA}`, {
    name: 'Engine A', upstreamProtocol: 'openai', apiBase: 'https://a.example', model: 'model-a3',
    models: [{ id: 'm-a', apiModel: 'model-a3', enabled: true, reasoningEffort: 'auto' }],
    activeModelId: 'm-a',
  });
  assert.strictEqual(readDisk().apiKey, 'sk-manual', '手工草稿在位时 provider 更新不得覆盖文件');

  // 2f. 恢复自动:按活跃 provider 重新生成
  const restore = await call('DELETE', `/api/agent/config-files/skills/${FILE_NAME}/override`);
  assert.strictEqual(restore.status, 200);
  assert.strictEqual(restore.json.files[0].overridden, false);
  assert.strictEqual(readDisk().model, 'model-a3', '恢复自动后文件应回到跟随活跃 provider');

  // 2g. 启用/切路由 → 文件跟随
  const addB = await call('POST', '/api/agent/providers/skills', {
    name: 'Engine B',
    upstreamProtocol: 'anthropic',
    apiBase: 'https://b.example',
    apiKey: 'sk-bbb',
    models: [{ id: 'm-b', apiModel: 'model-b', enabled: true, reasoningEffort: 'auto' }],
    activeModelId: 'm-b',
  });
  const pidB = addB.json.id;
  assert.strictEqual(readDisk().apiKey, 'sk-aaa', '添加非活跃 provider 不应改变文件');
  const activateB = await call('PUT', `/api/agent/providers/skills/${pidB}/activate`, { modelId: 'm-b' });
  assert.strictEqual(activateB.status, 200);
  assert.strictEqual(readDisk().apiKey, 'sk-bbb', '启用 B 后文件应切到 B');
  assert.strictEqual(readDisk().upstreamProtocol, 'anthropic');
  const routeA = await call('PUT', '/api/agent/routes/skills', { providerId: pidA, modelId: 'm-a' });
  assert.strictEqual(routeA.status, 200);
  assert.strictEqual(readDisk().apiKey, 'sk-aaa', '切路由回 A 后文件应跟随');

  // 2h. 删除:非活跃不影响;删掉最后的活跃 provider 应清文件
  await call('DELETE', `/api/agent/providers/skills/${pidB}`);
  assert.strictEqual(readDisk().apiKey, 'sk-aaa', '删除非活跃 provider 不应改变文件');
  await call('DELETE', `/api/agent/providers/skills/${pidA}`);
  assert.strictEqual(fs.existsSync(filePath), false, '删除最后的活跃 provider 后应清掉自动生成的文件');

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ 3. 代理运行时:文件优先,损坏回退 store ═══

async function runProxyRuntimeE2E() {
  let captured = null;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured = { url: req.url, auth: req.headers.authorization || '', body: JSON.parse(raw || '{}') };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-ai-cfg-proxy-'));
  const store = createProxyConfigStore(dir);
  const cfg = createOneshellAiConfig({ dataDir: dir, proxyConfigStore: store, logger: silentLogger });
  const filePath = path.join(dir, FILE_NAME);

  store.addProvider('skills', {
    name: 'Store Engine',
    upstreamProtocol: 'openai',
    apiBase: upstreamBase,
    apiKey: 'sk-store',
    models: [{ id: 'm-s', apiModel: 'model-store', enabled: true, reasoningEffort: 'auto' }],
    activeModelId: 'm-s',
  });

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/proxy', createProxyRouter({ proxyConfigStore: store, proxyToken: '', oneshellAiConfig: cfg }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxyBase = `http://127.0.0.1:${server.address().port}`;

  async function callSkills() {
    const resp = await fetch(`${proxyBase}/api/proxy/skills/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'ignored', max_tokens: 128, stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (resp.status !== 200) {
      const detail = await resp.text().catch(() => '');
      assert.fail(`skills 代理应返回 200,实际 ${resp.status}: ${detail}`);
    }
    return resp.json();
  }

  // 3a. 无文件 → 用 store 活跃 provider
  await callSkills();
  assert.strictEqual(captured.body.model, 'model-store');
  assert.strictEqual(captured.auth, 'Bearer sk-store');

  // 3b. 文件在位 → 文件是运行时权威(含 requestParams 合并)
  cfg.writeFile(FILE_NAME, JSON.stringify({
    upstreamProtocol: 'openai',
    apiBase: upstreamBase,
    apiKey: 'sk-file',
    model: 'model-file',
    requestParams: { temperature: 0.9 },
  }));
  await callSkills();
  assert.strictEqual(captured.body.model, 'model-file', '文件配置应优先于 store');
  assert.strictEqual(captured.auth, 'Bearer sk-file');
  assert.strictEqual(captured.body.temperature, 0.9, '文件里的 requestParams 应合并进请求体');

  // 3c. 文件损坏 → 回退 store
  fs.writeFileSync(filePath, '{broken');
  await callSkills();
  assert.strictEqual(captured.body.model, 'model-store', '损坏文件应回退 store 活跃 provider');
  assert.strictEqual(captured.auth, 'Bearer sk-store');

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

runRoutesE2E()
  .then(runProxyRuntimeE2E)
  .then(() => {
    console.log('✓ 1shell-ai.json 配置文件生成器测试通过');
    console.log('  - 模块:models[] 投影 / legacy effort 迁移 / 手工接管 / 无 provider 清理 / 校验与损坏回退');
    console.log('  - 路由:增改启用切路由删全程自动同步;preview=落盘;手工草稿不被覆盖');
    console.log('  - 运行时:文件优先于 store,损坏回退');
  })
  .catch((err) => {
    console.error('✗ 1shell-ai.json 配置文件生成器测试失败:', err);
    process.exit(1);
  });
