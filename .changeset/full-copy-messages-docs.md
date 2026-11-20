---
"deepagents": patch
---

docs(deepagents): document that the default delta storage of `messages` needs a checkpointer that keeps a thread's checkpoint history. On a checkpointer that deletes, expires, or overwrites old checkpoints, such as a shallow saver or a saver with a TTL, declare `messages` with `MessagesValue` in `stateSchema` to store full copies.
