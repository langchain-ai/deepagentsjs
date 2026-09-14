---
"deepagents": patch
"@langchain/quickjs": patch
---

feat(filesystem): replace read_file's line-number gutter with a status header

`read_file` now states the line range once, in a `@@ lines A-B[ of T] | ... @@` header above unmodified source, instead of repeating a line-number prefix on every row. Pagination and truncation notices are folded into terse header fields (`next offset N`, `truncated due to size`, `truncated mid-line | N of M chars`), and truncation now discloses exactly how much of an oversized single line was shown rather than silently cutting it. A negative `offset` is now disclosed too: `read_file` states that it clamped the request and read from line 1 instead, rather than silently reinterpreting it.

The quickjs provider's `stripLineNumbers` is updated to recognize and drop the new header (with a fallback to the legacy per-line stripping) so sandboxed code still gets clean file content.
