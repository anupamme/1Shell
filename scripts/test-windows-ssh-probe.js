#!/usr/bin/env node
// Windows SSH 靶机特征化探测（M-W1 前置调研）
// 用法: RIG_HOST/RIG_PORT/RIG_USER/RIG_PASS 环境变量 + node scripts/test-windows-ssh-probe.js
// 每条命令走独立 exec 通道（即 bridge.service execViaExec 模式的行为），
// 验证: DefaultShell 是谁 / 退出码是否原生传递 / 输出编码 / -EncodedCommand 方案可行性。

const { Client } = require('ssh2');

const HOST = process.env.RIG_HOST || '';
const PORT = Number(process.env.RIG_PORT || 22);
const USER = process.env.RIG_USER || '';
const PASS = process.env.RIG_PASS || '';

if (!HOST || !USER || !PASS) {
  console.error('缺少 RIG_HOST / RIG_USER / RIG_PASS 环境变量');
  process.exit(2);
}

let decodeGbk = null;
try {
  const td = new TextDecoder('gbk');
  decodeGbk = (buf) => td.decode(buf);
} catch { /* 无 ICU 时跳过 gbk 解码 */ }

const HAS_REPLACEMENT = (s) => s.includes('�');

function describe(buf) {
  if (!buf || buf.length === 0) return '(空)';
  const utf8 = buf.toString('utf8');
  const out = { utf8: utf8.trim() };
  if (HAS_REPLACEMENT(utf8) && decodeGbk) out.gbk = decodeGbk(buf).trim();
  if (HAS_REPLACEMENT(utf8)) out.hexHead = buf.subarray(0, 48).toString('hex');
  return out;
}

// 模拟当前 wrapRemoteCommand 的产物（bridge.service.js）
function bashWrapReplica(cmd) {
  const q = `'${cmd.replace(/'/g, `'\\''`)}'`;
  return [
    'if command -v bash >/dev/null 2>&1; then',
    `  exec bash -lc ${q}`,
    'else',
    `  exec sh -lc ${q}`,
    'fi',
  ].join('\n');
}

// M-W1 赌注: EncodedCommand + UTF-8 前导 + LASTEXITCODE 透传
function encodedCommand(psPayload) {
  const b64 = Buffer.from(psPayload, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

const PS_PAYLOAD = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  `Write-Output ("中文测试OK|" + [Environment]::OSVersion.VersionString + "|" + $PSVersionTable.PSVersion)`,
  'cmd /c "exit 7"',
  'exit $LASTEXITCODE',
].join('; ');

const BATTERY = [
  { id: 'ver',        cmd: 'ver',                 why: 'DefaultShell=cmd 则输出 Windows 版本' },
  { id: 'comspec-cmd', cmd: 'echo %COMSPEC%',      why: 'cmd 展开 / 其他 shell 原样回显' },
  { id: 'comspec-ps',  cmd: 'echo $env:COMSPEC',   why: 'powershell 展开 / cmd 原样回显' },
  { id: 'uname',      cmd: 'uname -s',            why: '检出 Git-bash/MINGW 冒充 POSIX 的情况' },
  { id: 'exit5',      cmd: 'exit 5',              why: '退出码是否原生经 exec 通道传递' },
  { id: 'chcp',       cmd: 'chcp',                why: '代码页 + 中文输出编码地面真值' },
  { id: 'cmd-ver',    cmd: 'cmd /c ver',          why: '跨 shell 的 OS 探测候选命令' },
  { id: 'bash-wrap',  cmd: bashWrapReplica('echo hi'), why: '当前 1Shell exec 模式包装在此机的真实下场' },
  { id: 'enc-cmd',    cmd: encodedCommand(PS_PAYLOAD), why: 'M-W1 方案: EncodedCommand+UTF8+退出码7' },
];

function execOnce(client, cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const chunksOut = [];
    const chunksErr = [];
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ timeout: true, stdout: Buffer.concat(chunksOut), stderr: Buffer.concat(chunksErr) }); }
    }, timeoutMs);
    client.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); if (!done) { done = true; resolve({ error: err.message }); } return; }
      stream.on('data', (d) => chunksOut.push(d));
      stream.stderr.on('data', (d) => chunksErr.push(d));
      stream.on('close', (code, signal) => {
        clearTimeout(timer);
        if (!done) { done = true; resolve({ code, signal, stdout: Buffer.concat(chunksOut), stderr: Buffer.concat(chunksErr) }); }
      });
    });
  });
}

const client = new Client();
client.on('ready', async () => {
  console.log(`# 连接成功 ${HOST}:${PORT} (${USER})`);
  for (const item of BATTERY) {
    const r = await execOnce(client, item.cmd);
    const report = {
      id: item.id,
      why: item.why,
      cmd: item.cmd.length > 90 ? item.cmd.slice(0, 90) + '…' : item.cmd,
      exitCode: r.code ?? null,
      signal: r.signal ?? null,
      timeout: r.timeout || false,
      error: r.error || null,
      stdout: describe(r.stdout),
      stderr: describe(r.stderr),
    };
    console.log(JSON.stringify(report, null, 2));
  }
  client.end();
});
client.on('error', (e) => { console.error('连接失败:', e.message); process.exit(1); });
client.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 20000 });
