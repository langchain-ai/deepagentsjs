---
"deepagents": minor
"@langchain/daytona": patch
"@langchain/modal": patch
---

Add a per-call `timeout` to `execute`. Sandbox backends accept `execute(command, { timeout })`, and the `execute` tool takes an optional `timeout` argument in seconds that overrides the backend default for one command. `createFilesystemMiddleware` rejects values above `maxExecuteTimeout` (default 3600 seconds). `LocalShellBackend`, `CompositeBackend`, `DaytonaSandbox`, and `ModalSandbox` honor the override.
