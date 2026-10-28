---
"deepagents": patch
---

`StateBackend` stores binary uploads and writes as base64 text with `encoding: "base64"`, so threads with uploaded images or PDFs keep working after a JSON checkpointer round trip. Uploads at text paths whose bytes are not valid UTF-8 are kept byte-for-byte as `application/octet-stream` instead of being lossily decoded.
