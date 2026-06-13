# 1Shell

1Shell is a local-first server operations console with an embedded AI agent.

It brings together:

- multi-host terminal access
- remote file operations
- script execution
- probe monitoring
- audit logs
- MCP gateway access
- 1Shell AI AgentRun execution
- Skill knowledge packs

## Current Direction

1Shell AI is being simplified around one runtime unit: **AgentRun**.

Reusable automation authoring has been removed from the active product path. It should not be exposed as routes, tools, prompts, docs, or AI-visible artifacts.

The current agent loop is:

```text
user goal
-> AgentRun
-> gather context
-> choose a tool
-> execute through Harness / policy
-> observe tool result
-> decide the next action
-> ask user / request secret / request approval when needed
-> verify outcome
-> publish a truthful final status
```

## Active Concepts

| Concept | Purpose |
| --- | --- |
| 1Shell AI | Controlled operations agent for real server work |
| AgentRun | Runtime state, budget, tool policy, trace, interrupts, and final outcome |
| Harness | Execution boundary for real-world tool calls |
| Skill | Optional markdown knowledge pack loaded only when relevant |
| Script | Deterministic command template managed outside the agent loop |
| Probe | Host health and telemetry source |
| MCP | External gateway for agents and tools |

## Removed Surface

Reusable automation authoring is intentionally absent from the active path.

Future reusable automation should not be restored until the AgentRun loop is proven on real low-risk operations work.

## Development

```bash
npm install
npm test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Run the server:

```bash
npm start
```

Run the frontend in development mode:

```bash
npm --prefix frontend run dev
```
