'use strict';

// MCP 网关 ask_1shell_ai 的只读探查能力测试（4.7.7）：
//   answer/plan 模式下 execute_command 放行只读命令（探查服务器的核心手段），
//   写命令与其余写工具仍然拒绝；execute 模式不设此门禁。

const assert = require('assert');
const { evaluateGatewayWriteToolPolicy } = require('../src/ide/ide.agent-kernel');

// ── answer 模式：只读命令放行 ──────────────────────────────────────────────
const readonlyCommands = [
  'docker ps -a',
  'docker logs --tail 100 web1',
  'systemctl status nginx',
  'systemctl list-units --type=service',
  'journalctl -u nginx -n 100 --no-pager',
  'ps auxww | grep -i node',
  'df -h',
  'free -m',
  'top -b -n 1 | head -20',
  'cat /etc/os-release',
  'ls -la /opt/app',
  'ss -tlnp',
  'uptime',
  'cd /opt/app && ls && cat config.yaml',
  'find /var/log -name "*.log" -mtime -1',
  'git -C /opt/app log --oneline -5',
];
for (const command of readonlyCommands) {
  assert.strictEqual(evaluateGatewayWriteToolPolicy('answer', 'execute_command', command), null, `answer 模式应放行只读命令: ${command}`);
}

// ── answer 模式：写命令拒绝 ────────────────────────────────────────────────
const writeCommands = [
  'docker compose up -d',
  'systemctl restart nginx',
  'rm -rf /tmp/old',
  'echo hi > /etc/motd',
  'apt-get install -y htop',
  'docker rm web1',
  'sed -i s/a/b/ file.conf',
  'tee /etc/hosts',
];
for (const command of writeCommands) {
  const verdict = evaluateGatewayWriteToolPolicy('answer', 'execute_command', command);
  assert.ok(verdict && verdict.allow === false, `answer 模式应拒绝写命令: ${command}`);
  assert.match(verdict.reason, /只读命令/, `拒绝理由应说明只读限制: ${command}`);
}

// ── answer/plan 模式：其余写工具仍一刀切拒绝 ────────────────────────────────
for (const tool of ['write_remote_file', 'delete_path', 'run_script', 'save_script', 'upload_file', 'delete_path', 'rename_path']) {
  const verdict = evaluateGatewayWriteToolPolicy('answer', tool, '');
  assert.ok(verdict && verdict.allow === false, `answer 模式应拒绝写工具: ${tool}`);
  assert.match(verdict.reason, /变更型工具/, `拒绝理由应指向写工具: ${tool}`);
  const planVerdict = evaluateGatewayWriteToolPolicy('plan', tool, '');
  assert.ok(planVerdict && planVerdict.allow === false, `plan 模式应拒绝写工具: ${tool}`);
}

// plan 模式的命令门禁与 answer 一致
assert.strictEqual(evaluateGatewayWriteToolPolicy('plan', 'execute_command', 'docker ps'), null, 'plan 模式放行只读命令');
assert.ok(evaluateGatewayWriteToolPolicy('plan', 'execute_command', 'docker compose up -d'), 'plan 模式拒绝写命令');

// ── execute 模式 / 无网关模式：不设此门禁 ──────────────────────────────────
assert.strictEqual(evaluateGatewayWriteToolPolicy('execute', 'execute_command', 'docker compose up -d'), null, 'execute 模式不设只读门禁');
assert.strictEqual(evaluateGatewayWriteToolPolicy('execute', 'write_remote_file', ''), null, 'execute 模式写工具不经此门禁');
assert.strictEqual(evaluateGatewayWriteToolPolicy('', 'execute_command', 'rm -rf /tmp'), null, '无 gatewayMode（普通会话）不经此门禁');

// 非写工具不拦
assert.strictEqual(evaluateGatewayWriteToolPolicy('answer', 'read_remote_file', ''), null, 'answer 模式读文件工具不受门禁');
assert.strictEqual(evaluateGatewayWriteToolPolicy('answer', 'query_probe', ''), null, 'answer 模式探针工具不受门禁');

// ── ide.service 装配守卫（防回归：门禁没挂进 applyToolPolicy） ──────────────
const fs = require('fs');
const path = require('path');
const ideServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src/ide/ide.service.js'), 'utf8');
assert.ok(
  ideServiceSource.includes('evaluateGatewayWriteToolPolicy(policy.gatewayMode, tc.name, input.command)'),
  'applyToolPolicy 必须把写工具交给网关门禁判定',
);

// 工具描述同步（外部 AI 依赖它知道 answer 能探查）
const coreToolsSource = fs.readFileSync(path.join(__dirname, '..', 'src/tools/oneshell-core.tools.js'), 'utf8');
assert.ok(coreToolsSource.includes('answer 只读探查与回答'), 'ask_1shell_ai 描述应说明 answer 可只读探查');
assert.ok(coreToolsSource.includes('read-only commands (ps/journalctl/docker ps/systemctl status'), 'guidance 应告知内部 AI 可跑只读命令');

console.log('test-gateway-readonly-exploration: OK');
