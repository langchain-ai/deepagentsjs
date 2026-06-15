---
"deepagents": minor
---

Add `interrupt` mode to `FilesystemPermission`

Filesystem permission rules now accept `mode: "interrupt"`, which pauses a
matching filesystem tool call for human approval before it runs — the
path-scoped counterpart to `interruptOn`. Exact-path tools (`read_file`,
`write_file`, `edit_file`) interrupt only when the target path matches a rule;
bulk tools (`ls`, `glob`, `grep`) interrupt whenever their search subtree could
overlap a rule's anchor. It reuses the same interrupt request/response shape as
`humanInTheLoopMiddleware`, so resuming works identically.
