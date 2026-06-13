---
"deepagents": patch
---

fix(deepagents): count tokens once per model call in summarization middleware

`createSummarizationMiddleware` counted tokens twice on every model call—once
inside `truncateArgs` and again for the should-summarize check—even when
nothing was truncated or summarized. Count once and pass the total into
`truncateArgs`; recount only when truncation actually modifies messages.
