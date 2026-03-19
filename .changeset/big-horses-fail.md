---
"deepagents": patch
---

fix(deepagents): throw on built-in tool collision
- `createDeepAgent` now throws at construction time if any user-supplied tool name collides with a built-in tool (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`, `task`, `write_todos`). Previously, colliding tools silently shadowed the built-in, causing cryptic schema-validation errors at runtime.

