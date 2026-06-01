---
"@langchain/node-vfs": patch
---

fix(node-vfs): safely rewrite absolute execute() paths to the sandbox workspace

Update VfsSandbox command rewriting so absolute paths in `execute()` map to the temp execution workspace by default, while preserving known host system roots unless they are explicitly shadowed by VFS entries. This fixes failures like `cp /a.txt /b.txt` and `echo ... > /b.txt`.

Add integration coverage for absolute copy targets, absolute redirection targets, host path passthrough (`/bin/sh`), and VFS precedence when an allowlisted host root (such as `/tmp`) is shadowed in the workspace.
