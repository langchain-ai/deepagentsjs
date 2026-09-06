---
"deepagents": patch
"@langchain/quickjs": patch
---

fix(middleware): omit repeated conversation and state inputs from owned middleware lifecycle traces

Keep middleware spans and outputs, and preserve model/tool tracing and user-supplied middleware policies. Apply the defaults to standalone middleware, subagents, and QuickJS cleanup. Lifecycle chain events also receive the omitted inputs.

Require LangChain 1.5.11-rc.0 and LangGraph 1.4.15-rc.0 or newer for middleware trace-policy support. QuickJS now declares its LangChain peer requirement explicitly.
