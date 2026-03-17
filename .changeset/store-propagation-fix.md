---
"deepagents": patch
"@langchain/quickjs": patch
---

fix(deepagents, quickjs): read store from runtime/config.store instead of config.configurable

The filesystem middleware was reading the store from `request.config.store` (with a `@ts-expect-error`) and the QuickJS middleware from `config.configurable.__pregel_store`. Both now use the properly typed paths: `request.runtime.store` and `config.store` respectively.
