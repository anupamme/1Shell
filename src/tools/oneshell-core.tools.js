'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { DATA_DIR, ROOT_DIR } = require('../config/env');
const { execLocalCommand } = require('../../lib/exec-local');
const { emitIdeEvent } = require('../ide/ide.events');
const { MCP_STANDARD_TOOL_SET } = require('./mcp-tool-profiles');
const { formatOutputDiagnostics, withOutputDiagnostics } = require('../utils/output-diagnostics');

const INLINE_UPLOAD_MAX_BYTES = envPositiveNumber('ONESHELL_MCP_INLINE_UPLOAD_MAX_BYTES', 1024 * 1024);
const TEXT_WRITE_MAX_BYTES = envPositiveNumber('ONESHELL_MCP_TEXT_WRITE_MAX_BYTES', 2 * 1024 * 1024);
const UPLOAD_CHUNK_MAX_BYTES = envPositiveNumber('ONESHELL_MCP_UPLOAD_CHUNK_MAX_BYTES', 1024 * 1024);
const UPLOAD_SESSION_MAX_BYTES = envPositiveNumber('ONESHELL_MCP_UPLOAD_SESSION_MAX_BYTES', 512 * 1024 * 1024);
const UPLOAD_SESSION_TTL_MS = envPositiveNumber('ONESHELL_MCP_UPLOAD_SESSION_TTL_MS', 30 * 60 * 1000);
const MCP_UPLOAD_TMP_DIR = path.join(DATA_DIR || path.join(ROOT_DIR, 'data'), 'tmp', 'mcp-uploads');
const FILE_TRANSFER_TMP_DIR = path.join(DATA_DIR || path.join(ROOT_DIR, 'data'), 'tmp', 'file-transfers');
const FILE_TRANSFER_RESULT_TTL_MS = envPositiveNumber('ONESHELL_MCP_FILE_TRANSFER_RESULT_TTL_MS', 24 * 60 * 60 * 1000);
const SYNC_ASK_DEFAULT_TIMEOUT_MS = 300000;
const SYNC_ASK_MAX_TIMEOUT_MS = 600000;
const DETACHED_ASK_DEFAULT_TIMEOUT_MS = envPositiveNumber('ONESHELL_MCP_DETACHED_ASK_TIMEOUT_MS', 60 * 60 * 1000);
const DETACHED_ASK_MAX_TIMEOUT_MS = envPositiveNumber('ONESHELL_MCP_DETACHED_ASK_MAX_TIMEOUT_MS', 6 * 60 * 60 * 1000);
const DETACHED_ASK_RESULT_TTL_MS = envPositiveNumber('ONESHELL_MCP_DETACHED_ASK_RESULT_TTL_MS', 24 * 60 * 60 * 1000);
const HOST_EXEC_SYNC_DEFAULT_TIMEOUT_MS = 30000;
const HOST_EXEC_BACKGROUND_THRESHOLD_MS = envPositiveNumber('ONESHELL_MCP_HOST_EXEC_BACKGROUND_THRESHOLD_MS', 90000);
const HOST_EXEC_DETACHED_DEFAULT_TIMEOUT_MS = envPositiveNumber('ONESHELL_MCP_HOST_EXEC_DETACHED_TIMEOUT_MS', 60 * 60 * 1000);
const HOST_EXEC_DETACHED_MAX_TIMEOUT_MS = envPositiveNumber('ONESHELL_MCP_HOST_EXEC_DETACHED_MAX_TIMEOUT_MS', 6 * 60 * 60 * 1000);
const HOST_EXEC_RESULT_TTL_MS = envPositiveNumber('ONESHELL_MCP_HOST_EXEC_RESULT_TTL_MS', 24 * 60 * 60 * 1000);

function commandHasTruncationMarker(command) {
  const text = String(command || '');
  return text.includes('\u2026') || /\[truncated(?:\s+\d+\s+chars)?\]/i.test(text);
}

function normalizeHostForTool(host = {}) {
  const type = String(host.type || 'ssh').trim() || 'ssh';
  const id = String(host.id || '').trim();
  const name = String(host.name || id || '').trim();
  const hostAddress = type === 'local' ? '127.0.0.1' : String(host.host || '127.0.0.1').trim();
  const port = type === 'local' ? null : (Number(host.port) || 22);
  return {
    id,
    name,
    host: hostAddress,
    port,
    address: port ? `${hostAddress}:${port}` : hostAddress,
    type,
  };
}

const EXEC_SCHEMA = {
  type: 'object',
  properties: {
    hostId: { type: 'string', description: '目标主机 ID（可通过 list_hosts 获取）' },
    command: { type: 'string', description: '要执行的非交互式 shell 命令' },
    timeout: { type: 'number', description: '命令执行超时毫秒数，默认 30000' },
    background: { type: 'boolean', description: 'true 时立即返回 runId，命令在后台继续运行' },
    async: { type: 'boolean', description: 'background 的别名' },
    wait: { type: 'boolean', description: 'false 等同 background=true；true 强制同步等待' },
  },
  required: ['hostId', 'command'],
};

