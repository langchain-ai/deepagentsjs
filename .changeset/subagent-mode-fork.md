---
"deepagents": minor
---

feat(deepagents): add `ForkedSubAgent` for subagent conversation forking

Lets a subagent inherit the parent's conversation history and (when the model matches) system prompt, instead of only seeing the task description. Unlike a regular `SubAgent`, a `ForkedSubAgent` has no `systemPrompt` of its own — it always inherits the parent's.
