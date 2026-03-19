---
"deepagents": patch
---

fix(deepagents): reorder middleware so prompt caching and memory run last

Move `anthropicPromptCachingMiddleware` and `memoryMiddleware` after all static and user-supplied middleware. This ensures that updates to memory contents do not invalidate Anthropic prompt caches.
