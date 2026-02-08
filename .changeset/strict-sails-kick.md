---
"@langchain/standard-tests": patch
"@langchain/deno": patch
"deepagents": patch
---

fix(deepagents): cross-platform shell commands for Alpine/BusyBox and macOS

The BaseSandbox shell commands for lsInfo, globInfo, and grepRaw now work across three environments via runtime detection:
- GNU Linux (Ubuntu, Debian): uses find -printf for efficient metadata listing
- BusyBox / Alpine: uses find -exec sh -c with stat -c for size/mtime and POSIX test builtins for file type detection
- BSD / macOS: uses find -exec stat -f as a fallback
