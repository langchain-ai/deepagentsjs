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
   - Python calls Harbor's `environment.exec()` -- which runs the command in the sandboxed container (Docker, Daytona, or LangSmith) -- and sends the result back as an `exec_response` via stdin
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
      langsmith_environment.py      # LangSmithEnvironment -- custom Harbor env backed by LangSmith sandbox
      __init__.py
    langsmith-env-config.yaml       # Harbor job config for LangSmith sandbox runs
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

### Docker (local)

```bash
# Run a single task
make bench-docker

# Run a specific task
make bench-docker TASK=gpt2-codegolf

# Run all tasks
make bench-docker-all
```

### Daytona (cloud)

```bash
# Run 10 concurrent tasks (requires DAYTONA_API_KEY)
make bench-daytona
```

### LangSmith Sandbox (cloud)

Uses a [LangSmith hosted sandbox](https://docs.smith.langchain.com) instead of Docker/Daytona. This is a custom Harbor environment that uses `--environment-import-path` to plug in a `LangSmithEnvironment` class backed by the `langsmith.sandbox` SDK.

```bash
# Run a single task (requires LANGSMITH_API_KEY)
make bench-langsmith

# Run a specific task
make bench-langsmith TASK=gpt2-codegolf
```

You can also use the YAML config directly with `harbor run`:

```bash
cd python
uv run harbor run \
  --agent-import-path deepagents_js_harbor:DeepAgentsJSWrapper \
  -c langsmith-env-config.yaml \
  --dataset terminal-bench@2.0 -n 1 \
  -t gpt2-codegolf \
  --jobs-dir ../jobs/terminal-bench
```

Or use `harbor trials run` with the CLI flag for a single task:

```bash
cd python
uv run harbor trials run \
  --agent-import-path deepagents_js_harbor:DeepAgentsJSWrapper \
  --environment-import-path "deepagents_js_harbor.langsmith_environment:LangSmithEnvironment" \
  --environment-kwargs template_name=harbor-default \
  --task ./path-to-task
```

The LangSmith environment accepts two kwargs (configurable via `--environment-kwargs` or the YAML config):

- `template_name` -- sandbox template name (default: `harbor-default`)
- `template_image` -- container image for auto-creating the template (default: `python:3.12-slim`)

## Environment variables

| Variable               | Required      | Description                                                                    |
| ---------------------- | ------------- | ------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`    | Yes           | API key for Claude models                                                      |
| `DAYTONA_API_KEY`      | For Daytona   | API key for Daytona cloud environments                                         |
| `LANGSMITH_API_KEY`    | For LangSmith | Required for LangSmith sandbox environment and tracing                         |
| `LANGSMITH_EXPERIMENT` | No            | Links runs to a LangSmith experiment                                           |
| `DEEPAGENTS_JS_RUNNER` | No            | Override path to `runner.js` (auto-detected by default)                        |
| `TASK`                 | No            | Task name for `make bench-docker`/`bench-langsmith` (default: `gpt2-codegolf`) |
