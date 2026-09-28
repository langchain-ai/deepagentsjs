---
"deepagents": patch
---

Add `UnsupportedContentMiddleware`, which replaces input content the active model can't accept with a text placeholder before each model call, so a provider rejection doesn't fail every later turn too. `createDeepAgent` and subagents add it automatically, last in the middleware stack.

`FilesystemMiddleware` also now recovers from a rejected `read_file` result that filtering missed: it retries once with the content replaced, and persists the swap to state.
