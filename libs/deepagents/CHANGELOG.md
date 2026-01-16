# deepagents

## 1.4.2

### Patch Changes

- [`c77537a`](https://github.com/langchain-ai/deepagentsjs/commit/c77537abeb9d02104c938cdf13b3774cd8b1bd03) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): define type bag to better type extraction

## 1.4.1

### Patch Changes

- [#109](https://github.com/langchain-ai/deepagentsjs/pull/109) [`9043796`](https://github.com/langchain-ai/deepagentsjs/commit/90437968e7fddfe08601eec586f705b7b44e618f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): improve type inference

- [#109](https://github.com/langchain-ai/deepagentsjs/pull/109) [`9043796`](https://github.com/langchain-ai/deepagentsjs/commit/90437968e7fddfe08601eec586f705b7b44e618f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): support SystemMessage as prompt

- [#109](https://github.com/langchain-ai/deepagentsjs/pull/109) [`9043796`](https://github.com/langchain-ai/deepagentsjs/commit/90437968e7fddfe08601eec586f705b7b44e618f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): use proper ToolMessage.isInstance

## 1.4.0

### Minor Changes

- [#98](https://github.com/langchain-ai/deepagentsjs/pull/98) [`321ecf3`](https://github.com/langchain-ai/deepagentsjs/commit/321ecf3193be01fd2173123307f43a41f8d2edf5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deepagents): properly infer types from createAgent, also fix "Channel "files" already exists with a different type." bug

## 1.3.1

### Patch Changes

- 27c4211: Fix 'Channel "files" already exists with a different type.' error due to different schema identity

## 1.3.0

### Minor Changes

- 6b914ba: Add CompiledSubAgent back to `createDeepAgent`
- 94b71fb: Allow passing `metadata` to the resulting ToolMessage when editing or saving a file

## 1.2.0

### Minor Changes

- 73445c2: Add readRaw method to filesystem backend protocol

### Patch Changes

- c346110: Fix warnings being shown when creating deep agent
- 3b3e703: fix(store): make sure `getNamespace` can be overridden

## 1.1.1

### Patch Changes

- dbdef4c: thread config options to subagents

## 1.1.0

### Minor Changes

- 39c64e1: Bumping to 1.1.0 because there was an old published version of 1.0.0 which was deprecated

## 1.0.0

### Major Changes

- bd0d712: Bring deepagentsjs up to date with latest 1.0.0 versions of LangChain and LangGraph. Add pluggable backends as well.

  DeepagentsJS now relies on middleware instead of built in tools.
  createDeepAgent's signature has been brought in line with createAgent's signature from LangChain 1.0.

  createDeepAgent now accepts a `backend` field in which users can specify custom backends for the deep agent filesystem.
