# @langchain/sandbox-standard-tests

## 1.0.0-alpha.0

### Patch Changes

- [`4faca20`](https://github.com/langchain-ai/deepagentsjs/commit/4faca20343089ee2d8ecaf4c8ad3b5f8fcf1e8f8) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): support multimodal files for backends

- [`07800c0`](https://github.com/langchain-ai/deepagentsjs/commit/07800c04d56bf2b9cb8ed99f769fd199908fd589) Thanks [@colifran](https://github.com/colifran)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

- Updated dependencies [[`b1a2c8d`](https://github.com/langchain-ai/deepagentsjs/commit/b1a2c8ddaef59f40aebe225cde458ce70d5fbdd3), [`bca71ed`](https://github.com/langchain-ai/deepagentsjs/commit/bca71ed044edc438389a4ca19d81f43dabe01fa7), [`4faca20`](https://github.com/langchain-ai/deepagentsjs/commit/4faca20343089ee2d8ecaf4c8ad3b5f8fcf1e8f8), [`07800c0`](https://github.com/langchain-ai/deepagentsjs/commit/07800c04d56bf2b9cb8ed99f769fd199908fd589), [`6b76b39`](https://github.com/langchain-ai/deepagentsjs/commit/6b76b39cfc6a87ccb034d6e27888f7f6f2f91b97)]:
  - deepagents@1.9.0-alpha.0

## 0.1.0

### Minor Changes

- [#237](https://github.com/langchain-ai/deepagentsjs/pull/237) [`a827af7`](https://github.com/langchain-ai/deepagentsjs/commit/a827af7be8600e29a2bc8e209fca5b29bcbabc25) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sandbox-standard-tests): allow custom testrunner

## 0.0.2

### Patch Changes

- [#201](https://github.com/langchain-ai/deepagentsjs/pull/201) [`3f30ba7`](https://github.com/langchain-ai/deepagentsjs/commit/3f30ba7e1dc20ec8c892838392b2df6a2c4155ac) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): cross-platform shell commands for Alpine/BusyBox and macOS

  The BaseSandbox shell commands for lsInfo, globInfo, and grepRaw now work across three environments via runtime detection:
  - GNU Linux (Ubuntu, Debian): uses find -printf for efficient metadata listing
  - BusyBox / Alpine: uses find -exec sh -c with stat -c for size/mtime and POSIX test builtins for file type detection
  - BSD / macOS: uses find -exec stat -f as a fallback
