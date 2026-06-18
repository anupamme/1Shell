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
  'get_1shell_ai_run',
  'start_file_upload',
  'append_file_upload',
  'finish_file_upload',
  'cancel_file_upload',
  'start_file_download',
  'get_file_transfer',
  'resume_file_transfer',
  'cancel_file_transfer',
];

const MCP_STANDARD_TOOL_SET = new Set(MCP_STANDARD_TOOL_NAMES);

module.exports = {
  MCP_STANDARD_TOOL_NAMES,
  MCP_STANDARD_TOOL_SET,
};
