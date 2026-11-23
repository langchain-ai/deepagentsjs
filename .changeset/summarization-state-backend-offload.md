---
"deepagents": patch
---

fix(deepagents): keep the summarization history offload with createDeepAgent's default StateBackend

With the default backend, the summarization middleware's `/conversation_history/<session>.md` offload never reached the agent's `files`, so the path the summary message points the model at did not exist. The middleware now applies the `filesUpdate` the backend returns, and reads `files` from state so later summarizations append to the file instead of replacing it.
