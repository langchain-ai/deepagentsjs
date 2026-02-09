---
"deepagents": patch
---

fix(skills): use systemMessage.concat() instead of systemPrompt string in SkillsMiddleware

Aligns SkillsMiddleware.wrapModelCall with FilesystemMiddleware and SubAgentMiddleware
by using request.systemMessage.concat() instead of request.systemPrompt string concatenation.
This preserves SystemMessage content blocks including cache_control annotations for
Anthropic prompt caching.
