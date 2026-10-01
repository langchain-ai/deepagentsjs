---
"deepagents": patch
---

Clamp an invalid `grep()` `maxCount` instead of letting `slice` drop matches from the end. A negative value previously returned all but the last N matches while still reporting `truncated`, and a non-finite value emptied the result set.
