---
"deepagents": patch
---

Fix `CompositeBackend` matching routes by bare string prefix: a route `/foo` no longer captures `/foobar.txt`. Route prefixes are now normalized to a trailing slash, so `routePrefixes` returns `/foo/`, and `/foo` and `/foo/` register as the same route.
