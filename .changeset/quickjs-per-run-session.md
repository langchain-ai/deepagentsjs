---
"@langchain/quickjs": patch
---

fix(quickjs): give each agent run its own REPL session, so parallel subagents of the same type no longer share variables or free each other's runtime
