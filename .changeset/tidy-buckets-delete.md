---
"deepagents": minor
---

feat(backends): add delete protocol support

Adds a `DeleteResult` type and optional backend `delete` method, preserves delete through backend protocol adaptation, and implements file deletion across the built-in state, store, filesystem, composite, context hub, and sandbox backends.
