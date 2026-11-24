---
"deepagents": patch
---

Reject later `write_file`, `edit_file`, and `delete` calls targeting the same normalized path within one model response, matching Python's filesystem middleware guard. This prevents same-response lost updates without changing backend atomicity.