const TOOL_DEFS = [
  {
    name: 'host_exec',
    targets: ['mcp'],
    description: '在 1Shell 已配置的主机上执行非交互式命令。长耗时 MCP 命令会返回 runId 并在后台继续运行，可用 get_host_exec_run 轮询。',
    schema: EXEC_SCHEMA,
  },
  {
    name: 'get_host_exec_run',
    targets: ['mcp'],
    description: '查询 host_exec background=true 启动的后台命令状态和最终 stdout/stderr/exitCode。',
    schema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'host_exec 返回的 runId' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'execute_command',
    targets: ['ide'],
    description: '在指定主机上执行非交互式 shell 命令。包管理器加 -y；长耗时命令把 timeout 设大；禁止在命令里用 ssh/scp。',
    schema: EXEC_SCHEMA,
  },
  {
    name: 'list_hosts',
    targets: ['mcp', 'ide'],
    description: '列出 1Shell 中所有已托管主机，返回 id / name / host / port / type。',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ask_1shell_ai',
    targets: ['mcp'],
    description: '把复杂运维、监控、脚本、审计或诊断目标委托给 1Shell AI，由它在内部选择合适工具并返回结果摘要。长任务请传 background=true，然后用 get_1shell_ai_run 查询结果，避免单次 MCP 请求断开导致等待失败。',
    schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '要交给 1Shell AI 完成的问题、目标或诊断目标' },
        hostId: { type: 'string', description: '可选的目标主机 ID，用于限定目标范围' },
        mode: { type: 'string', enum: ['answer', 'plan', 'execute'], description: '执行模式：answer 只回答，plan 只制定计划，execute 可执行必要动作；默认 answer' },
        requireConfirmation: { type: 'boolean', description: '是否要求 1Shell AI 在变更型动作前走确认；默认 true' },
        timeoutMs: { type: 'number', description: '等待 1Shell AI 完成的超时时间；同步默认 300000 最大 600000，后台默认 3600000 最大 21600000' },
        background: { type: 'boolean', description: 'true 时立即返回 runId，1Shell AI 在后台继续运行' },
        async: { type: 'boolean', description: 'background 的别名；true 时后台运行' },
        wait: { type: 'boolean', description: 'false 时等同 background=true' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'get_1shell_ai_run',
    targets: ['mcp'],
    description: '查询 ask_1shell_ai background=true 启动的后台运行状态和最终结果。',
    schema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'ask_1shell_ai 返回的 runId' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'list_scripts',
    targets: ['mcp', 'ide'],
    description: '列出 1Shell 脚本库中的脚本。返回 id / name / description / category / tags。',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '按分类过滤（可选）' },
        keyword: { type: 'string', description: '关键词搜索（可选）' },
      },
      required: [],
    },
  },
  {
    name: 'run_script',
    targets: ['mcp', 'ide'],
    description: '在指定主机上运行一个已有脚本。复用脚本服务的参数校验、风险确认、执行记录和审计。',
    schema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: '脚本 ID' },
        hostId: { type: 'string', description: '目标主机 ID' },
        params: { type: 'object', description: '脚本参数键值对（可选）' },
        timeout: { type: 'number', description: '超时毫秒，默认 60000' },
        confirmed: { type: 'boolean', description: '脚本需要确认或标记 danger 时必须为 true' },
      },
      required: ['scriptId', 'hostId'],
    },
  },
  {
    name: 'list_remote_dir',
    targets: ['mcp', 'ide'],
    description: '列出指定主机上的目录内容，返回路径、父目录、文件/目录名、大小和 mtime。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '目录路径，默认主目录或当前目录' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'read_remote_file',
    targets: ['mcp', 'ide'],
    description: '读取指定主机上的文本文件内容。默认最大 512KB，可用 maxBytes 调整。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '文件路径' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 524288' },
      },
      required: ['hostId', 'path'],
    },
  },
  {
    name: 'write_remote_file',
    targets: ['mcp', 'ide'],
    description: `写入指定主机上的小型文本文件。content 上限 ${TEXT_WRITE_MAX_BYTES} bytes；大文件请使用 upload_file localPath 或分片上传工具。可设置 backup=true 在覆盖前写一份同目录 .1shell-backup 备份。`,
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整文件内容（UTF-8）' },
        backup: { type: 'boolean', description: '覆盖前是否备份原文件，默认 false' },
      },
      required: ['hostId', 'path', 'content'],
    },
  },
  {
    name: 'upload_file',
    targets: ['mcp', 'ide'],
    description: `把 1Shell 本机文件或小内容上传到指定主机目录。localPath 相对 1Shell 根目录或绝对路径并走流式上传；content/base64Content 仅适合小文件，上限 ${INLINE_UPLOAD_MAX_BYTES} bytes。外部 MCP 客户端上传大文件请使用 start_file_upload/append_file_upload/finish_file_upload 分片流程。`,
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        dirPath: { type: 'string', description: '目标目录路径' },
        filename: { type: 'string', description: '目标文件名；localPath 模式默认取源文件名' },
        localPath: { type: 'string', description: '1Shell 本机源文件路径，相对项目根目录或绝对路径' },
        content: { type: 'string', description: '直接上传的 UTF-8 文本内容' },
        base64Content: { type: 'string', description: '直接上传的 base64 内容' },
      },
      required: ['hostId', 'dirPath'],
    },
  },
  {
    name: 'start_file_upload',
    targets: ['mcp'],
    description: '为外部 MCP 客户端创建大文件分片上传会话。随后用 append_file_upload 逐块传 base64，最后 finish_file_upload 流式写入目标主机。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        dirPath: { type: 'string', description: '目标目录路径' },
        filename: { type: 'string', description: '目标文件名' },
        size: { type: 'number', description: '可选，总字节数；超过服务器上限会被拒绝' },
      },
      required: ['hostId', 'dirPath', 'filename'],
    },
  },
  {
    name: 'append_file_upload',
    targets: ['mcp'],
    description: `向分片上传会话追加一个 base64 分片。单个分片解码后上限 ${UPLOAD_CHUNK_MAX_BYTES} bytes；offset 必须等于服务端返回的 nextOffset。`,
    schema: {
      type: 'object',
      properties: {
        uploadId: { type: 'string', description: 'start_file_upload 返回的 uploadId' },
        offset: { type: 'number', description: '本分片起始字节偏移，必须等于上次返回的 nextOffset' },
        base64Content: { type: 'string', description: '本分片的 base64 内容' },
      },
      required: ['uploadId', 'offset', 'base64Content'],
    },
  },
  {
    name: 'finish_file_upload',
    targets: ['mcp'],
    description: '完成分片上传。MCP 调用默认启动后台传输并返回 transferId；用 get_file_transfer 查询进度和结果。',
    schema: {
      type: 'object',
      properties: {
        uploadId: { type: 'string', description: 'start_file_upload 返回的 uploadId' },
        background: { type: 'boolean', description: 'true 时启动后台传输并返回 transferId' },
        async: { type: 'boolean', description: 'background 的别名' },
        wait: { type: 'boolean', description: 'true 强制同步上传；false 启动后台传输' },
      },
      required: ['uploadId'],
    },
  },
  {
    name: 'cancel_file_upload',
    targets: ['mcp'],
    description: '取消分片上传会话并删除本地暂存文件。',
    schema: {
      type: 'object',
      properties: {
        uploadId: { type: 'string', description: 'start_file_upload 返回的 uploadId' },
      },
      required: ['uploadId'],
    },
  },
  {
    name: 'start_file_download',
    targets: ['mcp'],
    description: 'Start a background file download. Data is staged outside the final path, supports progress, resume, sha256 verification, and commits to localPath only after validation.',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: 'Source host ID; local means this machine' },
        path: { type: 'string', description: 'Source file path' },
        localPath: { type: 'string', description: 'Destination path on the 1Shell machine, relative to project root or absolute' },
        expectedSha256: { type: 'string', description: 'Optional expected sha256 before commit' },
        sha256: { type: 'string', description: 'Alias of expectedSha256' },
      },
      required: ['hostId', 'path', 'localPath'],
    },
  },
  {
    name: 'get_file_transfer',
    targets: ['mcp'],
    description: 'Get status, progress, checksum, error, and final path for a background file transfer.',
    schema: {
      type: 'object',
      properties: {
        transferId: { type: 'string', description: 'transferId returned by start_file_download' },
      },
      required: ['transferId'],
    },
  },
  {
    name: 'resume_file_transfer',
    targets: ['mcp'],
    description: 'Resume a failed background download from the staged partial file offset.',
    schema: {
      type: 'object',
      properties: {
        transferId: { type: 'string', description: 'transferId returned by start_file_download' },
      },
      required: ['transferId'],
    },
  },
  {
    name: 'cancel_file_transfer',
    targets: ['mcp'],
    description: 'Cancel a background file transfer and clean uncommitted staged data.',
    schema: {
      type: 'object',
      properties: {
        transferId: { type: 'string', description: 'transferId returned by start_file_download' },
      },
      required: ['transferId'],
    },
  },
  {
    name: 'download_file',
    targets: ['mcp', 'ide'],
    description: '从指定主机下载文件。MCP 调用传 localPath 时默认启动后台传输并返回 transferId；不传 localPath 时仅小文件以内联 base64 返回。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '源主机 ID，local 表示本机' },
        path: { type: 'string', description: '源文件路径' },
        localPath: { type: 'string', description: '保存到 1Shell 本机的路径，相对项目根目录或绝对路径（可选）' },
        maxBytes: { type: 'number', description: '不传 localPath 时允许返回的最大字节数，默认 1048576' },
        expectedSha256: { type: 'string', description: '提交到 localPath 前校验的 sha256（可选）' },
        sha256: { type: 'string', description: 'expectedSha256 的别名' },
        background: { type: 'boolean', description: 'true 时启动后台传输并返回 transferId' },
        async: { type: 'boolean', description: 'background 的别名' },
        wait: { type: 'boolean', description: 'true 强制同步下载；false 启动后台传输' },
      },
      required: ['hostId', 'path'],
    },
  },
  {
    name: 'create_directory',
    targets: ['mcp', 'ide'],
    description: '在指定主机上创建目录（递归创建缺失的父目录）。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '要创建的目录路径' },
      },
      required: ['hostId', 'path'],
    },
  },
  {
    name: 'delete_path',
    targets: ['mcp', 'ide'],
    description: '删除指定主机上的文件或目录（目录递归删除）。操作不可恢复，禁止用于根目录。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '要删除的文件或目录路径' },
      },
      required: ['hostId', 'path'],
    },
  },
  {
    name: 'rename_path',
    targets: ['mcp', 'ide'],
    description: '重命名（或移动）指定主机上的文件或目录。目标路径已存在时拒绝执行。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID，local 表示本机' },
        path: { type: 'string', description: '原路径' },
        newPath: { type: 'string', description: '新路径' },
      },
      required: ['hostId', 'path', 'newPath'],
    },
  },
  {
    name: 'list_mcp_servers',
    targets: ['mcp', 'ide'],
    description: '列出 1Shell MCP Server 仓库中已登记的所有 MCP Server。返回 id / name / url / command / description。',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_mcp_server',
    targets: ['mcp', 'ide'],
    description: '向 1Shell MCP Server 仓库添加一个远程或本地 MCP Server。远程 url 必须为 http(s)://，本地必须提供 command。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'MCP 名称' },
        url: { type: 'string', description: '远程 MCP Server URL（http(s)://...）' },
        command: { type: 'string', description: '本地 MCP 启动命令（可选）' },
        installDir: { type: 'string', description: '本地 MCP 工作目录（可选）' },
        description: { type: 'string', description: '简要描述' },
        authToken: { type: 'string', description: '认证 token（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
        autoStart: { type: 'boolean', description: '服务启动时是否自动启动本地 MCP，默认 false' },
        exposeToIde: { type: 'boolean', description: '是否暴露给 1Shell IDE AI，默认 true' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_mcp_server',
    targets: ['mcp', 'ide'],
    description: '从 1Shell MCP Server 仓库中删除一个 MCP Server，并停止同名本地 MCP（如正在运行）。',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的 MCP Server ID' } },
      required: ['id'],
    },
  },
  {
    name: 'deploy_local_mcp',
    targets: ['mcp', 'ide'],
    description: '从 GitHub 仓库部署一个本地 MCP Server：git clone/pull → npm install → 注册到 1Shell 仓库。',
    schema: {
      type: 'object',
      properties: {
        repoUrl: { type: 'string', description: 'GitHub 仓库 URL' },
        name: { type: 'string', description: 'MCP 名称' },
        command: { type: 'string', description: '启动命令，如 node dist/index.js' },
        description: { type: 'string', description: '简要描述' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
        autoStart: { type: 'boolean', description: '服务启动时是否自动启动，默认 false' },
        exposeToIde: { type: 'boolean', description: '是否暴露给 1Shell AI，默认 true' },
      },
      required: ['repoUrl', 'name', 'command'],
    },
  },
  {
    name: 'query_audit',
    targets: ['mcp', 'ide'],
    description: '查询 1Shell 审计日志。可按 action / source / hostId / keyword 过滤。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 30，最多 200' },
        offset: { type: 'number', description: '偏移量，默认 0' },
        action: { type: 'string', description: '按 action 过滤（可选）' },
        source: { type: 'string', description: '按 source 过滤（可选）' },
        hostId: { type: 'string', description: '按主机 ID 过滤（可选）' },
        keyword: { type: 'string', description: '关键词搜索（可选）' },
      },
      required: [],
    },
  },
  {
    name: 'query_probe',
    targets: ['ide'],
    description: '获取所有主机的探针监控数据快照。兼容旧 IDE 工具；新调用建议使用 list_probes。',
    schema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '是否强制刷新（默认 false）' } },
      required: [],
    },
  },
  {
    name: 'list_probes',
    targets: ['mcp', 'ide'],
    description: '获取所有主机的探针监控快照，包含在线状态、CPU、内存、磁盘、网络、系统内部体检(systemHealth)、Agent 状态和流量摘要。',
    schema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '是否强制刷新（默认 false，优先使用缓存）' } },
      required: [],
    },
  },
  {
    name: 'get_probe',
    targets: ['mcp', 'ide'],
    description: '获取单台主机的探针监控快照，返回硬件指标和系统内部体检(systemHealth：端口、TCP 连接、僵尸进程、失败服务、错误日志、防火墙和系统安全状态)。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 ID' },
        refresh: { type: 'boolean', description: '是否强制刷新（默认 false）' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'get_probe_samples',
    targets: ['mcp', 'ide'],
    description: '读取单台主机最近一段时间的原始探针样本（最多 24 小时）。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 ID' },
        minutes: { type: 'number', description: '回看分钟数，默认 60，最多 1440' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'get_probe_timeseries',
    targets: ['mcp', 'ide'],
    description: '读取单台主机聚合后的探针时序数据，支持 auto/1m/1h/1d 分辨率。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 ID' },
        fromMs: { type: 'number', description: '开始时间戳毫秒；默认 24 小时前' },
        toMs: { type: 'number', description: '结束时间戳毫秒；默认当前时间' },
        resolution: { type: 'string', enum: ['auto', '1m', '1h', '1d'], description: '分辨率，默认 auto' },
      },
      required: ['hostId'],
    },
  },
  {
    name: 'get_probe_traffic',
    targets: ['mcp', 'ide'],
    description: '获取单台主机的月度流量详情，包括 hs/ds/ms 滚动 buffer、配额、阈值和校准信息。',
    schema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '主机 ID' } },
      required: ['hostId'],
    },
  },
  {
    name: 'list_probe_alerts',
    targets: ['mcp', 'ide'],
    description: '列出探针告警事件，可查看 open/firing/all。',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'firing', 'all'], description: '事件状态，默认 open' },
        limit: { type: 'number', description: '返回条数，默认 50' },
        offset: { type: 'number', description: '偏移量，默认 0' },
      },
      required: [],
    },
  },
  {
    name: 'ack_probe_alert',
    targets: ['mcp', 'ide'],
    description: '忽略一个或全部当前打开的探针告警事件。',
    schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: '告警事件 ID；ackAll=false 时必填' },
        ackAll: { type: 'boolean', description: '是否忽略全部打开告警' },
      },
      required: [],
    },
  },
  {
    name: 'install_probe_agent',
    targets: ['mcp', 'ide'],
    description: '通过 1Shell SSH 通道在目标 VPS 安装或升级 probe-agent，并执行真实校验闭环。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        serverUrl: { type: 'string', description: 'Agent 回连 1Shell 或 Relay 的可达 URL' },
        intervalSec: { type: 'number', description: '上报间隔秒数（可选）' },
        relayUpstreamId: { type: 'string', description: 'Relay 上游 ID（可选）' },
      },
      required: ['hostId', 'serverUrl'],
    },
  },
  {
    name: 'restart_probe_agent',
    targets: ['mcp', 'ide'],
    description: '通过 1Shell SSH 通道重启目标主机上的 probe-agent，并重新拉取最新二进制后校验状态。',
    schema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '目标主机 ID' } },
      required: ['hostId'],
    },
  },
  {
    name: 'uninstall_probe_agent',
    targets: ['mcp', 'ide'],
    description: '通过 1Shell SSH 通道卸载目标主机上的 probe-agent，并确认服务、进程和文件残留已清理。',
    schema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '目标主机 ID' } },
      required: ['hostId'],
    },
  },
  {
    name: 'probe_diag_ping',
    targets: ['mcp', 'ide'],
    description: '在指定主机上执行 Ping 诊断。目标参数由 probe-diag 服务白名单校验并写审计。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        target: { type: 'string', description: '目标域名或 IP' },
        count: { type: 'number', description: 'ping 次数，默认 4' },
        timeoutSec: { type: 'number', description: '单次超时秒数，默认 3' },
      },
      required: ['hostId', 'target'],
    },
  },
  {
    name: 'probe_diag_http',
    targets: ['mcp', 'ide'],
    description: '在指定主机上执行 HTTP 诊断，返回状态码和 DNS/连接/首包/总耗时。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        url: { type: 'string', description: 'http(s) URL' },
        method: { type: 'string', enum: ['GET', 'HEAD'], description: '请求方法，默认 GET' },
        timeoutSec: { type: 'number', description: '超时秒数，默认 10' },
      },
      required: ['hostId', 'url'],
    },
  },
  {
    name: 'probe_diag_dns',
    targets: ['mcp', 'ide'],
    description: '在指定主机上执行 DNS 解析诊断。',
    schema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '目标主机 ID' },
        name: { type: 'string', description: '待解析域名' },
      },
      required: ['hostId', 'name'],
    },
  },
];

