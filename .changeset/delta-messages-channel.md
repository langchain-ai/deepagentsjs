---
"deepagents": minor
---

`createDeepAgent` stores `messages` as per-step deltas with a full copy every 50 updates, as Python deepagents does. Checkpoints no longer copy the whole conversation at every step. On a 100-step `StateBackend` run, total checkpoint data falls from 114.8 MB to 45.1 MB, and stored messages and their writes from 72.1 MB to 2.4 MB. `getState` returns the same messages with the same ids, and threads saved by earlier versions load and continue in place.

Runs are faster and use less memory. On `MemorySaver`, a 100-step run with 40 KB tool results takes 0.64 ms per step against 3.49 ms before this change, and peaks at 334 MB against 811 MB.

Loading a thread replays the message writes since the last full copy, and the checkpoint saver decides what that costs. `@langchain/langgraph-checkpoint-postgres` 1.1.2 reads one checkpoint at a time, and each read also loads that checkpoint's other channels. With it, `getState` takes 20 ms and 1 query just after a full copy, as before, and up to 47.8 ms and 51 queries just before the next one, against 19.5 ms before this change. With about 100 KB of files the slowest `getState` takes 135 ms and 59 queries, against 16 ms and 1 query, and `getStateHistory` over a 100-step thread takes 4.57 s against 1.26 s in the same run. A paged history read in the Postgres saver, proposed in langchain-ai/langgraphjs#3149, removes most of the load cost. The SQLite saver also reads one checkpoint at a time; its cost has not been measured.

A `stateSchema` passed to `createDeepAgent`, as a `StateSchema` or a zod object, keeps the delta channel for `messages` unless it declares `messages` itself. Subagents store their messages the same way.

Removing a message whose id is not in the state no longer throws. The delta reducer ignores such a removal, where the earlier reducer threw an error.

The `@langchain/langgraph-checkpoint` floor rises to `^1.2.0`. Checkpoint savers replay a step's writes in the order the run applied them from `@langchain/langgraph-checkpoint` 1.2.0 (`MemorySaver`), `@langchain/langgraph-checkpoint-postgres` 1.1.0 and `@langchain/langgraph-checkpoint-sqlite` 1.1.0. Earlier Postgres and SQLite savers return a step's writes by task id or in insertion order, so parallel tool results can come back in another order after a reload. Upgrade them with deepagents.

Downgrading deepagents after it has saved threads is safe only while `@langchain/langgraph` stays at 1.5.1 or later. With LangGraph 1.5.0 or earlier, those threads read as having no messages.
