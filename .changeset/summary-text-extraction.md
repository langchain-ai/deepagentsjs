---
"deepagents": patch
---

fix(deepagents): extract text from content blocks when building the summary

When the summarization model responds with a content block array (e.g. reasoning/thinking enabled, or chunk aggregation from an internal streaming path), `createSummary` previously `JSON.stringify`'d the raw blocks — reasoning signatures included — into the summary message, bloating it instead of compacting the history. Use the message's `text` accessor to keep only text blocks.
