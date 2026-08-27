---
"deepagents": patch
---

feat(filesystem): report remaining lines for paginated file reads

Add optional read pagination metadata across built-in backends and append a model-facing continuation notice when more source lines remain. Size-based truncation now preserves complete source-line boundaries and recalculates the next offset so subsequent reads do not skip hidden content.
