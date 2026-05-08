# @langchain/quickjs

## 0.3.0

### Minor Changes

- [#520](https://github.com/langchain-ai/deepagentsjs/pull/520) [`2548954`](https://github.com/langchain-ai/deepagentsjs/commit/254895457fce2de7df4547ebcf825d60868bacce) Thanks [@colifran](https://github.com/colifran)! - chore(quickjs): rename to REPLMiddleware and adjust defaults

## 0.2.6

### Patch Changes

- [#501](https://github.com/langchain-ai/deepagentsjs/pull/501) [`5b0eaea`](https://github.com/langchain-ai/deepagentsjs/commit/5b0eaea7b20461414983b71ba08d26d078b49214) Thanks [@sukhmanghotraa](https://github.com/sukhmanghotraa)! - fix: bump @langchain/core to ^1.1.42 across all workspace packages

- [#496](https://github.com/langchain-ai/deepagentsjs/pull/496) [`8fd575f`](https://github.com/langchain-ai/deepagentsjs/commit/8fd575f06ca27cb0bef1a649aa34124a2c04ddd3) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): implement functional skills for quickjs middleware

- [#486](https://github.com/langchain-ai/deepagentsjs/pull/486) [`998d772`](https://github.com/langchain-ai/deepagentsjs/commit/998d772a07acc76fcc0d419e65b3c74a64d9ac52) Thanks [@colifran](https://github.com/colifran)! - feat(quickjs): remove built-in VFS globals, add PTC instance injection and StateBackend read-your-writes

- [#498](https://github.com/langchain-ai/deepagentsjs/pull/498) [`192bbd7`](https://github.com/langchain-ai/deepagentsjs/commit/192bbd7109817a826aa6bd982e16b54b5a5c8cb5) Thanks [@colifran](https://github.com/colifran)! - fix(quickjs): bound console buffering at capture time

- [#497](https://github.com/langchain-ai/deepagentsjs/pull/497) [`79dcf9a`](https://github.com/langchain-ai/deepagentsjs/commit/79dcf9ae4567fcce71ea7e529f332baf6a3d6dcd) Thanks [@colifran](https://github.com/colifran)! - feat(quickjs): add maxPtcCallsbudget for ptc calls

- [#492](https://github.com/langchain-ai/deepagentsjs/pull/492) [`43cd121`](https://github.com/langchain-ai/deepagentsjs/commit/43cd121133562abf0dee76c6db01f2bde0eb3fd3) Thanks [@colifran](https://github.com/colifran)! - implement file system permissions for fs middleware tools

- [#494](https://github.com/langchain-ai/deepagentsjs/pull/494) [`e64c7e3`](https://github.com/langchain-ai/deepagentsjs/commit/e64c7e31a7e62929d5d2a9048ad7df3315a546cd) Thanks [@colifran](https://github.com/colifran)! - feat(quickjs): implement delete session in after agent hook to clean up completed repl sessions

- [#499](https://github.com/langchain-ai/deepagentsjs/pull/499) [`352e487`](https://github.com/langchain-ai/deepagentsjs/commit/352e4876679fb708d9690ffeab82363ba02677dc) Thanks [@hntrl](https://github.com/hntrl)! - fix(quickjs): add ls_code_input_language metadata to js_eval tool

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
