---
"deepagents": patch
---

Async subagent notifications are labeled with `lc_synthetic`, `lc_source: "async_subagent"` and `lc_data` (the `TaskEvent`) via `createNotificationMessage`. `additional_kwargs.deepagents_notification` is still written and is deprecated.
