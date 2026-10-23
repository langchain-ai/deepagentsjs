---
"deepagents": patch
---

feat(deepagents): async subagents nest under the parent's trace, know which agent launched them, report `waiting` when paused for a human, and notify the launching agent when they finish, fail, wait or are cancelled (experimental)

Same-deployment subagents now run with the parent's run context, and task threads are named with `subagent_name`. `AsyncSubAgent` gains `webhook`, `notifyParent`, `mode: "fork"`, and `updateStrategy: "enqueue"`, which queues follow-ups behind the current run instead of interrupting it. `check_async_task` returns a list of content blocks when the answer includes media.

`AsyncTaskStatus` gains `"waiting"` and `TaskEvent.status` gains `"cancelled"`; exhaustive checks over them need new cases. `createCompletionCallbackMiddleware` is deprecated: deep agents now notify their parent on their own, so using both sends two notifications.
