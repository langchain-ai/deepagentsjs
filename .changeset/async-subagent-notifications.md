---
"deepagents": patch
---

feat(deepagents): async subagents notify the agent that launched them when they finish, fail, wait for a human or are cancelled (experimental)

`AsyncSubAgent` gains `webhook`, `notifyParent`, `mode: "fork"` and `updateStrategy: "enqueue"`. `check_async_task` returns a list of content blocks when the answer includes media. `AsyncTaskStatus` gains `"waiting"` and `TaskEvent.status` gains `"cancelled"`. `createCompletionCallbackMiddleware` is deprecated; using it as well sends two notifications.
