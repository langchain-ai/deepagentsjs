# Files

- [Add or Change a Backend Provider](adding-backend-provider.md) - A source-backed recipe for implementing or extending a DeepAgents file or sandbox backend safely. It covers protocol selection, file and command semantics, path and binary invariants, provider authentication and lifecycle, package exports, and focused plus shared conformance tests.
- [End-to-End Agent Run](agent-run.md) - Traces a deepagents request from createDeepAgent configuration through model and middleware selection, tool execution, backend state updates, delegation, summarization, checkpointing, and final output or stream events.
- [Run an Agent in a Sandbox](sandbox-backed-agent.md) - Shows how to resolve provider credentials, create and initialize a sandbox, pass it to deepagents as an execution-capable backend, move files through BaseSandbox, interpret command results, and guarantee provider cleanup. Compares cloud-isolated, host-local, and in-memory execution boundaries.
