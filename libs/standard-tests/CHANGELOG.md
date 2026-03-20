# @langchain/sandbox-standard-tests

## 0.1.1

### Patch Changes

- [#298](https://github.com/langchain-ai/deepagentsjs/pull/298) [`aab678a`](https://github.com/langchain-ai/deepagentsjs/commit/aab678ad66b2373bea35ee05b1d1340155cf73b2) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): support multimodal files for backends

- [#318](https://github.com/langchain-ai/deepagentsjs/pull/318) [`a5ba74e`](https://github.com/langchain-ai/deepagentsjs/commit/a5ba74eac26bc96a9d9d392f5b7ceffd20abfe07) Thanks [@colifran](https://github.com/colifran)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

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
