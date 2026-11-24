---
"deepagents-acp": patch
---

fix(acp): default the CLI model to `claude-sonnet-4-6`

The CLI default `claude-sonnet-4-5-20250929` is deprecated and retires on 2026-11-30. The default now matches the one `createDeepAgent` uses.
