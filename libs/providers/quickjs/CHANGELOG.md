# @langchain/quickjs

## 1.0.0-alpha.0

### Patch Changes

- [`4faca20`](https://github.com/langchain-ai/deepagentsjs/commit/4faca20343089ee2d8ecaf4c8ad3b5f8fcf1e8f8) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): support multimodal files for backends

- [`07800c0`](https://github.com/langchain-ai/deepagentsjs/commit/07800c04d56bf2b9cb8ed99f769fd199908fd589) Thanks [@colifran](https://github.com/colifran)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

- Updated dependencies [[`b1a2c8d`](https://github.com/langchain-ai/deepagentsjs/commit/b1a2c8ddaef59f40aebe225cde458ce70d5fbdd3), [`bca71ed`](https://github.com/langchain-ai/deepagentsjs/commit/bca71ed044edc438389a4ca19d81f43dabe01fa7), [`4faca20`](https://github.com/langchain-ai/deepagentsjs/commit/4faca20343089ee2d8ecaf4c8ad3b5f8fcf1e8f8), [`07800c0`](https://github.com/langchain-ai/deepagentsjs/commit/07800c04d56bf2b9cb8ed99f769fd199908fd589), [`6b76b39`](https://github.com/langchain-ai/deepagentsjs/commit/6b76b39cfc6a87ccb034d6e27888f7f6f2f91b97)]:
  - deepagents@1.9.0-alpha.0

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
