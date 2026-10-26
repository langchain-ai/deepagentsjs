# @langchain/smol

Run Deep Agents commands and filesystem tools inside Smol Machines microVMs. The same backend supports a local VM on macOS Apple Silicon or Linux x86_64/arm64, and a hosted VM on Smol Cloud.

## Install

```sh
npm install deepagents @langchain/smol
```

Local VMs require a working Smol Machines installation and host virtualization. The current `smolmachines` Node package publishes native binaries for macOS arm64 and Linux x86_64/arm64. Cloud VMs require a Smol Cloud login or `SMOL_CLOUD_TOKEN`.

## Use with an agent

```ts
import { createDeepAgent } from "deepagents";
import { SmolSandbox } from "@langchain/smol";

const sandbox = await SmolSandbox.create({
  image: "node:22-alpine",
  resources: { cpus: 2, memoryMb: 2048, network: true },
  initialFiles: { "README.md": "Agent workspace" },
});

try {
  const agent = createDeepAgent({
    model: "anthropic:claude-sonnet-4-5",
    backend: sandbox,
  });
  const result = await agent.invoke({
    messages: [{ role: "user", content: "Summarize the files in /workspace." }],
  });
  console.log(result);
} finally {
  await sandbox.close();
}
```

`target` defaults to `"local"` even if a Cloud token is in the environment. To use a hosted VM, pass `target: "cloud"`; you can pass a token explicitly with `connection: { apiKey: token }`. Cloud machines get a 30-minute TTL by default to bound abandoned sandboxes, which can be changed with `machine: { ttlSeconds: 3600 }`.

```ts
const sandbox = await SmolSandbox.create({
  target: "cloud",
  image: "node:22-alpine",
  machine: { ttlSeconds: 3600 },
});
```

Networking is configured through `resources`: use `network: true` for general egress, or an `allowHosts` list for a restricted agent. Files live under `/workspace` by default; relative paths are resolved there, and absolute paths refer to the guest filesystem. `uploadFiles` and `downloadFiles` return a result for each file. `execute` runs a shell command and reports its exit code, output, and truncation.

The underlying `sandbox.instance` is the native Smol `Machine`. Use it for operations such as checkpoints, branches, and published ports. The caller owns the sandbox's lifetime and must call `close()` to delete the VM, including after agent errors.

To run the live tests, use `pnpm --filter @langchain/smol test:int` on a machine with local virtualization; set `SMOL_TEST_CLOUD=1` to include the Cloud smoke test.
