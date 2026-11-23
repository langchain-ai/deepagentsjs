---
"deepagents": patch
---

`grep()`'s `glob` filter now matches directory-qualified patterns (`src/*.py`, `src/**`) against the path relative to the search root, consistent with `glob()`. Previously only the basename was matched, so any pattern containing a separator silently matched nothing. Bare patterns such as `*.py` keep their existing basename-anywhere behaviour.
