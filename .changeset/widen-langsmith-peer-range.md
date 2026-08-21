---
"deepagents": patch
---

chore(deepagents): widen the `langsmith` peer range to `>=0.7.1 <0.10.0`

`^0.7.1` resolves to at most 0.7.17, the last release on that line, so the range was pinned to a line langsmith has moved off. Because langsmith is a real dependency of `@langchain/core` rather than only a peer, the narrow range split installs across two langsmith copies — including inside this workspace, where `libs/deepagents` resolved 0.7.10 while `langchain` and `@langchain/langgraph` beside it resolved 0.8.9. Two copies means two sets of module-level singletons, so widening collapses them onto one.

The upper bound stops below 0.10.0 rather than 1.0.0 because langsmith is pre-1.0 and ships breaking changes in minor bumps, so a new minor should be adopted deliberately instead of pre-authorized.
