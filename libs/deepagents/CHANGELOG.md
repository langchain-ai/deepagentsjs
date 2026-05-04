# deepagents

## 1.9.1

### Patch Changes

- [#501](https://github.com/langchain-ai/deepagentsjs/pull/501) [`5b0eaea`](https://github.com/langchain-ai/deepagentsjs/commit/5b0eaea7b20461414983b71ba08d26d078b49214) Thanks [@sukhmanghotraa](https://github.com/sukhmanghotraa)! - fix: bump @langchain/core to ^1.1.42 across all workspace packages

- [#442](https://github.com/langchain-ai/deepagentsjs/pull/442) [`e90171a`](https://github.com/langchain-ai/deepagentsjs/commit/e90171abe4bcc76767246be470a7b17b94692f41) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): closer align store backend with Python

- [#496](https://github.com/langchain-ai/deepagentsjs/pull/496) [`8fd575f`](https://github.com/langchain-ai/deepagentsjs/commit/8fd575f06ca27cb0bef1a649aa34124a2c04ddd3) Thanks [@colifran](https://github.com/colifran)! - feat(deepagents): implement functional skills for quickjs middleware

- [#448](https://github.com/langchain-ai/deepagentsjs/pull/448) [`3657941`](https://github.com/langchain-ai/deepagentsjs/commit/3657941ea36b21b9b512c1eb68a250ae79124383) Thanks [@ItayCoCo](https://github.com/ItayCoCo)! - fix: follow symlinks in sandbox find commands by adding -L flag to find invocations in buildLsCommand, buildFindCommand, and buildGrepCommand

- [#486](https://github.com/langchain-ai/deepagentsjs/pull/486) [`998d772`](https://github.com/langchain-ai/deepagentsjs/commit/998d772a07acc76fcc0d419e65b3c74a64d9ac52) Thanks [@colifran](https://github.com/colifran)! - feat(quickjs): remove built-in VFS globals, add PTC instance injection and StateBackend read-your-writes

- [#470](https://github.com/langchain-ai/deepagentsjs/pull/470) [`55f3bd8`](https://github.com/langchain-ai/deepagentsjs/commit/55f3bd8d74cac22d124fd6d1b11538dc2c2c2aec) Thanks [@jacoblee93](https://github.com/jacoblee93)! - Adds agent type metadata prop to configurable

- [#451](https://github.com/langchain-ai/deepagentsjs/pull/451) [`79e20e1`](https://github.com/langchain-ai/deepagentsjs/commit/79e20e18082a19b65094b953cd857908a7525801) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - remove unconditional @langchain/anthropic import

- [#465](https://github.com/langchain-ai/deepagentsjs/pull/465) [`2442d7d`](https://github.com/langchain-ai/deepagentsjs/commit/2442d7d080c8a1008197eda526de52400303dd72) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents): route summarization through active request model

- [#492](https://github.com/langchain-ai/deepagentsjs/pull/492) [`43cd121`](https://github.com/langchain-ai/deepagentsjs/commit/43cd121133562abf0dee76c6db01f2bde0eb3fd3) Thanks [@colifran](https://github.com/colifran)! - implement file system permissions for fs middleware tools

- [#459](https://github.com/langchain-ai/deepagentsjs/pull/459) [`2994444`](https://github.com/langchain-ai/deepagentsjs/commit/2994444f32a6c0503defa6157652e742361abb00) Thanks [@open-swe](https://github.com/apps/open-swe)! - fix(deepagents): skill loading should default to 1000 lines

## 1.9.0

### Minor Changes

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - feat(deepagents): support multimodal files for backends

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - chore(deepagents): refactor backend method names - lsInfo -> ls, grepRaw -> grep, globInfo -> glob

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - feat(sdk): add async subagent middleware for remote LangGraph servers

### Patch Changes

- [#434](https://github.com/langchain-ai/deepagentsjs/pull/434) [`89ee206`](https://github.com/langchain-ai/deepagentsjs/commit/89ee206ba6dd07f895c662755a2058b08fcb5315) Thanks [@hntrl](https://github.com/hntrl)! - bump langgraph + langchain versions

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - feat(deepagents): add completion notifier middleware for async subagents

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - chore(sdk): unify sync subagents and async subagents into a single property

- [#419](https://github.com/langchain-ai/deepagentsjs/pull/419) [`815bc0f`](https://github.com/langchain-ai/deepagentsjs/commit/815bc0fac4b4d0d9b3e7fb97dd64ed8e2bbfb317) Thanks [@colifran](https://github.com/colifran)! - fix: deprecate backend factories and support zero-arg constructors for StateBackend and StoreBackend

- [#422](https://github.com/langchain-ai/deepagentsjs/pull/422) [`dc030a5`](https://github.com/langchain-ai/deepagentsjs/commit/dc030a5238534b8f63bc9d28b1608ded45e2fffc) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - fix: add default value to grep tool glob schema for strict mode compatibility

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - rename completion notifier to completion callback and align names

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - extend supported file types

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents): align prompt templates with runtime behavior
  - Align `read_file` long-line guidance with runtime behavior by rendering `MAX_LINE_LENGTH` in the prompt.
  - Normalize middleware prompt/template text for filesystem, memory, subagents, and summarization to match current behavior and improve consistency.
  - Remove Python-specific phrasing from skills guidance to keep descriptions language-agnostic.

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - clean up factory method middleware wiring

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - chore(sdk): update async subagent middleware for agent protocol

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): AsyncTask updatedAt field doesn't update on task status changes

## 1.9.0-alpha.1

### Patch Changes

- [#419](https://github.com/langchain-ai/deepagentsjs/pull/419) [`815bc0f`](https://github.com/langchain-ai/deepagentsjs/commit/815bc0fac4b4d0d9b3e7fb97dd64ed8e2bbfb317) Thanks [@colifran](https://github.com/colifran)! - fix: deprecate backend factories and support zero-arg constructors for StateBackend and StoreBackend

- [#422](https://github.com/langchain-ai/deepagentsjs/pull/422) [`dc030a5`](https://github.com/langchain-ai/deepagentsjs/commit/dc030a5238534b8f63bc9d28b1608ded45e2fffc) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - fix: add default value to grep tool glob schema for strict mode compatibility

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - rename completion notifier to completion callback and align names

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - extend supported file types

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents): align prompt templates with runtime behavior
  - Align `read_file` long-line guidance with runtime behavior by rendering `MAX_LINE_LENGTH` in the prompt.
  - Normalize middleware prompt/template text for filesystem, memory, subagents, and summarization to match current behavior and improve consistency.
  - Remove Python-specific phrasing from skills guidance to keep descriptions language-agnostic.

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - clean up factory method middleware wiring

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - chore(sdk): update async subagent middleware for agent protocol

- [#404](https://github.com/langchain-ai/deepagentsjs/pull/404) [`ca5cc0a`](https://github.com/langchain-ai/deepagentsjs/commit/ca5cc0acfbbeec08efd4f3aa651bdbefd2008518) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): AsyncTask updatedAt field doesn't update on task status changes

## 1.8.8

### Patch Changes

- [#395](https://github.com/langchain-ai/deepagentsjs/pull/395) [`92b2657`](https://github.com/langchain-ai/deepagentsjs/commit/92b26577b81979636222eb77e938650e2e4d752c) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): bump langchain deps

## 1.8.7

### Patch Changes

- [#357](https://github.com/langchain-ai/deepagentsjs/pull/357) [`2de4302`](https://github.com/langchain-ai/deepagentsjs/commit/2de43020032722d5951a22b2411aa38ea6e5bd1c) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): evict large HumanMessages to filesystem

- [#390](https://github.com/langchain-ai/deepagentsjs/pull/390) [`9301a9e`](https://github.com/langchain-ai/deepagentsjs/commit/9301a9efcc86abb7a5225d153770e293ebaa54e8) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): update langchain packages

## 1.8.6

### Patch Changes

- [#362](https://github.com/langchain-ai/deepagentsjs/pull/362) [`028f2f8`](https://github.com/langchain-ai/deepagentsjs/commit/028f2f818f9c4f95e71308fbdc80d035f0709224) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): extend BackendFactory and make it async

- [#381](https://github.com/langchain-ai/deepagentsjs/pull/381) [`8e6a283`](https://github.com/langchain-ai/deepagentsjs/commit/8e6a28316b8a1cf620192312917a9fd43aa8693c) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): support ttl for LS sandbox

## 1.8.5

### Patch Changes

- [#330](https://github.com/langchain-ai/deepagentsjs/pull/330) [`140e9ef`](https://github.com/langchain-ai/deepagentsjs/commit/140e9ef5176776261ddc0775d1858eb1374a20cb) Thanks [@maahir30](https://github.com/maahir30)! - fix(deepagents): throw on built-in tool collision
  - `createDeepAgent` now throws at construction time if any user-supplied tool name collides with a built-in tool (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`, `task`, `write_todos`). Previously, colliding tools silently shadowed the built-in, causing cryptic schema-validation errors at runtime.

- [#335](https://github.com/langchain-ai/deepagentsjs/pull/335) [`3254f71`](https://github.com/langchain-ai/deepagentsjs/commit/3254f71708de076fb1e17f5065b45318394d0c9e) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - fix(deepagents): remove orphaned ToolMessages for Gemini compatibility

- [#336](https://github.com/langchain-ai/deepagentsjs/pull/336) [`2b76272`](https://github.com/langchain-ai/deepagentsjs/commit/2b76272e9c435b5e23bede7cd79ab4ba8efae2c8) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(deepagents): use `crypto.randomUUID()` instead of uuid

- [#331](https://github.com/langchain-ai/deepagentsjs/pull/331) [`759fe19`](https://github.com/langchain-ai/deepagentsjs/commit/759fe19a776eb0befb55d83b1030824c28704a32) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents): reorder middleware so prompt caching and memory run last

  Move `anthropicPromptCachingMiddleware` and `memoryMiddleware` after all static and user-supplied middleware. This ensures that updates to memory contents do not invalidate Anthropic prompt caches.

- [#332](https://github.com/langchain-ai/deepagentsjs/pull/332) [`3ff382e`](https://github.com/langchain-ai/deepagentsjs/commit/3ff382e2ba0aa3ffa1f7431eec5bdf908075fa74) Thanks [@maahir30](https://github.com/maahir30)! - improve condition for checking sandbox backends

- [#324](https://github.com/langchain-ai/deepagentsjs/pull/324) [`cb352a0`](https://github.com/langchain-ai/deepagentsjs/commit/cb352a0412f2cf66109f7fbe63c65b7d14b0df88) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(deepagent): add LangSmithSandbox

## 1.8.4

### Patch Changes

- [#290](https://github.com/langchain-ai/deepagentsjs/pull/290) [`ab4a515`](https://github.com/langchain-ai/deepagentsjs/commit/ab4a515f37cc166cb5015afa3617f625b343bcbb) Thanks [@maahir30](https://github.com/maahir30)! - Add static structured output to subagent response

- [#289](https://github.com/langchain-ai/deepagentsjs/pull/289) [`5a4df6c`](https://github.com/langchain-ai/deepagentsjs/commit/5a4df6c050284e6024229ece108d58bcff3fdc66) Thanks [@alvedder](https://github.com/alvedder)! - fix(deepagents): move uuid from devDependencies to dependencies

- [#317](https://github.com/langchain-ai/deepagentsjs/pull/317) [`01da088`](https://github.com/langchain-ai/deepagentsjs/commit/01da08863acd74da303b78950050f3df850216fe) Thanks [@hntrl](https://github.com/hntrl)! - fix(deepagents, quickjs): read store from runtime/config.store instead of config.configurable

  The filesystem middleware was reading the store from `request.config.store` (with a `@ts-expect-error`) and the QuickJS middleware from `config.configurable.__pregel_store`. Both now use the properly typed paths: `request.runtime.store` and `config.store` respectively.

## 1.8.3

### Patch Changes

- [#305](https://github.com/langchain-ai/deepagentsjs/pull/305) [`7ffb0b6`](https://github.com/langchain-ai/deepagentsjs/commit/7ffb0b637524ec5469adde419f2ef309d2d78356) Thanks [@tanushree-sharma](https://github.com/tanushree-sharma)! - Add LangSmith integration metadata to deepagentsjs

## 1.8.2

### Patch Changes

- [#261](https://github.com/langchain-ai/deepagentsjs/pull/261) [`454fa26`](https://github.com/langchain-ai/deepagentsjs/commit/454fa268041a5ad08af2eff991102079e5d5d50b) Thanks [@hntrl](https://github.com/hntrl)! - fix(subagents): support PTC invocation of task tool

  Task tool now returns plain string when invoked without a tool call ID (i.e. via programmatic tool calling inside the REPL), instead of throwing.

- [#286](https://github.com/langchain-ai/deepagentsjs/pull/286) [`5f499ed`](https://github.com/langchain-ai/deepagentsjs/commit/5f499ed5af8aeab21dfe7a596a7339eef374d92a) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - fix: delegate CompositeBackend.id to default sandbox backend

- [#281](https://github.com/langchain-ai/deepagentsjs/pull/281) [`1b8bde9`](https://github.com/langchain-ai/deepagentsjs/commit/1b8bde902f071803781761c48a7d3f3c0fec5578) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - fix: add truncation to grep/glob/ls tool results

- [#285](https://github.com/langchain-ai/deepagentsjs/pull/285) [`5af9514`](https://github.com/langchain-ai/deepagentsjs/commit/5af9514ac4f51a909f202eacaabbc13972978791) Thanks [@colifran](https://github.com/colifran)! - fix(deepagents): prompt caching with anthropic models results in higher than expected cache miss rates

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
