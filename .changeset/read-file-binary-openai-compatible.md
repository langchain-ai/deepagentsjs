---
"deepagents": patch
---

fix(deepagents): avoid non-standard 'file' content block for binary files

Return a `text` placeholder for non-image/audio/video binary files read via the `read_file` tool, so that OpenAI-compatible providers (e.g. DeepSeek) do not reject the request with an "unknown variant `file`" error.
