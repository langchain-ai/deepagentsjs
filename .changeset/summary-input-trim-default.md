---
"deepagents": patch
---

fix(deepagents): disable summary-input trimming by default

Match Python DeepAgents by providing the full selected conversation to the summarizer unless `trimTokensToSummarize` is explicitly configured. This prevents oversized tool results from producing context-empty summaries under the default configuration.
