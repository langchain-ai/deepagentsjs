---
"deepagents": minor
---

feat(deepagents): async subagents nest under the parent's trace, know which agent launched them, report `waiting` when paused for a human, and notify the launching agent when they finish, fail or wait (experimental)

`AsyncTaskStatus` gains `"waiting"`; exhaustive checks over it need a new case. `createCompletionCallbackMiddleware` is deprecated: deep agents now notify their parent on their own, so using both sends two notifications.
