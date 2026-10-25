---
"deepagents": patch
---

`CompositeBackend.ls` now lists a mounted route as a child directory of its parent. With a route at `/workspace/memories/`, `ls("/workspace")` includes `/workspace/memories/`, and `ls("/")` lists `/workspace/` instead of the full mount path.
