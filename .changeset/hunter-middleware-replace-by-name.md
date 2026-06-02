---
"deepagents": patch
---

fix(deepagents): replace same-name middleware in createDeepAgent instead of appending duplicates

- Merge root and declarative subagent middleware by name so custom middleware can override built-ins in place.
- Reuse the shared profile merge helper and add agent tests covering replacement and ordering.
