'use strict';

const os = require('os');
const { PORT, ROOT_DIR } = require('../config/env');

const MODULE_ID = 'workloads';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_ACTION_TIMEOUT_MS = 90000;
const MAX_ACTION_TIMEOUT_MS = 180000;
const DEFAULT_CONCURRENCY = 4;
const WORKLOAD_ACTIONS = new Set(['start', 'stop', 'restart', 'delete', 'recreate']);

function createPanelWorkloadsService({ hostService, bridgeService, auditService = null }) {
  if (!hostService) throw new Error('panel-workloads.service: hostService required');
  if (!bridgeService) throw new Error('panel-workloads.service: bridgeService required');

  async function getHostWorkloads(hostId, options = {}) {
    const host = hostService.findHost(hostId);
    if (!host) {
      const error = new Error(`Host not found: ${hostId}`);
      error.status = 404;
      throw error;
    }
    return collectHostWorkloads(host, options);
  }

  async function runWorkloadAction(hostId, workloadId, action, options = {}) {
    const normalizedAction = normalizeWorkloadAction(action);
    const host = hostService.findHost(hostId);
    if (!host) {
      const error = new Error(`Host not found: ${hostId}`);
      error.status = 404;
      throw error;
    }
    const requestedTarget = normalizeWorkloadActionTarget(workloadId, options.workload || options.item || {});
    if (requestedTarget.hostId && requestedTarget.hostId !== hostId) {
      throw createStatusError(400, 'workload host does not match request host');
    }

    const target = await resolveWorkloadActionTarget(host, requestedTarget, options);
    const plan = buildWorkloadActionPlan(target, normalizedAction);
    const timeoutMs = normalizeActionTimeoutMs(options.timeoutMs);
    const result = await bridgeService.execOnHost(host.id, plan.command, timeoutMs, {
      source: 'panel_workloads',
      auditCommand: plan.auditCommand,
      clientIp: options.clientIp,
      ...(plan.localShell ? { localShell: plan.localShell } : {}),
    });
    auditService?.log?.({
      action: 'panel_workload_action',
      source: 'web_ui',
      hostId: host.id,
      hostName: host.name || host.id,
      command: plan.auditCommand,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      error: result.exitCode === 0 ? undefined : trimOutput(result.stderr || result.stdout || '', 1000),
      clientIp: options.clientIp,
      details: JSON.stringify({
        action: normalizedAction,
        workloadId: target.id,
        kind: target.kind,
        source: target.source,
        target: plan.targetLabel,
      }),
    });
    return {
      ok: result.exitCode === 0,
      module: MODULE_ID,
      action: normalizedAction,
      hostId: host.id,
      hostName: host.name || host.id,
      workloadId: target.id,
      target: {
        kind: target.kind,
        source: target.source,
        name: target.displayName || target.name || plan.targetLabel,
        label: plan.targetLabel,
      },
      result,
      error: result.exitCode === 0 ? null : trimOutput(result.stderr || result.stdout || `workload action exited with code ${result.exitCode}`, 1200),
    };
  }

  async function resolveWorkloadActionTarget(host, requestedTarget, options = {}) {
    const discovery = await collectHostWorkloads(host, { timeoutMs: options.discoveryTimeoutMs || DEFAULT_TIMEOUT_MS });
    if (!discovery.ok) {
      throw createStatusError(502, `刷新运行项失败：${discovery.error || 'workload discovery failed'}`);
    }
    const actual = (discovery.items || []).find((item) => item.id === requestedTarget.id);
    if (!actual) {
      throw createStatusError(404, '运行项不存在或已变化，请刷新后重试');
    }
    return normalizeWorkloadActionTarget(actual.id, actual);
  }

  async function getWorkloadsSummary(options = {}) {
    const includeArchived = options.includeArchived === true;
    const allHosts = typeof hostService.listHostsWithPreferences === 'function'
      ? hostService.listHostsWithPreferences()
      : hostService.listHosts();
    const hosts = allHosts.filter((host) => includeArchived || !host.preference?.archived);
    const collectedAt = new Date().toISOString();
    const results = await mapLimit(hosts, DEFAULT_CONCURRENCY, (host) => collectHostWorkloads(host, options));
    const items = results.flatMap((result) => result.items || []);
    const okResults = results.filter((result) => result.ok);

    return {
      ok: true,
      module: MODULE_ID,
      collectedAt,
      hostCount: hosts.length,
      okHostCount: okResults.length,
      failedHostCount: results.filter((result) => !result.ok).length,
      workloadCount: items.length,
      runningWorkloadCount: items.filter((item) => item.running).length,
      stoppedWorkloadCount: items.filter((item) => !item.running).length,
      unhealthyWorkloadCount: items.filter((item) => item.health === 'unhealthy' || item.failed).length,
      primaryWorkloadCount: items.filter(isPrimaryWorkload).length,
      containerCount: items.filter((item) => item.kind === 'container').length,
      runningContainerCount: items.filter((item) => item.kind === 'container' && item.running).length,
      serviceCount: items.filter((item) => item.kind === 'service').length,
      projectProcessCount: items.filter((item) => item.projectCandidate).length,
      infrastructureCount: items.filter((item) => item.infrastructure).length,
      processCount: items.filter((item) => item.kind !== 'container').length,
      systemdWorkloadCount: items.filter((item) => item.source === 'systemd').length,
      windowsServiceCount: items.filter((item) => item.source === 'windows-service').length,
      composeWorkloadCount: items.filter((item) => item.source === 'compose').length,
      dockerHostCount: results.filter((result) => result.dockerReachable).length,
      dockerUnavailableHostCount: okResults.filter((result) => result.dockerInstalled && !result.dockerReachable).length,
      dockerMissingHostCount: okResults.filter((result) => result.dockerInstalled === false).length,
      dockerUnsupportedHostCount: okResults.filter((result) => result.platformSupported === false).length,
      listeningPortCount: countListeningEndpoints(items),
      publishedPortCount: items.reduce((total, item) => total + (item.entrypoints || []).filter((port) => port.published).length, 0),
      composeProjectCount: countUnique(items.map((item) => item.composeProject).filter(Boolean)),
      hosts: results.map(toHostSummary),
      items,
      warnings: results.flatMap((result) => result.warnings || []),
    };
  }

  async function collectHostWorkloads(host, options = {}) {
    const startedAt = Date.now();
    const collectedAt = new Date().toISOString();
    const base = {
      hostId: host.id,
      hostName: host.name || host.id,
      module: MODULE_ID,
      collectedAt,
      ok: false,
      platformSupported: true,
      dockerInstalled: null,
      dockerReachable: false,
      dockerError: null,
      engineVersion: null,
      items: [],
      warnings: [],
      error: null,
      errorCode: null,
      rawCommand: null,
      platform: detectHostPlatform(host),
      durationMs: 0,
    };

    const platform = detectHostPlatform(host);
    let discovery = buildWorkloadDiscovery(host, { platform });
    try {
      let result = await bridgeService.execOnHost(host.id, discovery.command, options.timeoutMs || DEFAULT_TIMEOUT_MS, {
        source: 'panel_workloads',
        auditCommand: 'workload discovery',
        ...(discovery.localShell ? { localShell: discovery.localShell } : {}),
      });
      if (platform !== 'windows' && shouldRetryWithWindowsDiscovery(result)) {
        discovery = buildWorkloadDiscovery(host, { platform: 'windows' });
        result = await bridgeService.execOnHost(host.id, discovery.command, options.timeoutMs || DEFAULT_TIMEOUT_MS, {
          source: 'panel_workloads',
          auditCommand: 'workload discovery windows fallback',
          ...(discovery.localShell ? { localShell: discovery.localShell } : {}),
        });
      }
      const parsed = parseWorkloadDiscoveryOutput(result.stdout || '');
      const commandError = result.exitCode === 0 ? null : normalizeCommandFailure(result);
      const ok = !commandError && !parsed.parseError;
      const warnings = parsed.warnings || [];
      if (parsed.dockerError) warnings.push(parsed.dockerError);
      if (result.stderr && result.exitCode === 0) warnings.push(trimOutput(result.stderr, 1000));

      return {
        ...base,
        ok,
        platform: parsed.platform || platform,
        dockerInstalled: parsed.dockerInstalled,
        dockerReachable: parsed.dockerReachable,
        dockerError: parsed.dockerError,
        engineVersion: parsed.engineVersion,
        items: ok ? decorateItems(markLocalControllerWorkloads(parsed.items, host), host) : [],
        warnings,
        error: commandError || parsed.parseError || null,
        errorCode: commandError ? 'workload_discovery_failed' : null,
        rawCommand: parsed.platform === 'windows' || platform === 'windows'
          ? 'docker inspect/stats + Get-NetTCPConnection + Win32_Service'
          : 'docker inspect/stats + ss listening ports + /proc cgroup',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs ?? (Date.now() - startedAt),
      };
    } catch (error) {
      return {
        ...base,
        error: error?.message || 'workload discovery failed',
        errorCode: error?.code || 'execution_error',
        stdout: trimOutput(error?.stdout || '', 2000),
        stderr: trimOutput(error?.stderr || '', 2000),
        exitCode: typeof error?.exitCode === 'number' ? error.exitCode : null,
        durationMs: error?.durationMs ?? (Date.now() - startedAt),
      };
    }
  }

  return {
    getHostWorkloads,
    getWorkloadsSummary,
    runWorkloadAction,
  };
}

