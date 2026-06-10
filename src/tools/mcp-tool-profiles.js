'use strict';

// Default public MCP profile: deterministic primitives plus the 1Shell AI gateway.
// Richer internal capabilities stay available to 1Shell AI through the IDE target.
const MCP_STANDARD_TOOL_NAMES = [
  'list_hosts',
  'host_exec',
  'list_remote_dir',
  'read_remote_file',
  'write_remote_file',
  'upload_file',
  'download_file',
  'ask_1shell_ai',
];

const MCP_STANDARD_TOOL_SET = new Set(MCP_STANDARD_TOOL_NAMES);

module.exports = {
  MCP_STANDARD_TOOL_NAMES,
  MCP_STANDARD_TOOL_SET,
};
