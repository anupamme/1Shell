---
name: OneShell Task Authoring
description: Author reusable 1Shell AI tasks by deducing, through read-only exploration, what inputs a goal needs, then saving a lightweight task (goal + inputs). No real execution, no evidence gate.
category: ai-task
tags:
  - task
  - authoring
  - inputs
  - deduction
hidden: true
---
# OneShell Task Authoring

Use this skill only inside `/task` task-authoring mode.

A 1Shell AI task is lightweight: a goal plus the inputs a user must provide so 1Shell AI can complete it later on its own. It is not a workflow DSL, a scheduler, an approval layer, or a second agent.

## What authoring is

Authoring is **deduction, not execution**. Your job is to work out what inputs the goal needs, not to actually perform it.

- Explore read-only to ground your deduction: `list_hosts`, list directories, read files, check probes/ports, run read-only diagnostic commands.
- Do **not** perform real changes (install, write, delete, restart, deploy). In `/task` mode the Harness rejects change/high-risk tools and non-read-only commands; that is expected, keep exploring read-only.
- Don't just guess in a few seconds. Look at the real environment enough to name the right inputs and sensible defaults.

## What to save

Save with `create_ai_task`:

- `name` — short, action-oriented.
- `description` — one or two lines on what the task does and its validated scope.
- `inputs` — the values that change per host/environment and must come from the user: target host, domain, port, repo URL, service name, secret refs, etc. Keep each input simple (key, label, type, required, default).
- `steps` — optional. A few plain hints at most; the executing agent decides the real steps at run time. Do not freeze a rigid script.

Use `preview_ai_task` to check the structure first. `create_ai_task` / `update_ai_task` are the only way to save; never paste task JSON to the user instead of saving.

## Inputs are the point

Good input detection is what makes a task reusable instead of one-off. For anything that would differ on another host or another run, make it an input. Use `request_secret` for tokens/passwords and store only a secret reference, never plaintext.

## Don't aim for perfect

A task does not have to be complete on the first try. When a saved task later fails during execution, that run's 1Shell AI can fix the task in place with `update_ai_task`. Tasks improve through use.

## Example: deducing inputs for a VLESS node task

For "one-click VLESS node", don't try to build it here. Explore read-only and reason about what the user would need to provide, for example:

- target host (which VPS)
- listen port
- domain or SNI (if used)
- the runtime to use (e.g. sing-box) and transport mode
- any keys/UUIDs — generated at run time, or provided as secret refs

Save the task as goal + these inputs. State the validated scope honestly (e.g. "sing-box + VLESS Reality + systemd") and leave untested OS/transport variants out or marked as assumptions. The actual install, key generation, config write, and verification happen later when the task is executed, not during authoring.
