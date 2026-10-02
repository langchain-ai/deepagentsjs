---
"deepagents": patch
---

`LocalShellBackend` now enforces `maxOutputBytes` in actual UTF-8 bytes. It previously compared `output.length` (UTF-16 code units), so multi-byte output could exceed the cap by up to 3x, the appended truncation notice was never counted, and the cut could split a surrogate pair.