function createOneShellCoreTools(deps = {}) {
  const toolMap = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));
  const aiRuns = new Map();
  const hostExecRuns = new Map();
  const uploadSessions = new Map();
  const fileTransfers = new Map();

  const IN_DOCKER = process.env.ONESHELL_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  const READONLY_MOUNT_HINT = [
    '',
    '[1Shell 提示] 1Shell 当前运行在 Docker 容器内，本次 local 命令操作的是容器视角的文件系统，目标路径可能是 :ro 只读挂载（如 /opt/1panel、/www、/etc/nginx）。可选处理：',
    '1. 推荐：把这台 VPS 以 SSH 主机方式添加到 1Shell（主机仓库 → 添加主机），通过主机视角操作宿主机文件；',
    '2. 把 docker-compose.yml 中对应目录挂载从 :ro 改为 :rw 后重启容器；',
    '3. 通过 docker exec 在目标容器或宿主机内执行修改。',
  ].join('\n');

  // 容器内 local 命令因只读挂载/权限失败时，附加可行动提示（确定性，执行层）
  function withReadonlyMountHint(hostId, result) {
    if (hostId !== 'local' || !IN_DOCKER || !result || result.exitCode === 0) return result;
    const text = `${result.stderr || ''}\n${result.stdout || ''}`;
    if (!/read-only file system|permission denied|operation not permitted|EROFS|EACCES|EPERM/i.test(text)) return result;
    return { ...result, stderr: `${result.stderr || ''}${READONLY_MOUNT_HINT}` };
  }

  function isToolExposed(name, target) {
    const tool = toolMap.get(name);
    if (!tool || !tool.targets.includes(target)) return false;
  if (target === 'mcp') return MCP_STANDARD_TOOL_SET.has(name);
    return true;
  }

  function getToolSchemas(target) {
    return TOOL_DEFS
      .filter((tool) => isToolExposed(tool.name, target))
      .map((tool) => target === 'mcp'
        ? { name: tool.name, description: tool.description, inputSchema: tool.schema }
        : { name: tool.name, description: tool.description, input_schema: tool.schema });
  }

  async function handle(name, input = {}, context = {}) {
    if (!toolMap.has(name)) return err(`未知工具: ${name}`);

    switch (name) {
      case 'host_exec':
      case 'execute_command':
        return handleExec(input, context);
      case 'get_host_exec_run':
        return handleGetHostExecRun(input);
      case 'list_hosts':
        return handleListHosts(context);
      case 'ask_1shell_ai':
        return handleAskOneShellAi(input, context);
      case 'get_1shell_ai_run':
        return handleGetOneShellAiRun(input);
      case 'list_scripts':
        return handleListScripts(input);
      case 'run_script':
        return handleRunScript(input, context);
      case 'list_remote_dir':
        return handleListRemoteDir(input);
      case 'read_remote_file':
        return handleReadRemoteFile(input);
      case 'write_remote_file':
        return handleWriteRemoteFile(input, context);
      case 'upload_file':
        return handleUploadFile(input, context);
      case 'start_file_upload':
        return handleStartFileUpload(input, context);
      case 'append_file_upload':
        return handleAppendFileUpload(input, context);
      case 'finish_file_upload':
        return handleFinishFileUpload(input, context);
      case 'cancel_file_upload':
        return handleCancelFileUpload(input, context);
      case 'start_file_download':
        return handleStartFileDownload(input, context);
      case 'get_file_transfer':
        return handleGetFileTransfer(input);
      case 'resume_file_transfer':
        return handleResumeFileTransfer(input, context);
      case 'cancel_file_transfer':
        return handleCancelFileTransfer(input, context);
      case 'download_file':
        return handleDownloadFile(input, context);
      case 'create_directory':
        return handleCreateDirectory(input, context);
      case 'delete_path':
        return handleDeletePath(input, context);
      case 'rename_path':
        return handleRenamePath(input, context);
      case 'list_mcp_servers':
        return handleListMcpServers();
      case 'add_mcp_server':
        return handleAddMcpServer(input);
      case 'remove_mcp_server':
        return handleRemoveMcpServer(input);
      case 'deploy_local_mcp':
        return handleDeployLocalMcp(input);
      case 'query_audit':
        return handleQueryAudit(input);
      case 'query_probe':
      case 'list_probes':
        return handleListProbes(input);
      case 'get_probe':
        return handleGetProbe(input);
      case 'get_probe_samples':
        return handleGetProbeSamples(input);
      case 'get_probe_timeseries':
        return handleGetProbeTimeseries(input);
      case 'get_probe_traffic':
        return handleGetProbeTraffic(input);
      case 'list_probe_alerts':
        return handleListProbeAlerts(input);
      case 'ack_probe_alert':
        return handleAckProbeAlert(input, context);
      case 'install_probe_agent':
        return handleInstallProbeAgent(input, context);
      case 'restart_probe_agent':
        return handleRestartProbeAgent(input, context);
      case 'uninstall_probe_agent':
        return handleUninstallProbeAgent(input, context);
      case 'probe_diag_ping':
        return handleProbeDiag('ping', input, context);
      case 'probe_diag_http':
        return handleProbeDiag('http', input, context);
      case 'probe_diag_dns':
        return handleProbeDiag('dns', input, context);
      default:
        return err(`未知工具: ${name}`);
    }
  }

  function normalizeHostExecTimeout(input, background = false) {
    const raw = Number(input.timeout);
    if (raw > 0) {
      return background ? Math.min(raw, HOST_EXEC_DETACHED_MAX_TIMEOUT_MS) : raw;
    }
    return background ? HOST_EXEC_DETACHED_DEFAULT_TIMEOUT_MS : HOST_EXEC_SYNC_DEFAULT_TIMEOUT_MS;
  }

  function shouldRunHostExecInBackground(input, context, timeout) {
    if (input.background === true || input.async === true || input.wait === false) return true;
    if (input.wait === true) return false;
    return context.source === 'mcp' && timeout > HOST_EXEC_BACKGROUND_THRESHOLD_MS;
  }

  function publicHostExecRun(run) {
    return {
      runId: run.runId,
      status: run.status,
      hostId: run.hostId,
      command: run.command,
      timeout: run.timeout,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt || null,
      stdout: run.stdout || '',
      stderr: run.stderr || '',
      exitCode: run.exitCode,
      durationMs: run.durationMs || 0,
      outputDiagnostics: run.outputDiagnostics || null,
      error: run.error || null,
      pollTool: 'get_host_exec_run',
    };
  }

  function pruneHostExecRuns() {
    const now = Date.now();
    for (const [runId, run] of hostExecRuns) {
      if (!run.finishedAtMs) continue;
      if (now - run.finishedAtMs > HOST_EXEC_RESULT_TTL_MS) hostExecRuns.delete(runId);
    }
  }

  function parseStructuredExecResult(result) {
    const content = String(result?.content || '');
    if (content.startsWith('[ERROR] ')) {
      const message = content.slice(8);
      return { ok: false, summary: message, data: {}, error: message };
    }
    try {
      const parsed = JSON.parse(content);
      const failed = parsed.ok === false || result?.is_error === true;
      return {
        ok: !failed,
        summary: parsed.summary || '',
        data: parsed.data || {},
        error: failed ? (parsed.summary || 'host_exec failed') : null,
      };
    } catch {
      return { ok: result?.is_error !== true, summary: content, data: {}, error: result?.is_error ? content : null };
    }
  }

  function startHostExecRun({ hostId, command, timeout }, context = {}) {
    pruneHostExecRuns();
    const runId = createRuntimeId('host-exec');
    const now = new Date().toISOString();
    const run = {
      runId,
      status: 'running',
      hostId,
      command,
      timeout,
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 0,
      outputDiagnostics: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      finishedAtMs: 0,
    };
    hostExecRuns.set(runId, run);

    const detachedContext = {
      ...context,
      runId,
      signal: undefined,
      socket: undefined,
      onToolDelta: undefined,
      onOutput: undefined,
      requestApproval: undefined,
      allowApproval: false,
    };

    void executeHostCommand({ hostId, command, timeout }, detachedContext)
      .then((result) => {
        const parsed = parseStructuredExecResult(result);
        const data = parsed.data || {};
        run.status = parsed.ok ? 'succeeded' : 'failed';
        run.stdout = data.stdout || '';
        run.stderr = data.stderr || '';
        run.exitCode = Number.isFinite(Number(data.exitCode)) ? Number(data.exitCode) : (parsed.ok ? 0 : 1);
        run.durationMs = Number(data.durationMs) || 0;
        run.outputDiagnostics = data.outputDiagnostics || null;
        run.error = parsed.error || null;
        run.updatedAt = new Date().toISOString();
        run.finishedAt = run.updatedAt;
        run.finishedAtMs = Date.now();
      })
      .catch((error) => {
        run.status = 'failed';
        run.error = error?.message || 'host_exec failed';
        run.exitCode = 1;
        run.updatedAt = new Date().toISOString();
        run.finishedAt = run.updatedAt;
        run.finishedAtMs = Date.now();
      });

    return run;
  }

  async function handleExec(input, context) {
    const hostId = String(input.hostId || '').trim();
    const command = String(input.command || '').trim();
    const initialTimeout = normalizeHostExecTimeout(input, input.background === true || input.async === true || input.wait === false);
    const background = shouldRunHostExecInBackground(input, context, initialTimeout);
    const timeout = normalizeHostExecTimeout(input, background);
    if (commandHasTruncationMarker(command)) return err('命令疑似被摘要截断（包含省略号或 [truncated] 标记），请重新生成完整命令后再执行。');
    if (!hostId || !command) return err('hostId 和 command 为必填');
    if (background) {
      const run = startHostExecRun({ hostId, command, timeout }, context);
      return structured(true, 'host_exec started in background', publicHostExecRun(run));
    }
    return executeHostCommand({ hostId, command, timeout }, context);
  }

  function handleGetHostExecRun(input) {
    pruneHostExecRuns();
    const runId = String(input.runId || '').trim();
    if (!runId) return err('runId is required');
    const run = hostExecRuns.get(runId);
    if (!run) return err(`host_exec run not found or expired: ${runId}`);
    return structured(run.status !== 'failed', run.status === 'running' ? 'host_exec is running' : 'host_exec status', publicHostExecRun(run), run.status === 'failed');
  }

  async function executeHostCommand(input, context) {
    const hostId = String(input.hostId || '').trim();
    const command = String(input.command || '').trim();
    const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : 30000;
    if (commandHasTruncationMarker(command)) return err('命令疑似被摘要截断（包含省略号或 [truncated] 标记），请重新生成完整命令后再执行。');
    if (!hostId || !command) return err('hostId 和 command 为必填');
    const onOutput = typeof context.onToolDelta === 'function' ? context.onToolDelta : context.onOutput;

    // 经 harness 统一边界执行：guard → 人审 gate → 执行 → 打码 → 轨迹。
    // IDE 是人在场路径，risk-rules 的 approval 动作接入 IDE 审批弹窗；外部 Agent 路径保持无人审。
    if (deps.harness?.dispatch) {
      try {
        const canRequestApproval = context.allowApproval !== false && context.source === 'ide' && typeof context.requestApproval === 'function';
        const ctx = deps.harness.buildContext(context.source === 'mcp' ? 'mcp' : (context.source || 'core'), {
          hostId,
          allowApproval: canRequestApproval,
          approvalGranted: context.approvalGranted === true || context.preApproved === true,
          preApproved: context.preApproved === true,
          approvalMode: context.approvalMode || '',
          requestApproval: canRequestApproval ? context.requestApproval : undefined,
          runId: context.runId,
          sessionId: context.sessionId,
          signal: context.signal,
          onOutput,
        });
        const dispatched = await deps.harness.dispatch('execute_command', { command, hostId, timeout }, ctx);
        if (!dispatched.raw) {
          // 被 harness 拦截（无底层结果）
          emitTool(context, 'execute_command', { hostId, command }, { stdout: '', stderr: dispatched.content, exitCode: 126, durationMs: 0 });
          return err(dispatched.content);
        }
        const r = withOutputDiagnostics(withReadonlyMountHint(hostId, dispatched.raw), { timeout });
        emitTool(context, 'execute_command', { hostId, command }, r);
        const okRun = r.exitCode === 0;
        return structured(okRun, okRun ? '命令执行成功' : `命令执行失败，exitCode=${r.exitCode}`, {
          hostId, command, timeout,
          stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode, durationMs: r.durationMs || 0,
          outputDiagnostics: r.outputDiagnostics,
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
          ...(r.interactivePromptDetected === true ? { interactivePromptDetected: true } : {}),
        }, !okRun);
      } catch (e) {
        if (e?.name === 'AbortError' || e?.code === 'CANCELLED') throw e;
        if (hasExecutionErrorContext(e)) {
          const r = withOutputDiagnostics(withReadonlyMountHint(hostId, executionErrorToResult(e)), { timeout });
          emitTool(context, 'execute_command', { hostId, command }, r);
          return structured(false, `命令执行失败：${e.message || 'execution failed'}`, {
            hostId, command, timeout,
            stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode, durationMs: r.durationMs || 0,
            outputDiagnostics: r.outputDiagnostics,
            ...(r.errorCode ? { errorCode: r.errorCode } : {}),
            ...(r.interactivePromptDetected === true ? { interactivePromptDetected: true } : {}),
          }, true);
        }
        return err(e.message);
      }
    }

    // fallback：harness 未注入时保持旧路径
    try {
      if (hostId !== 'local' && !deps.bridgeService) return err('bridgeService 未初始化');
      const rawResult = hostId === 'local'
        ? await execLocal(command, timeout, { signal: context.signal, onOutput })
        : await deps.bridgeService.execOnHost(hostId, command, timeout, { source: context.source || 'core_tools', signal: context.signal, onOutput });
      const result = withOutputDiagnostics(withReadonlyMountHint(hostId, rawResult), { timeout });
      emitTool(context, 'execute_command', { hostId, command }, result);
      const okRun = result.exitCode === 0;
      return structured(okRun, okRun ? '命令执行成功' : `命令执行失败，exitCode=${result.exitCode}`, {
        hostId,
        command,
        timeout,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs || 0,
        outputDiagnostics: result.outputDiagnostics,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.interactivePromptDetected === true ? { interactivePromptDetected: true } : {}),
      }, !okRun);
    } catch (e) {
      if (e?.name === 'AbortError' || e?.code === 'CANCELLED') throw e;
      if (hasExecutionErrorContext(e)) {
        const result = withOutputDiagnostics(withReadonlyMountHint(hostId, executionErrorToResult(e)), { timeout });
        emitTool(context, 'execute_command', { hostId, command }, result);
        return structured(false, `命令执行失败：${e.message || 'execution failed'}`, {
          hostId,
          command,
          timeout,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: result.exitCode,
          durationMs: result.durationMs || 0,
          outputDiagnostics: result.outputDiagnostics,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.interactivePromptDetected === true ? { interactivePromptDetected: true } : {}),
        }, true);
      }
      return err(e.message);
    }
  }

  function handleListHosts(context = {}) {
    const allowedHosts = Array.isArray(context.allowedHosts) ? context.allowedHosts : [];
    const hosts = (deps.hostService?.listHosts?.() || [])
      .filter((h) => context.exposure !== 'remote' || allowedHosts.length === 0 || allowedHosts.includes('*') || allowedHosts.includes(h.id))
      .map(normalizeHostForTool)
      .filter((h) => h.id);
    return structured(true, hosts.length > 0 ? '主机列表读取成功' : '无允许访问的主机', { hosts });
  }

  function normalizeAskTimeout(input, background = false) {
    const raw = Number(input.timeoutMs);
    const fallback = background ? DETACHED_ASK_DEFAULT_TIMEOUT_MS : SYNC_ASK_DEFAULT_TIMEOUT_MS;
    const max = background ? DETACHED_ASK_MAX_TIMEOUT_MS : SYNC_ASK_MAX_TIMEOUT_MS;
    return raw > 0 ? Math.min(raw, max) : Math.min(fallback, max);
  }

  function pruneAiRuns() {
    const now = Date.now();
    for (const [runId, run] of aiRuns) {
      if (!run.finishedAtMs) continue;
      if (now - run.finishedAtMs > DETACHED_ASK_RESULT_TTL_MS) aiRuns.delete(runId);
    }
  }

  function publicAiRun(run) {
    const data = {
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      mode: run.mode,
      hostId: run.hostId || null,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt || null,
      timeoutMs: run.timeoutMs,
      goalPreview: run.goalPreview,
      response: run.result?.text || '',
      toolCalls: run.result?.toolCalls || [],
      error: run.error || null,
    };
    return data;
  }

  function startDetachedAiRun({ askPayload, mode, hostId, goal, timeoutMs }) {
    pruneAiRuns();
    const runId = createRuntimeId('ai-run');
    const sessionId = createRuntimeId('mcp-ai');
    const now = new Date().toISOString();
    const run = {
      runId,
      sessionId,
      status: 'running',
      mode,
      hostId: hostId || '',
      timeoutMs,
      goalPreview: String(goal || '').replace(/\s+/g, ' ').slice(0, 240),
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      finishedAtMs: 0,
      result: null,
      error: null,
    };
    aiRuns.set(runId, run);

    void deps.ideService.ask({ ...askPayload, sessionId, detached: true })
      .then((result) => {
        run.status = 'succeeded';
        run.result = { text: result.text || '', toolCalls: result.toolCalls || [], events: result.events || [] };
        run.updatedAt = new Date().toISOString();
        run.finishedAt = run.updatedAt;
        run.finishedAtMs = Date.now();
      })
      .catch((err) => {
        run.status = 'failed';
        run.error = err?.message || '1Shell AI 执行失败';
        run.updatedAt = new Date().toISOString();
        run.finishedAt = run.updatedAt;
        run.finishedAtMs = Date.now();
      });

    return run;
  }

  async function handleAskOneShellAi(input, context) {
    if (!deps.ideService?.ask) return err('1Shell AI gateway 未初始化');
    const goal = String(input.goal || '').trim();
    if (!goal) return err('goal 为必填');
    const mode = ['answer', 'plan', 'execute'].includes(input.mode) ? input.mode : 'answer';
    const hostId = String(input.hostId || '').trim();
    const requireConfirmation = input.requireConfirmation !== false;
    const background = input.background === true || input.async === true || input.wait === false;
    const timeoutMs = normalizeAskTimeout(input, background);
    const host = hostId && deps.hostService?.findHost ? deps.hostService.findHost(hostId) : null;
    const contextHosts = host ? [{
      id: host.id,
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      type: host.type,
      platform: host.platform || host.os,
    }] : (hostId ? [{ id: hostId }] : []);
    const guidance = [
      '[MCP_GATEWAY_REQUEST]',
      `mode=${mode}`,
      hostId ? `hostId=${hostId}` : '',
      'External MCP clients directly see only these tools: list_hosts, host_exec, get_host_exec_run, list_remote_dir, read_remote_file, write_remote_file, create_directory, delete_path, rename_path, upload_file, download_file, start_file_upload, append_file_upload, finish_file_upload, cancel_file_upload, start_file_download, get_file_transfer, resume_file_transfer, cancel_file_transfer, ask_1shell_ai, get_1shell_ai_run.',
      'Scripts, automations, probes, audit, diagnostics, and MCP registry operations are delegated capabilities behind ask_1shell_ai; do not describe them as directly visible external MCP tools.',
      requireConfirmation ? 'mutating actions require confirmation; if confirmation is unavailable, explain what would be done instead of forcing the action.' : 'the caller explicitly allowed execution without interactive confirmation.',
      mode === 'answer' ? 'Answer the request. Prefer read-only inspection and do not make changes.' : '',
      mode === 'plan' ? 'Produce a concrete plan. Do not make changes.' : '',
      mode === 'execute' ? 'Execute only the necessary actions and summarize exactly what changed.' : '',
      '',
      goal,
    ].filter(Boolean).join('\n');

    const askPayload = {
      message: guidance,
      context: {
        hosts: contextHosts,
        toolPolicy: {
          allowedTools: Array.isArray(context.allowedTools) ? context.allowedTools : [],
          allowedHosts: Array.isArray(context.allowedHosts) ? context.allowedHosts : [],
          allowedScripts: Array.isArray(context.allowedScripts) ? context.allowedScripts : [],
          allowedPaths: Array.isArray(context.allowedPaths) ? context.allowedPaths : [],
          gatewayMode: mode,
        },
      },
      entry: 'core',
      timeoutMs,
      approvalAction: requireConfirmation ? 'deny' : 'allow',
    };

    if (background) {
      const run = startDetachedAiRun({ askPayload, mode, hostId, goal, timeoutMs });
      return structured(true, '1Shell AI 后台运行已启动', {
        ...publicAiRun(run),
        pollTool: 'get_1shell_ai_run',
      });
    }

    try {
      const result = await deps.ideService.ask(askPayload);
      return structured(true, '1Shell AI 已完成请求', {
        mode,
        hostId: hostId || null,
        response: result.text || '',
        toolCalls: (result.toolCalls || []).map((item) => ({ name: item.name, input: item.input })),
      });
    } catch (e) {
      return err(e.message);
    }
  }

  function handleGetOneShellAiRun(input) {
    pruneAiRuns();
    const runId = String(input.runId || '').trim();
    if (!runId) return err('runId 为必填');
    const run = aiRuns.get(runId);
    if (!run) return err(`后台运行不存在或结果已过期: ${runId}`);
    return structured(run.status !== 'failed', run.status === 'running' ? '1Shell AI 仍在运行' : '1Shell AI 后台运行已结束', publicAiRun(run), run.status === 'failed');
  }

  function handleListScripts(input) {
    if (!deps.scriptService) return err('scriptService 未初始化');
    try {
      const scripts = deps.scriptService.listScripts({ category: input.category, keyword: input.keyword });
      if (scripts.length === 0) return ok('（脚本库为空）');
      return ok(scripts.map((s) =>
        `id=${s.id}  name="${s.name}"  category=${s.category || '-'}  tags=[${(s.tags || []).join(',')}]  ${s.description ? '— ' + s.description.slice(0, 80) : ''}`
      ).join('\n'));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleRunScript(input, context) {
    if (!deps.scriptService) return err('scriptService 未初始化');
    const scriptId = String(input.scriptId || '').trim();
    const hostId = String(input.hostId || '').trim();
    if (!scriptId || !hostId) return err('scriptId 和 hostId 为必填');
    try {
      const result = await deps.scriptService.runScript(scriptId, {
        hostId,
        params: input.params || {},
        confirmed: input.confirmed === true,
        timeoutMs: input.timeout || 60000,
        signal: context.signal,
      }, { clientIp: context.clientIp });
      const okRun = result.exitCode === 0;
      return structured(okRun, okRun ? '脚本执行成功' : `脚本执行失败，exitCode=${result.exitCode}`, {
        scriptId,
        hostId,
        runId: result.runId,
        status: result.status,
        renderedCommand: result.renderedCommand,
        warnings: result.warnings || [],
        params: input.params || {},
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs || 0,
      }, !okRun);
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleListRemoteDir(input) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      const result = await deps.fileService.listDir(hostId, input.path || '');
      return structured(true, '目录读取成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleReadRemoteFile(input) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    if (!hostId || !filePath) return err('hostId 和 path 为必填');
    try {
      const result = await deps.fileService.readFile(hostId, filePath, input.maxBytes);
      return structured(true, '文件读取成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleWriteRemoteFile(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    if (!hostId || !filePath) return err('hostId 和 path 为必填');
    if (typeof input.content !== 'string') return err('content 必须是字符串');
    const contentBytes = Buffer.byteLength(input.content, 'utf8');
    if (contentBytes > TEXT_WRITE_MAX_BYTES) {
      return err(`content 过大 (${formatBytes(contentBytes)})，write_remote_file 只用于小型文本/配置文件，当前上限 ${formatBytes(TEXT_WRITE_MAX_BYTES)}。请先把大文件放到 1Shell 本机后用 upload_file localPath，或使用 start_file_upload/append_file_upload/finish_file_upload 分片上传。`);
    }
    try {
      let backupPath = null;
      if (input.backup) {
        try {
          const old = await deps.fileService.readFile(hostId, filePath);
          backupPath = `${filePath}.1shell-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          await deps.fileService.writeFile(hostId, backupPath, old.content || '');
        } catch {
          backupPath = null;
        }
      }
      const result = await deps.fileService.writeFile(hostId, filePath, input.content);
      deps.auditService?.log?.({ action: 'mcp_file_write', source: context.source || 'core_tools', hostId, command: filePath, details: JSON.stringify({ size: result.size, backupPath }) });
      return structured(true, '文件写入成功', { hostId, backupPath, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleUploadFile(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const dirPath = String(input.dirPath || '').trim();
    if (!hostId || !dirPath) return err('hostId 和 dirPath 为必填');
    try {
      let filename = input.filename ? String(input.filename) : '';
      let buffer;
      if (typeof input.base64Content === 'string') {
        const normalized = normalizeBase64Content(input.base64Content);
        const decodedBytes = decodedBase64ByteLength(normalized);
        if (decodedBytes > INLINE_UPLOAD_MAX_BYTES) {
          return err(`base64Content 过大 (${formatBytes(decodedBytes)})，单次 inline 上传上限 ${formatBytes(INLINE_UPLOAD_MAX_BYTES)}。大文件请使用 start_file_upload/append_file_upload/finish_file_upload 分片流程，或把文件放到 1Shell 本机后传 localPath。`);
        }
        buffer = Buffer.from(normalized, 'base64');
      } else if (typeof input.content === 'string') {
        const contentBytes = Buffer.byteLength(input.content, 'utf8');
        if (contentBytes > INLINE_UPLOAD_MAX_BYTES) {
          return err(`content 过大 (${formatBytes(contentBytes)})，单次 inline 上传上限 ${formatBytes(INLINE_UPLOAD_MAX_BYTES)}。大文件请使用 start_file_upload/append_file_upload/finish_file_upload 分片流程，或把文件放到 1Shell 本机后传 localPath。`);
        }
        buffer = Buffer.from(input.content, 'utf8');
      } else if (input.localPath) {
        const localPath = resolveLocalPath(input.localPath);
        const stat = await fs.promises.stat(localPath);
        if (stat.isDirectory()) return err('localPath 不能是目录');
        if (!filename) filename = path.basename(localPath);
        if (!filename) return err('filename 为必填');
        const stream = fs.createReadStream(localPath);
        const result = await deps.fileService.uploadFileStream(hostId, dirPath, filename, stream, stat.size);
        deps.auditService?.log?.({ action: 'mcp_file_upload', source: context.source || 'core_tools', hostId, command: `${dirPath}/${filename}`, details: JSON.stringify({ size: result.size, localPath }) });
        return structured(true, '文件上传成功', { hostId, filename, source: 'localPath', ...result });
      } else {
        return err('localPath / content / base64Content 必须提供一个');
      }
      if (!filename) return err('filename 为必填');
      const result = await deps.fileService.uploadFile(hostId, dirPath, filename, buffer);
      deps.auditService?.log?.({ action: 'mcp_file_upload', source: context.source || 'core_tools', hostId, command: `${dirPath}/${filename}`, details: JSON.stringify({ size: result.size }) });
      return structured(true, '文件上传成功', { hostId, filename, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function pruneUploadSessions() {
    const now = Date.now();
    const expired = [];
    for (const [uploadId, session] of uploadSessions) {
      if (session.expiresAtMs <= now) expired.push([uploadId, session]);
    }
    for (const [uploadId, session] of expired) {
      uploadSessions.delete(uploadId);
      await fs.promises.rm(session.tempPath, { force: true }).catch(() => {});
    }
  }

  async function getUploadSession(uploadId) {
    await pruneUploadSessions();
    const id = String(uploadId || '').trim();
    if (!id) return { error: 'uploadId 为必填' };
    const session = uploadSessions.get(id);
    if (!session) return { error: `上传会话不存在或已过期: ${id}` };
    return { session };
  }

  async function handleStartFileUpload(input, context) {
    if (!deps.fileService?.uploadFileStream) return err('fileService 不支持流式上传');
    const hostId = String(input.hostId || '').trim();
    const dirPath = String(input.dirPath || '').trim();
    const filename = normalizeUploadSessionFilename(input.filename);
    if (!hostId || !dirPath || !filename) return err('hostId、dirPath、filename 均为必填');
    const declaredSize = Number(input.size);
    const hasDeclaredSize = Number.isFinite(declaredSize) && declaredSize >= 0;
    if (hasDeclaredSize && declaredSize > UPLOAD_SESSION_MAX_BYTES) {
      return err(`文件过大 (${formatBytes(declaredSize)})，当前分片上传总上限 ${formatBytes(UPLOAD_SESSION_MAX_BYTES)}`);
    }
    try {
      await pruneUploadSessions();
      await fs.promises.mkdir(MCP_UPLOAD_TMP_DIR, { recursive: true });
      const uploadId = createRuntimeId('upload');
      const tempPath = path.join(MCP_UPLOAD_TMP_DIR, `${uploadId}.part`);
      await fs.promises.writeFile(tempPath, Buffer.alloc(0), { flag: 'wx' });
      const now = Date.now();
      const session = {
        uploadId,
        hostId,
        dirPath,
        filename,
        tempPath,
        declaredSize: hasDeclaredSize ? declaredSize : null,
        maxBytes: hasDeclaredSize ? declaredSize : UPLOAD_SESSION_MAX_BYTES,
        receivedBytes: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAtMs: now + UPLOAD_SESSION_TTL_MS,
      };
      uploadSessions.set(uploadId, session);
      deps.auditService?.log?.({ action: 'mcp_file_upload_start', source: context.source || 'core_tools', hostId, command: `${dirPath}/${filename}`, details: JSON.stringify({ uploadId, declaredSize: session.declaredSize }) });
      return structured(true, '分片上传会话已创建', {
        uploadId,
        hostId,
        dirPath,
        filename,
        receivedBytes: 0,
        nextOffset: 0,
        declaredSize: session.declaredSize,
        chunkMaxBytes: UPLOAD_CHUNK_MAX_BYTES,
        maxBytes: session.maxBytes,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleAppendFileUpload(input) {
    const { session, error } = await getUploadSession(input.uploadId);
    if (error) return err(error);
    const offset = Number(input.offset);
    if (!Number.isFinite(offset) || offset < 0) return err('offset 必须是非负数字');
    if (offset !== session.receivedBytes) {
      return err(`offset 不匹配：当前 nextOffset=${session.receivedBytes}，收到 offset=${offset}`);
    }
    try {
      const normalized = normalizeBase64Content(input.base64Content);
      const decodedBytes = decodedBase64ByteLength(normalized);
      if (decodedBytes <= 0) return err('base64Content 分片为空');
      if (decodedBytes > UPLOAD_CHUNK_MAX_BYTES) {
        return err(`分片过大 (${formatBytes(decodedBytes)})，单分片上限 ${formatBytes(UPLOAD_CHUNK_MAX_BYTES)}`);
      }
      if (session.receivedBytes + decodedBytes > session.maxBytes) {
        return err(`分片会超过本上传会话大小上限：当前 ${formatBytes(session.receivedBytes)} + 分片 ${formatBytes(decodedBytes)} > ${formatBytes(session.maxBytes)}`);
      }
      const buffer = Buffer.from(normalized, 'base64');
      await fs.promises.appendFile(session.tempPath, buffer);
      session.receivedBytes += buffer.length;
      session.updatedAt = new Date().toISOString();
      session.expiresAtMs = Date.now() + UPLOAD_SESSION_TTL_MS;
      return structured(true, '分片已接收', {
        uploadId: session.uploadId,
        receivedBytes: session.receivedBytes,
        nextOffset: session.receivedBytes,
        declaredSize: session.declaredSize,
        complete: session.declaredSize !== null && session.receivedBytes === session.declaredSize,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleFinishFileUpload(input, context) {
    if (!deps.fileService?.uploadFileStream) return err('fileService 不支持流式上传');
    const { session, error } = await getUploadSession(input.uploadId);
    if (error) return err(error);
    if (session.declaredSize !== null && session.receivedBytes !== session.declaredSize) {
      return err(`上传尚未完整：已接收 ${formatBytes(session.receivedBytes)}，声明大小 ${formatBytes(session.declaredSize)}`);
    }
    try {
      const background = input.background === true || input.async === true || input.wait === false || (context.source === 'mcp' && input.wait !== true);
      if (background) {
        return createUploadTransfer(session, context);
      }
      const stream = fs.createReadStream(session.tempPath);
      const result = await deps.fileService.uploadFileStream(session.hostId, session.dirPath, session.filename, stream, session.receivedBytes);
      uploadSessions.delete(session.uploadId);
      await fs.promises.rm(session.tempPath, { force: true }).catch(() => {});
      deps.auditService?.log?.({ action: 'mcp_file_upload_finish', source: context.source || 'core_tools', hostId: session.hostId, command: `${session.dirPath}/${session.filename}`, details: JSON.stringify({ uploadId: session.uploadId, size: result.size }) });
      return structured(true, '分片上传完成', {
        uploadId: session.uploadId,
        hostId: session.hostId,
        dirPath: session.dirPath,
        filename: session.filename,
        size: result.size,
        path: result.path,
      });
    } catch (e) {
      session.updatedAt = new Date().toISOString();
      session.expiresAtMs = Date.now() + UPLOAD_SESSION_TTL_MS;
      return err(e.message);
    }
  }

  async function handleCancelFileUpload(input, context) {
    const { session, error } = await getUploadSession(input.uploadId);
    if (error) return err(error);
    uploadSessions.delete(session.uploadId);
    await fs.promises.rm(session.tempPath, { force: true }).catch(() => {});
    deps.auditService?.log?.({ action: 'mcp_file_upload_cancel', source: context.source || 'core_tools', hostId: session.hostId, command: `${session.dirPath}/${session.filename}`, details: JSON.stringify({ uploadId: session.uploadId, receivedBytes: session.receivedBytes }) });
    return structured(true, '分片上传已取消', {
      uploadId: session.uploadId,
      receivedBytes: session.receivedBytes,
    });
  }

  function normalizeExpectedSha256(input) {
    const value = String(input.expectedSha256 || input.sha256 || '').trim().toLowerCase();
    if (!value) return '';
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('expectedSha256 must be a 64-character hex sha256');
    return value;
  }

  function publicFileTransfer(job) {
    const totalBytes = Number(job.totalBytes) || 0;
    const receivedBytes = Number(job.receivedBytes) || 0;
    const progress = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    return {
      transferId: job.transferId,
      type: job.type,
      status: job.status,
      hostId: job.hostId,
      path: job.path || null,
      dirPath: job.dirPath || null,
      filename: job.filename || null,
      localPath: job.localPath || null,
      finalPath: job.finalPath || null,
      uploadId: job.uploadId || null,
      totalBytes: job.totalBytes,
      receivedBytes,
      progress,
      sha256: job.sha256 || null,
      expectedSha256: job.expectedSha256 || null,
      error: job.error || null,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt || null,
      canResume: job.status === 'failed' && (job.type === 'upload' || receivedBytes > 0),
      pollTool: 'get_file_transfer',
      resumeTool: 'resume_file_transfer',
      cancelTool: 'cancel_file_transfer',
    };
  }

  function markTransferUpdated(job) {
    job.updatedAt = new Date().toISOString();
  }

  async function pruneFileTransfers() {
    const now = Date.now();
    for (const [transferId, job] of fileTransfers) {
      if (!job.finishedAtMs) continue;
      if (now - job.finishedAtMs > FILE_TRANSFER_RESULT_TTL_MS) {
        fileTransfers.delete(transferId);
      }
    }
  }

  async function getFileTransfer(transferId) {
    await pruneFileTransfers();
    const id = String(transferId || '').trim();
    if (!id) return { error: 'transferId is required' };
    const job = fileTransfers.get(id);
    if (!job) return { error: `file transfer not found or expired: ${id}` };
    return { job };
  }

  async function createDownloadTransfer(input, context = {}) {
    if (!deps.fileService?.downloadFile) return err('fileService does not support downloads');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    const localPathInput = String(input.localPath || '').trim();
    if (!hostId || !filePath || !localPathInput) return err('hostId, path, and localPath are required');
    let expectedSha256 = '';
    try {
      expectedSha256 = normalizeExpectedSha256(input);
    } catch (e) {
      return err(e.message);
    }
    try {
      await pruneFileTransfers();
      await fs.promises.mkdir(FILE_TRANSFER_TMP_DIR, { recursive: true });
      const transferId = createRuntimeId('transfer');
      const now = new Date().toISOString();
      const job = {
        transferId,
        type: 'download',
        status: 'queued',
        hostId,
        path: filePath,
        localPath: resolveLocalPath(localPathInput),
        finalPath: null,
        tempPath: path.join(FILE_TRANSFER_TMP_DIR, `${transferId}.part`),
        expectedSha256,
        sha256: null,
        totalBytes: null,
        receivedBytes: 0,
        error: null,
        cancelRequested: false,
        abort: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        finishedAtMs: 0,
        source: context.source || 'core_tools',
      };
      fileTransfers.set(transferId, job);
      void runDownloadTransfer(job);
      return structured(true, 'file download started in background', publicFileTransfer(job));
    } catch (e) {
      return err(e.message);
    }
  }

  async function createUploadTransfer(session, context = {}) {
    if (!deps.fileService?.uploadFileStream) return err('fileService does not support stream uploads');
    try {
      await pruneFileTransfers();
      const transferId = createRuntimeId('transfer');
      const now = new Date().toISOString();
      const job = {
        transferId,
        type: 'upload',
        status: 'queued',
        uploadId: session.uploadId,
        hostId: session.hostId,
        path: null,
        dirPath: session.dirPath,
        filename: session.filename,
        localPath: null,
        finalPath: null,
        tempPath: session.tempPath,
        expectedSha256: '',
        sha256: null,
        totalBytes: session.receivedBytes,
        receivedBytes: 0,
        error: null,
        cancelRequested: false,
        abort: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        finishedAtMs: 0,
        source: context.source || 'core_tools',
      };
      fileTransfers.set(transferId, job);
      void runUploadTransfer(job);
      return structured(true, 'file upload finish started in background', publicFileTransfer(job));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleStartFileDownload(input, context) {
    return createDownloadTransfer(input, context);
  }

  function handleGetFileTransfer(input) {
    return getFileTransfer(input.transferId).then(({ job, error }) => {
      if (error) return err(error);
      return structured(job.status !== 'failed', job.status === 'running' ? 'file transfer is running' : 'file transfer status', publicFileTransfer(job), job.status === 'failed');
    });
  }

  async function handleResumeFileTransfer(input) {
    const { job, error } = await getFileTransfer(input.transferId);
    if (error) return err(error);
    if (job.status === 'running' || job.status === 'queued') return structured(true, 'file transfer is already running', publicFileTransfer(job));
    if (job.status === 'succeeded') return structured(true, 'file transfer already succeeded', publicFileTransfer(job));
    if (job.status === 'cancelled') return err('cancelled transfer cannot be resumed');
    job.cancelRequested = false;
    job.error = null;
    if (job.type === 'upload') {
      job.receivedBytes = 0;
      void runUploadTransfer(job);
    } else {
      void runDownloadTransfer(job);
    }
    return structured(true, 'file transfer resume started', publicFileTransfer(job));
  }

  async function handleCancelFileTransfer(input, context) {
    const { job, error } = await getFileTransfer(input.transferId);
    if (error) return err(error);
    if (job.status === 'succeeded') return structured(true, 'file transfer already succeeded', publicFileTransfer(job));
    job.cancelRequested = true;
    job.abort?.();
    if (job.status !== 'running') {
      await fs.promises.rm(job.tempPath, { force: true }).catch(() => {});
      if (job.uploadId) uploadSessions.delete(job.uploadId);
      job.status = 'cancelled';
      job.error = 'cancelled';
      markTransferUpdated(job);
      job.finishedAt = job.updatedAt;
      job.finishedAtMs = Date.now();
    }
    deps.auditService?.log?.({ action: 'mcp_file_transfer_cancel', source: context.source || 'core_tools', hostId: job.hostId, command: job.path, details: JSON.stringify({ transferId: job.transferId, receivedBytes: job.receivedBytes }) });
    return structured(true, 'file transfer cancelled', publicFileTransfer(job));
  }

  async function runDownloadTransfer(job) {
    if (job.status === 'running') return;
    job.status = 'running';
    job.error = null;
    job.finishedAt = null;
    job.finishedAtMs = 0;
    markTransferUpdated(job);

    let result = null;
    let writeStream = null;
    let progressStream = null;
    try {
      await fs.promises.mkdir(FILE_TRANSFER_TMP_DIR, { recursive: true });
      await fs.promises.mkdir(path.dirname(job.localPath), { recursive: true });
      let partial = await fs.promises.stat(job.tempPath).then((stat) => stat.size).catch(() => 0);
      result = await deps.fileService.downloadFile(job.hostId, job.path, { startOffset: partial });
      if (partial > result.size) {
        result.stream.destroy?.();
        await fs.promises.rm(job.tempPath, { force: true }).catch(() => {});
        partial = 0;
        result = await deps.fileService.downloadFile(job.hostId, job.path, { startOffset: 0 });
      }
      job.totalBytes = result.size;
      job.receivedBytes = partial;
      markTransferUpdated(job);

      await writeReadableToFile(result.stream, job.tempPath, {
        flags: partial > 0 ? 'a' : 'w',
        onChunk(chunk) {
          job.receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          markTransferUpdated(job);
        },
        setAbort(fn) {
          job.abort = fn;
        },
      });

      const tempStat = await fs.promises.stat(job.tempPath);
      job.receivedBytes = tempStat.size;
      if (tempStat.size !== result.size) {
        throw new Error(`download size mismatch: expected ${result.size}, got ${tempStat.size}`);
      }
      job.sha256 = await hashFile(job.tempPath);
      if (job.expectedSha256 && job.sha256 !== job.expectedSha256) {
        throw new Error(`sha256 mismatch: expected ${job.expectedSha256}, got ${job.sha256}`);
      }
      await commitLocalTempFile(job.tempPath, job.localPath, job.transferId);
      job.status = 'succeeded';
      job.finalPath = job.localPath;
      job.error = null;
      markTransferUpdated(job);
      job.finishedAt = job.updatedAt;
      job.finishedAtMs = Date.now();
      deps.auditService?.log?.({ action: 'mcp_file_transfer_finish', source: job.source || 'core_tools', hostId: job.hostId, command: job.path, details: JSON.stringify({ transferId: job.transferId, localPath: job.localPath, size: job.receivedBytes, sha256: job.sha256 }) });
    } catch (e) {
      job.abort = null;
      if (job.cancelRequested || e?.name === 'AbortError' || e?.code === 'CANCELLED') {
        await fs.promises.rm(job.tempPath, { force: true }).catch(() => {});
        job.status = 'cancelled';
        job.error = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = e.message;
        job.receivedBytes = await fs.promises.stat(job.tempPath).then((stat) => stat.size).catch(() => job.receivedBytes || 0);
      }
      markTransferUpdated(job);
      job.finishedAt = job.updatedAt;
      job.finishedAtMs = Date.now();
    }
  }

  async function runUploadTransfer(job) {
    if (job.status === 'running') return;
    job.status = 'running';
    job.error = null;
    job.finishedAt = null;
    job.finishedAtMs = 0;
    job.receivedBytes = 0;
    markTransferUpdated(job);

    let readStream = null;
    let progressStream = null;
    try {
      const tempStat = await fs.promises.stat(job.tempPath);
      job.totalBytes = tempStat.size;
      job.sha256 = await hashFile(job.tempPath);
      readStream = fs.createReadStream(job.tempPath);
      progressStream = new Transform({
        transform(chunk, encoding, callback) {
          job.receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
          markTransferUpdated(job);
          callback(null, chunk);
        },
      });
      job.abort = () => {
        const abortErr = makeAbortError();
        readStream?.destroy?.(abortErr);
        progressStream?.destroy?.(abortErr);
      };
      const result = await deps.fileService.uploadFileStream(job.hostId, job.dirPath, job.filename, readStream.pipe(progressStream), tempStat.size);
      job.abort = null;
      job.status = 'succeeded';
      job.finalPath = result.path;
      job.receivedBytes = result.size ?? tempStat.size;
      job.error = null;
      markTransferUpdated(job);
      job.finishedAt = job.updatedAt;
      job.finishedAtMs = Date.now();
      if (job.uploadId) uploadSessions.delete(job.uploadId);
      await fs.promises.rm(job.tempPath, { force: true }).catch(() => {});
      deps.auditService?.log?.({ action: 'mcp_file_upload_finish', source: job.source || 'core_tools', hostId: job.hostId, command: `${job.dirPath}/${job.filename}`, details: JSON.stringify({ transferId: job.transferId, uploadId: job.uploadId, size: job.receivedBytes, sha256: job.sha256, path: result.path }) });
    } catch (e) {
      job.abort = null;
      if (job.cancelRequested || e?.name === 'AbortError' || e?.code === 'CANCELLED') {
        await fs.promises.rm(job.tempPath, { force: true }).catch(() => {});
        if (job.uploadId) uploadSessions.delete(job.uploadId);
        job.status = 'cancelled';
        job.error = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = e.message;
        job.receivedBytes = 0;
      }
      markTransferUpdated(job);
      job.finishedAt = job.updatedAt;
      job.finishedAtMs = Date.now();
    }
  }

  async function downloadToLocalPathAtomic(hostId, filePath, localPath, input, context = {}) {
    const expectedSha256 = normalizeExpectedSha256(input);
    await fs.promises.mkdir(FILE_TRANSFER_TMP_DIR, { recursive: true });
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const tempPath = path.join(FILE_TRANSFER_TMP_DIR, `${createRuntimeId('sync-download')}.part`);
    let result = null;
    let writeStream = null;
    let progressStream = null;
    try {
      result = await deps.fileService.downloadFile(hostId, filePath);
      let receivedBytes = 0;
      writeStream = fs.createWriteStream(tempPath, { flags: 'wx' });
      progressStream = new Transform({
        transform(chunk, encoding, callback) {
          receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
          callback(null, chunk);
        },
      });
      const onAbort = () => {
        const abortErr = makeAbortError();
        result?.stream?.destroy?.(abortErr);
        progressStream?.destroy?.(abortErr);
        writeStream?.destroy?.(abortErr);
      };
      context.signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        await pipeline(result.stream, progressStream, writeStream);
      } finally {
        context.signal?.removeEventListener?.('abort', onAbort);
      }
      const tempStat = await fs.promises.stat(tempPath);
      if (tempStat.size !== result.size) {
        throw new Error(`download size mismatch: expected ${result.size}, got ${tempStat.size}`);
      }
      const sha256 = await hashFile(tempPath);
      if (expectedSha256 && sha256 !== expectedSha256) {
        throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${sha256}`);
      }
      await commitLocalTempFile(tempPath, localPath, createRuntimeId('sync-commit'));
      return {
        filename: result.filename,
        size: tempStat.size,
        sha256,
        receivedBytes,
      };
    } catch (e) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw e;
    }
  }

  async function handleDownloadFile(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const filePath = String(input.path || '').trim();
    if (!hostId || !filePath) return err('hostId 和 path 为必填');
    try {
      const background = input.localPath && (
        input.background === true
        || input.async === true
        || input.wait === false
        || (context.source === 'mcp' && input.wait !== true)
      );
      if (background) {
        return createDownloadTransfer(input, context);
      }
      const result = await deps.fileService.downloadFile(hostId, filePath);
      const maxBytes = Number(input.maxBytes) > 0 ? Number(input.maxBytes) : 1024 * 1024;
      if (!input.localPath && result.size > maxBytes) {
        result.stream.destroy?.();
        return err(`文件过大 (${result.size} bytes)，请传 localPath 启动后台下载并用 get_file_transfer 查询进度，或调大 maxBytes`);
      }
      if (input.localPath) {
        const localPath = resolveLocalPath(input.localPath);
        result.stream.destroy?.();
        const saved = await downloadToLocalPathAtomic(hostId, filePath, localPath, input, context);
        deps.auditService?.log?.({ action: 'mcp_file_download', source: context.source || 'core_tools', hostId, command: filePath, details: JSON.stringify({ localPath, size: saved.size, sha256: saved.sha256 }) });
        return structured(true, '文件下载成功', { hostId, path: filePath, localPath, filename: saved.filename, size: saved.size, sha256: saved.sha256 });
      }
      const buffer = await streamToBuffer(result.stream, context.signal);
      return structured(true, '文件下载成功', { hostId, path: filePath, filename: result.filename, size: buffer.length, base64Content: buffer.toString('base64') });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleCreateDirectory(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const dirPath = String(input.path || '').trim();
    if (!hostId || !dirPath) return err('hostId 和 path 为必填');
    try {
      const result = await deps.fileService.createDirectory(hostId, dirPath);
      deps.auditService?.log?.({ action: 'mcp_file_mkdir', source: context.source || 'core_tools', hostId, command: dirPath });
      return structured(true, '目录创建成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleDeletePath(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const targetPath = String(input.path || '').trim();
    if (!hostId || !targetPath) return err('hostId 和 path 为必填');
    try {
      const host = deps.hostService?.findHost?.(hostId);
      if (host && host.type !== 'local' && deps.bridgeService?.execOnHost) {
        const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : 120000;
        const command = buildRemoteDeleteCommand(targetPath);
        const result = await deps.bridgeService.execOnHost(hostId, command, timeout, {
          source: context.source || 'core_tools',
          signal: context.signal,
          auditCommand: `delete_path ${targetPath}`,
          onOutput: context.onToolDelta,
        });
        if (result.exitCode !== 0) {
          return structured(false, `删除失败，exitCode=${result.exitCode}`, {
            hostId,
            path: targetPath,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            exitCode: result.exitCode,
            durationMs: result.durationMs || 0,
          }, true);
        }
        const isDir = /type=dir/.test(result.stdout || '');
        deps.auditService?.log?.({ action: 'mcp_file_delete', source: context.source || 'core_tools', hostId, command: targetPath, details: JSON.stringify({ isDir, via: 'bridge_exec', durationMs: result.durationMs || 0 }) });
        return structured(true, '删除成功', { hostId, path: targetPath, isDir, stdout: result.stdout || '', durationMs: result.durationMs || 0 });
      }
      const result = await deps.fileService.deletePath(hostId, targetPath);
      deps.auditService?.log?.({ action: 'mcp_file_delete', source: context.source || 'core_tools', hostId, command: targetPath, details: JSON.stringify({ isDir: result.isDir }) });
      return structured(true, '删除成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  function buildRemoteDeleteCommand(targetPath) {
    assertSafeMutationTarget(targetPath, '删除');
    const quoted = shellQuote(targetPath);
    return [
      'set -eu',
      `target=${quoted}`,
      'if [ ! -e "$target" ] && [ ! -L "$target" ]; then printf "path not found: %s\\n" "$target" >&2; exit 2; fi',
      'if [ -d "$target" ] && [ ! -L "$target" ]; then type=dir; else type=file; fi',
      'rm -rf -- "$target"',
      'printf "deleted type=%s path=%s\\n" "$type" "$target"',
    ].join('\n');
  }

  function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
  }

  function assertSafeMutationTarget(targetPath, action) {
    const value = String(targetPath || '');
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) {
      throw new Error(`${action}被拒绝：路径包含 .. 穿越片段`);
    }
    const trimmed = value.trim().replace(/[\\/]+$/, '');
    if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) {
      throw new Error(`${action}被拒绝：不允许操作根目录`);
    }
  }

  async function handleRenamePath(input, context) {
    if (!deps.fileService) return err('fileService 未初始化');
    const hostId = String(input.hostId || '').trim();
    const oldPath = String(input.path || '').trim();
    const newPath = String(input.newPath || '').trim();
    if (!hostId || !oldPath || !newPath) return err('hostId、path 和 newPath 为必填');
    try {
      const result = await deps.fileService.renamePath(hostId, oldPath, newPath);
      deps.auditService?.log?.({ action: 'mcp_file_rename', source: context.source || 'core_tools', hostId, command: `${oldPath} -> ${newPath}` });
      return structured(true, '重命名成功', { hostId, ...result });
    } catch (e) {
      return err(e.message);
    }
  }

  function handleListMcpServers() {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    const servers = deps.mcpRegistry.listServers();
    if (servers.length === 0) return ok('（仓库中暂无 MCP Server）');
    return ok(servers.map((s) => {
      const typeTag = (s.type === 'local' || s.command) ? '[本地]' : '[远程]';
      const loc = s.type === 'local' ? `cmd=${s.command || ''}` : `url=${s.url}`;
      const runtime = deps.localMcpService && (s.type === 'local' || s.command) ? deps.localMcpService.getStatus(s.id) : { status: 'remote' };
      const flags = `enabled=${s.enabled !== false} autoStart=${s.autoStart === true} ide=${s.exposeToIde !== false} status=${runtime.status}`;
      const runtimeError = runtime.error ? `  error=${String(runtime.error).replace(/\s+/g, ' ').slice(0, 240)}` : '';
      return `${typeTag} id=${s.id}  name="${s.name}"  ${loc}  ${flags}${runtimeError}  ${s.description ? '— ' + s.description : ''}`;
    }).join('\n'));
  }

  async function handleAddMcpServer(input) {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    try {
      const server = deps.mcpRegistry.createServer({
        name: input.name,
        url: input.url || '',
        command: input.command || '',
        installDir: input.installDir || '',
        description: input.description || '',
        authToken: input.authToken || '',
        tags: input.tags || [],
        enabled: input.enabled,
        autoStart: input.autoStart,
        exposeToIde: input.exposeToIde,
      });
      if (server.type === 'local' && server.command && server.enabled && (server.autoStart || server.exposeToIde) && deps.localMcpService) {
        await deps.localMcpService.start(server.id, server.command, { cwd: server.installDir || undefined });
      }
      const typeLabel = server.type === 'local' ? '本地' : '远程';
      return ok(`${typeLabel} MCP Server 已添加到 1Shell 仓库: id=${server.id} name="${server.name}"`);
    } catch (e) {
      return err(`添加失败: ${e.message}`);
    }
  }

  function handleRemoveMcpServer(input) {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    const id = String(input.id || '').trim();
    if (!id) return err('id 为空');
    if (deps.localMcpService) deps.localMcpService.stop(id);
    const removed = deps.mcpRegistry.deleteServer(id);
    return removed ? ok(`MCP Server "${id}" 已从仓库中删除。`) : err(`MCP Server 不存在: ${id}`);
  }

  async function handleDeployLocalMcp(input) {
    if (!deps.mcpRegistry) return err('MCP Registry 未初始化');
    const repoUrl = String(input.repoUrl || '').trim();
    const mcpName = String(input.name || '').trim();
    const command = String(input.command || '').trim();
    if (!repoUrl || !mcpName || !command) return err('repoUrl、name、command 均为必填');

    try {
      if (deps.localMcpDeployer) {
        const inspected = await deps.localMcpDeployer.inspect({ repoUrl });
        const result = await deps.localMcpDeployer.register({
          ...input,
          repoUrl,
          installDir: inspected.installDir,
          name: mcpName,
          command,
        });
        const preloadText = result.preload ? `\n- 预加载: ${result.preload.ok ? `ready (${(result.preload.tools || []).length} tools)` : result.preload.error}` : '';
        return ok(`本地 MCP "${mcpName}" 部署成功！\n- 仓库: ${repoUrl}\n- 安装目录: ${result.server.installDir}\n- 启动命令: ${command}\n- 已注册 ID: ${result.server.id}${preloadText}`);
      }

      const mcpDir = path.join(ROOT_DIR, 'data', 'local-mcp');
      const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'mcp';
      const installDir = path.join(mcpDir, repoName);
      fs.mkdirSync(mcpDir, { recursive: true });
      const cloneCmd = fs.existsSync(installDir)
        ? `git pull`
        : `git clone "${repoUrl}" "${installDir}"`;
      const cloneResult = await execLocal(cloneCmd, 120000, { cwd: fs.existsSync(installDir) ? installDir : ROOT_DIR });
      if (cloneResult.exitCode !== 0 && !fs.existsSync(installDir)) return err(`git clone 失败: ${cloneResult.stderr.slice(0, 300)}`);

      const pkgJson = path.join(installDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        const installResult = await execLocal('npm install --production', 180000, { cwd: installDir });
        if (installResult.exitCode !== 0) return err(`npm install 失败: ${installResult.stderr.slice(0, 300)}`);
      }

      const server = deps.mcpRegistry.createServer({
        name: mcpName,
        command,
        installDir,
        description: input.description || `部署自 ${repoUrl}`,
        tags: input.tags || ['local', 'deployed'],
      });
      if (server.enabled && server.exposeToIde && deps.localMcpService) {
        await deps.localMcpService.start(server.id, server.command, { cwd: server.installDir || undefined });
      }
      return ok(`本地 MCP "${mcpName}" 部署成功！\n- 仓库: ${repoUrl}\n- 安装目录: ${installDir}\n- 启动命令: ${command}\n- 已注册 ID: ${server.id}`);
    } catch (e) {
      return err(`部署失败: ${e.message}`);
    }
  }

  function handleQueryAudit(input) {
    if (!deps.auditService) return err('auditService 未初始化');
    try {
      const result = deps.auditService.query({
        limit: input.limit || 30,
        offset: input.offset || 0,
        action: input.action,
        source: input.source,
        hostId: input.hostId,
        keyword: input.keyword,
      });
      const logs = result.logs || result || [];
      if (logs.length === 0) return ok('（无审计记录）');
      return ok(logs.map((l) => {
        const ts = l.created_at || l.createdAt || l.ts || '?';
        const action = l.action || '?';
        const hostId = l.host_id || l.hostId || '-';
        const cmd = l.command ? `cmd=${String(l.command).slice(0, 100)}` : '';
        const source = l.source ? `src=${l.source}` : '';
        return `[${ts}] action=${action}  host=${hostId}  ${cmd} ${source}`;
      }).join('\n'));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleListProbes(input) {
    if (!deps.probeService) return err('probeService 未初始化');
    try {
      const snapshot = input.refresh
        ? await deps.probeService.getSnapshot({ refresh: true })
        : (deps.probeService.getLatestSnapshot?.() || await deps.probeService.getSnapshot({ refresh: false }));
      return ok(formatJson({ generatedAt: snapshot.generatedAt, sampleIntervalMs: snapshot.sampleIntervalMs, probes: snapshot.probes || [] }));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleGetProbe(input) {
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    const result = await handleListProbes({ refresh: !!input.refresh });
    if (result.is_error) return result;
    const snapshot = JSON.parse(result.content);
    const probe = (snapshot.probes || []).find((p) => p.hostId === hostId || p.id === hostId);
    if (!probe) return err(`未找到主机探针: ${hostId}`);
    return ok(formatJson(probe));
  }

  function handleGetProbeSamples(input) {
    if (!deps.probeAgentService) return err('probeAgentService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    const minutes = Number(input.minutes);
    const sinceMs = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 60 * 24) * 60 * 1000 : 60 * 60 * 1000;
    try {
      const samples = deps.probeAgentService.getSampleHistory(hostId, { sinceMs });
      return ok(formatJson({ hostId, sinceMs, samples }));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleGetProbeTimeseries(input) {
    if (!deps.probeAggregatorService) return err('probeAggregatorService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    const now = Date.now();
    const toMs = Number.isFinite(Number(input.toMs)) ? Number(input.toMs) : now;
    const fromMs = Number.isFinite(Number(input.fromMs)) ? Number(input.fromMs) : toMs - 24 * 60 * 60 * 1000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return err('fromMs/toMs 参数非法');
    try {
      const result = deps.probeAggregatorService.listTimeseries(hostId, {
        fromMs,
        toMs,
        resolution: input.resolution || 'auto',
      });
      return ok(formatJson({ hostId, fromMs, toMs, resolution: result.resolution, points: result.points }));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleGetProbeTraffic(input) {
    if (!deps.probeTrafficService) return err('probeTrafficService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    if (hostId !== 'local' && deps.hostService?.findHost && !deps.hostService.findHost(hostId)) return err('主机不存在');
    try {
      return ok(formatJson(deps.probeTrafficService.getDetail(hostId)));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleListProbeAlerts(input) {
    if (!deps.probeAlertService) return err('probeAlertService 未初始化');
    try {
      const events = deps.probeAlertService.listEvents({
        status: input.status || 'open',
        limit: input.limit || 50,
        offset: input.offset || 0,
      });
      return ok(formatJson({ events, openCount: deps.probeAlertService.countOpenEvents() }));
    } catch (e) {
      return err(e.message);
    }
  }

  function handleAckProbeAlert(input, context) {
    if (!deps.probeAlertService) return err('probeAlertService 未初始化');
    try {
      const result = input.ackAll
        ? deps.probeAlertService.ackOpenEvents()
        : deps.probeAlertService.ackEvent(String(input.eventId || '').trim());
      deps.auditService?.log?.({ action: input.ackAll ? 'mcp_probe_alert_ack_all' : 'mcp_probe_alert_ack', source: context.source || 'core_tools', details: JSON.stringify({ eventId: input.eventId || null }) });
      return ok(formatJson(result));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleInstallProbeAgent(input, context) {
    if (!deps.probeAgentInstallerService) return err('Agent 安装器未启用');
    const hostId = String(input.hostId || '').trim();
    const serverUrl = String(input.serverUrl || '').trim().replace(/\/+$/, '');
    if (!hostId || !serverUrl) return err('hostId 和 serverUrl 为必填');
    try {
      const result = await deps.probeAgentInstallerService.install(hostId, {
        serverUrl,
        intervalSec: typeof input.intervalSec === 'number' ? input.intervalSec : undefined,
        relayUpstreamId: typeof input.relayUpstreamId === 'string' ? input.relayUpstreamId : undefined,
        clientIp: context.clientIp,
      });
      return ok(formatJson(result));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleRestartProbeAgent(input, context) {
    if (!deps.probeAgentInstallerService) return err('Agent 安装器未启用');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      return ok(formatJson(await deps.probeAgentInstallerService.restart(hostId, { clientIp: context.clientIp })));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleUninstallProbeAgent(input, context) {
    if (!deps.probeAgentInstallerService) return err('Agent 安装器未启用');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      return ok(formatJson(await deps.probeAgentInstallerService.uninstall(hostId, { clientIp: context.clientIp })));
    } catch (e) {
      return err(e.message);
    }
  }

  async function handleProbeDiag(kind, input, context) {
    if (!deps.probeDiagService) return err('probeDiagService 未初始化');
    const hostId = String(input.hostId || '').trim();
    if (!hostId) return err('hostId 为必填');
    try {
      if (kind === 'ping') {
        return ok(formatJson(await deps.probeDiagService.ping(hostId, {
          target: input.target,
          count: input.count,
          timeoutSec: input.timeoutSec,
          clientIp: context.clientIp,
        })));
      }
      if (kind === 'http') {
        return ok(formatJson(await deps.probeDiagService.http(hostId, {
          url: input.url,
          method: input.method,
          timeoutSec: input.timeoutSec,
          clientIp: context.clientIp,
        })));
      }
      return ok(formatJson(await deps.probeDiagService.dns(hostId, { name: input.name, clientIp: context.clientIp })));
    } catch (e) {
      return err(e.message);
    }
  }

  return { getToolSchemas, handle, isToolExposed };
}

function makeAbortError() {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  err.code = 'CANCELLED';
  return err;
}

function execLocal(command, timeout, { cwd = ROOT_DIR, signal, onOutput } = {}) {
  return execLocalCommand(command, { timeout, cwd, signal, onOutput });
}

function hasExecutionErrorContext(err) {
  if (!err || typeof err !== 'object') return false;
  return ['stdout', 'stderr', 'partialOutput', 'exitCode', 'durationMs', 'interactivePromptDetected']
    .some((key) => Object.prototype.hasOwnProperty.call(err, key));
}

function executionErrorToResult(err) {
  const stdout = String(err.stdout ?? err.partialOutput ?? '');
  const stderrParts = [];
  if (err.stderr) stderrParts.push(String(err.stderr));
  if (err.message && !stderrParts.some((part) => part.includes(err.message))) stderrParts.push(String(err.message));
  if (err.interactivePromptDetected === true) stderrParts.push('[1Shell] interactivePromptDetected=true');
  return {
    stdout,
    stderr: stderrParts.join('\n'),
    exitCode: typeof err.exitCode === 'number' ? err.exitCode : (err.code === 'EXEC_TIMEOUT' ? 124 : -1),
    durationMs: typeof err.durationMs === 'number' ? err.durationMs : 0,
    errorCode: err.code || undefined,
    interactivePromptDetected: err.interactivePromptDetected === true,
  };
}

function emitTool(context, toolName, input, result) {
  if (!context.socket) return;
  emitIdeEvent(context.socket, 'ide:tool-call', {
    sessionId: context.sessionId,
    runId: context.runId,
    tool: toolName,
    input,
    result: {
      stdout: result.stdout?.substring(0, 4000),
      stderr: result.stderr?.substring(0, 2000),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputDiagnostics: result.outputDiagnostics,
    },
  });
}

function envPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRuntimeId(prefix) {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function normalizeBase64Content(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return '';
  if (text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('base64Content 不是有效的标准 base64 字符串');
  }
  return text;
}

function decodedBase64ByteLength(value) {
  const text = String(value || '');
  if (!text) return 0;
  const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function normalizeUploadSessionFilename(value) {
  const safeName = path.basename(String(value || '').replace(/\\/g, '/')).trim();
  if (!safeName || safeName === '.' || safeName === '..') return '';
  return safeName;
}

function resolveLocalPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('localPath 为空');
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw);
}

function streamToFile(stream, filePath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try { stream.destroy?.(); } catch { /* ignore */ }
      return reject(makeAbortError());
    }
    const writeStream = fs.createWriteStream(filePath);
    let settled = false;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try { stream.destroy?.(); } catch { /* ignore */ }
      try { writeStream.destroy?.(); } catch { /* ignore */ }
      settle(reject, makeAbortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    pipeline(stream, writeStream).then(
      () => settle(resolve),
      (err) => settle(reject, err),
    );
  });
}

function streamToBuffer(stream, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try { stream.destroy?.(); } catch { /* ignore */ }
      return reject(makeAbortError());
    }
    const chunks = [];
    let settled = false;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try { stream.destroy?.(); } catch { /* ignore */ }
      settle(reject, makeAbortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => settle(resolve, Buffer.concat(chunks)));
    stream.on('close', () => settle(resolve, Buffer.concat(chunks)));
    stream.on('error', (err) => settle(reject, err));
  });
}

async function writeReadableToFile(readStream, filePath, { flags = 'w', signal = null, onChunk = null, setAbort = null } = {}) {
  const writeStream = fs.createWriteStream(filePath, { flags });
  let abortError = null;
  const abort = () => {
    abortError = makeAbortError();
    readStream.destroy?.(abortError);
  };
  const onAbort = () => abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  setAbort?.(abort);
  try {
    for await (const chunk of readStream) {
      if (signal?.aborted) throw makeAbortError();
      if (!writeStream.write(chunk)) await once(writeStream, 'drain');
      onChunk?.(chunk);
    }
    writeStream.end();
    await once(writeStream, 'finish');
  } catch (e) {
    if (abortError || e?.name === 'AbortError' || e?.code === 'CANCELLED') {
      writeStream.destroy(e);
    } else {
      writeStream.end();
      await once(writeStream, 'finish').catch(() => {});
    }
    throw e;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    setAbort?.(null);
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function commitLocalTempFile(tempPath, finalPath, transferId) {
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await fs.promises.rename(tempPath, finalPath);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }

  const stagePath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.1shell-transfer-${String(transferId || createRuntimeId('commit')).replace(/[^A-Za-z0-9_.-]/g, '_')}.part`,
  );
  try {
    await pipeline(fs.createReadStream(tempPath), fs.createWriteStream(stagePath, { flags: 'wx' }));
    await fs.promises.rename(stagePath, finalPath);
    await fs.promises.rm(tempPath, { force: true });
  } catch (e) {
    await fs.promises.rm(stagePath, { force: true }).catch(() => {});
    throw e;
  }
}

function structured(okValue, summary, data, isError = false) {
  return { content: formatJson({ ok: okValue, summary, data }), is_error: isError };
}

function formatExec({ stdout, stderr, exitCode, durationMs, outputDiagnostics }) {
  const parts = [];
  if (stdout) parts.push(`[stdout]\n${stdout.trimEnd()}`);
  if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  parts.push(`[exitCode] ${exitCode}`);
  parts.push(`[durationMs] ${durationMs || 0}`);
  const diagnosticsText = formatOutputDiagnostics(outputDiagnostics);
  if (diagnosticsText) parts.push(diagnosticsText);
  return parts.join('\n\n');
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function ok(content) {
  return { content, is_error: false };
}

function err(content) {
  return { content: `[ERROR] ${content}`, is_error: true };
}

module.exports = { createOneShellCoreTools };
