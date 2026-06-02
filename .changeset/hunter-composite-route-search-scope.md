---
"deepagents": patch
---

fix(backends): scope CompositeBackend grep/glob route fanout by search path

CompositeBackend now limits fallback route fanout to routes mounted under the requested search path, instead of querying all routed backends unconditionally.

This avoids unrelated routed backend calls (and side-effect errors) for scoped searches like `path="/workspace"`, while preserving full fanout behavior at root (`path="/"`).
