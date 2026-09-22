---
"deepagents": patch
---

fix(deepagents): degrade unsupported binary files in read_file instead of crashing the run

`read_file` returned every non-text, non-image/audio/video binary as a `{ type: "file" }` content block. For any MIME type other than `application/pdf` this produces a provider request that is rejected — Anthropic fails the whole turn with `messages.N...document.source.base64.media_type: Input should be 'application/pdf'`, and OpenAI/OpenRouter only accept PDF (and images) via `input_file`. As a result, reading a `.docx`/`.pptx`/`.xlsx` (or any `application/octet-stream` file) aborted the entire agent run. `read_file` now emits a `file` block only for PDFs — the one document type accepted across providers — and degrades other binaries to a short text note, so the agent can keep going.
