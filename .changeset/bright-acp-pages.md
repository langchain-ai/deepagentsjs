---
"deepagents-acp": patch
---

fix(filesystem): preserve pagination metadata for ACP-backed reads

Return source ranges, total line counts, and continuation offsets when reading paginated editor buffers through ACP.
