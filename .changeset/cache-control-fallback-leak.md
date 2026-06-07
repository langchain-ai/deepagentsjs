---
"deepagents": patch
---

fix(deepagents): gate cache_control writes on per-call request.model

`createCacheBreakpointMiddleware` and `createMemoryMiddleware` were gating
the Anthropic-specific `cache_control` write at agent-creation time only.
When `modelFallbackMiddleware` swapped `request.model` to a non-Anthropic
provider mid-flight (e.g. on Anthropic 5xx), the marker leaked through
and the fallback provider rejected the request with
`400 Unknown parameter: 'cache_control'`. Both middlewares now also
check `isAnthropicModel(request.model)` inside `wrapModelCall`. Fixes #550.
