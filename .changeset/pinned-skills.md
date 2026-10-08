---
"deepagents": minor
---

feat(deepagents): pin skills by name via `pinnedSkills`

Pass skill names in `pinnedSkills` to guarantee the model gets those skills' instructions, for example when a user names a skill with a `/skill:` command or a picker. Before the next model call, the skills middleware appends each named skill's `SKILL.md`, without its frontmatter, as its own `HumanMessage` marked with `additional_kwargs.lc_source: "pinned_skill"` and the skill's `name`, `path` and `description`. The middleware clears the key once it uses it, and skips an unknown or unreadable skill. A tool can pin skills by returning `Command({ update: { pinnedSkills } })`, and a pinned skill discloses its `metadata.include_tools` the same way reading it does. A custom middleware can declare the key on its state schema with the exported `pinnedSkillsValue`.
