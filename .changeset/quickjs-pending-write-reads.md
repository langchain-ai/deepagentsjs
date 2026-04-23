---
"@langchain/quickjs": patch
---

fix(quickjs): make readFile reflect pending writes in the same eval

Ensure `readFile` checks buffered `pendingWrites` first (latest write wins)
before falling back to backend `readRaw`, and add regression coverage for
`writeFile` then `readFile` in a single `js_eval` call.
