# LangSmith Skills

> **⚠️** — This project is in early development. APIs and skill content may change.

Agent skills for observing and evaluating LLM applications with [LangSmith](https://smith.langchain.com/). Query traces, build evaluation datasets, and create custom evaluators — all from your coding agent.

## Supported Coding Agents

These skills can be installed for any agent supported by [`skills.sh`](https://skills.sh), including Claude Code, [Deep Agents CLI](https://docs.langchain.com/oss/python/deepagents/cli/overview), Cursor, Windsurf, Goose, and [many more](https://github.com/vercel-labs/skills).

## Prerequisites

- A [LangSmith API key](https://smith.langchain.com/)

## Installation

### Quick Install

Using [`npx skills`](https://github.com/vercel-labs/skills):

**Local** (current project):
```bash
npx skills add langchain-ai/langsmith-skills --skill '*' --yes
```

**Global** (all projects):
```bash
npx skills add langchain-ai/langsmith-skills --skill '*' --yes --global
```

To link skills to a specific agent (e.g. Claude Code):
```bash
npx skills add langchain-ai/langsmith-skills --agent claude-code --skill '*' --yes --global
```

---

### Claude Code Plugin

Install directly as a [Claude Code plugin](https://code.claude.com/docs/en/plugins):

```bash
/plugin marketplace add langchain-ai/langsmith-skills
/plugin install langsmith-skills@langsmith-skills
```

---

### Install Script (Claude Code & Deep Agents CLI only)

Alternatively, clone the repo and use the install script:

```bash
# Install for Claude Code in current directory (default)
./install.sh

# Install for Claude Code globally
./install.sh --global

# Install for DeepAgents CLI in current directory
./install.sh --deepagents

# Install for DeepAgents CLI globally (includes agent persona)
./install.sh --deepagents --global
```

| Flag | Description |
|------|-------------|
| `--claude` | Install for Claude Code (default) |
| `--deepagents` | Install for DeepAgents CLI |
| `--global`, `-g` | Install globally instead of current directory |
| `--force`, `-f` | Overwrite skills with same names as this package |
| `--yes`, `-y` | Skip confirmation prompts |

## Usage

After installation, set your API keys:

```bash
export LANGSMITH_API_KEY=<your-key>
export OPENAI_API_KEY=<your-key>      # For OpenAI models
export ANTHROPIC_API_KEY=<your-key>   # For Anthropic models
```

Then run your coding agent from the directory where you installed (for local installs) or from anywhere (for global installs).

## Available Skills (3)

### LangSmith
- **langsmith-trace** - Query and export traces (includes helper scripts)
- **langsmith-dataset** - Generate evaluation datasets from traces (includes helper scripts)
- **langsmith-evaluator** - Create custom evaluators (includes helper scripts)

**Note:** All skills include Python and TypeScript helper scripts for common operations.

## Development

Agent configuration lives in `config/`. To update an existing installation:

```bash
./install.sh --force
```
