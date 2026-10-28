---
"deepagents": minor
---

`createDeepAgent` stores `messages` as per-step deltas with a full copy every 50 updates, as Python deepagents does. Checkpoints no longer copy the whole conversation at every step. On `MemorySaver`, a 100-step run with 10 KB tool results stores 4.0 MB of checkpoints and writes, against 112.4 MB before this change. `getState` returns the same messages with the same ids, and threads saved by earlier versions load and continue in place.

Runs are faster and use less memory. With 40 KB tool results, a 100-step run takes 0.73 ms per step against 4.05 ms before this change, and peaks at 314 MB against 762 MB.

Loading a thread replays the message writes since the last full copy, and the checkpoint saver decides what that costs. Use `@langchain/langgraph-checkpoint-postgres` 1.1.3 or later, which reads that history in a few paged queries. With it, `getState` just before a full copy takes 16 ms against 21 ms before this change, and `getStateHistory` over 206 checkpoints takes 1.4 s against 1.1 s. Version 1.1.2 and earlier read one checkpoint per query, and there `getState` takes up to 48 ms against 20 ms. The SQLite saver also reads one checkpoint at a time; its cost has not been measured.

A `stateSchema` passed to `createDeepAgent`, as a `StateSchema` or a zod object, keeps the delta channel for `messages` unless it declares `messages` itself. Subagents store their messages the same way.

Removing a message whose id is not in the state no longer throws. The delta reducer ignores such a removal, where the earlier reducer threw an error.

The `@langchain/langgraph-checkpoint` floor rises to `^1.2.0`. Checkpoint savers replay a step's writes in the order the run applied them from `@langchain/langgraph-checkpoint` 1.2.0 (`MemorySaver`), `@langchain/langgraph-checkpoint-postgres` 1.1.0 and `@langchain/langgraph-checkpoint-sqlite` 1.1.0. Earlier Postgres and SQLite savers return a step's writes by task id or in insertion order, so parallel tool results can come back in another order after a reload. Upgrade them with deepagents.

Downgrading deepagents after it has saved threads is safe only while `@langchain/langgraph` stays at 1.5.1 or later. With LangGraph 1.5.0 or earlier, those threads read as having no messages.
