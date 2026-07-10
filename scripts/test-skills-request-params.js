'use strict';

/**
 * 1Shell AI(skills 槽位)requestParams "配置文件式自填参数" 全链路测试。
 *
 * 设计背景(4.7.x):skills 槽位不再翻译语义化 reasoning 档位,
 * 用户按上游 API 文档自填 JSON(thinking / reasoning_effort / …),
 * 代理请求时原样浅合并进请求体顶层;旧配置的 reasoningEffort 注入
 * 在无 requestParams 时仍生效(兼容回退)。
 *
 * 覆盖:
 *   1. normalizeRequestParams / applyRequestParams 纯函数
 *   2. Provider store 归一化 → 投影 → 脱敏回显 → 增量更新/清空
 *   3. 假上游 e2e:anthropic / openai 双协议合并、同 key 覆盖旧注入、legacy 回退
 *   4. ProviderModal.vue UI guard(skills 槽位隐藏档位、暴露 JSON 编辑器)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createProxyRouter, createProxyConfigStore, __private } = require('../src/routes/proxy.routes');

const { normalizeRequestParams, applyRequestParams } = __private;

// ═══ 1. 纯函数 ═══

assert.deepStrictEqual(normalizeRequestParams('{"reasoning_effort":"xhigh"}'), { reasoning_effort: 'xhigh' });
assert.deepStrictEqual(normalizeRequestParams({ thinking: { type: 'adaptive' } }), { thinking: { type: 'adaptive' } });
assert.strictEqual(normalizeRequestParams(''), null);
assert.strictEqual(normalizeRequestParams('   '), null);
assert.strictEqual(normalizeRequestParams(null), null);
assert.strictEqual(normalizeRequestParams(undefined), null);
assert.strictEqual(normalizeRequestParams({}), null, '空对象应归一化为 null(不落盘)');

// messages / stream 属于调用方与代理机制,写入时剥离
assert.strictEqual(normalizeRequestParams({ messages: [], stream: true }), null);
assert.deepStrictEqual(normalizeRequestParams({ stream: true, temperature: 0.5 }), { temperature: 0.5 });

assert.throws(() => normalizeRequestParams('[1,2]'), /JSON 对象/, '数组应被拒绝');
assert.throws(() => normalizeRequestParams('not json'), /JSON/, '非法 JSON 字符串应报错');
assert.throws(() => normalizeRequestParams(42), /JSON 对象/, '标量应被拒绝');
assert.throws(() => normalizeRequestParams({ big: 'x'.repeat(17000) }), /16KB/, '超过 16KB 应报错');

{
  const body = {
    model: 'claude-opus-4-8',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 64000 },
  };
  applyRequestParams(body, {
    requestParams: {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
      stream: true,
      messages: [],
    },
  });
  assert.deepStrictEqual(body.thinking, { type: 'adaptive' }, '同 key 用户参数应覆盖内置注入');
  assert.deepStrictEqual(body.output_config, { effort: 'max' }, '新增 key 应合并进请求体');
  assert.strictEqual(body.stream, false, 'stream 运行时也不可覆盖');
  assert.strictEqual(body.messages.length, 1, 'messages 运行时也不可覆盖');

  // 无 requestParams 时不动请求体
  const untouched = { model: 'm', max_tokens: 1 };
  applyRequestParams(untouched, {});
  assert.deepStrictEqual(untouched, { model: 'm', max_tokens: 1 });
}

// ═══ 2. Provider store ═══

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-req-params-'));
const store = createProxyConfigStore(tmpDir);

const pid = store.addProvider('skills', {
  name: 'DeepSeek',
  apiBase: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  upstreamProtocol: 'openai',
  models: [{
    id: 'model-deepseek-chat',
    apiModel: 'deepseek-chat',
    displayName: 'deepseek-chat',
    enabled: true,
    reasoningEffort: 'auto',
    requestParams: { reasoning_effort: 'xhigh', temperature: 0.3 },
  }],
  activeModelId: 'model-deepseek-chat',
});

{
  const active = store.getActiveProvider('skills');
  assert.deepStrictEqual(active.requestParams, { reasoning_effort: 'xhigh', temperature: 0.3 }, '活跃投影应携带 requestParams');
  const masked = store.listProviders('skills').providers.find((p) => p.id === pid);
  assert.deepStrictEqual(masked.requestParams, { reasoning_effort: 'xhigh', temperature: 0.3 }, '脱敏回显应携带 requestParams');
  assert.deepStrictEqual(masked.models[0].requestParams, { reasoning_effort: 'xhigh', temperature: 0.3 }, '模型档案脱敏也应携带');
}

// 增量更新(legacy partial 路径)与清空
store.updateProvider('skills', pid, { requestParams: { enable_thinking: true } });
assert.deepStrictEqual(store.getActiveProvider('skills').requestParams, { enable_thinking: true });
store.updateProvider('skills', pid, { requestParams: null });
assert.strictEqual(store.getActiveProvider('skills').requestParams, undefined, '清空后不应残留');
assert.throws(() => store.updateProvider('skills', pid, { requestParams: 'oops{' }), /JSON/, '非法 JSON 更新应报错');

// models[] 全量替换路径也能写入/清除
store.updateProvider('skills', pid, {
  models: [{ id: 'model-deepseek-chat', apiModel: 'deepseek-chat', enabled: true, requestParams: { reasoning_effort: 'high' } }],
  activeModelId: 'model-deepseek-chat',
});
assert.deepStrictEqual(store.getActiveProvider('skills').requestParams, { reasoning_effort: 'high' });
store.updateProvider('skills', pid, {
  models: [{ id: 'model-deepseek-chat', apiModel: 'deepseek-chat', enabled: true }],
  activeModelId: 'model-deepseek-chat',
});
assert.strictEqual(store.getActiveProvider('skills').requestParams, undefined, '不带字段的档案替换即清除');

// ═══ 3. e2e:假上游双协议 ═══

async function runE2E() {
  // 假上游:记录最近一次请求
  let captured = null;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured = { url: req.url, body: JSON.parse(raw || '{}') };
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/chat/completions')) {
        res.end(JSON.stringify({
          id: 'chatcmpl-1', object: 'chat.completion', model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), '1shell-req-params-e2e-'));
  const e2eStore = createProxyConfigStore(e2eDir);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/proxy', createProxyRouter({ proxyConfigStore: e2eStore, proxyToken: '' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxyBase = `http://127.0.0.1:${server.address().port}`;

  async function callSkills(body) {
    const resp = await fetch(`${proxyBase}/api/proxy/skills/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) {
      const detail = await resp.text().catch(() => '');
      assert.fail(`代理应返回 200,实际 ${resp.status}: ${detail}`);
    }
    return resp.json();
  }

  const clientBody = {
    model: 'ignored-by-routing',
    max_tokens: 2048,
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  };

  // ── 3a. anthropic 协议:requestParams 合并 + 同 key 覆盖旧 effort 注入 ──
  //   reasoningEffort=high 且 claude-opus-4* 命中白名单,旧逻辑会注入
  //   thinking:{enabled,budget_tokens:64000};requestParams 的 thinking 应覆盖它。
  const anthropicPid = e2eStore.addProvider('skills', {
    name: 'Claude 中转',
    apiBase: upstreamBase,
    apiKey: 'sk-a',
    upstreamProtocol: 'anthropic',
    models: [{
      id: 'model-opus',
      apiModel: 'claude-opus-4-8',
      enabled: true,
      reasoningEffort: 'high',
      requestParams: { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } },
    }],
    activeModelId: 'model-opus',
  });
  e2eStore.setActive('skills', anthropicPid, 'model-opus');
  await callSkills(clientBody);
  assert.ok(captured.url.endsWith('/v1/messages'), `anthropic 协议应打到 /v1/messages,实际 ${captured.url}`);
  assert.strictEqual(captured.body.model, 'claude-opus-4-8', '模型路由应生效');
  assert.deepStrictEqual(captured.body.thinking, { type: 'adaptive' }, 'requestParams 应覆盖旧 effort 注入的 thinking');
  assert.deepStrictEqual(captured.body.output_config, { effort: 'max' }, 'requestParams 新增字段应透传上游');
  assert.strictEqual(captured.body.stream, false, 'stream 不可被覆盖');
  assert.strictEqual(captured.body.max_tokens, 2048);

  // ── 3b. openai 协议:requestParams 合并进 chat/completions 请求体 ──
  const openaiPid = e2eStore.addProvider('skills', {
    name: 'DeepSeek',
    apiBase: upstreamBase,
    apiKey: 'sk-b',
    upstreamProtocol: 'openai',
    models: [{
      id: 'model-ds',
      apiModel: 'deepseek-chat',
      enabled: true,
      reasoningEffort: 'auto',
      requestParams: { reasoning_effort: 'xhigh', temperature: 0.3 },
    }],
    activeModelId: 'model-ds',
  });
  e2eStore.setActive('skills', openaiPid, 'model-ds');
  await callSkills(clientBody);
  assert.ok(captured.url.endsWith('/v1/chat/completions'), `openai 协议应打到 /v1/chat/completions,实际 ${captured.url}`);
  assert.strictEqual(captured.body.model, 'deepseek-chat');
  assert.strictEqual(captured.body.reasoning_effort, 'xhigh', 'requestParams 应原样透传 reasoning_effort');
  assert.strictEqual(captured.body.temperature, 0.3, 'requestParams 应原样透传 temperature');

  // ── 3c. 兼容回退:无 requestParams 的旧配置仍走 effort 注入 ──
  const legacyPid = e2eStore.addProvider('skills', {
    name: 'Legacy',
    apiBase: upstreamBase,
    apiKey: 'sk-c',
    upstreamProtocol: 'openai',
    models: [{
      id: 'model-r1',
      apiModel: 'deepseek-reasoner',
      enabled: true,
      reasoningEffort: 'high',
    }],
    activeModelId: 'model-r1',
  });
  e2eStore.setActive('skills', legacyPid, 'model-r1');
  await callSkills(clientBody);
  assert.strictEqual(captured.body.reasoning_effort, 'high', '旧配置(无 requestParams)应保留 effort 注入行为');

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(e2eDir, { recursive: true, force: true });
}

// ═══ 4. ProviderModal UI guard ═══

function checkModalSource() {
  const modalSource = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'components', 'ProviderModal.vue'),
    'utf8',
  );
  assert.match(
    modalSource,
    /v-if="isSkillsSlot"[\s\S]{0,1600}v-model="fRequestParams"/,
    'skills 槽位必须暴露 requestParams JSON 编辑器',
  );
  assert.match(
    modalSource,
    /Reasoning 档位[\s\S]{0,200}v-if="!isSkillsSlot"/,
    'skills 槽位必须隐藏语义化 Reasoning 档位按钮(已由参数自填取代)',
  );
  assert.match(modalSource, /legacyEffortToParamsJson/, '旧档位应可迁移预填为等效原始参数');
  assert.match(modalSource, /profile\.requestParams = parseRequestParams\(\)/, '保存时模型档案必须携带 requestParams');
  assert.doesNotMatch(
    modalSource,
    /requestBodyPreview/,
    '示意版上游请求体预览已删,由真实 1shell-ai.json 配置文件预览取代',
  );
  assert.match(modalSource, /1Shell AI 配置文件/, 'skills 槽位应有 1shell-ai.json 配置文件生成器区(所见即所得)');
  assert.doesNotMatch(
    modalSource,
    /showConfigEditor = computed\([^\n]*SKILLS_SLOT_ID/,
    '配置文件生成器不得再排除 skills 槽位',
  );
}

runE2E()
  .then(() => {
    checkModalSource();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('✓ skills requestParams 测试通过');
    console.log('  - normalize/apply 纯函数:剥离 messages/stream、16KB 上限、空值归一');
    console.log('  - store:模型档案携带/投影/脱敏/增量清空');
    console.log('  - e2e:anthropic 覆盖旧注入 + openai 透传 + legacy effort 回退');
    console.log('  - ProviderModal UI guard:skills 槽位参数编辑器就位');
  })
  .catch((err) => {
    console.error('✗ skills requestParams 测试失败:', err);
    process.exit(1);
  });
