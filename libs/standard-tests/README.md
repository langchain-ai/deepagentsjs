# @langchain/sandbox-standard-tests

Shared integration test suites for [deepagents](https://github.com/langchain-ai/deepagentsjs) sandbox providers. Run a single function call and get comprehensive coverage of the `SandboxBackendProtocol` — lifecycle management, command execution, file I/O, search, and more.

The package is **framework-agnostic** — it works with any test runner that provides `describe`, `it`, `expect`, `beforeAll`, and `afterAll`. A first-class Vitest sub-export is included for convenience.

## Installation

```bash
npm install @langchain/sandbox-standard-tests
```

## Quick start

### With Vitest (recommended)

Import from `@langchain/sandbox-standard-tests/vitest` and the Vitest primitives are injected automatically:

```ts
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { MySandbox } from "./sandbox.js";

sandboxStandardTests({
  name: "MySandbox",
  skip: !process.env.MY_SANDBOX_TOKEN,
  timeout: 120_000,
  createSandbox: (opts) => MySandbox.create({ ...opts }),
  closeSandbox: (sb) => sb.close(),
  resolvePath: (name) => `/tmp/${name}`,
});
```

### With any test runner

Import from the root entry point and pass your runner's primitives via the `runner` config property:

```ts
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MySandbox } from "./sandbox.js";

sandboxStandardTests({
  name: "MySandbox",
  runner: { describe, it, expect, beforeAll, afterAll },
  createSandbox: (opts) => MySandbox.create({ ...opts }),
  closeSandbox: (sb) => sb.close(),
  resolvePath: (name) => `/tmp/${name}`,
});
```

Run with your test runner of choice:

```bash
npx vitest run sandbox.int.test.ts
```

That single `sandboxStandardTests()` call registers **11 describe blocks** covering every method on the sandbox protocol.

## Configuration

`sandboxStandardTests` accepts a `StandardTestsConfig<T>` object:

| Option                       | Type                               | Required | Description                                                                                                                                                |
| ---------------------------- | ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                       | `string`                           | yes      | Display name shown in the test runner (e.g. `"ModalSandbox"`).                                                                                             |
| `runner`                     | `TestRunner`                       | yes\*    | Test-runner primitives (`describe`, `it`, `expect`, `beforeAll`, `afterAll`). \*Optional when importing from `/vitest`.                                    |
| `createSandbox`              | `(opts?) => Promise<T>`            | yes      | Factory that creates and returns a running sandbox. Receives an optional `{ initialFiles }` map.                                                           |
| `resolvePath`                | `(relativePath: string) => string` | yes      | Converts a relative filename (e.g. `"test-file.txt"`) to the provider-specific absolute path (e.g. `"/tmp/test-file.txt"` or `"/home/app/test-file.txt"`). |
| `closeSandbox`               | `(sandbox: T) => Promise<void>`    | no       | Teardown function. If omitted the "close" lifecycle test is skipped.                                                                                       |
| `createUninitializedSandbox` | `() => T`                          | no       | Factory for a sandbox that has **not** been started yet. Enables the two-step initialization test.                                                         |
| `skip`                       | `boolean`                          | no       | Skip the entire suite (useful when credentials are missing).                                                                                               |
| `sequential`                 | `boolean`                          | no       | Run tests sequentially instead of in parallel (useful to avoid provider concurrency limits).                                                               |
| `timeout`                    | `number`                           | no       | Per-test timeout in ms. Defaults to `120_000` (2 min).                                                                                                     |

### `TestRunner`

The `runner` object must provide these five primitives from your test framework:

```ts
interface TestRunner {
  describe: SuiteFn;
  it: TestFn;
  expect: ExpectFn;
  beforeAll: HookFn;
  afterAll: HookFn;
}
```

The `describe` and `it` functions may optionally expose `.skip`, `.skipIf(condition)`, and `.sequential` modifiers. When a modifier is not available the suite gracefully degrades (e.g. `describe.sequential` falls back to `describe`).

### `SandboxInstance`

Your sandbox class must implement the `SandboxInstance` interface, which extends `SandboxBackendProtocol` from `deepagents`:

```ts
interface SandboxInstance extends SandboxBackendProtocol {
  readonly isRunning: boolean;
  uploadFiles(files: Array<[string, Uint8Array]>): MaybePromise<FileUploadResponse[]>;
  downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;
  initialize?(): Promise<void>;
}
```

The key difference from the base protocol is that `uploadFiles` and `downloadFiles` are **required** (they are optional in `SandboxBackendProtocol`).

## What gets tested

| Suite                 | What it covers                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------- |
| **Lifecycle**         | `create`, `isRunning`, `close`, two-step `initialize`                                        |
| **Command execution** | `echo`, exit codes, multiline output, stderr, env vars, non-existent commands                |
| **File operations**   | `uploadFiles`, `downloadFiles`, round-trip integrity                                         |
| **write()**           | New files, parent directory creation, overwrite, special characters, unicode, long content   |
| **read()**            | Basic read, non-existent path, `offset`, `limit`, `offset + limit`, unicode, chunked reads   |
| **edit()**            | Single/multi occurrence, `replaceAll`, not-found handling, special chars, multiline, unicode |
| **lsInfo()**          | Directory listing, empty dirs, hidden files, large directories, absolute paths               |
| **grepRaw()**         | Pattern search, glob filters, case sensitivity, nested directories, unicode                  |
| **globInfo()**        | Wildcards, recursive patterns, extension filters, character classes, deeply nested           |
| **Initial files**     | Basic seeding, nested paths, empty files                                                     |
| **Integration**       | End-to-end write → read → edit workflows, complex directory operations, error handling       |

## Sandbox reuse strategy

To avoid spinning up too many sandbox instances (which can hit provider concurrency limits), the test suite uses a **single shared sandbox** for the majority of tests. Only two kinds of tests create temporary instances:

- **Lifecycle** tests that verify `close` and two-step initialization
- **Initial files** tests that require a fresh sandbox with pre-seeded content

These temporary sandboxes are torn down immediately, so the concurrent sandbox count never exceeds **2**.

## Retry helper

The package exports a `withRetry` utility for working around transient sandbox creation failures (e.g. provider concurrency limits):

```ts
import { withRetry } from "@langchain/sandbox-standard-tests/vitest";

const sandbox = await withRetry(
  () => MySandbox.create({ memoryMb: 512 }),
  5,       // max attempts (default: 5)
  15_000,  // delay between attempts in ms (default: 15 000)
);
```

## Real-world examples

### Remote provider (Modal)

```ts
import { sandboxStandardTests, withRetry } from "@langchain/sandbox-standard-tests/vitest";
import { ModalSandbox } from "./sandbox.js";

const hasCredentials = !!(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

sandboxStandardTests({
  name: "ModalSandbox",
  skip: !hasCredentials,
  timeout: 180_000,
  createSandbox: (opts) =>
    ModalSandbox.create({ imageName: "alpine:3.21", ...opts }),
  createUninitializedSandbox: () =>
    new ModalSandbox({ imageName: "alpine:3.21" }),
  closeSandbox: (sb) => sb.close(),
  resolvePath: (name) => `/tmp/${name}`,
});
```

### Sequential execution (Deno Deploy)

```ts
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { DenoSandbox } from "./sandbox.js";

sandboxStandardTests({
  name: "DenoSandbox",
  skip: !process.env.DENO_DEPLOY_TOKEN,
  sequential: true,
  timeout: 120_000,
  createSandbox: (opts) =>
    DenoSandbox.create({ memoryMb: 768, ...opts }),
  createUninitializedSandbox: () => new DenoSandbox({ memoryMb: 768 }),
  closeSandbox: (sb) => sb.close(),
  resolvePath: (name) => `/home/app/${name}`,
});
```

### Local provider (Node VFS)

```ts
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { VfsSandbox } from "./sandbox.js";

sandboxStandardTests({
  name: "VfsSandbox",
  skip: process.platform === "win32",
  timeout: 30_000,
  createSandbox: (opts) => VfsSandbox.create(opts),
  closeSandbox: (sb) => sb.stop(),
  resolvePath: (name) => name,
});
```

### Custom runner (Bun)

```ts
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MySandbox } from "./sandbox.js";

sandboxStandardTests({
  name: "MySandbox",
  runner: { describe, it, expect, beforeAll, afterAll },
  createSandbox: (opts) => MySandbox.create(opts),
  closeSandbox: (sb) => sb.close(),
  resolvePath: (name) => `/tmp/${name}`,
});
```

## Adding provider-specific tests

After calling `sandboxStandardTests`, you can add provider-specific tests in the same file using standard Vitest `describe` / `it` blocks:

```ts
sandboxStandardTests({ /* ... */ });

describe("MySandbox Provider-Specific Tests", () => {
  it("should support custom image types", async () => {
    const sb = await MySandbox.create({ image: "python:3.12" });
    const result = await sb.execute("python --version");
    expect(result.exitCode).toBe(0);
    await sb.close();
  });
});
```

## License

MIT
