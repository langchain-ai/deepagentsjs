---
"deepagents": patch
---

`CompositeBackend.glob` now matches a pattern against paths relative to the searched directory when a mounted route lies below it. With a route at `/workspace/memories/`, `glob("memories/*.txt", "/workspace")` finds `/workspace/memories/note.txt`.
