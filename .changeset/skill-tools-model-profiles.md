---
"deepagents": patch
---

feat(deepagents): read inline skill tool support from model profiles

The skills middleware now discloses a skill's tools inline, which keeps the prompt cache valid, for any model whose profile sets `midConversationTools`. It no longer matches model names. That adds Claude Sonnet 5.5 and Haiku 5.5, GPT-4.1, GPT-5.x and o3, and a `ChatOpenAI` that routes to the Responses API without an explicit `useResponsesApi`. Models whose profile leaves the flag unset or `false`, including Chat Completions and Azure, still get the tool in `tools`. Inline disclosure needs the `@langchain/anthropic` and `@langchain/openai` releases that add the flag.
