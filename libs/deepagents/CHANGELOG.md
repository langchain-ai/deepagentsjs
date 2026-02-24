# deepagents

## 1.8.1

### Patch Changes

- [#227](https://github.com/langchain-ai/deepagentsjs/pull/227) [`a553936`](https://github.com/langchain-ai/deepagentsjs/commit/a553936c5350ed148282533539491452d8815db2) Thanks [@christian-bromann](https://github.com/christian-bromann)! - docs(deepagents): add streaming examples

- [`d8cb607`](https://github.com/langchain-ai/deepagentsjs/commit/d8cb607e01ffd1b7d1970b29908c401c5154695a) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): filter invalid content blocks from subagent ToolMessage

- [#250](https://github.com/langchain-ai/deepagentsjs/pull/250) [`4bcc9d4`](https://github.com/langchain-ai/deepagentsjs/commit/4bcc9d46cff0d59b113034a42eede0040d4d8ba4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): fix OOM in conversation history offloading

- [#248](https://github.com/langchain-ai/deepagentsjs/pull/248) [`20c7df0`](https://github.com/langchain-ai/deepagentsjs/commit/20c7df08685754f88b5605fa426e9a07694f9a2c) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents): preserve ToolMessage metadata when evicting large outputs

- [#244](https://github.com/langchain-ai/deepagentsjs/pull/244) [`9e04404`](https://github.com/langchain-ai/deepagentsjs/commit/9e04404df2c64528e38d7c77e71bd7226e062fd5) Thanks [@hntrl](https://github.com/hntrl)! - Add `namespace` option to `StoreBackend` for custom store namespace isolation.
  - `StoreBackend` now accepts an optional `{ namespace: string[] }` to control where files are stored in the LangGraph store
  - Enables user-scoped, org-scoped, or any custom isolation pattern when combined with the `backend` factory on `createDeepAgent`
  - Namespace components are validated to prevent wildcard/glob injection
  - Defaults to `["filesystem"]` (or `[assistantId, "filesystem"]` when `assistantId` is set) for backwards compatibility
  - Added integration tests verifying store propagation via invoke config (cloud deployment simulation)

## 1.8.0

### Minor Changes

- [#236](https://github.com/langchain-ai/deepagentsjs/pull/236) [`357a092`](https://github.com/langchain-ai/deepagentsjs/commit/357a092b31a991c57a87bf156c94042a7de70423) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deepagents): add local shell backend

### Patch Changes

- [#230](https://github.com/langchain-ai/deepagentsjs/pull/230) [`a762b91`](https://github.com/langchain-ai/deepagentsjs/commit/a762b91e7a304edc0ad3114a12d78e534f701c1d) Thanks [@alvedder](https://github.com/alvedder)! - chore(deepagents): re-export createSummarizationMiddleware

- [#234](https://github.com/langchain-ai/deepagentsjs/pull/234) [`199c86c`](https://github.com/langchain-ai/deepagentsjs/commit/199c86c013c97fb193fd8f58220c9969fc26da08) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): update summarization behavior

- [#223](https://github.com/langchain-ai/deepagentsjs/pull/223) [`bfa843d`](https://github.com/langchain-ai/deepagentsjs/commit/bfa843d4fe8df5f735307f18ab256098e518c929) Thanks [@maahir30](https://github.com/maahir30)! - fix(deepagents): prevent write_file crash when model omits content
  - Default the content parameter to an empty string so a missing argument doesn't crash the entire agent run via Zod validation failure.

## 1.7.6

### Patch Changes

- [#218](https://github.com/langchain-ai/deepagentsjs/pull/218) [`ae70fa4`](https://github.com/langchain-ai/deepagentsjs/commit/ae70fa400eb3b9710f7917467574d6e08b6583aa) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): pass on subagent name

- [#222](https://github.com/langchain-ai/deepagentsjs/pull/222) [`163c135`](https://github.com/langchain-ai/deepagentsjs/commit/163c1357e8d865dafed181907544ed03b476b650) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): unwrap responseFormat strategy types so structuredResponse is correctly typed

## 1.7.5

### Patch Changes

- [#211](https://github.com/langchain-ai/deepagentsjs/pull/211) [`adce96c`](https://github.com/langchain-ai/deepagentsjs/commit/adce96c7c7a99fd37a2ebbd850984b0793e1f8b4) Thanks [@hntrl](https://github.com/hntrl)! - fix(skills): improve skills middleware input validation and add annotations

  Port of Python PR #1189. Hardens `parseSkillMetadataFromContent` with stricter
  coercion/trimming for all YAML fields, adds Unicode lowercase support in
  `validateSkillName`, validates and truncates compatibility length, handles
  `allowed-tools` as YAML list or space-delimited string, and shows
  license/compatibility annotations in the system prompt skill listing.

- [#210](https://github.com/langchain-ai/deepagentsjs/pull/210) [`2eea576`](https://github.com/langchain-ai/deepagentsjs/commit/2eea576809f5f89ec29ba9f9425f9a113e6db365) Thanks [@hntrl](https://github.com/hntrl)! - refactor(summarization): state rework, move to wrap pattern

  Refactors `createSummarizationMiddleware` to use the `wrapModelCall` hook instead of `beforeModel`. Instead of rewriting LangGraph state with `RemoveMessage(REMOVE_ALL_MESSAGES)` on each summarization, the middleware now tracks a `SummarizationEvent` in private state and reconstructs the effective message list on each call, avoiding full state rewrites. Supports chained summarizations with correct cutoff index progression.

## 1.7.4

### Patch Changes

- [#208](https://github.com/langchain-ai/deepagentsjs/pull/208) [`4ea1858`](https://github.com/langchain-ai/deepagentsjs/commit/4ea18587a3799a1cffcfa706ae00c5b9a89040b3) Thanks [@antonnak](https://github.com/antonnak)! - fix(skills): use systemMessage.concat() instead of systemPrompt string in SkillsMiddleware

  Aligns SkillsMiddleware.wrapModelCall with FilesystemMiddleware and SubAgentMiddleware
  by using request.systemMessage.concat() instead of request.systemPrompt string concatenation.
  This preserves SystemMessage content blocks including cache_control annotations for
  Anthropic prompt caching.

## 1.7.3

### Patch Changes

- [#200](https://github.com/langchain-ai/deepagentsjs/pull/200) [`a837eac`](https://github.com/langchain-ai/deepagentsjs/commit/a837eacb8145b3c5467c56d18946cf7ae1ddb69f) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - fix: normalize path handling for cross-platform compatibility

- [#201](https://github.com/langchain-ai/deepagentsjs/pull/201) [`3f30ba7`](https://github.com/langchain-ai/deepagentsjs/commit/3f30ba7e1dc20ec8c892838392b2df6a2c4155ac) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): cross-platform shell commands for Alpine/BusyBox and macOS

  The BaseSandbox shell commands for lsInfo, globInfo, and grepRaw now work across three environments via runtime detection:
  - GNU Linux (Ubuntu, Debian): uses find -printf for efficient metadata listing
  - BusyBox / Alpine: uses find -exec sh -c with stat -c for size/mtime and POSIX test builtins for file type detection
  - BSD / macOS: uses find -exec stat -f as a fallback

## 1.7.2

### Patch Changes

- [#197](https://github.com/langchain-ai/deepagentsjs/pull/197) [`e4b5892`](https://github.com/langchain-ai/deepagentsjs/commit/e4b5892b0e171cf33b75c8e2c93665ce97f87638) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): runtime agnostic sandbox operations

## 1.7.1

### Patch Changes

- [#194](https://github.com/langchain-ai/deepagentsjs/pull/194) [`731b01e`](https://github.com/langchain-ai/deepagentsjs/commit/731b01ed172dd4cbc0fa45f0189723ad6890f366) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): polish sandbox interfaces

## 1.7.0

### Minor Changes

- [#165](https://github.com/langchain-ai/deepagentsjs/pull/165) [`988b44c`](https://github.com/langchain-ai/deepagentsjs/commit/988b44c129277dea526ba48c56bb34ebf098614d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat: add SandboxProvider abstraction

- [`b5e719c`](https://github.com/langchain-ai/deepagentsjs/commit/b5e719c8aacb1eac74560ac46bc1604d6733b36b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deepagents): support skills in subagents

### Patch Changes

- [`b5e719c`](https://github.com/langchain-ai/deepagentsjs/commit/b5e719c8aacb1eac74560ac46bc1604d6733b36b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore: migrate to use SystemMessage and add tests for filesystem middleware

- [`b5e719c`](https://github.com/langchain-ai/deepagentsjs/commit/b5e719c8aacb1eac74560ac46bc1604d6733b36b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): grep should perform literal search instead of regex (

- [`b5e719c`](https://github.com/langchain-ai/deepagentsjs/commit/b5e719c8aacb1eac74560ac46bc1604d6733b36b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(summarization): resolve fraction trigger bug by using model profile for maxInputTokens

## 1.6.3

### Patch Changes

- [#178](https://github.com/langchain-ai/deepagentsjs/pull/178) [`9f77da4`](https://github.com/langchain-ai/deepagentsjs/commit/9f77da472360dcf0554f468fd15a9e25ab649cd5) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - refactor: migrate memory middleware to use SystemMessage

- [#183](https://github.com/langchain-ai/deepagentsjs/pull/183) [`063436e`](https://github.com/langchain-ai/deepagentsjs/commit/063436e0a023d288698da4ba7d5d2776e20b4f8d) Thanks [@hntrl](https://github.com/hntrl)! - feat: set default recursionLimit to 10k

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
