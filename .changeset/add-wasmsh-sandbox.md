---
"deepagents": minor
"@langchain/wasmsh": minor
---

feat: add @langchain/wasmsh sandbox provider

Adds a new sandbox provider backed by wasmsh, a Bash-compatible shell
runtime compiled to WebAssembly. Runs entirely in-process with no
containers or remote services — works in both Node.js and browser
Web Workers.

- New package `@langchain/wasmsh` with `WasmshSandbox.createNode()` and
  `WasmshSandbox.createBrowserWorker()` factory methods
- Browser build entry for deepagents core (`index.browser.js`)
- `filesystemOptions` parameter on `createDeepAgent` for middleware tuning
- Browser-compatible subagent state handling
