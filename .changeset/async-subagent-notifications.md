---
"deepagents": minor
---

feat(deepagents): async subagents notify the agent that launched them (experimental)

When an async subagent finishes, fails, is cancelled or pauses for a human, it now wakes the agent that started it with a notification message, so the agent no longer has to poll `check_async_task`.

- `AsyncSubAgent` gains `notifyParent` (set `false` to turn notifications off), `webhook` (also POST each outcome to a URL), `updateStrategy: "enqueue"` (queue follow-ups behind the current run instead of interrupting it) and `mode: "fork"` (start the subagent with a copy of the parent's conversation).
- A subagent paused for approval or input shows as `"waiting"`; the user answers it on the subagent's own thread.
- `check_async_task` returns content blocks when the answer includes media.
- `createCompletionCallbackMiddleware` is deprecated; using it alongside notifications sends two of them.
