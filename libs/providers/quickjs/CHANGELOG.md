# @langchain/quickjs

## 0.2.5

### Patch Changes

- [#434](https://github.com/langchain-ai/deepagentsjs/pull/434) [`89ee206`](https://github.com/langchain-ai/deepagentsjs/commit/89ee206ba6dd07f895c662755a2058b08fcb5315) Thanks [@hntrl](https://github.com/hntrl)! - bump langgraph + langchain versions

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - feat(deepagents): support multimodal files for backends

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

## 0.2.4

### Patch Changes

- [#395](https://github.com/langchain-ai/deepagentsjs/pull/395) [`92b2657`](https://github.com/langchain-ai/deepagentsjs/commit/92b26577b81979636222eb77e938650e2e4d752c) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): bump langchain deps

## 0.2.3

### Patch Changes

- [#390](https://github.com/langchain-ai/deepagentsjs/pull/390) [`9301a9e`](https://github.com/langchain-ai/deepagentsjs/commit/9301a9efcc86abb7a5225d153770e293ebaa54e8) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): update langchain packages

## 0.2.2

### Patch Changes

- [#362](https://github.com/langchain-ai/deepagentsjs/pull/362) [`028f2f8`](https://github.com/langchain-ai/deepagentsjs/commit/028f2f818f9c4f95e71308fbdc80d035f0709224) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): extend BackendFactory and make it async

## 0.2.1

### Patch Changes

- [#317](https://github.com/langchain-ai/deepagentsjs/pull/317) [`01da088`](https://github.com/langchain-ai/deepagentsjs/commit/01da08863acd74da303b78950050f3df850216fe) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents, quickjs): read store from runtime/config.store instead of config.configurable

  The filesystem middleware was reading the store from `request.config.store` (with a `@ts-expect-error`) and the QuickJS middleware from `config.configurable.__pregel_store`. Both now use the properly typed paths: `request.runtime.store` and `config.store` respectively.

## 0.2.0

### Minor Changes

- [#261](https://github.com/langchain-ai/deepagentsjs/pull/261) [`454fa26`](https://github.com/langchain-ai/deepagentsjs/commit/454fa268041a5ad08af2eff991102079e5d5d50b) Thanks [@hntrl](https://github.com/hntrl)! - feat(quickjs): add `@langchain/quickjs` — sandboxed JavaScript/TypeScript REPL tool
  - New `createQuickJSMiddleware()` providing a WASM-sandboxed QuickJS REPL (`js_eval` tool) with VFS integration, TypeScript support, top-level await, and cross-eval state persistence
  - Programmatic tool calling (PTC): expose any agent tool as a typed async function inside the REPL for code-driven orchestration, batching, and parallel execution
  - Environment variable isolation with secret management: opaque placeholders for secrets, per-tool allowlists, and file-write leak prevention
  - AST-based transform pipeline (acorn + estree-walker + magic-string) for TypeScript stripping, declaration hoisting, and auto-return
