# @langchain/modal

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
