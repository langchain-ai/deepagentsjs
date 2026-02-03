---
"deepagents": patch
---

fix(skills): properly restore skills from StateBackend checkpoint

- Add `files` channel to `SkillsStateSchema` for StateBackend integration
- Fix skills restoration check to require non-empty array instead of just non-null
- Export `FileDataSchema` from fs middleware for reuse
