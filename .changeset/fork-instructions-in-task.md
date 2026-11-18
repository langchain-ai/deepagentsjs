---
"deepagents": patch
---

fix(deepagents): keep forked subagents on the parent's prompt-cache prefix

A fork's own `systemPrompt` is now delivered in its task message instead of being appended to the parent's system prompt, so the fork's request matches the parent's through the inherited history. Ports langchain-ai/deepagents#7628.
