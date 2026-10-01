---
"deepagents": patch
---

Add `UnsupportedContentMiddleware`, which replaces input content the active model can't accept with a text placeholder before each model call, so a provider rejection doesn't fail every later turn too. `createDeepAgent` and subagents add it automatically, last in the middleware stack. File support is read from `model.profile.fileMimeTypes` (requires `@langchain/core@^1.2.14`, and `@langchain/openai@^1.6.1` for OpenAI/Azure models).

`FilesystemMiddleware` also now recovers from a rejected `read_file` result that filtering missed: it retries once with the content replaced, and persists the swap to state.
