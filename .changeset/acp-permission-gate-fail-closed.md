---
"deepagents-acp": patch
---

fix(acp): ask for tool permission before the tool runs, and deny when the request fails

The permission request now runs in a tool-call middleware, so a tool only executes after the client allows it. A failed request (including clients without `session/request_permission`) now denies the call instead of allowing it.
