---
"@langchain/quickjs": minor
---

feat(quickjs): add `@langchain/quickjs` — sandboxed JavaScript/TypeScript REPL tool

- New `createQuickJSMiddleware()` providing a WASM-sandboxed QuickJS REPL (`js_eval` tool) with VFS integration, TypeScript support, top-level await, and cross-eval state persistence
- Programmatic tool calling (PTC): expose any agent tool as a typed async function inside the REPL for code-driven orchestration, batching, and parallel execution
- Environment variable isolation with secret management: opaque placeholders for secrets, per-tool allowlists, and file-write leak prevention
- AST-based transform pipeline (acorn + estree-walker + magic-string) for TypeScript stripping, declaration hoisting, and auto-return
