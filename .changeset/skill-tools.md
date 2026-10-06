---
"deepagents": minor
---

feat(deepagents): load a skill's tools only when the skill is read

Skills can list tools in `metadata.include_tools`. Pass those tools to `createSkillsMiddleware` as `tools` (an array or a resolver), and pass that middleware to `createDeepAgent`. The model can't see or call a skill tool until it reads a skill that lists it. On models that accept tool definitions mid-conversation this keeps the prompt cache intact, and needs `@langchain/anthropic` >= 1.5.12 or `@langchain/openai` >= 1.6.2.

The skills middleware now sits just before prompt caching, after custom and harness-profile middleware.
