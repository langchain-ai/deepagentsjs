---
"deepagents": patch
---

fix(deepagents): accept permission paths that exactly equal a composite route

A permission path equal to a single-file mount (e.g. `/instructions.md`) was rejected when the backend supported execution, forcing users to write `/instructions.md/**`. The route-scoping check now also accepts the route root itself. Sibling prefixes such as `/workspace2/**` for route `/workspace` remain rejected.
