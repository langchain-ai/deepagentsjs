---
"deepagents": patch
---

refactor(stream): use langchain `run.subagents` instead of bespoke transformer

Remove deepagents' custom `createSubagentTransformer` and rely on the native
subagent stream that `createAgent` registers (langchain#37739). Keep
`DeepAgentRunStream` as a compile-time overlay that narrows `run.subagents` to
declared subagent specs. Update streaming tests for `cause` and per-subagent
message coverage.
