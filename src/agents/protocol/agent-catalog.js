'use strict';

// 协议 agent 目录：描述每个第三方 agent 如何以结构化协议接入 Agent 板块。
// 与 cli-manifest.js（安装/原生配置）互补：这里只关心「怎么起协议进程」。

const fs = require('fs');
const path = require('path');
const { findBinaryInNpmGlobal } = require('../binary-locate');

const PROTOCOL_AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    protocol: 'claude-stream',
    binary: 'claude',
    args: [],
    icon: 'claude',
    supportsResume: true,
    description: 'Anthropic 终端 coding agent，stream-json 双向流接入。',
  },
  {
    id: 'codex',
    name: 'Codex',
    protocol: 'codex-app-server',
    binary: 'codex',
    args: ['app-server'],
    icon: 'codex',
    supportsResume: true,
    description: 'OpenAI Codex CLI，app-server 协议接入。',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    protocol: 'acp',
    binary: 'opencode',
    args: ['acp'],
    icon: 'opencode',
    supportsResume: false,
    description: 'OpenCode 终端 agent，ACP 接入。',
    // 与 native-cli-config getBinaryProbeSkipReason 同规则：Windows 桌面版启动器
    // （<...>/OpenCode/opencode.exe）会拉起 GUI 而非 CLI，不能作为 acp 进程。
    excludePath: (full) => process.platform === 'win32'
      && path.basename(full).toLowerCase() === 'opencode.exe'
      && path.basename(path.dirname(full)).toLowerCase() === 'opencode',
  },
];

function executableCandidates(binary) {
  if (process.platform !== 'win32') return [binary];
  // Windows：无扩展名文件（npm 的 sh shim）无法被 spawn，只找 PATHEXT 候选；
  // .exe 优先于 .cmd/.bat，避免解析到还要包 shell 的 shim。
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  exts.sort((a, b) => (b.toLowerCase() === '.exe' ? 1 : 0) - (a.toLowerCase() === '.exe' ? 1 : 0));
  return exts.map((ext) => `${binary}${ext.toLowerCase()}`);
}

function findBinaryOnPath(binary, excludePath) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of executableCandidates(binary)) {
      const full = path.join(dir, candidate);
      if (excludePath && excludePath(full)) continue;
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch { /* keep scanning */ }
    }
  }
  // PATH 扫描失败时兜底：npm 全局目录直查（桌面自启动等场景 PATH 可能残缺）
  const fallback = findBinaryInNpmGlobal(binary);
  if (fallback && !(excludePath && excludePath(fallback))) return fallback;
  return null;
}

function createProtocolAgentCatalog({ binaryOverrides = () => null } = {}) {
  function listAgents() {
    return PROTOCOL_AGENTS.map((agent) => {
      const override = binaryOverrides(agent.id) || null;
      const binaryPath = override || findBinaryOnPath(agent.binary, agent.excludePath);
      return {
        id: agent.id,
        name: agent.name,
        protocol: agent.protocol,
        icon: agent.icon,
        description: agent.description,
        supportsResume: agent.supportsResume,
        installed: Boolean(binaryPath),
        binaryPath: binaryPath || '',
      };
    });
  }

  function getAgent(agentId) {
    const spec = PROTOCOL_AGENTS.find((a) => a.id === agentId);
    if (!spec) return null;
    const override = binaryOverrides(spec.id) || null;
    const binaryPath = override || findBinaryOnPath(spec.binary, spec.excludePath);
    return { ...spec, binaryPath: binaryPath || '' };
  }

  return { listAgents, getAgent };
}

module.exports = { createProtocolAgentCatalog, PROTOCOL_AGENTS };
