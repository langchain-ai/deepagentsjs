---
"deepagents": minor
---

feat(deepagents): add interrupt mode to filesystem permissions

Filesystem permission rules now support `mode: "interrupt"`, pausing matching tool calls for human approval via `HumanInTheLoopMiddleware` instead of denying or running silently. `createDeepAgent` auto-installs HITL when interrupt rules are present and merges fs-derived `interruptOn` configs with user overrides (user wins per tool name). Scope-aware `when` predicates fire only when calls intersect protected paths, including hardening for pathless bulk tools and current-dir aliases.

Port of langchain-ai/deepagents#3505. Requires `langchain@1.4.5-dev-1781048185730` (or later with `when` predicate support).
