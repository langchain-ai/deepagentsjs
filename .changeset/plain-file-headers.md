---
"deepagents": patch
"@langchain/quickjs": patch
---

feat(filesystem): replace read_file's line-number gutter with a status header

Before:
```
     1	hello
     2	world
```

After:
```
@@ lines 1-2 of 2 @@
hello
world
```

`read_file` now states its line range once, in a `@@ lines A-B[ of T] | ... @@` header above unmodified source, instead of a per-line prefix. Truncation and a clamped negative `offset` are now disclosed as terse header fields instead of prose.

The quickjs provider's `stripLineNumbers` is updated to strip the new header (with a fallback to the legacy format) so sandboxed code still gets clean file content.
