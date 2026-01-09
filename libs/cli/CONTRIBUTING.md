# Contributing to deepagents-cli

This document explains how to build, test, and release the deepagents-cli npm package.

## Overview

The `deepagents-cli` npm package wraps the Python [deepagents-cli](https://pypi.org/project/deepagents-cli/) as platform-specific standalone binaries. This allows Node.js users to use the CLI without installing Python.

## Architecture

```txt
PyPI (deepagents-cli)
        ↓
   Build Script (scripts/build.ts)
        ↓
   PyInstaller Bundle
        ↓
   Platform-Specific Binaries
        ↓
   NPM Packages:
   ├── deepagents-cli (main wrapper)
   ├── @deepagents-cli/linux-x64
   ├── @deepagents-cli/linux-arm64
   ├── @deepagents-cli/darwin-x64
   ├── @deepagents-cli/darwin-arm64
   └── @deepagents-cli/win32-x64
```

## Prerequisites

- **Node.js**: >= 18
- **pnpm**: >= 9
- **Python**: 3.11+ (for building binaries)
- **pip**: Latest version

## Development Setup

```bash
# Clone the repository
git clone https://github.com/langchain-ai/deepagentsjs.git
cd deepagentsjs

# Install dependencies
pnpm install

# Navigate to CLI package
cd libs/cli
```

## Building Locally

### Build for Current Platform

```bash
# Build the TypeScript wrapper
pnpm build

# Build the CLI binary (downloads from PyPI, bundles with PyInstaller)
pnpm run build:cli
```

This will:

1. Fetch the latest version from PyPI
2. Create a Python virtual environment
3. Install deepagents-cli in the venv
4. Bundle into a standalone binary using PyInstaller
5. Create a platform package in `dist/platforms/`

### Build Options

```bash
# Build specific version
pnpm run build:cli --version 0.0.12

# Build for specific platform (must match current OS/arch)
pnpm run build:cli --platform darwin-arm64

# Skip download (use existing venv)
pnpm run build:cli --skip-download

# Clean build
pnpm run build:cli --clean

# Show help
pnpm run build:cli --help
```

### Platform-Specific Build Commands

```bash
pnpm run build:cli:linux-x64
pnpm run build:cli:linux-arm64
pnpm run build:cli:darwin-x64
pnpm run build:cli:darwin-arm64
pnpm run build:cli:win32-x64
```

> **Note**: You can only build for the current platform. Cross-compilation is not supported by PyInstaller.

## Testing

### Run Unit Tests

```bash
pnpm test
```

### Test the Built Binary

After building, you can test the binary directly:

```bash
# The binary is in dist/platforms/<platform>/bin/
./dist/platforms/darwin-arm64/bin/deepagents help

# Or test through the wrapper
node dist/cli.js help
```

### Test Package Installation

```bash
# Create a tarball
npm pack

# Install in a test directory
cd /tmp
mkdir test-cli && cd test-cli
npm init -y
npm install /path/to/deepagents-cli-x.x.x.tgz

# Test
npx deepagents help
```

## Release Process

### Automatic Releases

The GitHub Actions workflow (`.github/workflows/cli-release.yml`) automatically:

1. Checks PyPI daily for new versions
2. Builds binaries for all platforms
3. Publishes to npm

### Manual Release

To trigger a manual release:

```bash
# Using GitHub CLI
gh workflow run cli-release.yml

# With specific version
gh workflow run cli-release.yml -f version=0.0.12

# Dry run (no publish)
gh workflow run cli-release.yml -f dry_run=true
```

### Publishing Locally

> **Warning**: This is typically handled by CI. Only do this if you need to publish manually.

```bash
# Build for current platform
pnpm run build:cli --version x.x.x

# Publish platform package
cd dist/platforms/darwin-arm64
npm publish --access public

# Publish main package
cd ../../..
npm publish --access public
```

## Adding a New Platform

1. Add platform config to `scripts/utils.ts`:

   ```typescript
   {
     name: "linux-riscv64",
     os: "linux",
     cpu: "riscv64",
     binaryName: "deepagents",
     runner: "ubuntu-latest-riscv64",  // hypothetical
     pythonVersion: "3.11",
   }
   ```

1. Add to GitHub Actions matrix in `.github/workflows/cli-release.yml`
1. Update `src/index.ts` PLATFORM_MAP
1. Update documentation

## Troubleshooting

### PyInstaller Build Fails

**Missing hidden imports**: Add the module to `scripts/bundle-binary.ts`:

```typescript
hidden_imports = [..."missing_module"];
```

**Binary too large**: Review excludes in the spec file.

### Binary Doesn't Start

Check for missing data files or runtime dependencies. Run with verbose output:

```bash
./deepagents --help 2>&1 | head -50
```

### npm Install Fails

The platform-specific package may not have installed correctly:

```bash
npm uninstall -g deepagents-cli
npm cache clean --force
npm install -g deepagents-cli
```

## Project Structure

```txt
libs/cli/
├── package.json              # Main package configuration
├── tsconfig.json             # TypeScript configuration
├── tsdown.config.ts          # Build configuration
├── vitest.config.ts          # Test configuration
├── README.md                 # User documentation
├── CONTRIBUTING.md           # This file
├── src/
│   ├── index.ts              # Programmatic API
│   ├── index.test.ts         # Unit tests
│   └── cli.ts                # CLI entry point
├── scripts/
│   ├── utils.ts              # Shared utilities
│   ├── fetch-cli.ts          # Download from PyPI
│   ├── bundle-binary.ts      # PyInstaller bundling
│   ├── create-platform-packages.ts  # Platform packages
│   └── build.ts              # Main orchestrator
└── dist/                     # Build output (gitignored)
    ├── index.js              # Compiled API
    ├── cli.js                # Compiled CLI
    └── platforms/            # Platform packages
        ├── linux-x64/
        ├── darwin-arm64/
        └── ...
```

## Related Documentation

- [Main README](./README.md) - User documentation
- [Spec](../../agent-os/specs/2026-01-04-create-deepagent-cli/spec.md) - Technical specification
- [Python CLI](https://github.com/langchain-ai/deepagents/tree/main/libs/deepagents-cli) - Source CLI