function detectHostPlatform(host) {
  if (host?.type === 'local' || host?.id === 'local') {
    if (os.platform() === 'win32') return 'windows';
    if (os.platform() === 'darwin') return 'darwin';
    return 'linux';
  }
  const value = String(host?.osInfo?.os || host?.osInfo?.distroId || host?.osInfo?.prettyName || '').toLowerCase();
  if (value.includes('windows') || value === 'win32') return 'windows';
  if (value.includes('darwin') || value.includes('mac')) return 'darwin';
  return 'linux';
}

function shouldRetryWithWindowsDiscovery(result) {
  const stdout = String(result?.stdout || '');
  if (stdout.includes('__1SHELL_DOCKER_INFO_BEGIN__') || stdout.includes('__1SHELL_PLATFORM=')) return false;
  const combined = `${stdout}\n${result?.stderr || ''}`;
  return /not recognized|不是内部或外部|无法将|ParserError|CommandNotFoundException/i.test(combined);
}

function normalizeWorkloadAction(action) {
  const value = String(action || '').trim().toLowerCase();
  if (!WORKLOAD_ACTIONS.has(value)) {
    throw createStatusError(400, `unsupported workload action: ${action || ''}`);
  }
  return value;
}

function normalizeActionTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_ACTION_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(timeoutMs), 1000), MAX_ACTION_TIMEOUT_MS);
}

function normalizeWorkloadActionTarget(workloadId, raw = {}) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = String(workloadId || item.id || '').trim();
  if (!id) throw createStatusError(400, 'workloadId is required');
  return {
    id,
    hostId: normalizeEmpty(item.hostId),
    kind: normalizeEmpty(item.kind),
    source: normalizeEmpty(item.source),
    name: normalizeEmpty(item.name),
    displayName: normalizeEmpty(item.displayName),
    nativeId: normalizeEmpty(item.nativeId),
    shortId: normalizeEmpty(item.shortId),
    serviceName: normalizeEmpty(item.serviceName),
    processName: normalizeEmpty(item.processName),
    composeProject: normalizeEmpty(item.composeProject),
    composeService: normalizeEmpty(item.composeService),
    composeWorkingDir: normalizeEmpty(item.composeWorkingDir),
  };
}

function buildWorkloadActionPlan(item, action) {
  if (isDockerActionTarget(item)) return buildDockerActionPlan(item, action);
  if ((item.source === 'systemd' || item.source === 'windows-service') && !isLifecycleAction(action)) {
    throw createStatusError(400, '该运行项暂不支持删除或重建');
  }
  if (item.source === 'systemd' && item.serviceName) return buildSystemdActionPlan(item, action);
  if (item.source === 'windows-service' && item.serviceName) return buildWindowsServiceActionPlan(item, action);
  throw createStatusError(400, '该运行项暂不支持面板操作');
}

function isLifecycleAction(action) {
  return action === 'start' || action === 'stop' || action === 'restart';
}

function isDockerActionTarget(item) {
  return item.kind === 'container' && (item.source === 'docker' || item.source === 'compose' || item.id.startsWith('container:'));
}

function buildDockerActionPlan(item, action) {
  if (action === 'recreate') return buildComposeRecreateActionPlan(item);
  const containerId = item.nativeId || parseContainerIdFromWorkloadId(item.id) || item.shortId || item.name;
  if (!containerId) throw createStatusError(400, 'container id is required');
  const label = item.displayName || item.name || item.shortId || containerId.slice(0, 12);
  if (action === 'delete') {
    return {
      command: `docker rm -f ${shQuote(containerId)}`,
      auditCommand: `docker rm -f <container:${label}>`,
      targetLabel: label,
    };
  }
  return {
    command: `docker ${action} ${shQuote(containerId)}`,
    auditCommand: `docker ${action} <container:${label}>`,
    targetLabel: label,
  };
}

function buildComposeRecreateActionPlan(item) {
  if (item.source !== 'compose') throw createStatusError(400, '只有 Compose 容器支持重建');
  const project = item.composeProject;
  const service = item.composeService;
  const workingDir = item.composeWorkingDir;
  if (!project || !service || !workingDir) {
    throw createStatusError(400, 'Compose 容器缺少 project/service/working_dir 标签，无法安全重建');
  }
  const label = item.displayName || item.name || service;
  const composeArgs = `-p ${shQuote(project)} up -d --force-recreate --no-deps ${shQuote(service)}`;
  return {
    command: `cd ${shQuote(workingDir)} && (docker compose ${composeArgs} || docker-compose ${composeArgs})`,
    auditCommand: `docker compose recreate <compose:${project}/${service}>`,
    targetLabel: label,
  };
}

function buildSystemdActionPlan(item, action) {
  const serviceName = item.serviceName;
  return {
    command: `systemctl ${action} ${shQuote(serviceName)}`,
    auditCommand: `systemctl ${action} <service:${serviceName}>`,
    targetLabel: serviceName,
  };
}

function buildWindowsServiceActionPlan(item, action) {
  const serviceName = item.serviceName;
  const verb = action === 'start'
    ? 'Start-Service'
    : action === 'stop'
      ? 'Stop-Service'
      : 'Restart-Service';
  const force = action === 'start' ? '' : ' -Force';
  const script = [
    '$ErrorActionPreference = "Stop"',
    `${verb} -Name ${psSingleQuote(serviceName)}${force}`,
    `Get-Service -Name ${psSingleQuote(serviceName)} | Select-Object Name,Status | ConvertTo-Json -Compress`,
  ].join('\n');
  return {
    command: buildWindowsPowerShellCommand(script),
    auditCommand: `powershell ${action} <windows-service:${serviceName}>`,
    targetLabel: serviceName,
  };
}

function parseContainerIdFromWorkloadId(value) {
  const match = String(value || '').match(/^container:(.+)$/);
  return normalizeEmpty(match?.[1]);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildWindowsPowerShellCommand(script) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(String(script || ''), 'utf16le').toString('base64')}`;
}

function createStatusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildWorkloadDiscovery(host, options = {}) {
  const platform = options.platform || detectHostPlatform(host);
  if (platform === 'windows' && (host?.type === 'local' || host?.id === 'local')) {
    return { command: buildWindowsWorkloadDiscoveryScript(), localShell: 'powershell' };
  }
  return { command: buildWorkloadDiscoveryCommand({ platform }) };
}

function buildWorkloadDiscoveryCommand(options = {}) {
  if (options.platform === 'windows') return buildWindowsWorkloadDiscoveryCommand();
  return `#!/bin/sh
export LC_ALL=C LANG=C
printf '__1SHELL_PLATFORM=linux\\n'
printf '__1SHELL_DOCKER_INFO_BEGIN__\\n'
if ! command -v docker >/dev/null 2>&1; then
  printf '__1SHELL_DOCKER_ERROR_CODE=docker_missing\\n'
  printf '__1SHELL_DOCKER_ERROR=docker command not found\\n'
elif ! docker info >/dev/null 2>&1; then
  printf '__1SHELL_DOCKER_ERROR_CODE=docker_unavailable\\n'
  printf '__1SHELL_DOCKER_ERROR=docker daemon unavailable or permission denied\\n'
else
  docker version --format '{{json .Server}}' 2>/dev/null || true
fi
printf '\\n__1SHELL_DOCKER_INFO_END__\\n'
ids=''
running_ids=''
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ids=$(docker ps -aq --no-trunc 2>/dev/null || true)
  running_ids=$(docker ps -q --no-trunc 2>/dev/null || true)
fi
printf '__1SHELL_DOCKER_PS_BEGIN__\\n'
if [ -n "$ids" ]; then
  docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null || true
fi
printf '__1SHELL_DOCKER_PS_END__\\n'
printf '__1SHELL_DOCKER_INSPECT_BEGIN__\\n'
if [ -n "$ids" ]; then
  docker inspect $ids 2>/dev/null || printf '[]\\n'
else
  printf '[]\\n'
