---
"deepagents": patch
---

fix(deepagents): add explicit browser and node entrypoints

- add `deepagents/browser` and `deepagents/node` subpath exports
- route browser bundlers to the browser-safe bundle via the root `browser` export condition
- avoid named Node builtin imports in backend utils that can break browser builds
- document browser guidance to import from `deepagents/browser`
