---
"deepagents": patch
---

fix(deepagents): declare LangChain runtime packages as peer dependencies

Move `@langchain/core`, `@langchain/langgraph`, `@langchain/langgraph-sdk`, and
`langchain` from `dependencies` to `peerDependencies`, and also declare
`@langchain/langgraph-checkpoint` as a peer (its `BaseCheckpointSaver`/`BaseStore`
types are part of the public API), so they resolve to a single shared instance in
the consumer's tree. Previously they were bundled as regular
dependencies, which let a consumer end up with two copies of `@langchain/core`
(e.g. `1.2.0` vs `1.2.1`). Because these packages ship classes with private/
protected fields, the duplicate copies are treated as nominally distinct types,
producing errors like passing a `ChatOpenAI` model to `createDeepAgent` or a
compiled graph to the local protocol helpers. As peers, the app controls the
version and bumping `@langchain/core` no longer requires a `deepagents` release.
