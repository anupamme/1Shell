# 1Shell AI Task Authoring Handoff - 2026-06-14

## Current State

This document is the handoff point for the next window. The user is redesigning the 1Shell AI task system after deleting the old task/program implementation to keep the core 1Shell AI agent pure.

Important baseline:

- Pure 1Shell AI baseline was saved earlier as commit `981d847 feat: save pure agent baseline`.
- The user explicitly does not want reuse of the old task/program implementation.
- The old failure was conceptual pollution: task logic became mixed into the normal agent, so the user had to delete it first to restore a pure agent.

Current uncommitted implementation already added a first pass of the new surface:

- A new `/features` page with two tabs:
  - AI task tab
  - program tab, currently reusing/embedding the existing scripts view. The user noted scripts are not exactly programs, but accepted postponing this.
- Backend AI task storage foundation:
  - Migration v10 creates `ai_tasks` and `ai_task_runs`.
  - `src/repositories/ai-task.repository.js`
  - `src/services/ai-task.service.js`
  - `src/routes/ai-task.routes.js`
- Frontend:
  - `frontend/src/views/FeaturesView.vue`
  - `frontend/src/utils/aiTasks.ts`
  - Sidebar/router changes, including `/scripts -> /features?tab=programs`.
- IDE-only `/task` command:
  - Implemented in `frontend/src/views/IdeView.vue`.
  - Other AI entry points should not be synced with `/task`; user said IDE only is enough.
- Task authoring tools:
  - `preview_ai_task`
  - `create_ai_task`
  - `update_ai_task`
  - `get_ai_task`
- Task tools are exposed only when IDE session `entry === 'task'`.
- `task_authoring` capability was added in `src/harness/capabilities.js`.
- Regression test added:
  - `scripts/test-task-authoring-capability.js`
  - Wired into `package.json`.

Verification already run before this handoff:

- `npm.cmd --prefix frontend run build` passed.
- `npm.cmd test` passed.
- `node --check` passed for touched backend files.

## Critical Correction

The current first pass is conceptually wrong.

The user tested `/task` with a "deploy GitHub project to VPS port" task. 1Shell AI immediately created a generic task template, then "verified" it by reading the saved DB task back with `get_ai_task` and recording `verify_outcome`.

That is not valid.

The user's definition:

> A task is not splitting a prompt into several step cards. A task is packaging a real successful agent workflow.

For example, "GitHub project deploy to VPS" must not be saved after writing generic steps. The authoring agent must first take a real repo, real VPS, real port, and needed secrets, then actually deploy or run a serious sandbox simulation, fail/fix as needed, and verify with real evidence such as `ss`, `curl`, service status/logs, file existence, or HTTP response. Only then can the successful path be packaged.

If only one path was tested, the task may only honestly claim that tested scope. Example: if a Node project was deployed successfully, Docker/Python/static branches are unverified unless separately practiced.

## Task Concept

The current working concept:

> Task = a skill with fixed/declared inputs + a successful practice trajectory.

Another way to say it:

- A normal skill teaches the agent a method.
- A task is a skill-like method where the user-facing inputs have been determined and turned into a reusable UI entry.
- The task artifact itself should remain simple:
  - input form
  - flow cards
  - short description
- Do not turn the task artifact into a heavy DSL, scheduler, approval framework, or second agent architecture.

The authoring process itself can be treated as a skill/task:

1. User enters `/task`.
2. User describes a new task to create, or asks to package a previous conversation flow.
3. The task-authoring agent first proposes a practice plan:
   - sandbox simulation or real operation
   - required test inputs
   - required secrets
   - expected verification evidence
   - cleanup plan if real operation creates artifacts
4. The agent executes the practice.
5. The agent verifies success with real external evidence.
6. The agent extracts the successful trajectory.
7. The agent writes the simple task template into the `/features` AI task interface.
8. The agent verifies both:
   - authoring validity: the workflow really succeeded
   - persistence validity: the task was saved/readable

## 1Shell Skill Status

The user asked whether old `1shell skill` still affects the current 1Shell AI.

Confirmed from code:

- The skill system still exists.
  - `server.js` creates `skillRegistry`.
  - `src/skills/runner.js` still reads `SKILL.md`, referenced files, and builds a skill-specific system prompt.
  - The skill warehouse UI and `skill:run` socket path still exist.
- But current pure 1Shell AI / IDE agent does not automatically load 1Shell skills.
  - `src/ide/ide.service.js` uses `ONESHELL_CORE_SYSTEM_PROMPT`.
  - `/task` currently appends a hardcoded `TASK_AUTHORING_SYSTEM_PROMPT`.
  - `server.js` passes `skillRegistry` into `createIdeService`, but `createIdeService` does not receive/use `skillRegistry`, so that parameter is effectively dropped.

Conclusion:

- Skill warehouse runner: 1Shell skill still works there.
- Current pure 1Shell AI / IDE agent: old 1Shell skill does not automatically affect it.
- Current `/task`: not a real skill yet; it is only prompt text plus tools.

