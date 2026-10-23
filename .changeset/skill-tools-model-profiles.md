---
"deepagents": patch
---

feat(deepagents): read inline skill tool support from model profiles

The skills middleware discloses a skill's tools inline for any model whose profile sets `midConversationTools`, instead of matching model names.
