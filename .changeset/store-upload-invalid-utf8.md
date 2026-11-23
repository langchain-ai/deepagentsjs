---
"deepagents": patch
---

fix(deepagents): keep non-UTF-8 bytes uploaded to a text path in `StoreBackend` byte-for-byte as `application/octet-stream` instead of decoding them lossily, as `StateBackend` already does
