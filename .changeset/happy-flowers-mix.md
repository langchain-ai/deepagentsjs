---
"deepagents": patch
---

fix(deepagents): prevent write_file crash when model omits content
- Default the content parameter to an empty string so a missing argument doesn't crash the entire agent run via Zod validation failure.
