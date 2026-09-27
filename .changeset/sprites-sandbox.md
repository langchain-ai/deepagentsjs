---
"@langchain/sprites": minor
---

feat(sprites): add Fly.io Sprites sandbox provider for DeepAgents

Adds `@langchain/sprites` package providing Fly.io Sprites sandbox integration for the DeepAgents framework.

Features:

- Command execution via `execute()` in persistent Linux VMs that boot in 1-2 seconds
- File operations via `uploadFiles()` and `downloadFiles()`
- Initial file population via `initialFiles` option
- Persistent named sandboxes: reconnect with `SpritesSandbox.fromName()` after idle suspend
- Full-machine `checkpoint()` / `restore()` for rolling back agent changes
- Direct SDK access via `.client` and `.instance` properties
- Configurable machine sizing (RAM, CPUs, region, storage), environment variables, labels, and timeouts
