---
"deepagents": patch
---

fix(deepagents): anchor the summarization cutoff by message id

The summarization event now stores `cutoffMessageId`, the id of the first message kept after the summary, and finds the cutoff by that id, so removing earlier messages no longer shifts it. `cutoffIndex` is still used for older events or when the id isn't found.
