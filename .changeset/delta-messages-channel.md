---
"deepagents": minor
---

`createDeepAgent` stores `messages` as per-step deltas with a full copy every 50 updates, as Python deepagents does, instead of copying the whole conversation into every checkpoint. A 100-step run on `MemorySaver` stores 4.0 MB instead of 112.4 MB, and runs 5.5x faster per step. `getState` returns the same messages, and existing threads continue in place. A custom `stateSchema` keeps the delta channel unless it declares `messages` itself. Subagents defined by a spec still store full copies, while a deep agent passed as a subagent's `runnable` stores deltas.

- Postgres users should upgrade `@langchain/langgraph-checkpoint-postgres` to 1.1.3 or later, which reads the deltas in a few paged queries.
- Removing a message whose id is not in the state is now ignored instead of throwing.
- The `@langchain/langgraph-checkpoint` floor rises to `^1.2.0`. With SQLite, use `@langchain/langgraph-checkpoint-sqlite` 1.1.0 or later so parallel tool results reload in call order.
- Downgrading deepagents after it has saved threads is safe only while `@langchain/langgraph` stays at 1.5.1 or later. Earlier versions read those threads as having no messages.
