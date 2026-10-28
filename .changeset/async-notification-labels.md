---
"deepagents": patch
---

Async subagent notifications carry notification metadata (`lc_source: "async_subagent"`, `lc_data`: the `TaskEvent`), read with `getNotificationMetadata`. `additional_kwargs.deepagents_notification` is still written and is deprecated.
