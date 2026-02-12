# Harbor Benchmark Runner for DeepAgents JS

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
  scripts/
    harbor_langsmith.py              # CLI for creating LangSmith datasets & experiments
  src/                               # TypeScript (Node.js side)
    runner.ts                        # Entry point spawned by Python -- creates agent, runs bridge loop
    rpc-sandbox.ts                   # RpcSandbox extends BaseSandbox -- bridges execute() over stdin/stdout
    rpc-protocol.ts                  # JSON-RPC message types and stdio helpers
    index.ts                         # Package exports
  python/                            # Python (Harbor side)
    deepagents_js_harbor/
      wrapper.py                     # DeepAgentsJSWrapper -- extends BaseAgent, spawns Node, proxies exec calls
      upload_to_langsmith.py         # Attach feedback & upload experiment tables to LangSmith
      langsmith_environment.py       # LangSmithEnvironment -- custom Harbor env backed by LangSmith sandbox
      __init__.py
    langsmith-env-config.yaml        # Harbor job config for LangSmith sandbox runs
    pyproject.toml
  Makefile                           # Build + benchmark targets
```

## Quick Start

```bash
# 1. Install Python dependencies
cd libs/harbor/python && uv sync

# 2. Build the TypeScript runner
cd libs/harbor && pnpm build

# 3. Configure API keys (use .env or export directly)
export ANTHROPIC_API_KEY="sk-ant-..."          # Required: For Claude model
export LANGSMITH_API_KEY="lsv2_..."            # Required: For LangSmith tracing & datasets
export LANGCHAIN_TRACING_V2=true               # Required: Enable LangSmith tracing
export LANGSMITH_ENDPOINT="https://api.smith.langchain.com"  # Optional: Default shown

# 4. Run a quick test (1 task, Docker)
make bench-docker
```

## LangSmith Integration

LangSmith provides tracing, observability, and experiment comparison for agent runs. The full workflow:

```
Create Dataset → Create Experiment → Run Benchmark with Tracing → Attach Feedback → Analyze
```

### Prerequisites

Ensure your LangSmith credentials are configured:

```bash
export LANGSMITH_API_KEY=lsv2_...
export LANGCHAIN_TRACING_V2=true
export LANGSMITH_ENDPOINT=https://api.smith.langchain.com  # Optional: defaults to this
```

### Step 1: Create Dataset and Experiment

Create a LangSmith dataset from Harbor benchmark tasks, then create an experiment session to organize your runs:

```bash
# Create a dataset from Harbor tasks (downloads from the Harbor registry)
cd python
uv run python ../scripts/harbor_langsmith.py create-dataset terminal-bench --version 2.0

# Or use a custom LangSmith name (useful if a dataset with the same name already exists)
uv run python ../scripts/harbor_langsmith.py create-dataset terminal-bench --version 2.0 \
  --langsmith-name terminal-bench-js-v1

# Create an experiment session linked to the dataset
uv run python ../scripts/harbor_langsmith.py create-experiment tb2-random-test \
  --name deepagentsjs-baseline-v1
```

The `create-experiment` command outputs the session ID and a direct link to the LangSmith comparison view.

### Step 2: Run Benchmark with Tracing

Set `LANGSMITH_EXPERIMENT` to link all runs to the experiment you created in Step 1:

```bash
# Option 1: Run with experiment tracking (enables side-by-side comparison in LangSmith)
export LANGSMITH_EXPERIMENT="deepagentsjs-baseline-v1"
make bench-docker               # 1 task locally
make bench-docker-all           # All tasks locally
make bench-daytona              # 10 tasks on Daytona (cloud)

# Option 2: Run a specific task
LANGSMITH_EXPERIMENT="deepagentsjs-baseline-v1" make bench-docker TASK=hello-world@1.0

