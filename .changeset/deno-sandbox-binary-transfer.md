---
"@langchain/deno": patch
---

`DenoSandbox.uploadFiles` and `downloadFiles` now transfer file bytes unchanged. Binary files such as images, PDFs and archives are no longer corrupted by a UTF-8 string round trip.
