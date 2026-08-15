---
"deepagents": minor
---

feat(deepagents): add `mode: "fork" | "dynamic"` for subagent conversation forking

Lets a subagent inherit the parent's conversation history and (when the model matches) system prompt, instead of only seeing the task description.
