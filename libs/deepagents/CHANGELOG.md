# deepagents

## 1.6.2

### Patch Changes

- [#169](https://github.com/langchain-ai/deepagentsjs/pull/169) [`e6d895b`](https://github.com/langchain-ai/deepagentsjs/commit/e6d895bdf9835701153a95cbec0c0763de78cd6a) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(middleware): avoid unnecessary REMOVE_ALL_MESSAGES in PatchToolCallsMiddleware

- [#160](https://github.com/langchain-ai/deepagentsjs/pull/160) [`e4f9f8d`](https://github.com/langchain-ai/deepagentsjs/commit/e4f9f8d8c835dee073c5fc271cbaac1ad90a9647) Thanks [@maahir30](https://github.com/maahir30)! - fix(skills): properly restore skills from StateBackend checkpoint
  - Add `files` channel to `SkillsStateSchema` for StateBackend integration
  - Fix skills restoration check to require non-empty array instead of just non-null
  - Export `FileDataSchema` from fs middleware for reuse

- [`b3cf8e3`](https://github.com/langchain-ai/deepagentsjs/commit/b3cf8e391d98f47f1fb2ee339f775bdf05356123) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): handle empty oldString in performStringReplacement

- [#159](https://github.com/langchain-ai/deepagentsjs/pull/159) [`0fe09a5`](https://github.com/langchain-ai/deepagentsjs/commit/0fe09a51ded895e93973d6d12e8cbd56747fd31d) Thanks [@maahir30](https://github.com/maahir30)! - fix(deepagents): fix memoryMiddleware for statebacken
  - Export FileDataSchema for reuse.
  - Add files to MemoryStateSchema via StateSchema/ReducedValue.
  - Add StateBackend memory tests mirroring skills flow.

- [#172](https://github.com/langchain-ai/deepagentsjs/pull/172) [`c674c61`](https://github.com/langchain-ai/deepagentsjs/commit/c674c619cdee057c5e0d6d7237f61f70886cf193) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): prevent infinite loop when read_file returns large content

- [`0b65b09`](https://github.com/langchain-ai/deepagentsjs/commit/0b65b09864e8618860b8ba002412f4239beae2ac) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): copy LICENSE file into published package

## 1.6.1

### Patch Changes

- [`a0f6960`](https://github.com/langchain-ai/deepagentsjs/commit/a0f69609b85327f339fe162c227696e1a618371f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): use new StateSchema to define middleware schemas

## 1.6.0

### Minor Changes

- [`10c4e8b`](https://github.com/langchain-ai/deepagentsjs/commit/10c4e8b6f805cf682daf4227efc2a98372002fa0) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deepagents): align JS implementation with Python deepagents

## 1.5.1

### Patch Changes

- [#133](https://github.com/langchain-ai/deepagentsjs/pull/133) [`0fa85f6`](https://github.com/langchain-ai/deepagentsjs/commit/0fa85f61695af4ad6cdea4549c798e8219448bbb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deepagents): update deps

## 1.5.0

### Minor Changes

- [`b3bb68b`](https://github.com/langchain-ai/deepagentsjs/commit/b3bb68bcaee21849ce55d32bc350c02f77b7d5dd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deepagents): port backend agnostic skills

- [`b3bb68b`](https://github.com/langchain-ai/deepagentsjs/commit/b3bb68bcaee21849ce55d32bc350c02f77b7d5dd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deepagents): add MemoryMiddleware for AGENTS.md support

### Patch Changes

- [#125](https://github.com/langchain-ai/deepagentsjs/pull/125) [`06a2631`](https://github.com/langchain-ai/deepagentsjs/commit/06a2631b9e0eeefbcc40c637bad93c96f1c8a092) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): align with Python interfaces

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
