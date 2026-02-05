---
"@langchain/modal": minor
---

feat(modal): add Modal sandbox provider for DeepAgents

Adds `@langchain/modal` package providing Modal sandbox integration for the DeepAgents framework.

Features:
- Command execution via `execute()` in isolated Modal containers
- File operations via `uploadFiles()` and `downloadFiles()`
- Initial file population via `initialFiles` option
- Direct SDK access via `.client` and `.instance` properties
- Configurable container images, timeouts, memory, GPU, volumes, and secrets
- Type-safe options extending Modal SDK's `SandboxCreateParams`
