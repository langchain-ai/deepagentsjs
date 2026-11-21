---
"@langchain/node-vfs": patch
---

Fix `grep()` directory-qualified glob filters to match paths relative to the search root, while preserving basename matching for bare patterns.
