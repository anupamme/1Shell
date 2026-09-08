'use strict';

/**
 * 脚本库核心语义回归（4.7.6 重构）。
 *
 * 覆盖三件容易悄悄坏掉的事：
 *   1. 占位符扫描规则（去重、保序、拒绝非法名）
 *   2. 渲染时的缺键报错 —— agent 漏传参数必须当场失败，而不是跑出空值命令
 *   3. shell 转义 —— 这是脚本库唯一的防注入手段
 *   4. 渲染后的灾难命令拦截 —— run_script 不经过 harness guard 的命令红线，
 *      拦截必须在 service 里生效
 */

const assert = require('assert');
const { extractPlaceholders } = require('../lib/script-placeholders');
const { createScriptService } = require('../src/services/script.service');

// ─── 1. 占位符扫描 ──────────────────────────────────────────────────────
assert.deepStrictEqual(extractPlaceholders('echo {{name}}'), ['name']);
assert.deepStrictEqual(extractPlaceholders('{{ a }} {{b}} {{ a }}'), ['a', 'b'], '重复占位符应去重并保序');
assert.deepStrictEqual(extractPlaceholders('no placeholders here'), []);
assert.deepStrictEqual(extractPlaceholders('{{1bad}} {{good}}'), ['good'], '数字开头的名字不是合法占位符');
assert.deepStrictEqual(extractPlaceholders('{{a-b}}'), [], '连字符不是合法占位符名');
assert.deepStrictEqual(extractPlaceholders(''), []);
assert.deepStrictEqual(extractPlaceholders(null), []);
// 模块级正则带 g 标志，连续调用不能因 lastIndex 残留而漏匹配
assert.deepStrictEqual(extractPlaceholders('{{x}}'), ['x']);
assert.deepStrictEqual(extractPlaceholders('{{x}}'), ['x'], 'lastIndex 必须每次重置');

// ─── 测试替身 ───────────────────────────────────────────────────────────
function makeService(script, { execResult, onExec, commandRules } = {}) {
  const calls = [];
  const service = createScriptService({
    scriptRepository: {
      findScript: (id) => (id === script.id ? script : null),
      listScripts: () => [script],
      createScript: (p) => ({ ...p, id: 'new' }),
      updateScript: (id, p) => ({ ...p, id }),
      deleteScript: () => true,
    },
    hostService: { findHost: (id) => (id === 'h1' ? { id: 'h1', name: 'H1' } : null) },
    bridgeService: {
      execOnHost: async (hostId, command) => {
        calls.push({ hostId, command });
        if (onExec) onExec(command);
        return execResult || { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
      },
    },
    auditService: { log: () => {} },
    securitySettingsService: { getSettings: () => ({ commandRules: commandRules || [] }) },
  });
  return { service, calls };
}

const script = { id: 's1', name: 'demo', content: 'echo {{msg}} {{other}}', tags: [] };

// ─── 2. 缺键报错 ────────────────────────────────────────────────────────
{
  const { service } = makeService(script);
  assert.throws(
    () => service.renderContent(script, { msg: 'hi' }, { hostId: 'h1' }),
    (err) => err.status === 400 && err.message.includes('other'),
    '缺键必须抛 400 并点名缺哪个',
  );
  // 空串是合法值，不算缺键
  assert.doesNotThrow(() => service.renderContent(script, { msg: '', other: '' }, { hostId: 'h1' }));
  // allowMissing 供预览用，缺键按空串渲染
  const preview = service.renderContent(script, {}, { hostId: 'h1', allowMissing: true });
  assert.strictEqual(preview.rendered, "echo '' ''");
  assert.deepStrictEqual(preview.placeholders, ['msg', 'other']);
}

// ─── 3. shell 转义 ──────────────────────────────────────────────────────
{
  const { service } = makeService(script);
  const evil = { msg: "a'; rm -rf /; echo 'b", other: 'x' };
  const { rendered } = service.renderContent(script, evil, { hostId: 'h1' });
  // 单引号被转义后，注入的命令整体仍是一个字面量参数
  assert.ok(rendered.includes("'a'\\''; rm -rf /; echo '\\''b'"), `bash 转义未生效: ${rendered}`);
  assert.ok(!/^echo a'; rm/.test(rendered), '恶意参数不能逃逸成命令');
  assert.strictEqual(service.renderContent(script, evil, { hostId: 'h1' }).shellStyle, 'bash', '远程主机一律按 bash 转义');
}

// ─── 4. 渲染后的灾难命令拦截 ────────────────────────────────────────────
(async () => {
  const danger = { id: 's2', name: 'danger', content: 'rm -rf /', tags: [] };
  const { service, calls } = makeService(danger);
  await assert.rejects(
    () => service.runScript('s2', { hostId: 'h1', params: {} }, {}),
    (err) => err.status === 400 && err.message.includes('拦截'),
    '灾难命令必须在执行前被拦下',
  );
  assert.strictEqual(calls.length, 0, '被拦截的脚本不能真的发到主机');

  // 正常脚本仍然放行，且发出去的是渲染后的命令
  const { service: okService, calls: okCalls } = makeService(script);
  const result = await okService.runScript('s1', { hostId: 'h1', params: { msg: 'hello', other: 'world' } }, {});
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(okCalls.length, 1);
  assert.strictEqual(okCalls[0].command, "echo 'hello' 'world'");

  // 缺键在 runScript 里同样要拦住，不能落到执行层
  const { service: missService, calls: missCalls } = makeService(script);
  await assert.rejects(
    () => missService.runScript('s1', { hostId: 'h1', params: { msg: 'only' } }, {}),
    (err) => err.status === 400,
  );
  assert.strictEqual(missCalls.length, 0);

  // ─── 5. 自定义命令黑名单同样拦渲染后的成品命令 ─────────────────────────
  // run_script 不经过 harness guard，黑名单若不在 service 里生效就成了绕过通道
  const gitPush = { id: 's3', name: 'push', content: 'git push --force {{remote}}', tags: [] };
  const { service: denyService, calls: denyCalls } = makeService(gitPush, {
    commandRules: [{ pattern: 'git push --force*', action: 'deny', enabled: true }],
  });
  await assert.rejects(
    () => denyService.runScript('s3', { hostId: 'h1', params: { remote: 'origin' } }, {}),
    (err) => err.status === 400 && err.message.includes('黑名单'),
    '黑名单规则必须拦下渲染后的成品命令',
  );
  assert.strictEqual(denyCalls.length, 0, '被黑名单拦截的脚本不能发到主机');

  console.log('script library ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
