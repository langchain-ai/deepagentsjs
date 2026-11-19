---
"deepagents": patch
---

`createDeepAgent` stores a full copy of `messages` in every checkpoint again, as it did before 1.17.0. Storing them as deltas is now something you choose.

Version 1.17.0 stored each step's new messages as deltas by default. A checkpoint saver that deletes or expires old checkpoints, such as a shallow saver or one with a TTL, then lost the messages held only in the checkpoints it removed, with no error. Threads saved by 1.17.0 still load while `@langchain/langgraph` is 1.5.1 or later. LangGraph rebuilds the message list from the stored deltas, and the next checkpoint stores a full copy. Messages a saver already removed do not come back.

To store deltas, declare `messages` with LangGraph's `MessagesDeltaValue` in the agent's `stateSchema`:

```ts
import { MessagesDeltaValue, StateSchema } from "@langchain/langgraph";

const agent = createDeepAgent({
  stateSchema: new StateSchema({ messages: MessagesDeltaValue }),
});
```

- Store deltas only with a saver that keeps every checkpoint of a thread.
- `MessagesDeltaValue` stores a full copy every 100 updates. Version 1.17.0 stored one every 50.
- With deltas, or with any thread that 1.17.0 saved, use `@langchain/langgraph-checkpoint-postgres` 1.1.0 or later, `@langchain/langgraph-checkpoint-mongodb` 1.5.0 or later, or `@langchain/langgraph-checkpoint-sqlite` 1.1.0 or later. Older releases reload parallel tool results out of call order.
- Removing a message whose id is not in the state throws again unless you store deltas.
- The `@langchain/langgraph-checkpoint` floor stays at `^1.2.0`.
