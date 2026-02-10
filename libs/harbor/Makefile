.PHONY: all build bench-docker bench-docker-all bench-daytona help

AGENT_IMPORT = deepagents_js_harbor:DeepAgentsJSWrapper
PYTHON_DIR = python

# Default target
all: help

######################
# BUILD
######################

build:
	pnpm build

######################
# BENCHMARKS
######################

# Run 1 task on Docker (local, good for quick testing)
# Use TASK=<name> to pick a specific task, e.g.: make bench-docker TASK=gpt2-codegolf
TASK ?= gpt2-codegolf
bench-docker: build
	@mkdir -p jobs/terminal-bench
	cd $(PYTHON_DIR) && uv run harbor run \
		--agent-import-path $(AGENT_IMPORT) \
		--dataset terminal-bench@2.0 -n 1 \
		-t $(TASK) \
		--jobs-dir ../jobs/terminal-bench --env docker

# Run all tasks on Docker (local)
bench-docker-all: build
	@mkdir -p jobs/terminal-bench
	cd $(PYTHON_DIR) && uv run harbor run \
		--agent-import-path $(AGENT_IMPORT) \
		--dataset terminal-bench@2.0 -n 1 \
		--jobs-dir ../jobs/terminal-bench --env docker

# Run 10 concurrent tasks on Daytona (cloud, requires DAYTONA_API_KEY)
bench-daytona: build
	@mkdir -p jobs/terminal-bench
	cd $(PYTHON_DIR) && uv run harbor run \
		--agent-import-path $(AGENT_IMPORT) \
		--dataset terminal-bench@2.0 -n 10 \
		--jobs-dir ../jobs/terminal-bench --env daytona

######################
# HELP
######################

help:
	@echo '===================='
	@echo 'Harbor Benchmark Runner for DeepAgents JS'
	@echo '===================='
	@echo ''
	@echo 'Prerequisites:'
	@echo '  - Run: cd $(PYTHON_DIR) && uv sync'
	@echo '  - Set ANTHROPIC_API_KEY in environment'
	@echo ''
	@echo 'Commands:'
	@echo '  make build              - Build the TypeScript package'
	@echo '  make bench-docker       - Run 1 task on Docker (TASK=gpt2-codegolf)'
	@echo '  make bench-docker-all   - Run all tasks on Docker'
	@echo '  make bench-daytona      - Run 10 tasks on Daytona (cloud)'
	@echo ''
	@echo 'Environment variables:'
	@echo '  TASK                  - Task name for bench-docker (default: gpt2-codegolf)'
	@echo '  ANTHROPIC_API_KEY     - Required for Claude models'
	@echo '  DAYTONA_API_KEY       - Required for Daytona environment'
	@echo '  LANGSMITH_API_KEY     - Optional for LangSmith tracing'
	@echo '  LANGSMITH_EXPERIMENT  - Optional experiment name for LangSmith'
	@echo '  DEEPAGENTS_JS_RUNNER  - Override path to runner.js'
