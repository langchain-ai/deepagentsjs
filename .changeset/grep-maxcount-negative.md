---
"deepagents": patch
---

Clamp an invalid `grep()` `maxCount` instead of letting `slice` drop matches from the end. A negative value previously returned all but the last N matches while still reporting `truncated`, and `NaN` emptied the result set. Treat non-finite limits as unlimited consistently across ordinary and composite backends.
