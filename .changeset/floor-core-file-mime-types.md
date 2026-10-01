---
"deepagents": minor
---

`UnsupportedContentMiddleware` now relies entirely on `model.profile.fileMimeTypes` to decide whether a generic file attachment is supported, instead of falling back to a hardcoded OpenAI MIME-type allowlist. This requires `@langchain/core@^1.2.14` (the peer dependency floor is raised accordingly) and, for OpenAI/Azure OpenAI models, `@langchain/openai@^1.6.1` to populate `fileMimeTypes`.

Breaking: the `OPENAI_FILE_MIME_TYPES` export is removed, and `multimodalBlockSupported` no longer takes a `model` argument. Consumers on older `@langchain/openai` versions will see generic (non-PDF) file attachments replaced with a placeholder, since `fileMimeTypes` won't be populated yet — upgrade `@langchain/openai` to restore support.
