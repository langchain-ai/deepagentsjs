---
"deepagents": patch
---

`validatePath()` now behaves as its documentation describes: it collapses `.` segments and duplicate separators, and rejects `..` traversal and Windows absolute paths. It previously only prepended and appended a slash, so none of its documented examples matched.
