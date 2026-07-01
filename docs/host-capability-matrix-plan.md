# 1Shell Host Capability Matrix Plan

> Created: 2026-07-01
> Scope: Redesign the Extensions area into a host-level MCP and Skill manager.

## Goal

The Extensions area should show the MCP servers and Skills available on this VPS, then let the user decide which agent can see each capability.

Agents are first-class columns:

- `oneshell-ai`
- `claude-code`
- `codex`
- `opencode`
- future: `gemini`, `hermes`, `openclaw`

`1Shell AI` is not a side path. It must consume the same managed MCP and Skill catalog as native CLI agents.

## Product Shape

The frontend extension section should be rebuilt around two matrix views:

- MCP matrix: one MCP server per row, agent exposure toggles on the right.
- Skill matrix: one Skill per row, agent exposure toggles on the right.

Each row should show:

- name
- type or source
- tags
- origin path or managed state
- runtime status where available
- per-agent exposure toggles

Discovery and management must be visually distinct:

- `managed`: 1Shell owns the record and may sync/remove its managed projection.
- `imported`: discovered from host config and explicitly imported.
- `external`: MCP found on the host but not yet managed by 1Shell.
- `unmanaged`: Skill found in a native agent directory and available as an import candidate, not a matrix row.
- `preset`: known preset from 1Shell.
- `oneshell`: internal 1Shell capability.

## Core Rule

Scanning must not equal takeover.

Discovery can read host files and show capabilities, but 1Shell should only write, remove, copy, or symlink after the user explicitly toggles exposure or imports a capability into management.

## Data Model

Use a canonical capability record plus per-agent exposure policy.

```js
{
  id: "context7",
  kind: "mcp",
  name: "Context7",
  source: "preset",
  originPaths: ["~/.claude/mcp-config.json"],
  config: {},
  exposure: {
    "oneshell-ai": true,
    "claude-code": true,
    "codex": false,
    "opencode": false
  }
}
```

Skill record:

```js
{
  id: "ui-ux-pro-max",
  kind: "skill",
  name: "UI UX Pro Max",
  sourceDir: "data/skills/ui-ux-pro-max",
  exposure: {
    "oneshell-ai": true,
    "claude-code": true,
    "codex": false,
    "opencode": false
  }
}
```

Persist exposure policy separately from discovered source data:

```txt
data/host-capabilities/exposure.json
```

This keeps imported host configuration readable without claiming ownership of every discovered item.

## Adapter Responsibilities

Different agents receive the same capability through different mechanisms.

### 1Shell AI

No external CLI config file is written.

- Skills: use `skillRegistry` and AI skill resolver policy.
- Local MCP: expose tools from `mcpRegistry` + `localMcpService`.
- Remote MCP: use Anthropic `mcp_servers` when the provider supports it; otherwise translate MCP tools into 1Shell tool calls.
- Built-in 1Shell tools remain available through the existing IDE/AI tool catalog.

### Claude Code

- MCP: write `~/.claude/mcp-config.json` or equivalent manifest-defined config.
- Skills: sync managed Skill directories into `~/.claude/skills`.

### Codex

- MCP: write the correct Codex MCP table in `~/.codex/config.toml`.
- Skills: sync managed Skill directories into `~/.codex/skills` when supported.

### OpenCode

- MCP: write OpenCode config via an adapter.
- Skills: sync to OpenCode's skills directory when supported.

## Backend API

Initial facade:

```txt
GET  /api/host-capabilities/agents
GET  /api/host-capabilities/mcp
GET  /api/host-capabilities/skills
PUT  /api/host-capabilities/:kind/:id/exposure/:agentId
POST /api/host-capabilities/scan
POST /api/host-capabilities/apply
```

Phase 1 can support:

- `GET` agents, MCP, Skills
- `PUT` exposure state
- `oneshell-ai` exposure wired to existing 1Shell runtime policy where possible
- external CLI exposure persisted as policy, with apply marked as pending until adapters are completed

Phase 2 adds:

- scanning host MCP configs
- scanning host Skill directories
- applying MCP to Claude/Codex/OpenCode adapters
- applying Skill sync/copy/symlink to agent directories
- dry-run diff and restore

## Frontend Rebuild

Do not extend the current cards/tabs layout.

Replace the Extensions page with a work-focused matrix:

- dense rows
- agent icon toggles
- filter/search
- source/status chips
- separate tabs for MCP and Skill
- import/add actions in the header
- no nested cards

The MCP Hub page can remain for remote API/token management, but `/config/skills` should become the new Extensions matrix. `/config/mcp` can later be folded into this model or left as the remote MCP service configuration page.

## Safety

Before writing host config:

- compute diff
- create backup
- write atomically
- keep a managed marker when deleting or replacing files
- never delete unmanaged host entries
- do not infer app exposure from discovery location without user confirmation

## Implementation Phases

### Phase 1: Matrix Foundation

- Add host capability facade service and route.
- Add exposure policy store.
- List current 1Shell MCP registry and `data/skills`.
- Include `1Shell AI`, Claude Code, Codex, OpenCode as agent columns.
- Rebuild frontend extension view as MCP/Skill matrix.
- Wire `oneshell-ai` toggles to existing 1Shell state:
  - MCP -> `mcpRegistry.exposeToIde`
  - Skill -> `skillRegistry.enabled`

### Phase 2: Host Discovery

- Import existing MCP entries from Claude/Codex/OpenCode configs.
- Scan Skill directories:
  - `~/.claude/skills`
  - `~/.codex/skills`
  - `~/.config/opencode/skills`
  - `~/.agents/skills`
- Treat native agent directories as `unmanaged` import candidates until imported.
- Keep `GET /host-capabilities/skills` scoped to 1Shell-managed `data/skills`.

Current implementation:

- Added a read-only host scanner for Claude Code, Codex, and OpenCode MCP config files.
- Added a read-only Skill scanner for Claude Code, Codex, OpenCode, and generic host Skill directories.
- Matrix rows show managed 1Shell Skills only; native agent Skill directories are exposed through an unmanaged import-candidate endpoint.
- External MCP and unmanaged Skill candidates can be imported into 1Shell management; import does not automatically expose them to `1Shell AI`.
- Native CLI write-back and Skill sync remain Phase 3 adapter work.

### Phase 3: Apply Adapters

- Move MCP apply logic behind agent adapters.
- Move Skill sync behind agent adapters.
- Add dry-run diff and backup/restore UI.

### Phase 4: Runtime Integration

- Ensure `1Shell AI` can call exposed MCP tools consistently.
- Add per-run capability policy to prevent accidental overexposure.
- Add audit events for capability exposure and tool calls.