fi
printf '\\n__1SHELL_DOCKER_INSPECT_END__\\n'
printf '__1SHELL_DOCKER_STATS_BEGIN__\\n'
if [ -n "$running_ids" ]; then
  docker stats --no-stream --format '{{json .}}' $running_ids 2>/dev/null || true
fi
printf '\\n__1SHELL_DOCKER_STATS_END__\\n'
printf '__1SHELL_PORTS_BEGIN__\\n'
if command -v ss >/dev/null 2>&1; then
  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t oneshell-workloads.XXXXXX 2>/dev/null || printf '/tmp/oneshell-workloads-%s' "$$")
  mkdir -p "$tmp_dir" 2>/dev/null || tmp_dir=''
  ss_file="$tmp_dir/ss"
  meta_file="$tmp_dir/meta"
  if [ -n "$tmp_dir" ]; then
    ss -H -ltnup 2>/dev/null > "$ss_file" || true
    sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' "$ss_file" 2>/dev/null | sort -u | while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      svc=''
      docker_cid=''
      cmd=''
      cwd=''
      user=''
      cpu=''
      rss=''
      if [ -r "/proc/$pid/cgroup" ]; then
        svc=$(awk -F/ '{for (i=NF; i>=1; i--) if ($i ~ /\\.service$/) {print $i; exit}}' "/proc/$pid/cgroup" 2>/dev/null | head -n 1 | tr '|\\t\\r\\n' '    ')
        docker_cid=$(sed -n 's/.*docker[-\\/]\\([0-9a-f]\\{64\\}\\).*/\\1/p; s/.*docker-\\([0-9a-f]\\{64\\}\\)\\.scope.*/\\1/p; s/.*libpod[-\\/]\\([0-9a-f]\\{64\\}\\).*/\\1/p; s/.*containerd[-\\/]\\([0-9a-f]\\{64\\}\\).*/\\1/p' "/proc/$pid/cgroup" 2>/dev/null | head -n 1 | tr '|\\t\\r\\n' '    ')
      fi
      if [ -r "/proc/$pid/cmdline" ]; then
        cmd=$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | tr '|\\t\\r\\n' '    ' | cut -c1-300)
      fi
      if [ -e "/proc/$pid/cwd" ]; then
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null | tr '|\\t\\r\\n' '    ' | cut -c1-300)
      fi
      user=$(ps -o user= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' | head -n 1 | tr '|\\t\\r\\n' '    ')
      cpu=$(ps -o pcpu= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' | head -n 1 | tr '|\\t\\r\\n' '    ')
      rss=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' | head -n 1 | tr '|\\t\\r\\n' '    ')
      printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$pid" "$svc" "$docker_cid" "$cmd" "$cwd" "$user" "$cpu" "$rss"
    done > "$meta_file"
  else
    ss_file=''
    meta_file=''
  fi
  tab_char=$(printf '\\t')
  last_meta_pid=''
  last_svc=''
  last_docker_cid=''
  last_cmd=''
  last_cwd=''
  last_user=''
  last_cpu=''
  last_rss=''
  if [ -n "$ss_file" ] && [ -r "$ss_file" ]; then
    awk '{
      raw=$0
      proto=$1
      local_addr=$5
      pid=""
      proc=""
      if (match(raw, /pid=[0-9]+/)) pid=substr(raw, RSTART + 4, RLENGTH - 4)
      process_text=raw
      if (sub(/^.*users:\\(\\(\\("/, "", process_text)) {
        sub(/".*$/, "", process_text)
        proc=process_text
      }
      gsub(/\\t/, " ", raw)
      if (length(raw) > 500) raw=substr(raw, 1, 500)
      printf "%s\\t%s\\t%s\\t%s\\t%s\\n", proto, local_addr, pid, proc, raw
    }' "$ss_file"
  else
    ss -H -ltnup 2>/dev/null | awk '{
      raw=$0
      proto=$1
      local_addr=$5
      pid=""
      proc=""
      if (match(raw, /pid=[0-9]+/)) pid=substr(raw, RSTART + 4, RLENGTH - 4)
      process_text=raw
      if (sub(/^.*users:\\(\\(\\("/, "", process_text)) {
        sub(/".*$/, "", process_text)
        proc=process_text
      }
      gsub(/\\t/, " ", raw)
      if (length(raw) > 500) raw=substr(raw, 1, 500)
      printf "%s\\t%s\\t%s\\t%s\\t%s\\n", proto, local_addr, pid, proc, raw
    }'
  fi | while IFS="$tab_char" read -r proto local_addr pid proc raw_line; do
    [ -n "$local_addr" ] || continue
    svc=''
    docker_cid=''
    cmd=''
    user=''
    cwd=''
    cpu=''
    rss=''
    if [ -n "$pid" ] && [ -n "$meta_file" ] && [ -r "$meta_file" ]; then
      if [ "$pid" = "$last_meta_pid" ]; then
        svc=$last_svc
        docker_cid=$last_docker_cid
        cmd=$last_cmd
        cwd=$last_cwd
        user=$last_user
        cpu=$last_cpu
        rss=$last_rss
      else
        meta=$(awk -F'|' -v p="$pid" '$1 == p {print; exit}' "$meta_file" 2>/dev/null)
        if [ -n "$meta" ]; then
        old_ifs=$IFS
        IFS='|'
        read -r _pid svc docker_cid cmd cwd user cpu rss <<EOF_META
$meta
EOF_META
        IFS=$old_ifs
        fi
        last_meta_pid=$pid
        last_svc=$svc
        last_docker_cid=$docker_cid
        last_cmd=$cmd
        last_cwd=$cwd
        last_user=$user
        last_cpu=$cpu
        last_rss=$rss
      fi
    fi
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$proto" "$local_addr" "$pid" "$proc" "$svc" "$user" "$cmd" "$raw_line" "$cwd" "$docker_cid" "$cpu" "$rss"
  done
  [ -n "$tmp_dir" ] && rm -rf "$tmp_dir" 2>/dev/null || true
else
  printf '__1SHELL_WARN=ss_missing\\n'
fi
printf '__1SHELL_PORTS_END__\\n'
printf '__1SHELL_PROCESSES_BEGIN__\\n'
if command -v ps >/dev/null 2>&1; then
  ps -eo pid=,comm= 2>/dev/null | awk '$2 ~ /^(frpc|frps|cloudflared|ngrok|tailscaled|zerotier-one)$/ {print $1}' | while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    proc=$(ps -o comm= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' | head -n 1)
    user=$(ps -o user= -p "$pid" 2>/dev/null | awk '{$1=$1; print}' | head -n 1)
    cmd=$(ps -o args= -p "$pid" 2>/dev/null | tr '\\t\\r\\n' ' ' | cut -c1-500)
    svc=''
    cwd=''
    if [ -r "/proc/$pid/cgroup" ]; then
      svc=$(awk -F/ '{for (i=NF; i>=1; i--) if ($i ~ /\\.service$/) {print $i; exit}}' "/proc/$pid/cgroup" 2>/dev/null | head -n 1)
    fi
    if [ -e "/proc/$pid/cwd" ]; then
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null | tr '\\t\\r\\n' ' ' | cut -c1-300)
    fi
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$pid" "$proc" "$user" "$cmd" "$svc" "$cwd" "$cmd"
  done
fi
printf '__1SHELL_PROCESSES_END__\\n'`;
}

function buildWindowsWorkloadDiscoveryCommand() {
  const script = buildWindowsWorkloadDiscoveryScript();
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function buildWindowsWorkloadDiscoveryScript() {
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
function Write-CleanLine([string]$Value) { Write-Output $Value }
function Clean-Field($Value) {
  if ($null -eq $Value) { return '' }
  $text = [string]$Value
  $text = $text.Replace([string][char]9, ' ')
  $text = $text -replace "(\r|\n)+", ' '
  return $text
}
function Write-Tsv($Values) {
  Write-Output (($Values | ForEach-Object { Clean-Field $_ }) -join ([char]9))
}
Write-CleanLine '__1SHELL_PLATFORM=windows'
Write-CleanLine '__1SHELL_DOCKER_INFO_BEGIN__'
$docker = Get-Command docker -ErrorAction SilentlyContinue
$dockerOk = $false
if (-not $docker) {
  Write-CleanLine '__1SHELL_DOCKER_ERROR_CODE=docker_missing'
  Write-CleanLine '__1SHELL_DOCKER_ERROR=docker command not found'
} else {
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-CleanLine '__1SHELL_DOCKER_ERROR_CODE=docker_unavailable'
    Write-CleanLine '__1SHELL_DOCKER_ERROR=docker daemon unavailable or permission denied'
  } else {
    $dockerOk = $true
    docker version --format '{{json .Server}}' 2>$null
  }
}
Write-CleanLine '__1SHELL_DOCKER_INFO_END__'
$ids = @()
$runningIds = @()
if ($dockerOk) {
  $ids = @(docker ps -aq --no-trunc 2>$null | Where-Object { $_ })
  $runningIds = @(docker ps -q --no-trunc 2>$null | Where-Object { $_ })
}
Write-CleanLine '__1SHELL_DOCKER_PS_BEGIN__'
if ($ids.Count -gt 0) { docker ps -a --no-trunc --format '{{json .}}' 2>$null }
Write-CleanLine '__1SHELL_DOCKER_PS_END__'
Write-CleanLine '__1SHELL_DOCKER_INSPECT_BEGIN__'
if ($ids.Count -gt 0) { docker inspect @ids 2>$null } else { Write-CleanLine '[]' }
Write-CleanLine '__1SHELL_DOCKER_INSPECT_END__'
Write-CleanLine '__1SHELL_DOCKER_STATS_BEGIN__'
if ($runningIds.Count -gt 0) { docker stats --no-stream --format '{{json .}}' @runningIds 2>$null }
Write-CleanLine '__1SHELL_DOCKER_STATS_END__'
Write-CleanLine '__1SHELL_PORTS_BEGIN__'
try {
  $servicesByPid = @{}
  Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
    $pidKey = [int]$_.ProcessId
    if (-not $servicesByPid.ContainsKey($pidKey)) { $servicesByPid[$pidKey] = $_ }
  }
  $processCache = @{}
  Get-NetTCPConnection -State Listen | Sort-Object LocalPort, LocalAddress | ForEach-Object {
    $pidValue = [int]$_.OwningProcess
    $process = $null
    $wmi = $null
    if ($pidValue -gt 0) {
      if (-not $processCache.ContainsKey($pidValue)) {
        $processCache[$pidValue] = @{
          Process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
          Wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
        }
      }
      $process = $processCache[$pidValue].Process
      $wmi = $processCache[$pidValue].Wmi
    }
    $service = if ($servicesByPid.ContainsKey($pidValue)) { $servicesByPid[$pidValue] } else { $null }
    $address = if ($_.LocalAddress) { $_.LocalAddress } else { '*' }
    $endpoint = $address + ':' + $_.LocalPort
    $processName = if ($process) { $process.ProcessName } elseif ($wmi) { $wmi.Name } else { '' }
    $serviceName = if ($service) { $service.Name } else { '' }
    $user = if ($service) { $service.StartName } else { '' }
    $command = if ($wmi -and $wmi.CommandLine) { $wmi.CommandLine } elseif ($wmi) { $wmi.ExecutablePath } else { '' }
    $path = if ($wmi) { $wmi.ExecutablePath } else { '' }
    $raw = "tcp LISTEN $endpoint pid=$pidValue"
    Write-Tsv @('tcp', $endpoint, $pidValue, $processName, $serviceName, $user, $command, $raw, $path)
  }
} catch {
  Write-CleanLine "__1SHELL_WARN=windows_ports_failed:$($_.Exception.Message)"
}
Write-CleanLine '__1SHELL_PORTS_END__'
Write-CleanLine '__1SHELL_PROCESSES_BEGIN__'
try {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(frpc|frps|cloudflared|ngrok|tailscaled|zerotier-one)(\.exe)?$' } | ForEach-Object {
    $name = if ($_.Name) { $_.Name -replace '\.exe$', '' } else { '' }
    $command = if ($_.CommandLine) { $_.CommandLine } elseif ($_.ExecutablePath) { $_.ExecutablePath } else { '' }
    $cwd = if ($_.ExecutablePath) { Split-Path -Parent $_.ExecutablePath } else { '' }
    Write-Tsv @($_.ProcessId, $name, '', $command, '', $cwd, $_.ExecutablePath)
  }
} catch {
  Write-CleanLine "__1SHELL_WARN=windows_processes_failed:$($_.Exception.Message)"
}
Write-CleanLine '__1SHELL_PROCESSES_END__'
`;
  return `${script.replace(/\s*$/, '')}\n\n`;
}

function parseWorkloadDiscoveryOutput(stdout) {
  const text = String(stdout || '');
  const warnings = readWarns(text);
  const platform = normalizePlatform(readKey(text, '__1SHELL_PLATFORM'));
  const dockerErrorCode = readKey(text, '__1SHELL_DOCKER_ERROR_CODE');
  const dockerError = readKey(text, '__1SHELL_DOCKER_ERROR');
  const infoSection = extractSection(text, 'DOCKER_INFO').trim();
  const psItems = parseNdjson(extractSection(text, 'DOCKER_PS'), warnings, 'docker ps');
  const statsItems = parseNdjson(extractSection(text, 'DOCKER_STATS'), warnings, 'docker stats');
  const inspectResult = parseInspectItems(extractSection(text, 'DOCKER_INSPECT'));
  const portLines = extractSection(text, 'PORTS')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const processLines = extractSection(text, 'PROCESSES')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const dockerInstalled = dockerErrorCode !== 'docker_missing';
  const dockerReachable = dockerInstalled && !dockerErrorCode;
  const engineInfo = parseJsonMaybe(infoSection, warnings);
  const psMap = buildPsMap(psItems);
  const statsMap = buildStatsMap(statsItems);
  const containers = inspectResult.items
    .map((item) => toContainerWorkload(item, findPsItem(item, psMap), findStatsItem(item, statsMap)))
    .filter(Boolean);
  const containerLookup = buildContainerLookup(containers);
  const parsedPorts = portLines
    .filter((line) => !line.startsWith('__1SHELL_WARN='))
    .map((line) => parsePortWorkloadLine(line, { platform }))
    .filter(Boolean);
  const hostPorts = [];
  for (const item of parsedPorts) {
    if (mergeContainerProcessPort(item, containerLookup)) continue;
    hostPorts.push(item);
  }
  const dockerPortKeys = buildDockerPortKeys(containers);
  const ports = aggregatePortWorkloads(hostPorts.filter((item) => !isDockerDuplicatePort(item, dockerPortKeys)));
  const portPids = new Set(ports.map((item) => String(item.pid || '')).filter(Boolean));
  const processes = processLines
    .filter((line) => !line.startsWith('__1SHELL_WARN='))
    .map((line) => parseProcessWorkloadLine(line, { platform }))
    .filter(Boolean)
    .filter((item) => !portPids.has(String(item.pid || '')));

  return {
    items: [...containers, ...ports, ...processes].sort(sortWorkloads),
    warnings,
    platform,
    dockerInstalled,
    dockerReachable,
    dockerError: dockerError || null,
    engineVersion: normalizeEmpty(engineInfo?.Version) || normalizeEmpty(engineInfo?.APIVersion) || null,
    parseError: inspectResult.parseError || null,
  };
}

function parseInspectItems(section) {
  const text = String(section || '').trim();
  if (!text) return { items: [], parseError: null };
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? { items: parsed, parseError: null }
      : { items: [], parseError: 'docker inspect did not return an array' };
  } catch (error) {
    return { items: [], parseError: `docker inspect parse failed: ${error.message}` };
  }
}

function parseNdjson(section, warnings, label) {
  const items = [];
  String(section || '').split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (!text || text.startsWith('__1SHELL_')) return;
    try {
      items.push(JSON.parse(text));
    } catch (error) {
      warnings.push(`${label} line parse failed: ${trimOutput(error.message, 160)}`);
    }
  });
  return items;
}

function parseJsonMaybe(text, warnings) {
  const value = String(text || '').trim();
  if (!value || value.startsWith('__1SHELL_')) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    warnings.push(`docker version parse failed: ${trimOutput(error.message, 160)}`);
    return null;
  }
}

function normalizePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('windows') || text === 'win32') return 'windows';
  if (text.includes('darwin') || text.includes('mac')) return 'darwin';
  return text || 'linux';
}

function toContainerWorkload(inspectItem, psItem, statsItem) {
  if (!inspectItem || typeof inspectItem !== 'object') return null;
  const id = String(inspectItem.Id || psItem?.ID || '').trim();
  if (!id) return null;
  const labels = normalizeLabels(inspectItem.Config?.Labels);
  const stateInfo = inspectItem.State || {};
  const state = normalizeEmpty(stateInfo.Status) || normalizeEmpty(psItem?.State) || 'unknown';
  const health = normalizeEmpty(stateInfo.Health?.Status);
  const name = normalizeContainerName(inspectItem.Name || psItem?.Names || id.slice(0, 12));
  const entrypoints = parseInspectPorts(inspectItem.NetworkSettings?.Ports, inspectItem.Config?.ExposedPorts);
  const networks = parseNetworks(inspectItem.NetworkSettings?.Networks);
  const stats = normalizeStats(statsItem);
  const composeProject = normalizeEmpty(labels['com.docker.compose.project']);
  const composeService = normalizeEmpty(labels['com.docker.compose.service']);
  const composeWorkingDir = normalizeEmpty(labels['com.docker.compose.project.working_dir']);
  const isFromCompose = Boolean(composeProject || composeService);
  const running = Boolean(stateInfo.Running) || state === 'running';

  return {
    id: `container:${id}`,
    nativeId: id,
    shortId: id.slice(0, 12),
    kind: 'container',
    primary: true,
    projectCandidate: true,
    infrastructure: false,
    source: isFromCompose ? 'compose' : 'docker',
    sourceLabel: isFromCompose ? 'Compose' : 'Docker',
    name,
    imageName: normalizeEmpty(inspectItem.Config?.Image) || normalizeEmpty(psItem?.Image) || null,
    imageId: stripImageId(inspectItem.Image || psItem?.ImageID || ''),
    command: Array.isArray(inspectItem.Config?.Cmd) ? inspectItem.Config.Cmd.join(' ') : normalizeEmpty(psItem?.Command),
    state,
    status: normalizeEmpty(psItem?.Status) || state,
    health,
    failed: health === 'unhealthy' || state === 'dead',
    running,
    runTime: normalizeEmpty(psItem?.Status) || state,
    entrypoints,
    entrypointsText: entrypoints.map(formatPort).filter(Boolean),
    primaryEndpoint: entrypoints.map(formatPort).filter(Boolean)[0] || '',
    publishedPortCount: entrypoints.filter((port) => port.published).length,
    ipAddresses: networks.map((item) => item.ipAddress).filter(Boolean),
    networkText: formatNetworks(networks),
    relatedResource: isFromCompose ? [composeProject, composeService].filter(Boolean).join('/') : 'Docker',
    composeProject,
    composeService,
    composeWorkingDir,
    stats,
    evidence: [isFromCompose ? 'compose-label' : 'docker', running ? 'running' : state].filter(Boolean),
  };
}

function parsePortWorkloadLine(line, options = {}) {
  const parts = String(line || '').split('\t');
  if (parts.length < 2) return null;
  const [protocol, localAddress, pid, processName, serviceName, user, command, rawLine, cwd, dockerContainerId, cpuPercentText, rssKb] = parts;
  const endpoint = parseSocketAddress(localAddress);
  if (!endpoint.port) return null;
  const platform = normalizePlatform(options.platform);
  const source = serviceName ? (platform === 'windows' ? 'windows-service' : 'systemd') : 'process';
  const cleanProtocol = normalizeProtocol(protocol);
  const serviceLike = Boolean(serviceName) || isServiceProcess(processName, command);
  const projectCandidate = isProjectProcess({ processName, command, cwd, port: endpoint.port, serviceName, platform });
  const infrastructure = isInfrastructureWorkload({ port: endpoint.port, processName, serviceName, command });
  const kind = serviceLike || projectCandidate ? 'service' : 'port';
  const displayName = stripServiceSuffix(serviceName) || inferProjectDisplayName({ processName, command, cwd }) || processName || `:${endpoint.port}`;
  const name = serviceName || displayName || processName || `:${endpoint.port}`;
  return {
    id: `port:${cleanProtocol}:${endpoint.address}:${endpoint.port}:${pid || processName || ''}`,
    kind,
    source,
    sourceLabel: source === 'systemd' ? 'systemd' : (source === 'windows-service' ? 'Windows Service' : 'Process'),
    name,
    displayName,
    state: 'listening',
    status: 'LISTEN',
    running: true,
    failed: false,
    protocol: cleanProtocol,
    address: endpoint.address,
    port: endpoint.port,
    primaryEndpoint: formatEndpoint(endpoint.address, endpoint.port, cleanProtocol),
    entrypoints: [{
      protocol: cleanProtocol,
      address: endpoint.address,
      port: endpoint.port,
      endpoint: formatEndpoint(endpoint.address, endpoint.port, cleanProtocol),
      published: true,
    }],
    entrypointsText: [formatEndpoint(endpoint.address, endpoint.port, cleanProtocol)],
    publishedPortCount: 1,
    processName: processName || null,
    pid: pid || null,
    user: user || null,
    command: command || null,
    serviceName: serviceName || null,
    cwd: cwd || null,
    dockerContainerId: normalizeContainerId(dockerContainerId),
    stats: normalizeProcessStats(cpuPercentText, rssKb),
    primary: !infrastructure && (projectCandidate || (serviceLike && platform !== 'windows')),
    projectCandidate,
    infrastructure,
    relatedResource: serviceName || processName || 'process',
    rawLine: rawLine || null,
    evidence: [
      source === 'systemd' ? 'systemd-cgroup' : '',
      source === 'windows-service' ? 'windows-service' : '',
      source === 'process' ? 'process' : '',
      projectCandidate ? 'project-process' : '',
      platform === 'windows' ? 'nettcp' : 'ss',
    ].filter(Boolean),
  };
}

function aggregatePortWorkloads(items) {
  const groups = [];
  const byKey = new Map();
  for (const item of items || []) {
    const key = portWorkloadGroupKey(item);
    if (!key) {
      groups.push(item);
      continue;
    }
    let group = byKey.get(key);
    if (!group) {
      group = {
        ...item,
        id: portWorkloadGroupId(item),
        entrypoints: [],
        entrypointsText: [],
        publishedPortCount: 0,
      };
      byKey.set(key, group);
      groups.push(group);
    }
    mergePortEndpoint(group, item);
  }
  return groups.map(finalizePortWorkloadGroup);
}

function portWorkloadGroupKey(item) {
  if (!item) return null;
  if (item.serviceName) return `service:${item.source}:${item.serviceName}`;
  if (item.pid) return `pid:${item.source}:${item.pid}`;
  if (item.processName && item.command) return `process:${item.source}:${item.processName}:${item.command}`;
  return item.id || null;
}

function portWorkloadGroupId(item) {
  if (item.serviceName) return `service:${item.source}:${item.serviceName}`;
  if (item.pid) return `listener:${item.source}:${item.pid}`;
  if (item.processName) return `listener:${item.source}:${item.processName}`;
  return item.id;
}

function mergePortEndpoint(group, item) {
  const entrypoints = Array.isArray(item.entrypoints) ? item.entrypoints : [];
  group.entrypoints.push(...entrypoints);
  group.entrypointsText.push(...(item.entrypointsText || []));
  group.publishedPortCount += item.publishedPortCount || 0;
  group.evidence = [...new Set([...(group.evidence || []), ...(item.evidence || [])])];
  group.infrastructure = Boolean(group.infrastructure && item.infrastructure);
  group.projectCandidate = Boolean(group.projectCandidate || item.projectCandidate);
  group.primary = Boolean(group.primary || item.primary);
  if (!group.stats && item.stats) group.stats = item.stats;
  if (!group.dockerContainerId && item.dockerContainerId) group.dockerContainerId = item.dockerContainerId;
}

function finalizePortWorkloadGroup(item) {
  const entrypointMap = new Map();
  for (const endpoint of item.entrypoints || []) {
    const key = endpoint.endpoint || formatEndpoint(endpoint.address, endpoint.port, endpoint.protocol);
    if (key && !entrypointMap.has(key)) entrypointMap.set(key, endpoint);
  }
  const entrypoints = Array.from(entrypointMap.values()).sort(compareEntrypoints);
  const entrypointsText = formatEndpointRanges(entrypoints);
  return {
    ...item,
    port: entrypoints[0]?.port || item.port || null,
    address: entrypoints[0]?.address || item.address || null,
    primaryEndpoint: entrypointsText[0] || item.primaryEndpoint || '',
    entrypoints,
    entrypointsText,
    publishedPortCount: entrypoints.filter((endpoint) => endpoint.published).length,
  };
}

function buildContainerLookup(containers) {
  const lookup = new Map();
  for (const container of containers || []) {
    const id = normalizeContainerId(container?.nativeId);
    const shortId = normalizeContainerId(container?.shortId);
    if (id) {
      lookup.set(id, container);
      lookup.set(id.slice(0, 12), container);
    }
    if (shortId) lookup.set(shortId, container);
  }
  return lookup;
}

function mergeContainerProcessPort(item, containerLookup) {
  const containerId = normalizeContainerId(item?.dockerContainerId);
  if (!containerId || !containerLookup?.size) return false;
  const container = containerLookup.get(containerId) || containerLookup.get(containerId.slice(0, 12));
  if (!container) return false;
  const endpoint = Array.isArray(item.entrypoints) ? item.entrypoints[0] : null;
  if (endpoint?.port) {
    addContainerEntrypoint(container, {
      containerPort: String(endpoint.port),
      protocol: normalizeProtocol(endpoint.protocol || item.protocol),
      hostIp: null,
      hostPort: null,
      address: endpoint.address,
      port: endpoint.port,
      endpoint: endpoint.endpoint,
      published: false,
      discoveredFromProcess: true,
    });
  }
  if (!container.stats && item.stats) container.stats = item.stats;
  container.evidence = [...new Set([...(container.evidence || []), 'container-cgroup-port'])];
  refreshContainerEntrypoints(container);
  return true;
}

function addContainerEntrypoint(container, entrypoint) {
  if (!container || !entrypoint?.containerPort) return;
  const key = containerEntrypointKey(entrypoint);
  const exists = (container.entrypoints || []).some((item) => containerEntrypointKey(item) === key);
  if (exists) return;
  container.entrypoints = [...(container.entrypoints || []), entrypoint];
}

function refreshContainerEntrypoints(container) {
  if (!container) return;
  const entrypointMap = new Map();
  for (const entrypoint of container.entrypoints || []) {
    const key = containerEntrypointKey(entrypoint);
    if (key && !entrypointMap.has(key)) entrypointMap.set(key, entrypoint);
  }
  const entrypoints = Array.from(entrypointMap.values()).sort(sortPorts);
  const entrypointsText = entrypoints.map(formatPort).filter(Boolean);
  container.entrypoints = entrypoints;
  container.entrypointsText = [...new Set(entrypointsText)];
  container.primaryEndpoint = container.entrypointsText[0] || '';
  container.publishedPortCount = entrypoints.filter((port) => port.published).length;
}

function containerEntrypointKey(port) {
  if (!port) return '';
  const protocol = normalizeProtocol(port.protocol);
  const containerPort = String(port.containerPort || port.port || '').trim();
  if (port.published) {
    return `${protocol}:published:${port.hostIp || '*'}:${port.hostPort || ''}->${containerPort}`;
  }
  return `${protocol}:internal:${containerPort}`;
}

function formatEndpointRanges(entrypoints) {
  const groups = new Map();
  const fallback = [];
  for (const endpoint of entrypoints || []) {
    const protocol = normalizeProtocol(endpoint.protocol);
    const address = String(endpoint.address || '*').trim() || '*';
    const port = Number(endpoint.port);
    if (!Number.isInteger(port) || port <= 0) {
      const text = endpoint.endpoint || formatEndpoint(endpoint.address, endpoint.port, endpoint.protocol);
      if (text) fallback.push(text);
      continue;
    }
    const key = `${protocol}\t${address}`;
    if (!groups.has(key)) groups.set(key, { protocol, address, ports: [] });
    groups.get(key).ports.push(port);
  }

  const values = [];
  for (const group of groups.values()) {
    const ports = [...new Set(group.ports)].sort((a, b) => a - b);
    let start = null;
    let previous = null;
    const pushRange = () => {
      if (start === null || previous === null) return;
      if (previous - start >= 2) {
        values.push(formatEndpointRange(group.address, `${start}-${previous}`, group.protocol));
      } else {
        for (let port = start; port <= previous; port += 1) {
          values.push(formatEndpointRange(group.address, String(port), group.protocol));
        }
      }
    };
    for (const port of ports) {
      if (start === null) {
        start = port;
        previous = port;
        continue;
      }
      if (port === previous + 1) {
        previous = port;
        continue;
      }
      pushRange();
      start = port;
      previous = port;
    }
    pushRange();
  }
  return [...new Set([...values, ...fallback])].filter(Boolean);
}

function formatEndpointRange(address, portRange, protocol) {
  const cleanAddress = String(address || '').trim();
  const host = cleanAddress && cleanAddress !== '*' && cleanAddress !== '0.0.0.0' && cleanAddress !== '::' ? cleanAddress : '*';
  return `${host}:${portRange}/${normalizeProtocol(protocol)}`;
}

function compareEntrypoints(a, b) {
  const protocolDelta = String(a.protocol || '').localeCompare(String(b.protocol || ''));
  if (protocolDelta) return protocolDelta;
  const addressDelta = String(a.address || '').localeCompare(String(b.address || ''));
  if (addressDelta) return addressDelta;
  const portDelta = Number(a.port || 0) - Number(b.port || 0);
  if (portDelta) return portDelta;
  return String(a.endpoint || '').localeCompare(String(b.endpoint || ''));
}

function parseProcessWorkloadLine(line, options = {}) {
  const parts = String(line || '').split('\t');
  if (parts.length < 2) return null;
  const [pid, processName, user, command, serviceName, cwd, rawLine] = parts;
  if (!isTunnelProcess(processName, command)) return null;
  const platform = normalizePlatform(options.platform);
  const displayName = inferTunnelDisplayName(processName, command);
  const cleanProcessName = normalizeEmpty(processName) || displayName;
  return {
    id: `process:${platform}:${pid || cleanProcessName}:${displayName}`,
    kind: 'service',
    source: 'tunnel',
    sourceLabel: tunnelSourceLabel(cleanProcessName),
    name: displayName,
    displayName,
    state: 'running',
    status: 'RUNNING',
    running: true,
    failed: false,
    primaryEndpoint: 'outbound',
    entrypoints: [],
    entrypointsText: ['outbound'],
    publishedPortCount: 0,
    processName: cleanProcessName,
    pid: pid || null,
    user: user || null,
    command: command || null,
    serviceName: serviceName || null,
    cwd: cwd || null,
    primary: true,
    projectCandidate: true,
    infrastructure: false,
    relatedResource: tunnelSourceLabel(cleanProcessName),
    rawLine: rawLine || null,
    evidence: ['tunnel-process', 'process'].filter(Boolean),
  };
}

function buildDockerPortKeys(containers) {
  const keys = new Set();
  for (const item of containers || []) {
    for (const port of item.entrypoints || []) {
      if (!port.published || !port.hostPort) continue;
      const protocol = normalizeProtocol(port.protocol);
      const hostIp = port.hostIp || '*';
      keys.add(`${protocol}:*:${port.hostPort}`);
      keys.add(`${protocol}:${hostIp}:${port.hostPort}`);
    }
  }
  return keys;
}

function isDockerDuplicatePort(item, dockerPortKeys) {
  if (!item) return false;
  if (item.processName === 'docker-proxy' || /(^|\s)docker-proxy(\s|$)/.test(String(item.command || ''))) return true;
  const address = item.address && item.address !== '0.0.0.0' && item.address !== '::' ? item.address : '*';
  return dockerPortKeys.has(`${normalizeProtocol(item.protocol)}:*:${item.port}`)
    || dockerPortKeys.has(`${normalizeProtocol(item.protocol)}:${address}:${item.port}`);
}

function parseInspectPorts(ports, exposedPorts = null) {
  const results = [];
  const seen = new Set();
  const addUnpublished = (containerPort, protocol) => {
    const cleanPort = normalizeEmpty(containerPort);
    if (!cleanPort) return;
    results.push({ containerPort: cleanPort, protocol: normalizeProtocol(protocol), hostIp: null, hostPort: null, published: false });
  };
  const portEntries = ports && typeof ports === 'object' ? Object.entries(ports) : [];
  for (const [key, bindings] of portEntries) {
    const [containerPort, protocol = 'tcp'] = String(key || '').split('/');
    if (!containerPort) continue;
    seen.add(`${containerPort}/${normalizeProtocol(protocol)}`);
    if (Array.isArray(bindings) && bindings.length) {
      for (const binding of bindings) {
        results.push({
          containerPort,
          protocol: normalizeProtocol(protocol),
          hostIp: normalizeHostIp(binding?.HostIp),
          hostPort: normalizeEmpty(binding?.HostPort),
          published: Boolean(binding?.HostPort),
        });
      }
    } else {
      results.push({ containerPort, protocol: normalizeProtocol(protocol), hostIp: null, hostPort: null, published: false });
    }
  }
  const exposedEntries = exposedPorts && typeof exposedPorts === 'object' ? Object.keys(exposedPorts) : [];
  for (const key of exposedEntries) {
    const [containerPort, protocol = 'tcp'] = String(key || '').split('/');
    const normalizedKey = `${containerPort}/${normalizeProtocol(protocol)}`;
    if (!containerPort || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    addUnpublished(containerPort, protocol);
  }
  return results.sort(sortPorts);
}

function parseNetworks(networks) {
  if (!networks || typeof networks !== 'object') return [];
  return Object.entries(networks).map(([name, value]) => ({
    name,
    ipAddress: normalizeEmpty(value?.IPAddress) || normalizeEmpty(value?.GlobalIPv6Address),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeStats(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    cpuPercent: parsePercent(item.CPUPerc),
    cpuPercentText: normalizeEmpty(item.CPUPerc),
    memoryUsage: normalizeEmpty(item.MemUsage),
    memoryPercent: parsePercent(item.MemPerc),
    memoryPercentText: normalizeEmpty(item.MemPerc),
    netIO: normalizeEmpty(item.NetIO),
    blockIO: normalizeEmpty(item.BlockIO),
    pids: normalizeEmpty(item.PIDs),
  };
}

function normalizeProcessStats(cpuPercentText, rssKbText) {
  const cpuPercent = parsePercent(cpuPercentText);
  const rssKb = Number(String(rssKbText || '').trim());
  const memoryBytes = Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : null;
  if (cpuPercent === null && memoryBytes === null) return null;
  return {
    cpuPercent,
    cpuPercentText: cpuPercent === null ? null : `${cpuPercent.toFixed(2)}%`,
    memoryUsage: memoryBytes === null ? null : formatBytes(memoryBytes),
    memoryBytes,
  };
}

function formatBytes(bytes) {
  let value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)}${units[unitIndex]}`;
}

function parseSocketAddress(value) {
  const text = String(value || '').trim();
  if (!text) return { address: '', port: '' };
  const bracket = text.match(/^\[([^\]]*)\]:(\d+)$/);
  if (bracket) return { address: bracket[1] || '*', port: bracket[2] };
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return { address: text, port: '' };
  return { address: text.slice(0, lastColon) || '*', port: text.slice(lastColon + 1) };
}

function inferProjectDisplayName({ processName, command, cwd }) {
  const cleanCwd = normalizeEmpty(cwd);
  if (cleanCwd) {
    const base = cleanCwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    if (base && isProjectPath(cleanCwd)) return base;
  }
  const text = String(command || '').trim();
  const pythonModuleMatch = text.match(/(?:^|\s)(?:python|python3)(?:\.\d+)?(?:\s+-[^\s]+)*\s+-m\s+([A-Za-z0-9_.-]+)/i);
  if (pythonModuleMatch?.[1]) return pythonModuleMatch[1];
  const scriptMatch = text.match(/(?:^|\s)([^\s"'`]+(?:server|app|main|index|manage|start|vite|next|uwsgi|gunicorn|uvicorn)[^\s"'`]*)/i);
  if (scriptMatch) {
    const base = scriptMatch[1].replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    if (base && !isConfigLikeName(base)) return base;
  }
  return normalizeEmpty(processName);
}

function isConfigLikeName(value) {
  const text = String(value || '').trim().toLowerCase();
  return /(^|[._-])(config|settings?|credentials?|secrets?)([._-]|$)/.test(text)
    || /\.(json|ya?ml|toml|ini|conf|env)$/i.test(text);
}

function inferTunnelDisplayName(processName, command) {
  const baseName = normalizeProcessBaseName(processName) || 'tunnel';
  const configName = extractConfigName(command);
  if (!configName) return baseName;
  const suffix = configName
    .replace(/\.(toml|ini|yaml|yml|json|conf)$/i, '')
    .replace(new RegExp(`^${escapeRegExp(baseName)}[-_]?`, 'i'), '');
  return suffix ? `${baseName}: ${suffix}` : baseName;
}

function extractConfigName(command) {
  const text = String(command || '');
  const match = text.match(/(?:^|\s)(?:-c|--config)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const value = match ? (match[1] || match[2] || match[3] || '') : '';
  const clean = value.trim();
  if (!clean) return '';
  return clean.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || clean;
}

function normalizeProcessBaseName(value) {
  return String(value || '')
    .trim()
    .replace(/\.exe$/i, '')
    .replace(/^.*[\\/]/, '')
    .toLowerCase();
}

function tunnelSourceLabel(processName) {
  const base = normalizeProcessBaseName(processName);
  if (base === 'frpc' || base === 'frps') return 'FRP';
  if (base === 'cloudflared') return 'Cloudflared';
  if (base === 'ngrok') return 'ngrok';
  if (base === 'tailscaled') return 'Tailscale';
  if (base === 'zerotier-one') return 'ZeroTier';
  return 'Tunnel';
}

function isTunnelProcess(processName, command) {
  const text = `${normalizeProcessBaseName(processName)} ${command || ''}`.toLowerCase();
  return /\b(frpc|frps|cloudflared|ngrok|tailscaled|zerotier-one)\b/.test(text);
}

function isProjectProcess({ processName, command, cwd, port, serviceName, platform }) {
  if (serviceName && platform !== 'windows' && !isInfrastructureWorkload({ port, processName, serviceName, command })) return true;
  const text = `${processName || ''} ${command || ''}`.toLowerCase();
  if (isTunnelProcess(processName, command)) return true;
  if (/\b(node|npm|pnpm|yarn|bun|deno|vite|next|nuxt|pm2|python|python3|uvicorn|gunicorn|uwsgi|flask|django|java|jar|dotnet|php|php-fpm|ruby|rails|puma|go|cargo|serve)\b/.test(text)) return true;
  if (isProjectPath(cwd)) return true;
  return false;
}

function isServiceProcess(processName, command) {
  const text = `${processName || ''} ${command || ''}`.toLowerCase();
  return /\b(frpc|frps|cloudflared|ngrok|tailscaled|zerotier-one|postgres|postmaster|mysqld|mariadbd|redis-server|mongod|caddy|traefik|nginx|apache2|httpd|php-fpm|node|python|python3|java|dotnet)\b/.test(text);
}

function isProjectPath(value) {
  const text = String(value || '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(srv|opt|app|apps|www|var\/www|home|users)\/.+/.test(text)
    && !/\/(windows|program files|system32|usr\/bin|usr\/sbin|bin|sbin|lib|lib64)(\/|$)/.test(text);
}

function isInfrastructureWorkload({ port, processName, serviceName, command }) {
  if (isInfrastructurePort(port)) return true;
  const text = `${processName || ''} ${serviceName || ''} ${command || ''}`.toLowerCase();
  return /\b(sshd|ssh|systemd|init|chronyd|ntpd|systemd-resolved|networkmanager|containerd|dockerd|docker-proxy|x11vnc|vncserver|winrm|winlogon|svchost|lsass|services)\b/.test(text);
}

function isInfrastructurePort(port) {
  const numberValue = Number(port);
  if (!Number.isFinite(numberValue)) return false;
  if ([22, 53, 68, 80, 123, 135, 137, 138, 139, 323, 389, 443, 445, 3389].includes(numberValue)) return true;
  return numberValue >= 5900 && numberValue <= 5999;
}

function isPrimaryWorkload(item) {
  if (!item || item.failed) return false;
  if (item.primary === true) return true;
  return item.kind === 'container';
}

function hasListeningEndpoint(item) {
  if (!item || item.kind === 'container') return false;
  if (item.port) return true;
  return (item.entrypoints || []).some((entrypoint) => entrypoint?.port || entrypoint?.endpoint);
}

function countListeningEndpoints(items) {
  return (items || []).reduce((total, item) => {
    if (!item || item.kind === 'container') return total;
    if (Array.isArray(item.entrypoints) && item.entrypoints.length) return total + item.entrypoints.length;
    return total + (hasListeningEndpoint(item) ? 1 : 0);
  }, 0);
}

function formatEndpoint(address, port, protocol) {
  const cleanAddress = String(address || '').trim();
  const host = cleanAddress && cleanAddress !== '*' && cleanAddress !== '0.0.0.0' && cleanAddress !== '::' ? cleanAddress : '*';
  return `${host}:${port}/${normalizeProtocol(protocol)}`;
}

function formatPort(port) {
  if (!port) return '';
  const target = `${port.containerPort}/${normalizeProtocol(port.protocol)}`;
  if (!port.published) return target;
  const host = port.hostIp ? `${port.hostIp}:` : '';
  return `${host}${port.hostPort}->${target}`;
}

function formatNetworks(networks) {
  if (!Array.isArray(networks) || !networks.length) return '';
  return networks.map((item) => item.ipAddress ? `${item.name}:${item.ipAddress}` : item.name).join(', ');
}

function buildPsMap(items) {
  const byId = new Map();
  const byName = new Map();
  for (const item of items || []) {
    const id = String(item.ID || item.Id || '').trim();
    const name = normalizeContainerName(item.Names || item.Name || '');
    if (id) {
      byId.set(id, item);
      byId.set(id.slice(0, 12), item);
    }
    if (name) byName.set(name, item);
  }
  return { byId, byName };
}

function buildStatsMap(items) {
  const byId = new Map();
  const byName = new Map();
  for (const item of items || []) {
    const id = String(item.Container || item.ID || '').trim();
    const name = normalizeContainerName(item.Name || '');
    if (id) byId.set(id, item);
    if (name) byName.set(name, item);
  }
  return { byId, byName };
}

function findPsItem(inspectItem, psMap) {
  const id = String(inspectItem?.Id || '').trim();
  const name = normalizeContainerName(inspectItem?.Name || '');
  return psMap.byId.get(id) || psMap.byId.get(id.slice(0, 12)) || psMap.byName.get(name) || null;
}

function findStatsItem(inspectItem, statsMap) {
  const id = String(inspectItem?.Id || '').trim();
  const name = normalizeContainerName(inspectItem?.Name || '');
  return statsMap.byId.get(id) || statsMap.byId.get(id.slice(0, 12)) || statsMap.byName.get(name) || null;
}

function normalizeLabels(labels) {
  if (!labels || typeof labels !== 'object') return {};
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [String(key), String(value || '')]));
}

function normalizeProtocol(value) {
  const text = String(value || '').toLowerCase();
  if (text.startsWith('tcp')) return 'tcp';
  if (text.startsWith('udp')) return 'udp';
  return text || 'tcp';
}

function normalizeHostIp(value) {
  const text = String(value || '').trim();
  if (!text || text === '0.0.0.0' || text === '::') return null;
  return text.replace(/^\[|\]$/g, '');
}

function normalizeContainerName(value) {
  return String(value || '').trim().replace(/^\/+/, '');
}

function normalizeContainerId(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/[0-9a-f]{12,64}/);
  return match ? match[0] : null;
}

function stripImageId(value) {
  return String(value || '').replace(/^sha256:/, '').slice(0, 12) || null;
}

function stripServiceSuffix(name) {
  return String(name || '').replace(/\.service$/, '');
}

function parsePercent(value) {
  const text = String(value || '').replace('%', '').trim();
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
}

function decorateItems(items, host) {
  return items.map((item) => ({ ...item, hostId: host.id, hostName: host.name || host.id }));
}

function markLocalControllerWorkloads(items, host) {
  if (!Array.isArray(items) || (host?.type !== 'local' && host?.id !== 'local')) return items || [];
  const serverPort = String(PORT || process.env.PORT || '3301');
  const serverPid = String(process.pid || '');
  return items.map((item) => {
    const command = String(item?.command || '');
    const processName = String(item?.processName || '').toLowerCase();
    const isCurrentPid = serverPid && String(item?.pid || '') === serverPid;
    const isServerPort = serverPort && String(item?.port || '') === serverPort;
    const looksLikeNodeServer = /\bnode(?:\.exe)?\b/i.test(processName)
      || /(^|\s|["'])node(?:\.exe)?(["']|\s|$)/i.test(command);
    const looksLikeOneShellEntry = /(^|\s|["'\\/])server\.js(["']|\s|$)/i.test(command);
    if (!isCurrentPid && !(isServerPort && looksLikeNodeServer && looksLikeOneShellEntry)) return item;
    return {
      ...item,
      name: '1Shell',
      displayName: '1Shell',
      cwd: ROOT_DIR,
      relatedResource: '1Shell',
      sourceLabel: item.sourceLabel || 'Process',
      primary: true,
      projectCandidate: true,
      infrastructure: false,
      evidence: [...new Set([...(item.evidence || []), 'oneshell-controller'])],
    };
  });
}

function toHostSummary(result) {
  const items = result.items || [];
  return {
    hostId: result.hostId,
    hostName: result.hostName,
    ok: Boolean(result.ok),
    collectedAt: result.collectedAt,
    durationMs: result.durationMs,
    platformSupported: result.platformSupported,
    platform: result.platform || 'linux',
    dockerInstalled: result.dockerInstalled,
    dockerReachable: result.dockerReachable,
    dockerError: result.dockerError || null,
    engineVersion: result.engineVersion,
    workloadCount: items.length,
    runningWorkloadCount: items.filter((item) => item.running).length,
    stoppedWorkloadCount: items.filter((item) => !item.running).length,
    unhealthyWorkloadCount: items.filter((item) => item.health === 'unhealthy' || item.failed).length,
    primaryWorkloadCount: items.filter(isPrimaryWorkload).length,
    containerCount: items.filter((item) => item.kind === 'container').length,
    runningContainerCount: items.filter((item) => item.kind === 'container' && item.running).length,
    serviceCount: items.filter((item) => item.kind === 'service').length,
    projectProcessCount: items.filter((item) => item.projectCandidate).length,
    infrastructureCount: items.filter((item) => item.infrastructure).length,
    processCount: items.filter((item) => item.kind !== 'container').length,
    systemdWorkloadCount: items.filter((item) => item.source === 'systemd').length,
    windowsServiceCount: items.filter((item) => item.source === 'windows-service').length,
    composeWorkloadCount: items.filter((item) => item.source === 'compose').length,
    listeningPortCount: countListeningEndpoints(items),
    publishedPortCount: items.reduce((total, item) => total + (item.entrypoints || []).filter((port) => port.published).length, 0),
    warnings: result.warnings || [],
    error: result.error || null,
    errorCode: result.errorCode || null,
  };
}

function normalizeCommandFailure(result) {
  const stderr = trimOutput(result.stderr || '', 1000);
  const stdout = trimOutput(result.stdout || '', 1000);
  return stderr || stdout || `workload discovery exited with code ${result.exitCode}`;
}

function extractSection(text, name) {
  const start = `__1SHELL_${name}_BEGIN__`;
  const end = `__1SHELL_${name}_END__`;
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return '';
  const bodyStart = startIndex + start.length;
  const endIndex = text.indexOf(end, bodyStart);
  const raw = endIndex === -1 ? text.slice(bodyStart) : text.slice(bodyStart, endIndex);
  return raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function readKey(text, key) {
  const match = String(text || '').match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function readWarns(text) {
  const warnings = [];
  const re = /^__1SHELL_WARN=(.*)$/gm;
  let match;
  while ((match = re.exec(String(text || '')))) warnings.push(match[1].trim());
  return warnings.filter(Boolean);
}

function sortPorts(a, b) {
  const hostA = Number(a.hostPort || a.port || a.containerPort);
  const hostB = Number(b.hostPort || b.port || b.containerPort);
  if (Number.isFinite(hostA) && Number.isFinite(hostB) && hostA !== hostB) return hostA - hostB;
  return String(a.protocol || '').localeCompare(String(b.protocol || ''));
}

function sortWorkloads(a, b) {
  if (a.failed !== b.failed) return a.failed ? -1 : 1;
  const primaryDelta = workloadPrimaryRank(a) - workloadPrimaryRank(b);
  if (primaryDelta) return primaryDelta;
  if (a.kind !== b.kind) return workloadKindRank(a) - workloadKindRank(b);
  if (a.running !== b.running) return a.running ? -1 : 1;
  const portNoiseDelta = workloadPortNoiseRank(a) - workloadPortNoiseRank(b);
  if (portNoiseDelta) return portNoiseDelta;
  const sourceDelta = workloadSourceRank(a) - workloadSourceRank(b);
  if (sourceDelta) return sourceDelta;
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
}

function workloadPrimaryRank(item) {
  if (isPrimaryWorkload(item)) return 0;
  if (item.kind === 'container') return 1;
  if (item.kind === 'service') return 2;
  return 3;
}

function workloadKindRank(item) {
  if (item.kind === 'container') return 0;
  if (item.kind === 'service') return 1;
  if (item.kind === 'port') return 2;
  return 2;
}

function workloadSourceRank(item) {
  if (item.source === 'compose') return 0;
  if (item.source === 'docker') return 1;
  if (item.source === 'systemd') return 2;
  if (item.source === 'tunnel') return 3;
  if (item.source === 'windows-service') return 4;
  if (item.source === 'process') return 5;
  return 6;
}

function workloadPortNoiseRank(item) {
  if (item.kind === 'container') return 0;
  if (item.infrastructure) return 2;
  const port = String(item.port || '');
  return port === '22' || port === '80' || port === '443' ? 1 : 0;
}

function countUnique(values) {
  return new Set(values.filter(Boolean)).size;
}

function trimOutput(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iteratee(items[index], index);
    }
  }));
  return results;
}

module.exports = {
  createPanelWorkloadsService,
  _internals: {
    buildWorkloadDiscoveryCommand,
    buildWindowsWorkloadDiscoveryScript,
    buildWindowsWorkloadDiscoveryCommand,
    parseWorkloadDiscoveryOutput,
    detectHostPlatform,
    isPrimaryWorkload,
    hasListeningEndpoint,
    markLocalControllerWorkloads,
  },
};
