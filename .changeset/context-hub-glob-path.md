---
"deepagents": patch
---

`ContextHubBackend.glob` now honors its `path` argument: it returns only files under `path`, or only that file when `path` names one, and matches the pattern relative to it. Patterns written from the repo root, which callers used to scope a glob before, still match. Before, every matching file in the repo came back whatever `path` was, so a `CompositeBackend` route searched under a subdirectory returned files from outside it.
