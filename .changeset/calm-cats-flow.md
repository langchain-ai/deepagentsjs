---
"deepagents": patch
"@langchain/quickjs": patch
---

Forward LangGraph runnable config explicitly through subagent and QuickJS PTC tool calls so browser runtimes do not depend on AsyncLocalStorage.
