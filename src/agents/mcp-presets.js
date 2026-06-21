'use strict';

/**
 * MCP Server preset 集合(v3 plan §4.1 + §4.3)
 *
 * 用户在 "/agent" 的 Tools 面板里可选一个 preset,一键把这个 MCP server 添加到
 * 某个 CLI(claude/codex/opencode) 的沙箱 MCP 配置里(deep-merge,默认 disabled)。
 *
 * 字段含义:
 *   id           — 内部唯一 id
 *   name         — 显示名
 *   tags         — 标签数组,用于前端筛选
 *   description  — 一句话介绍
 *   homepage     — 项目主页
 *   docs         — 文档链接
 *   server       — MCP server 启动配置(stdio)
 *     command    — 启动命令
 *     args       — 启动参数(可含模板变量 {githubToken}/{cwd} 等,前端 UI 引导用户填)
 *     env        — env 注入(同 args 可含模板变量)
 *     needsToken — 标记需要外部 token 的 preset(github/...)
 *
 * 数据原则(R7 安全风险缓解):
 *   - 只收官方 @modelcontextprotocol/* 或明确背书的 server
 *   - 描述里标"会运行 X 包,首次启用前请审阅",由 UI 渲染
 *   - 默认 disabled,用户手动开启(由 mcp-registry 接口实现)
 */

const MCP_PRESETS = [
  {
    id: 'fetch',
    name: 'Fetch',
    tags: ['web', 'official'],
    description: '抓取网页并转为 markdown,适合让 agent 读外部文档/资料。',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch#readme',
    server: {
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: {},
    },
  },
  {
    id: 'time',
    name: 'Time',
    tags: ['utility', 'official'],
    description: '时区转换、当前时间查询。给 agent 准确的时间感知。',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time#readme',
    server: {
      command: 'uvx',
      args: ['mcp-server-time'],
      env: {},
    },
  },
  {
    id: 'memory',
    name: 'Memory(知识图)',
    tags: ['knowledge', 'official'],
    description: '在内存里维护实体关系图,跨会话给 agent 持久记忆。',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory#readme',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
    },
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    tags: ['reasoning', 'official'],
    description: '强制 agent 走"分步思考"流程,适合复杂推理任务。',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking#readme',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      env: {},
    },
  },
  {
    id: 'context7',
    name: 'Context7',
    tags: ['docs', 'third-party'],
    description: 'Upstash 维护的库文档查询服务,适合 agent 查最新框架/SDK 文档。',
    homepage: 'https://github.com/upstash/context7',
    docs: 'https://github.com/upstash/context7#readme',
    server: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: {},
    },
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    tags: ['file', 'official'],
    description: '让 agent 读写本机文件系统(限制在指定目录内)。',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem#readme',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '{rootDir}'],
      env: {},
    },
    needsConfig: ['rootDir'],
  },
  {
    id: 'github',
    name: 'GitHub',
    tags: ['vcs', 'official'],
    description: '让 agent 操作 GitHub repo / issue / PR(需要 PAT)。',
    homepage: 'https://github.com/github/github-mcp-server',
    docs: 'https://github.com/github/github-mcp-server#readme',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '{githubToken}',
      },
    },
    needsToken: true,
    needsConfig: ['githubToken'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    tags: ['browser', 'official'],
    description: 'Microsoft 官方浏览器自动化 MCP,适合 agent 做 E2E 验证/UI 操作。',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    docs: 'https://github.com/microsoft/playwright-mcp#readme',
    server: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      env: {},
    },
  },
];

const MCP_TAGS = ['official', 'third-party', 'web', 'file', 'utility', 'knowledge', 'reasoning', 'docs', 'vcs', 'browser'];

function getMcpPreset(id) {
  return MCP_PRESETS.find(p => p.id === id) || null;
}

function getAllMcpPresets() {
  return MCP_PRESETS;
}

module.exports = {
  MCP_PRESETS,
  MCP_TAGS,
  getMcpPreset,
  getAllMcpPresets,
};
