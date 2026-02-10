# Harbor Benchmark Runner

Runs deepagents-js against [Harbor](https://github.com/laude-institute/harbor) benchmarks like [terminal-bench](https://github.com/laude-institute/terminal-bench-2).

## Why Python in a JS repo?

Harbor is a Python-only benchmark framework. It can only load Python agent classes that extend `BaseAgent`. Since our agent runs in Node.js, we need a thin Python wrapper that acts as a bridge between the two runtimes.

The Python side is purely glue (~300 lines). It has no dependency on the deepagents Python SDK -- all agent logic runs in Node.js.

## Architecture

```
Harbor (Python)  →  wrapper.py (Python)  →  runner.ts (Node.js)  →  createDeepAgent (JS)
                         ↑                        ↓
                         ↑    exec_request/exec_response
                         ↑    (JSON-RPC over stdin/stdout)
                         ↑                        ↓
                    environment.exec()    ←   RpcSandbox.execute()
                    (runs in sandbox)
```

1. **Harbor calls `run(instruction, environment)`** on our Python wrapper (`DeepAgentsJSWrapper`)
2. **Python spawns a Node.js subprocess** running `runner.ts`, which creates a deepagents agent via `createDeepAgent()`
3. **The two processes communicate via JSON-RPC over stdin/stdout:**
   - When the JS agent needs to execute a shell command (e.g., `ls -la`), the Node process sends an `exec_request` to Python via stdout
   - Python calls Harbor's `environment.exec()` -- which runs the command in the sandboxed Docker/Daytona container -- and sends the result back as an `exec_response` via stdin
   - All higher-level file operations (read, write, edit, grep, glob) are handled inside Node by `BaseSandbox`, which builds shell commands and routes them through `execute()`
4. **When the agent finishes**, Node sends a `done` message with the full message history, and Python saves the trajectory in Harbor's ATIF format

## Directory structure

```
libs/harbor/
  src/                              # TypeScript (Node.js side)
    runner.ts                       # Entry point spawned by Python -- creates agent, runs bridge loop
    rpc-sandbox.ts                  # RpcSandbox extends BaseSandbox -- bridges execute() over stdin/stdout
    rpc-protocol.ts                 # JSON-RPC message types and stdio helpers
    index.ts                        # Package exports
  python/                           # Python (Harbor side)
    deepagents_js_harbor/
      wrapper.py                    # DeepAgentsJSWrapper -- extends BaseAgent, spawns Node, proxies exec calls
      __init__.py
    pyproject.toml
  Makefile                          # Build + benchmark targets
```

## Setup

```bash
# Install Python dependencies
cd libs/harbor/python && uv sync

# Build the TypeScript runner
cd libs/harbor && pnpm build
```

## Running benchmarks

From `libs/harbor/`:

```bash
# Run a single task on Docker (local)
make bench-docker

# Run a specific task
make bench-docker TASK=gpt2-codegolf

# Run all tasks on Docker
make bench-docker-all

# Run 10 concurrent tasks on Daytona (cloud)
make bench-daytona
```

## Environment variables

| Variable               | Required    | Description                                                  |
| ---------------------- | ----------- | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`    | Yes         | API key for Claude models                                    |
| `DAYTONA_API_KEY`      | For Daytona | API key for Daytona cloud environments                       |
| `LANGSMITH_API_KEY`    | No          | Enables LangSmith tracing                                    |
| `LANGSMITH_EXPERIMENT` | No          | Links runs to a LangSmith experiment                         |
| `DEEPAGENTS_JS_RUNNER` | No          | Override path to `runner.js` (auto-detected by default)      |
| `TASK`                 | No          | Task name for `make bench-docker` (default: `gpt2-codegolf`) |
