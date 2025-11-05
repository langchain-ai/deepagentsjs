---
"deepagents": major
---

Bring deepagentsjs up to date with latest 1.0.0 versions of LangChain and LangGraph. Add pluggable backends as well.

DeepagentsJS now relies on middleware intead of built in tools.
createDeepAgent's signature has been brought in line with createAgent's signature from LangChain 1.0.

createDeepAgent now accepts a `backend` field in which users can specify custom backends for the deep agent filesystem.
