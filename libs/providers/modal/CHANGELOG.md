# @langchain/modal

## 0.1.4

### Patch Changes

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - feat(deepagents): support multimodal files for backends

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

## 1.0.0-alpha.0

### Patch Changes

- [`4faca20`](https://github.com/langchain-ai/deepagentsjs/commit/4faca20343089ee2d8ecaf4c8ad3b5f8fcf1e8f8) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): support multimodal files for backends

- [`07800c0`](https://github.com/langchain-ai/deepagentsjs/commit/07800c04d56bf2b9cb8ed99f769fd199908fd589) Thanks [@colifran](https://github.com/colifran)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

- Updated dependencies [[`b1a2c8d`](https://github.com/langchain-ai/deepagentsjs/commit/b1a2c8ddaef59f40aebe225cde458ce70d5fbdd3), [`bca71ed`](https://github.com/langchain-ai/deepagentsjs/commit/bca71ed044edc438389a4ca19d81f43dabe01fa7), [`4faca20`](https://github.com/langchain-ai/deepagentsjs/commit/4faca20343089ee2d8ecaf4c8ad3b5f8fcf1e8f8), [`07800c0`](https://github.com/langchain-ai/deepagentsjs/commit/07800c04d56bf2b9cb8ed99f769fd199908fd589), [`6b76b39`](https://github.com/langchain-ai/deepagentsjs/commit/6b76b39cfc6a87ccb034d6e27888f7f6f2f91b97)]:
  - deepagents@1.9.0-alpha.0

## 0.1.3

### Patch Changes

- [#237](https://github.com/langchain-ai/deepagentsjs/pull/237) [`a827af7`](https://github.com/langchain-ai/deepagentsjs/commit/a827af7be8600e29a2bc8e209fca5b29bcbabc25) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(modal): adding license file

## 0.1.2

### Patch Changes

- [#197](https://github.com/langchain-ai/deepagentsjs/pull/197) [`e4b5892`](https://github.com/langchain-ai/deepagentsjs/commit/e4b5892b0e171cf33b75c8e2c93665ce97f87638) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): runtime agnostic sandbox operations

## 0.1.1

### Patch Changes

- [#194](https://github.com/langchain-ai/deepagentsjs/pull/194) [`731b01e`](https://github.com/langchain-ai/deepagentsjs/commit/731b01ed172dd4cbc0fa45f0189723ad6890f366) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): polish sandbox interfaces

## 0.1.0

### Minor Changes

- [#188](https://github.com/langchain-ai/deepagentsjs/pull/188) [`0d3aa48`](https://github.com/langchain-ai/deepagentsjs/commit/0d3aa4823077449a867032a66f7a3ce4d3a78a99) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(modal): add Modal sandbox provider for DeepAgents

  Adds `@langchain/modal` package providing Modal sandbox integration for the DeepAgents framework.

  Features:
  - Command execution via `execute()` in isolated Modal containers
  - File operations via `uploadFiles()` and `downloadFiles()`
  - Initial file population via `initialFiles` option
  - Direct SDK access via `.client` and `.instance` properties
  - Configurable container images, timeouts, memory, GPU, volumes, and secrets
  - Type-safe options extending Modal SDK's `SandboxCreateParams`

## 0.0.1

### Patch Changes

- Initial release
