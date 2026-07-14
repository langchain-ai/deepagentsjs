---
"deepagents": minor
---

feat(backends): add delete protocol support

Adds a `DeleteResult` type and optional backend `delete` method, preserves delete through backend protocol adaptation, and implements StateBackend deletion through Pregel file-state updates.
