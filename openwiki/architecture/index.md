# Files

- [Deep Agent Runtime and Public Surface](agent-runtime.md) - Explains the deepagents package entrypoints and traces how createDeepAgent resolves models and harness profiles, assembles deterministic middleware, compiles the LangGraph agent, and exposes typed state and streaming APIs.
- [Backend Protocol and File Storage Architecture](backend-storage.md) - Defines the v1-to-v2 backend contract, structured file and operation results, and runtime resolution. Explains how StateBackend, StoreBackend, FilesystemBackend, CompositeBackend, and protocol adapters divide checkpointed, persistent, local, and routed storage.
