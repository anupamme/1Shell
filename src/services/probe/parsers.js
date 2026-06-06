'use strict';

const { KEY_PROCESS_NAMES } = require('./commands');

function parseInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function parseProbeOutput(text) {
  const result = {};

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    result[key] = value;
  }

  return result;
}

function parseNetworkBytesText(text, rxKey, txKey) {
  const parsed = parseProbeOutput(text);
  return {
    rxBytes: parseInteger(parsed[rxKey]),
    txBytes: parseInteger(parsed[txKey]),
  };
}

function parseDiskBytesText(text, readKey, writeKey) {
  const parsed = parseProbeOutput(text);
  return {
    diskReadBytes: parseInteger(parsed[readKey]),
    diskWriteBytes: parseInteger(parsed[writeKey]),
  };
}

function parseKeyProcesses(value) {
  if (!KEY_PROCESS_NAMES.length) return [];

  const countMap = new Map();
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const index = item.lastIndexOf(':');
      if (index === -1) return;
      const name = item.slice(0, index).trim();
      const count = parseInteger(item.slice(index + 1));
      countMap.set(name, count || 0);
    });

  return KEY_PROCESS_NAMES.map((name) => {
    const count = countMap.get(name) || 0;
    return {
      name,
      count,
      running: count > 0,
    };
  });
}

function parseSystemHealth(parsed = {}) {
  return {
    network: {
      listeningPortCount: parseInteger(parsed.LISTEN_PORT_COUNT),
      tcpConnectionCount: parseInteger(parsed.TCP_CONN_COUNT),
      topListeningPorts: parseTopListeningPorts(parsed.TOP_LISTEN_PORTS),
    },
    process: {
      zombieCount: parseInteger(parsed.ZOMBIE_COUNT),
    },
    service: {
      failedServiceCount: parseInteger(parsed.FAILED_SERVICE_COUNT),
      failedServices: parseCsv(parsed.FAILED_SERVICES).slice(0, 5),
    },
    logs: {
      recentErrorCount: parseInteger(parsed.RECENT_ERROR_COUNT),
      recentErrors: parsePipeList(parsed.RECENT_ERRORS).slice(0, 3),
    },
    security: {
      firewallState: normalizeText(parsed.FIREWALL_STATE),
      selinuxState: normalizeText(parsed.SELINUX_STATE),
    },
  };
}

function parsePlatformInfo(parsed = {}) {
  const distroId = normalizeText(parsed.PLATFORM_DISTRO_ID)?.toLowerCase() || null;
  const prettyName = normalizeText(parsed.PLATFORM_PRETTY_NAME);
  const arch = normalizeText(parsed.PLATFORM_ARCH);
  const kernel = normalizeText(parsed.PLATFORM_KERNEL);
  const osName = normalizeText(parsed.PLATFORM_OS);
  const cpuVendor = normalizeText(parsed.CPU_VENDOR);
  const cpuModel = normalizeText(parsed.CPU_MODEL);
  const packageManager = normalizeText(parsed.PACKAGE_MANAGER);
  if (!distroId && !prettyName && !arch && !kernel && !osName && !cpuVendor && !cpuModel && !packageManager) {
    return null;
  }

  return {
    os: osName || (distroId || prettyName ? 'linux' : null),
    distroId,
    versionId: normalizeText(parsed.PLATFORM_VERSION_ID),
    prettyName,
    arch,
    kernel,
    cpuVendor,
    cpuModel,
    packageManager: packageManager && packageManager !== 'unknown' ? packageManager : null,
  };
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePipeList(value) {
  return String(value || '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function parseTopListeningPorts(value) {
  return parseCsv(value)
    .map((item) => {
      const parts = item.split(':');
      if (parts.length < 2) return null;
      return {
        protocol: parts[0] || null,
        port: parts[1] || null,
        process: parts.slice(2).join(':') || null,
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

module.exports = {
  parseDiskBytesText,
  parseInteger,
  parseKeyProcesses,
  parseNetworkBytesText,
  parsePlatformInfo,
  parseProbeOutput,
  parseSystemHealth,
};
