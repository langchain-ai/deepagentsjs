# @langchain/deno

## 0.2.0

### Minor Changes

- [#216](https://github.com/langchain-ai/deepagentsjs/pull/216) [`786053f`](https://github.com/langchain-ai/deepagentsjs/commit/786053fe42e7df66a5d728cd4635a18bde049387) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deno): better support for sandboxes with volume

## 0.1.2

### Patch Changes

- [#201](https://github.com/langchain-ai/deepagentsjs/pull/201) [`3f30ba7`](https://github.com/langchain-ai/deepagentsjs/commit/3f30ba7e1dc20ec8c892838392b2df6a2c4155ac) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): cross-platform shell commands for Alpine/BusyBox and macOS

  The BaseSandbox shell commands for lsInfo, globInfo, and grepRaw now work across three environments via runtime detection:
  - GNU Linux (Ubuntu, Debian): uses find -printf for efficient metadata listing
  - BusyBox / Alpine: uses find -exec sh -c with stat -c for size/mtime and POSIX test builtins for file type detection
  - BSD / macOS: uses find -exec stat -f as a fallback

## 0.1.1

### Patch Changes

- [#194](https://github.com/langchain-ai/deepagentsjs/pull/194) [`731b01e`](https://github.com/langchain-ai/deepagentsjs/commit/731b01ed172dd4cbc0fa45f0189723ad6890f366) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): polish sandbox interfaces

## 0.1.0

### Minor Changes

- [#162](https://github.com/langchain-ai/deepagentsjs/pull/162) [`c0e676a`](https://github.com/langchain-ai/deepagentsjs/commit/c0e676a1a5818e8a22d01b89edccf90834eca3ba) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deno): add support for Deno sandbox

## 0.0.1

### Patch Changes

- Initial release
