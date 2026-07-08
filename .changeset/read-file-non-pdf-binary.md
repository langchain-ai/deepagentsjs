---
"deepagents": patch
---

Fix `read_file` emitting an unsendable document block for non-PDF binary files. Provider APIs only accept `application/pdf` for base64 document blocks, so reading any other binary (fonts, wasm, archives, etc.) caused a 400 (`document.source.base64.media_type: Input should be 'application/pdf'`). Non-PDF binaries now return a short text note instead; PDFs and image/audio/video blocks are unchanged.
