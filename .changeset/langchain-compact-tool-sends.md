---
"deepagents": patch
"deepagents-acp": patch
---

Require `langchain` `^1.5.19`, which schedules each tool call with only the tool call instead of a copy of the whole agent state. Checkpoints no longer store the conversation and the `files` channel again for every tool call. On a 100-step `StateBackend` run, tool task writes fall from 57.5 MB to about 20 KB. Threads saved by earlier versions, including ones stopped at a tool approval, resume as before.

The `@langchain/core` and `@langchain/langgraph` peer floors rise to `^1.2.20` and `^1.4.18`, the versions `langchain` 1.5.19 requires, in `deepagents` and `deepagents-acp`. The `langsmith` peer range of `deepagents` becomes `>=0.11.0 <1.0.0`, the range `langchain` and `@langchain/core` require, so an install holds one `langsmith` copy.
