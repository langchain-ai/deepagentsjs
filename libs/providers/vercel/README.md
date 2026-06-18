# @langchain/vercel-sandbox

Vercel Sandbox backend for `deepagents`.

## Installation

```bash
pnpm add @langchain/vercel-sandbox @vercel/sandbox deepagents
```

## Usage

```typescript
import { VercelSandbox } from "@langchain/vercel-sandbox";

const sandbox = await VercelSandbox.create({
  runtime: "node24",
});

try {
  const result = await sandbox.execute("node --version");
  console.log(result.output);
} finally {
  await sandbox.close();
}
```

`VercelSandbox.create()` defaults `persistent` to `false` so ordinary Deep Agents usage gets a disposable workspace. Set `persistent: true` or use `getOrCreate()`/`fromName()` when you want Vercel's named sandbox lifecycle.

## File Paths

File operations accept relative and absolute paths. Relative paths resolve
against `sandbox.instance.cwd`, which is usually `/vercel/sandbox` for standard
runtime sandboxes. Image-based sandboxes may use the image's configured working
directory instead.

```typescript
await sandbox.uploadFiles([
  ["src/index.ts", new TextEncoder().encode("console.log('hello')")],
]);

const [file] = await sandbox.downloadFiles(["src/index.ts"]);
```

## Lifecycle

- `close()` deletes the named Vercel sandbox.
- `delete()` explicitly deletes the named Vercel sandbox.
- `stop()` stops the current Vercel session without deleting the named sandbox, preserving snapshot-backed state when `persistent: true`.
- `getOrCreate()` and `fromName()` are the explicit named sandbox entry points.

```typescript
const sandbox = await VercelSandbox.getOrCreate({
  name: "agent-workspace",
  persistent: true,
});

await sandbox.execute("echo persisted > /vercel/sandbox/state.txt");
await sandbox.stop();

const resumed = await VercelSandbox.fromName("agent-workspace");
```

## Command Timeouts

Commands run as `bash -lc` processes. Command timeouts are enforced by the Vercel Sandbox SDK.

```typescript
const sandbox = await VercelSandbox.create({
  commandTimeoutMs: 120_000,
});

await sandbox.execute("npm test");
```

Use `commandTimeoutMs: 0` to wait indefinitely. Negative values throw.