# Option 3: Run harbor directly (customize -n for number of tasks)
cd python
LANGSMITH_EXPERIMENT="deepagentsjs-baseline-v1" uv run harbor run \
  --agent-import-path deepagents_js_harbor:DeepAgentsJSWrapper \
  --dataset terminal-bench@2.0 -n 10 --jobs-dir ../jobs/terminal-bench --env docker

# Option 4: Development mode (simpler project view, no experiment linking)
LANGSMITH_PROJECT="deepagentsjs-dev" make bench-docker
```

### Step 3: Attach Feedback

After the benchmark completes, attach verifier results (pass/fail, reward scores, test pass rate) to the LangSmith traces:

```bash
cd python
uv run python -m deepagents_js_harbor.upload_to_langsmith \
  ../jobs/terminal-bench/<job-dir> \
  --attach-feedback --project-name deepagentsjs-baseline-v1

# Dry run first to see what would happen
uv run python -m deepagents_js_harbor.upload_to_langsmith \
  ../jobs/terminal-bench/<job-dir> \
  --attach-feedback --project-name deepagentsjs-baseline-v1 --dry-run

# Optionally also upload structured experiment table for comparison view
uv run python -m deepagents_js_harbor.upload_to_langsmith \
  ../jobs/terminal-bench/<job-dir> \
  --attach-feedback --upload --dataset-name terminal-bench-js-v1
```

This matches trials to traces via `harbor_session_id` metadata and adds feedback scores:
- **pass** — 1.0 or 0.0 based on verifier result
- **reward** — 0.0-1.0 from Harbor's test results
- **test_pass_rate** — fraction of tests passed

## Analyzing Results

LangSmith captures every LLM call, tool invocation, and performance metric. Combined with Harbor reward scores (added via Step 3), you can filter runs by performance and identify patterns in successful vs. failed runs.

### Common Patterns & Fixes

After running evaluations, analyze failed runs in LangSmith to identify improvement opportunities:

| Pattern                    | Symptom                                              | Potential Fix                              |
|----------------------------|------------------------------------------------------|--------------------------------------------|
| **Poor Planning**          | Agent jumps into coding without reading requirements | Add upfront planning requirement to prompt |
| **Incorrect Tool Usage**   | Uses `bash cat` instead of `read_file`               | Improve tool descriptions with examples    |
| **No Incremental Testing** | Writes 200 lines, then tests once                    | Prompt to test after each logical unit     |
| **Hallucinated Paths**     | Reads files before checking existence                | Add "always `ls` before read" rule         |
| **Wrong Model**            | Model fails on complex reasoning                     | Use more capable model for hard tasks      |

### Agent-Assisted Analysis

Use LangSmith's Insights Agent or your own agent to analyze trajectory data across runs. Task it with identifying common failure patterns, grouping errors by category, and suggesting prompt or tool improvements.

## Running Benchmarks

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
make bench-langsmith TASK=hello-world@1.0
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

## Environment Variables

| Variable               | Required      | Description                                                                    |
| ---------------------- | ------------- | ------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`    | Yes           | API key for Claude models                                                      |
| `DAYTONA_API_KEY`      | For Daytona   | API key for Daytona cloud environments                                         |
| `LANGSMITH_API_KEY`    | For LangSmith | Required for LangSmith sandbox environment, tracing, and dataset management    |
| `LANGCHAIN_TRACING_V2` | For tracing  | Set to `true` to enable LangSmith tracing                                      |
| `LANGSMITH_ENDPOINT`   | No            | LangSmith API endpoint (default: `https://api.smith.langchain.com`)            |
| `LANGSMITH_EXPERIMENT` | No            | Links runs to a LangSmith experiment for side-by-side comparison               |
| `LANGSMITH_PROJECT`    | No            | LangSmith project name for development/ad-hoc runs                             |
| `DEEPAGENTS_JS_RUNNER` | No            | Override path to `runner.js` (auto-detected by default)                        |
| `TASK`                 | No            | Task name for `make bench-docker`/`bench-langsmith` (default: `gpt2-codegolf`) |
