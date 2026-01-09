# deepagents-cli

[![npm version](https://badge.fury.io/js/deepagents-cli.svg)](https://www.npmjs.com/package/deepagents-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**DeepAgents CLI** - An AI coding assistant that runs in your terminal, powered by [DeepAgents](https://github.com/langchain-ai/deepagents).

This package wraps the Python [deepagents-cli](https://pypi.org/project/deepagents-cli/) as platform-specific binaries, allowing you to use the full-featured CLI without installing Python.

## Installation

```bash
# Using npm
npm install -g deepagents-cli

# Using pnpm
pnpm add -g deepagents-cli

# Using yarn
yarn global add deepagents-cli

# Or run directly with npx (no installation required)
npx deepagents-cli
```

## Quick Start

```bash
# Start the interactive CLI
deepagents

# Get help
deepagents help

# List available agents
deepagents list
```

## Features

- **Built-in Tools**: File operations (read, write, edit, glob, grep), shell commands, web search, and subagent delegation
- **Customizable Skills**: Add domain-specific capabilities through a progressive disclosure skill system
- **Persistent Memory**: Agent remembers your preferences, coding style, and project context across sessions
- **Project-Aware**: Automatically detects project roots and loads project-specific configurations

## Usage

### Basic Commands

```bash
# Start the CLI (default agent)
deepagents

# Use a specific agent configuration
deepagents --agent mybot

# Use a specific model (auto-detects provider)
deepagents --model claude-sonnet-4-5-20250929
deepagents --model gpt-4o

# Auto-approve tool usage (skip human-in-the-loop prompts)
deepagents --auto-approve

# Execute code in a remote sandbox
deepagents --sandbox modal        # or runloop, daytona
deepagents --sandbox-id dbx_123   # reuse existing sandbox
```

### Skills Management

```bash
# List all skills (global + project)
deepagents skills list

# Create a new skill
deepagents skills create my-skill

# View skill information
deepagents skills info web-research
```

## Environment Variables

Set your API keys:

```bash
# Model providers (at least one required)
export ANTHROPIC_API_KEY="your-key"
export OPENAI_API_KEY="your-key"
export GOOGLE_API_KEY="your-key"

# Optional: Web search
export TAVILY_API_KEY="your-key"

# Optional: LangSmith tracing
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY="your-key"
```

## Supported Platforms

| Platform | Architecture          | Package                        |
| -------- | --------------------- | ------------------------------ |
| Linux    | x64                   | `@deepagents-cli/linux-x64`    |
| Linux    | ARM64                 | `@deepagents-cli/linux-arm64`  |
| macOS    | Intel (x64)           | `@deepagents-cli/darwin-x64`   |
| macOS    | Apple Silicon (ARM64) | `@deepagents-cli/darwin-arm64` |
| Windows  | x64                   | `@deepagents-cli/win32-x64`    |

The appropriate platform package is automatically installed based on your system.

## Troubleshooting

### Binary not found

If you see an error about the binary not being found:

```bash
# Reinstall the package
npm uninstall -g deepagents-cli
npm install -g deepagents-cli
```

### Unsupported platform

If your platform is not supported, please [open an issue](https://github.com/langchain-ai/deepagentsjs/issues).

## Version Synchronization

This package automatically mirrors the version of the Python [deepagents-cli](https://pypi.org/project/deepagents-cli/). New versions are typically available within 24 hours of a PyPI release.

## Programmatic API

You can also use this package programmatically:

```typescript
import { getBinaryPath, isAvailable, getVersion } from "deepagents-cli";

// Check if CLI is available for this platform
if (isAvailable()) {
  const binaryPath = getBinaryPath();
  console.log(`CLI binary at: ${binaryPath}`);
}

// Get installed version
const version = getVersion();
console.log(`Version: ${version}`);
```

## License

MIT - see [LICENSE](https://github.com/langchain-ai/deepagentsjs/blob/main/LICENSE)

## Related

- [deepagents](https://www.npmjs.com/package/deepagents) - The core DeepAgents library for building AI agents
- [deepagents-cli (PyPI)](https://pypi.org/project/deepagents-cli/) - The Python version of this CLI
- [LangGraph](https://github.com/langchain-ai/langgraph) - Framework for building stateful agents
