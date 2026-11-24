---
"deepagents": patch
---

fix(deepagents): keep the summarization middleware's summary model call off the `messages` stream, so the summary text no longer arrives as an AI message before the real answer
