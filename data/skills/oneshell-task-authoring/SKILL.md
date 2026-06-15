---
name: OneShell Task Authoring
description: Author reusable 1Shell AI tasks by practicing a real workflow first, verifying it with external evidence, and only then packaging the successful path as a lightweight task template.
category: ai-task
tags:
  - task
  - authoring
  - verification
  - practice
hidden: true
---
# OneShell Task Authoring

Use this skill only inside IDE `/task` mode.

A 1Shell AI task is not a prompt split into step cards. A task is a lightweight package of a real successful agent workflow:

- fixed user-facing inputs
- simple flow cards
- a short description
- evidence that the authoring workflow was practiced and verified

Do not create a task immediately after writing a generic template. Practice first.

## Required Authoring Flow

1. Understand the task the user wants to create.
2. Propose a practice plan before saving anything.
3. Ask for required real or sandbox inputs:
   - target host
   - repo, branch, port, domain, service name, or other task-specific values
   - secrets through `request_secret`
   - cleanup preference if practice creates artifacts
4. Execute the practice run with real tools.
5. Iterate on failures until the practiced path succeeds or clearly report blocked.
6. Verify success with `verify_outcome`.
7. Extract only the successful practiced path.
8. Use `preview_ai_task` to normalize the lightweight task structure.
9. Use `create_ai_task` or `update_ai_task` only after successful practice evidence exists.
10. After saving, `get_ai_task` may verify persistence, but persistence does not count as workflow verification.

## Evidence Rules

Valid workflow evidence is external to the task database, such as:

- command output proving a service is active
- `ss` or `netstat` showing a listening port
- `curl` or HTTP result showing a real response
- `sing-box check`, `systemctl status`, logs, generated files, or similar task-specific checks
- file existence or content checks where the task goal is file-oriented

Invalid evidence:

- "I think this should work"
- a generic checklist with no execution
- `get_ai_task` reading the saved task back
- database persistence confirmation alone
- unverified branches such as Docker/Python/static support when only one branch was practiced

## Packaging Rules

Keep the saved task simple:

- `name`
- `description`
- `inputs`
- `steps`

Do not design a DSL, scheduler, new approval framework, or second agent architecture inside the task.

State limitations honestly. If only one stack or host type was practiced, the saved task must only claim that validated scope.

For GitHub deployment tasks, the practice run must actually use the repository:

- clone, checkout, pull, or otherwise consume the requested repo URL
- build or run from the checked-out repository, or explicitly use `docker build` / Compose `build:` from that repo
- verify the service created from that repo

If the practice run only used a prebuilt Docker image, package the result as an image-based deployment task. Do not keep a `repo_url` input or claim "deploy a GitHub project" unless the repo workflow was truly practiced.

## Example: VLESS Node Authoring

For a "one-click VLESS node" task, do not save a template first.

Practice on a real or sandbox VPS:

1. Download the selected runtime, such as sing-box.
2. Run its version/check command.
3. Generate UUID, Reality keys, shortId, or other required keys.
4. Write a real server config file.
5. Run config validation.
6. Install or write the systemd service.
7. Start the service.
8. Verify listening port, logs, and service state.
9. Generate a real client config.
10. If a client test environment is available, run a client-side proxy test and verify outbound connectivity.

Only after this succeeds may the workflow be packaged. The task should claim only the practiced path, for example:

`sing-box + VLESS Reality + systemd + tested VPS/OS family + tested port behavior`

Untested transport modes, operating systems, reverse proxy modes, or client types must be listed as limitations or omitted.
