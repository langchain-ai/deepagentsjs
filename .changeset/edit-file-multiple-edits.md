---
"deepagents": patch
---

feat(deepagents): apply multiple replacements in one `edit_file` call

`edit_file` accepts an optional `edits` array of `{ old_string, new_string, replace_all }` entries that are applied together with the top-level `old_string`/`new_string`. Every replacement is matched against the file content as it was before the call, overlapping replacements are rejected, and the file is only written if every replacement succeeds. Calls without `edits` behave exactly as before, and existing backends need no changes.
