# MCP AI Gateway Optimization

## Goal

Reduce the 1Shell MCP tool surface exposed to external agents while preserving access to rich 1Shell capabilities through a single AI gateway tool.

The current local MCP surface exposes 29 tools. Many of them are convenience, diagnosis, monitoring, script, program, or internal management capabilities. They are useful, but they do not need to occupy the external agent's tool context directly.

## Core idea

Expose a small set of deterministic base tools directly, and route complex or optional capabilities through `ask_1shell_ai`.

External agents should directly control only the capabilities that require precise, deterministic operation:

- host discovery
- command execution
- remote file browsing and transfer
- a single 1Shell AI gateway

Everything else should be delegated to 1Shell AI, which can use internal tools, scripts, probes, programs, audit data, and MCP registry capabilities without polluting the external MCP client context.

## Recommended standard MCP profile

The default public MCP profile should expose:

```text
list_hosts
host_exec
list_remote_dir
read_remote_file
write_remote_file
upload_file
download_file
ask_1shell_ai
```

This keeps the external agent capable of direct infrastructure work while removing the majority of high-level and domain-specific tools from the visible MCP schema.

## Tools delegated to 1Shell AI

These tools should no longer be directly exposed in the standard MCP profile:

### Script library

```text
list_scripts
run_script
```

Scripts are internal operational assets. External agents can ask 1Shell AI to find, explain, and run an appropriate script.

### MCP registry management

```text
list_mcp_servers
add_mcp_server
remove_mcp_server
deploy_local_mcp
```

These affect 1Shell's own capability layer and should be mediated by 1Shell AI with clear planning and confirmation.

### Audit

```text
query_audit
```

External agents normally need summaries, not raw audit rows. 1Shell AI should summarize recent activity, failures, denied calls, and risky operations.

### Program automation

```text
list_programs
trigger_program
```

Programs are 1Shell-specific automations. 1Shell AI should select and trigger them based on a user goal.

### Probe monitoring and diagnosis

```text
list_probes
get_probe
get_probe_samples
get_probe_timeseries
get_probe_traffic
list_probe_alerts
ack_probe_alert
install_probe_agent
restart_probe_agent
uninstall_probe_agent
probe_diag_ping
probe_diag_http
probe_diag_dns
```

Probe capabilities are the largest source of MCP context pollution. External agents can ask questions such as "which VPS is unhealthy?", "why is this host slow?", or "check network reachability" and let 1Shell AI run the correct probe workflow internally.

## Gateway tool contract

`ask_1shell_ai` should accept a compact request from the external agent:

```json
{
  "task": "Diagnose why host abc has high memory usage",
  "hostId": "abc",
  "mode": "answer",
  "requireConfirmation": true
}
```

Suggested schema:

- `task` string, required: the user goal or question.
- `hostId` string, optional: preferred host scope.
- `mode` enum, optional: `answer`, `plan`, or `execute`.
- `requireConfirmation` boolean, optional: whether 1Shell AI must avoid mutating actions unless explicitly confirmed.

The response should be structured text or JSON containing:

- summary
- plan or actions considered
- actions taken, if any
- tool calls or commands used internally, if available
- result
- warnings or required confirmations

## Safety requirements

Changing the visible `tools/list` output is not enough. MCP clients can still manually call a hidden tool name.

The implementation must enforce direct-call eligibility at `tools/call` time:

- A tool must be present in the active MCP exposure profile to be callable directly.
- Remote MCP must still apply global allowed tools and token-level allowed tools.
- Hidden legacy tools should remain callable only through trusted internal 1Shell AI dispatch, not by external MCP clients.

## Remote MCP permission migration

The existing Remote MCP UI stores allowed tool names in both global config and token records. After the public tool surface changes, stale tool names can remain in `data/remote-mcp.json`.

The implementation should prune stale tool permissions against the current exposed MCP tool list:

- global `allowedTools`
- token `allowedTools`

This avoids invalid states such as `12 / 8` tools selected and prevents old clients from retaining removed tool names.

## Compatibility strategy

Prefer profiles instead of permanently deleting tools:

- `standard`: default public profile with base tools + `ask_1shell_ai`.
- `legacy`: full direct MCP exposure for trusted local debugging or compatibility.

The first implementation can hard-code the standard profile and leave the internal tool handlers intact. A future UI setting can expose profile selection if needed.
