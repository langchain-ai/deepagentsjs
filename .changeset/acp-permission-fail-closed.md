---
"deepagents-acp": patch
---

fix(acp): ask for tool permission before the tool runs, and refuse when the request fails

The permission prompt now runs inside the agent, in front of each of the agent's tool calls, so the tool does not start until the user allows it. A failed permission request, including one from a client that does not implement `session/request_permission`, now rejects the call instead of approving it, as does an option the server did not offer. `langchain` is now a peer dependency.
