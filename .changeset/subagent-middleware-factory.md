---
"deepagents": minor
---

Add an optional `subagentMiddleware` factory to `createDeepAgent` for injecting middleware into declarative synchronous children, including the native general-purpose agent. The factory preserves native child configuration and runs before harness-profile exclusions.
