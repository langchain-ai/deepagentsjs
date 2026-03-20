# @langchain/quickjs

## 0.2.2

### Patch Changes

- [#298](https://github.com/langchain-ai/deepagentsjs/pull/298) [`aab678a`](https://github.com/langchain-ai/deepagentsjs/commit/aab678ad66b2373bea35ee05b1d1340155cf73b2) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): support multimodal files for backends

- [#318](https://github.com/langchain-ai/deepagentsjs/pull/318) [`a5ba74e`](https://github.com/langchain-ai/deepagentsjs/commit/a5ba74eac26bc96a9d9d392f5b7ceffd20abfe07) Thanks [@colifran](https://github.com/colifran)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

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
