'use strict';

const assert = require('assert');
const { createPanelWorkloadsService, _internals } = require('../src/services/panel-workloads.service');

const webId = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const workerId = '123456abcdef7890123456abcdef7890123456abcdef7890123456abcdef7890';
const openrestyId = '999999abcdef999999abcdef999999abcdef999999abcdef999999abcdef9999';

const inspectItems = [
  {
    Id: webId,
    Name: '/web',
    Created: '2026-06-23T01:00:00Z',
    Image: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    Config: {
      Image: 'ghcr.io/acme/web:latest',
      Cmd: ['node', 'server.js'],
      Labels: {
        'com.docker.compose.project': 'stack',
        'com.docker.compose.service': 'web',
        'com.docker.compose.project.working_dir': '/opt/stack',
      },
    },
    State: {
      Status: 'running',
      Running: true,
      StartedAt: '2026-06-23T02:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      ExitCode: 0,
      Health: { Status: 'healthy' },
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: {
      Ports: {
        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        '443/tcp': null,
      },
      Networks: {
        bridge: { IPAddress: '172.17.0.2' },
      },
    },
    Mounts: [],
  },
  {
    Id: workerId,
    Name: '/worker',
    Created: '2026-06-22T01:00:00Z',
    Image: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    Config: {
      Image: 'ghcr.io/acme/worker:latest',
      Cmd: ['node', 'worker.js'],
      Labels: {},
    },
    State: {
      Status: 'exited',
      Running: false,
      StartedAt: '2026-06-22T02:00:00Z',
      FinishedAt: '2026-06-22T03:00:00Z',
      ExitCode: 0,
    },
    HostConfig: { RestartPolicy: { Name: 'no' } },
    NetworkSettings: {
      Ports: { '9000/tcp': null },
      Networks: {},
    },
    Mounts: [],
  },
];

const psItems = [
  { ID: webId, Names: 'web', Image: 'ghcr.io/acme/web:latest', State: 'running', Status: 'Up 2 hours' },
  { ID: workerId, Names: 'worker', Image: 'ghcr.io/acme/worker:latest', State: 'exited', Status: 'Exited (0) 1 hour ago' },
];

const statsItems = [
  { Container: webId, Name: 'web', CPUPerc: '0.10%', MemUsage: '12MiB / 1GiB', MemPerc: '1.20%', NetIO: '1kB / 2kB', BlockIO: '0B / 0B', PIDs: '8' },
];

const linuxDiscoveryCommand = _internals.buildWorkloadDiscoveryCommand();
assert(linuxDiscoveryCommand.includes('sort -u'), 'Linux discovery should collect process metadata once per unique PID');
assert(linuxDiscoveryCommand.includes('last_meta_pid'), 'Linux discovery should cache repeated PID metadata while rendering port rows');
assert(!linuxDiscoveryCommand.includes("printf '%s\\n' \"$line\" | awk"), 'Linux discovery should not spawn awk once per listening port line');
assert.strictEqual((linuxDiscoveryCommand.match(/ps -o pcpu=/g) || []).length, 1);

const sampleOutput = `__1SHELL_PLATFORM=linux
__1SHELL_DOCKER_INFO_BEGIN__
{"Version":"27.0.0","APIVersion":"1.46"}
__1SHELL_DOCKER_INFO_END__
__1SHELL_DOCKER_PS_BEGIN__
${psItems.map((item) => JSON.stringify(item)).join('\n')}
__1SHELL_DOCKER_PS_END__
__1SHELL_DOCKER_INSPECT_BEGIN__
${JSON.stringify(inspectItems)}
__1SHELL_DOCKER_INSPECT_END__
__1SHELL_DOCKER_STATS_BEGIN__
${statsItems.map((item) => JSON.stringify(item)).join('\n')}
__1SHELL_DOCKER_STATS_END__
__1SHELL_PORTS_BEGIN__
tcp\t0.0.0.0:80\t1201\tnginx\tnginx.service\twww-data\tnginx: master process nginx -g daemon off;\ttcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1201,fd=6))
tcp\t127.0.0.1:5432\t2222\tpostgres\t\tpostgres\tpostgres -D /var/lib/postgresql/data\ttcp LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=2222,fd=5))
tcp\t0.0.0.0:8080\t3001\tdocker-proxy\t\troot\tdocker-proxy -proto tcp -host-ip 0.0.0.0 -host-port 8080\ttcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("docker-proxy",pid=3001,fd=4))
tcp\t0.0.0.0:3000\t3300\tnode\t\troot\tnode server.js\ttcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=3300,fd=9))\t/app\t${webId}\t0.50\t24576
__1SHELL_PORTS_END__
__1SHELL_PROCESSES_BEGIN__
__1SHELL_PROCESSES_END__`;

const parsed = _internals.parseWorkloadDiscoveryOutput(sampleOutput);
assert.strictEqual(parsed.dockerInstalled, true);
assert.strictEqual(parsed.dockerReachable, true);
assert.strictEqual(parsed.engineVersion, '27.0.0');
assert.strictEqual(parsed.items.length, 4);
assert.strictEqual(parsed.items.some((item) => item.processName === 'docker-proxy'), false);
assert.strictEqual(parsed.items[0].kind, 'container');
assert.strictEqual(parsed.items[0].name, 'web');
assert.strictEqual(parsed.items[1].kind, 'container');

const web = parsed.items.find((item) => item.name === 'web');
assert(web);
assert.strictEqual(web.kind, 'container');
assert.strictEqual(web.source, 'compose');
assert.strictEqual(web.composeProject, 'stack');
assert.strictEqual(web.entrypoints.length, 3);
assert.strictEqual(web.publishedPortCount, 1);
assert.strictEqual(web.entrypointsText.includes('8080->80/tcp'), true);
assert.strictEqual(web.entrypointsText.includes('3000/tcp'), true);
assert.deepStrictEqual(web.ipAddresses, ['172.17.0.2']);
assert.strictEqual(web.stats.cpuPercent, 0.1);

const nginx = parsed.items.find((item) => item.serviceName === 'nginx.service');
assert(nginx);
assert.strictEqual(nginx.kind, 'service');
assert.strictEqual(nginx.source, 'systemd');
assert.strictEqual(nginx.primaryEndpoint, '*:80/tcp');
assert.strictEqual(nginx.infrastructure, true);
assert.strictEqual(_internals.isPrimaryWorkload(nginx), false);

const postgres = parsed.items.find((item) => item.processName === 'postgres');
assert(postgres);
assert.strictEqual(postgres.kind, 'service');
assert.strictEqual(postgres.source, 'process');
assert.strictEqual(postgres.primaryEndpoint, '127.0.0.1:5432/tcp');
assert.strictEqual(_internals.isPrimaryWorkload(postgres), true);
assert(parsed.items.indexOf(postgres) < parsed.items.indexOf(nginx));

const missingOutput = `__1SHELL_PLATFORM=linux
__1SHELL_DOCKER_INFO_BEGIN__
__1SHELL_DOCKER_ERROR_CODE=docker_missing
__1SHELL_DOCKER_ERROR=docker command not found
__1SHELL_DOCKER_INFO_END__
__1SHELL_DOCKER_PS_BEGIN__
__1SHELL_DOCKER_PS_END__
__1SHELL_DOCKER_INSPECT_BEGIN__
[]
__1SHELL_DOCKER_INSPECT_END__
__1SHELL_DOCKER_STATS_BEGIN__
__1SHELL_DOCKER_STATS_END__
__1SHELL_PORTS_BEGIN__
tcp\t127.0.0.1:3000\t3333\tnode\t\tapp\tnode server.js\ttcp LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=3333,fd=21))\t/home/app/site\t\t0.70\t20480
tcp\t0.0.0.0:8099\t4444\tpython\t\troot\tpython -m gemini_web2api --config /app/config.json\ttcp LISTEN 0 128 0.0.0.0:8099 0.0.0.0:* users:(("python",pid=4444,fd=9))\t/app
__1SHELL_PORTS_END__
__1SHELL_PROCESSES_BEGIN__
3334\tfrpc\tapp\t./frpc -c /home/app/frp/frpc-oneshell-3301-20260620.toml\t\t/home/app/frp\t./frpc -c /home/app/frp/frpc-oneshell-3301-20260620.toml
__1SHELL_PROCESSES_END__`;

const missing = _internals.parseWorkloadDiscoveryOutput(missingOutput);
assert.strictEqual(missing.dockerInstalled, false);
assert.strictEqual(missing.dockerReachable, false);
assert.strictEqual(missing.items.length, 3);
const missingNode = missing.items.find((item) => item.processName === 'node');
assert(missingNode);
assert.strictEqual(missingNode.kind, 'service');
assert.strictEqual(missingNode.projectCandidate, true);
assert.strictEqual(_internals.isPrimaryWorkload(missingNode), true);
assert.strictEqual(missingNode.stats.cpuPercent, 0.7);
assert.strictEqual(missingNode.stats.cpuPercentText, '0.70%');
assert.strictEqual(missingNode.stats.memoryUsage, '20.0MiB');
const configProcess = missing.items.find((item) => item.port === '8099');
assert(configProcess);
assert.strictEqual(configProcess.displayName, 'gemini_web2api');
assert.notStrictEqual(configProcess.displayName, 'config.json');
const frpc = missing.items.find((item) => item.processName === 'frpc');
assert(frpc);
assert.strictEqual(frpc.kind, 'service');
assert.strictEqual(frpc.source, 'tunnel');
assert.strictEqual(frpc.displayName, 'frpc: oneshell-3301-20260620');
assert.strictEqual(frpc.primaryEndpoint, 'outbound');
assert.strictEqual(_internals.isPrimaryWorkload(frpc), true);
assert.strictEqual(_internals.hasListeningEndpoint(missingNode), true);
assert.strictEqual(_internals.hasListeningEndpoint(frpc), false);

const windowsOutput = `__1SHELL_PLATFORM=windows
__1SHELL_DOCKER_INFO_BEGIN__
__1SHELL_DOCKER_ERROR_CODE=docker_missing
__1SHELL_DOCKER_ERROR=docker command not found
__1SHELL_DOCKER_INFO_END__
__1SHELL_DOCKER_PS_BEGIN__
__1SHELL_DOCKER_PS_END__
__1SHELL_DOCKER_INSPECT_BEGIN__
[]
__1SHELL_DOCKER_INSPECT_END__
__1SHELL_DOCKER_STATS_BEGIN__
__1SHELL_DOCKER_STATS_END__
__1SHELL_PORTS_BEGIN__
tcp\t0.0.0.0:5985\t4\tsvchost\tWinRM\tNT AUTHORITY\\NetworkService\tC:\\Windows\\system32\\svchost.exe -k NetworkService\ttcp LISTEN 0.0.0.0:5985 pid=4\tC:\\Windows\\system32\\svchost.exe
tcp\t127.0.0.1:5173\t9000\tnode\t\tjsw\tnode C:\\Users\\jsw\\app\\server.js\ttcp LISTEN 127.0.0.1:5173 pid=9000\tC:\\Program Files\\nodejs\\node.exe
__1SHELL_PORTS_END__
__1SHELL_PROCESSES_BEGIN__
9001\tfrpc\tjsw\tfrpc.exe -c C:\\frp\\frpc-demo.toml\t\tC:\\frp\tC:\\frp\\frpc.exe
__1SHELL_PROCESSES_END__`;

const windows = _internals.parseWorkloadDiscoveryOutput(windowsOutput);
assert.strictEqual(windows.platform, 'windows');
assert.strictEqual(windows.items.length, 3);
const winrm = windows.items.find((item) => item.serviceName === 'WinRM');
assert(winrm);
assert.strictEqual(winrm.kind, 'service');
assert.strictEqual(winrm.source, 'windows-service');
assert.strictEqual(winrm.infrastructure, true);
assert.strictEqual(_internals.isPrimaryWorkload(winrm), false);
const winNode = windows.items.find((item) => item.processName === 'node');
assert(winNode);
assert.strictEqual(winNode.kind, 'service');
assert.strictEqual(winNode.projectCandidate, true);
assert.strictEqual(_internals.isPrimaryWorkload(winNode), true);
const winFrpc = windows.items.find((item) => item.processName === 'frpc');
assert(winFrpc);
assert.strictEqual(winFrpc.source, 'tunnel');
assert.strictEqual(winFrpc.displayName, 'frpc: demo');
assert.strictEqual(_internals.hasListeningEndpoint(winFrpc), false);

const haproxyOutput = `__1SHELL_PLATFORM=linux
__1SHELL_DOCKER_INFO_BEGIN__
__1SHELL_DOCKER_ERROR_CODE=docker_missing
__1SHELL_DOCKER_ERROR=docker command not found
__1SHELL_DOCKER_INFO_END__
__1SHELL_DOCKER_PS_BEGIN__
__1SHELL_DOCKER_PS_END__
__1SHELL_DOCKER_INSPECT_BEGIN__
[]
__1SHELL_DOCKER_INSPECT_END__
__1SHELL_DOCKER_STATS_BEGIN__
__1SHELL_DOCKER_STATS_END__
__1SHELL_PORTS_BEGIN__
tcp\t0.0.0.0:6776\t2770912\thaproxy\thaproxy.service\thaproxy\t/usr/sbin/haproxy -Ws -f /etc/haproxy/haproxy.cfg\ttcp LISTEN 0 4096 0.0.0.0:6776 0.0.0.0:* users:(("haproxy",pid=2770912,fd=11))
tcp\t0.0.0.0:6777\t2770912\thaproxy\thaproxy.service\thaproxy\t/usr/sbin/haproxy -Ws -f /etc/haproxy/haproxy.cfg\ttcp LISTEN 0 4096 0.0.0.0:6777 0.0.0.0:* users:(("haproxy",pid=2770912,fd=12))
tcp\t0.0.0.0:6778\t2770912\thaproxy\thaproxy.service\thaproxy\t/usr/sbin/haproxy -Ws -f /etc/haproxy/haproxy.cfg\ttcp LISTEN 0 4096 0.0.0.0:6778 0.0.0.0:* users:(("haproxy",pid=2770912,fd=13))
__1SHELL_PORTS_END__
__1SHELL_PROCESSES_BEGIN__
__1SHELL_PROCESSES_END__`;

const haproxyParsed = _internals.parseWorkloadDiscoveryOutput(haproxyOutput);
assert.strictEqual(haproxyParsed.items.length, 1);
const haproxy = haproxyParsed.items[0];
assert.strictEqual(haproxy.id, 'service:systemd:haproxy.service');
assert.strictEqual(haproxy.serviceName, 'haproxy.service');
assert.strictEqual(haproxy.primaryEndpoint, '*:6776-6778/tcp');
assert.deepStrictEqual(haproxy.entrypointsText, ['*:6776-6778/tcp']);
assert.deepStrictEqual(haproxy.entrypoints.map((item) => item.port), ['6776', '6777', '6778']);
assert.strictEqual(haproxy.publishedPortCount, 3);
assert.strictEqual(_internals.hasListeningEndpoint(haproxy), true);

const exposedOnlyOutput = `__1SHELL_PLATFORM=linux
__1SHELL_DOCKER_INFO_BEGIN__
{"Version":"27.0.0","APIVersion":"1.46"}
__1SHELL_DOCKER_INFO_END__
__1SHELL_DOCKER_PS_BEGIN__
{"ID":"${openrestyId}","Names":"1Panel-openresty","Image":"openresty/openresty:latest","State":"running","Status":"Up 3 hours"}
__1SHELL_DOCKER_PS_END__
__1SHELL_DOCKER_INSPECT_BEGIN__
${JSON.stringify([{
  Id: openrestyId,
  Name: '/1Panel-openresty',
  Config: {
    Image: 'openresty/openresty:latest',
    Cmd: ['openresty', '-g', 'daemon off;'],
    Labels: {
      'com.docker.compose.project': '1Panel',
      'com.docker.compose.service': 'openresty',
    },
    ExposedPorts: {
      '80/tcp': {},
      '443/tcp': {},
    },
  },
  State: { Status: 'running', Running: true },
  NetworkSettings: {
    Ports: {},
    Networks: { onepanel: { IPAddress: '172.20.0.2' } },
  },
}])}
__1SHELL_DOCKER_INSPECT_END__
__1SHELL_DOCKER_STATS_BEGIN__
__1SHELL_DOCKER_STATS_END__
__1SHELL_PORTS_BEGIN__
__1SHELL_PORTS_END__
__1SHELL_PROCESSES_BEGIN__
__1SHELL_PROCESSES_END__`;

const exposedOnly = _internals.parseWorkloadDiscoveryOutput(exposedOnlyOutput);
const openresty = exposedOnly.items.find((item) => item.name === '1Panel-openresty');
assert(openresty);
assert.strictEqual(openresty.kind, 'container');
assert.deepStrictEqual(openresty.entrypointsText, ['80/tcp', '443/tcp']);
assert.strictEqual(openresty.publishedPortCount, 0);

async function testSummary() {
  const service = createPanelWorkloadsService({
    hostService: {
      findHost(id) {
        return { id, type: 'ssh', name: id === 'h1' ? 'Alpha' : 'Beta' };
      },
      listHostsWithPreferences() {
        return [
          { id: 'h1', type: 'ssh', name: 'Alpha', preference: { archived: false } },
          { id: 'h2', type: 'ssh', name: 'Beta', preference: { archived: true } },
        ];
      },
    },
    bridgeService: {
      async execOnHost(hostId) {
        assert.strictEqual(hostId, 'h1');
        return { stdout: sampleOutput, stderr: '', exitCode: 0, durationMs: 12 };
      },
    },
  });

  const summary = await service.getWorkloadsSummary();
  assert.strictEqual(summary.hostCount, 1);
  assert.strictEqual(summary.okHostCount, 1);
  assert.strictEqual(summary.workloadCount, 4);
  assert.strictEqual(summary.primaryWorkloadCount, 3);
  assert.strictEqual(summary.containerCount, 2);
  assert.strictEqual(summary.runningContainerCount, 1);
  assert.strictEqual(summary.processCount, 2);
  assert.strictEqual(summary.listeningPortCount, 2);
  assert.strictEqual(summary.serviceCount, 2);
  assert.strictEqual(summary.infrastructureCount, 1);
  assert.strictEqual(summary.composeWorkloadCount, 1);
  assert.strictEqual(summary.publishedPortCount, 3);
  assert.strictEqual(summary.items[0].hostName, 'Alpha');
  assert.strictEqual(summary.items[0].kind, 'container');
  assert.strictEqual(summary.hosts[0].composeWorkloadCount, 1);
  assert.strictEqual(summary.hosts[0].primaryWorkloadCount, 3);
}

async function testWorkloadActions() {
  const calls = [];
  const service = createPanelWorkloadsService({
    hostService: {
      findHost(id) {
        return { id, type: 'ssh', name: id === 'h1' ? 'Alpha' : 'Beta' };
      },
    },
    bridgeService: {
      async execOnHost(hostId, command, timeoutMs, options) {
        calls.push({ hostId, command, timeoutMs, options });
        if (options?.auditCommand && String(options.auditCommand).startsWith('workload discovery')) {
          return { stdout: sampleOutput, stderr: '', exitCode: 0, durationMs: 12 };
        }
        return { stdout: 'done', stderr: '', exitCode: 0, durationMs: 7 };
      },
    },
    auditService: {
      log(entry) {
        calls.push({ audit: entry });
      },
    },
  });

  const containerResult = await service.runWorkloadAction('h1', `container:${webId}`, 'restart', {
    workload: {
      id: `container:${webId}`,
      hostId: 'h1',
      kind: 'container',
      source: 'compose',
      name: 'fake-web',
      displayName: 'fake-web',
      nativeId: 'not-the-container',
      shortId: 'not-the-cont',
    },
  });
  assert.strictEqual(containerResult.ok, true);
  assert.strictEqual(calls[0].hostId, 'h1');
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');
  assert.strictEqual(calls[1].command, `docker restart '${webId}'`);
  assert.strictEqual(calls[1].options.auditCommand, 'docker restart <container:web>');
  assert.strictEqual(calls[1].options.source, 'panel_workloads');
  assert.strictEqual(calls[1].timeoutMs, 90000);
  assert.strictEqual(calls[2].audit.action, 'panel_workload_action');
  assert.strictEqual(calls[2].audit.command, 'docker restart <container:web>');

  calls.length = 0;
  const recreateResult = await service.runWorkloadAction('h1', `container:${webId}`, 'recreate', {
    workload: {
      id: `container:${webId}`,
      hostId: 'h1',
      kind: 'container',
      source: 'compose',
      name: 'fake-web',
      displayName: 'fake-web',
      nativeId: 'not-the-container',
      composeProject: 'fake-project',
      composeService: 'fake-service',
      composeWorkingDir: '/tmp/fake',
    },
  });
  assert.strictEqual(recreateResult.ok, true);
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');
  assert.strictEqual(calls[1].command, "cd '/opt/stack' && (docker compose -p 'stack' up -d --force-recreate --no-deps 'web' || docker-compose -p 'stack' up -d --force-recreate --no-deps 'web')");
  assert.strictEqual(calls[1].options.auditCommand, 'docker compose recreate <compose:stack/web>');

  calls.length = 0;
  const deleteResult = await service.runWorkloadAction('h1', `container:${webId}`, 'delete', {
    workload: {
      id: `container:${webId}`,
      hostId: 'h1',
      kind: 'container',
      source: 'compose',
      name: 'fake-web',
      nativeId: 'not-the-container',
    },
  });
  assert.strictEqual(deleteResult.ok, true);
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');
  assert.strictEqual(calls[1].command, `docker rm -f '${webId}'`);
  assert.strictEqual(calls[1].options.auditCommand, 'docker rm -f <container:web>');

  calls.length = 0;
  await assert.rejects(
    () => service.runWorkloadAction('h1', `container:${workerId}`, 'recreate', {
      workload: {
        id: `container:${workerId}`,
        hostId: 'h1',
        kind: 'container',
        source: 'docker',
        name: 'worker',
      },
    }),
    (error) => error && error.status === 400,
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');

  calls.length = 0;
  const systemdResult = await service.runWorkloadAction('h1', 'service:systemd:nginx.service', 'restart', {
    workload: {
      id: 'service:systemd:nginx.service',
      hostId: 'h1',
      kind: 'service',
      source: 'systemd',
      name: 'nginx',
      displayName: 'nginx',
      serviceName: 'sshd.service',
    },
  });
  assert.strictEqual(systemdResult.ok, true);
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');
  assert.strictEqual(calls[1].command, "systemctl restart 'nginx.service'");
  assert.strictEqual(calls[1].options.auditCommand, 'systemctl restart <service:nginx.service>');

  calls.length = 0;
  await assert.rejects(
    () => service.runWorkloadAction('h1', 'service:systemd:nginx.service', 'delete', {
      workload: {
        id: 'service:systemd:nginx.service',
        hostId: 'h1',
        kind: 'service',
        source: 'systemd',
        name: 'nginx',
      },
    }),
    (error) => error && error.status === 400,
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');

  calls.length = 0;
  await assert.rejects(
    () => service.runWorkloadAction('h1', 'listener:process:2222', 'restart', {
      workload: {
        id: 'listener:process:2222',
        hostId: 'h1',
        kind: 'service',
        source: 'process',
        name: 'postgres',
      },
    }),
    (error) => error && error.status === 400,
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.auditCommand, 'workload discovery');
}

async function main() {
  await testSummary();
  await testWorkloadActions();
  console.log('test-panel-workloads ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
