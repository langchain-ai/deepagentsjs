---
"deepagents": patch
"@langchain/quickjs": patch
---

Built-in middleware now omit their lifecycle hook inputs (the full agent state) from LangSmith traces via `tracePolicy: { processInputs: omitPayload }`. Hook outputs, model and tool runs, and streaming are unchanged. Requires `langchain` >= 1.6.2.
