---
"deepagents": patch
---

fix(filesystem): replace `read_file` media blocks the model can't accept with text placeholders before the model call, instead of failing every later turn with a provider 400. Non-PDF files are only sent to OpenAI models on the Responses API, and only for supported MIME types.