This explains the failure: we thought the agent had entered a task-authoring skill, but it only received prompt instructions and save tools.

## Design Principle Going Forward

Do not solve this with a larger prompt.

The prompt/skill may teach the authoring behavior, but the save tools must enforce the key invariant:

> No successful practice evidence, no saved task.

This gate is not a restriction on task execution. It is only a gate on task creation/update. The final task should remain simple and flexible.

Avoid these mistakes:

- Do not load task authoring rules into the normal 1Shell AI.
- Do not add multiple approval layers such as goal approval + Hermes approval + task approval unless there is a specific need.
- Do not make `verify_outcome` of DB persistence count as workflow verification.
- Do not let `create_ai_task` accept a model-written template with no practice evidence.
- Do not claim generic multi-stack support unless each branch was practiced or clearly marked unverified.

## Recommended Next Implementation

### 1. Keep Task Authoring Out of 1Shell Skills

2026-07-01 update: the old hidden task-authoring Skill was removed. Do not
revive `/task` behavior through a bundled 1Shell Skill or forced skill injection.
1Shell AI is now a real agent, and task authoring should stay in the IDE
entry/capability/tool policy layer instead of appearing as an imported Skill.

### 2. Keep Tool-Level Evidence Gate

Modify `create_ai_task` and probably `update_ai_task`.

They should reject save attempts without authoring evidence tied to the current `/task` session.

Minimum evidence shape can stay lightweight:

```json
{
  "mode": "real_run",
  "summary": "Deployed repo X to host Y port Z",
  "verified": true,
  "validatedScope": ["node project deployed with systemd on host <id>"],
  "actions": [
    "cloned repository",
    "installed dependencies",
    "started service"
  ],
  "verification": [
    "ss showed LISTEN on port Z",
    "curl http://127.0.0.1:Z returned HTTP 200"
  ],
  "cleanup": {
    "required": true,
    "status": "completed"
  },
  "limitations": [
    "Docker/Python/static branches not validated"
  ]
}
```

Important: the tool should not blindly trust this JSON if it is just model-written. Prefer checking the current session trace/tool events when possible. At minimum, reject missing evidence and make the response explicitly say that `get_ai_task`/DB persistence verification is not enough.

### 3. Separate Draft From Save

`preview_ai_task` can remain permissive.

It should return a clear status such as:

- `draft`
- `unverified`
- `cannot_save_until_practiced`

`create_ai_task` is the hard gate.

### 4. Store Evidence Without Polluting The Task

The user wants the task artifact simple.

So either:

- store authoring evidence in a side column/table, or
- store it as metadata not shown as the task's execution contract.

Do not make users edit a giant evidence DSL in the task UI.

### 5. Update Prompts Only As Secondary Support

After the tool gate exists, update:

- `frontend/src/views/IdeView.vue`
- `src/ide/ide.service.js`

The `/task` prompt should say:

- first propose practice plan
- ask for real/sandbox inputs
- use `request_secret` for secrets
- do not save until the workflow has succeeded
- persistence verification is separate from workflow verification

But again: this is secondary. The tool gate is primary.

### 6. Add Tests

Add/extend tests for:

- `create_ai_task` rejects missing authoring evidence.
- `create_ai_task` rejects `verified: false`.
- `create_ai_task` rejects evidence that only claims DB persistence.
- task tools remain unavailable outside `/task`.
- normal IDE policy still does not include `task_authoring`.

## Suggested File Touch Points

Likely files:

- `src/ide/ide.tools.js`
  - schemas and handlers for `preview_ai_task`, `create_ai_task`, `update_ai_task`, `get_ai_task`
  - best place to add evidence fields and session-aware checks
- `src/services/ai-task.service.js`
  - task payload validation
  - can validate the task structure and evidence shape
- `src/ide/ide.service.js`
  - `/task` prompt and possibly skill loading for task entry
- `frontend/src/views/IdeView.vue`
  - `/task` modal copy and injected startup message
- `src/ide/ide.agent-kernel.js`
  - keep `task_authoring` capability only for `entry === 'task'`
- `src/harness/capabilities.js`
  - keep task tools scoped to task authoring capability
- `scripts/test-task-authoring-capability.js`
  - extend or add a new test for evidence gating

## The Exact User Expectation

When user asks for a generic "deploy a GitHub project to a specified VPS and port" task:

Expected authoring behavior is not to immediately create cards.

Expected flow:

1. AI says it needs a real/sandbox practice run.
2. AI asks for:
   - target host
   - repo URL
   - branch
   - port
   - optional token/secret via encrypted secret input
   - whether to cleanup after practice
3. AI proposes:
   - real VPS practice or sandbox simulation
   - verification commands
   - cleanup boundary
4. AI executes the deployment.
5. AI fixes failures until success or reports blocked.
6. AI verifies actual result.
7. AI packages only the verified path.
8. AI saves the task.
9. AI verifies the saved task is readable.

The previous result, where AI saved a generic "Docker/Node/Python/static" template in seconds and verified only the saved task ID, is explicitly wrong.
