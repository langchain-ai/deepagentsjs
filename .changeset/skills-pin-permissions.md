---
"deepagents": patch
---

fix(deepagents): pinned skills honor read permissions and must be valid `SKILL.md` files

A pinned skill's `SKILL.md` is now read only if the agent's `permissions` allow reading it, and only if it is a `SKILL.md` whose frontmatter parses with the pinned skill's name. Before, a `skillsMetadata` entry passed in a run's input could pin any file the backend could read.
