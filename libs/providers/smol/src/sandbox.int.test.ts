import { describe, expect, it } from "vitest";
import { Machine } from "smolmachines";
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { SmolSandbox } from "./sandbox.js";

const LOCAL_AVAILABLE = Machine.localAvailability().available;
const TIMEOUT = 180_000;

sandboxStandardTests({
  name: "SmolSandbox (local)",
  skip: !LOCAL_AVAILABLE,
  sequential: true,
  timeout: TIMEOUT,
  createSandbox: (options) =>
    SmolSandbox.create({
      image: "node:22-alpine",
      resources: { cpus: 1, memoryMb: 1024, network: true },
      ...options,
    }),
  createUninitializedSandbox: () =>
    new SmolSandbox({
      image: "node:22-alpine",
      resources: { cpus: 1, memoryMb: 1024, network: true },
    }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => `/workspace/${name}`,
});

describe.skipIf(process.env.SMOL_TEST_CLOUD !== "1")("Smol Cloud VM", () => {
  it(
    "executes commands and transfers byte-exact files",
    async () => {
      const sandbox = await SmolSandbox.create({
        target: "cloud",
        image: "node:22-alpine",
        resources: { cpus: 1, memoryMb: 1024, network: true },
        machine: { ttlSeconds: 600 },
        initialFiles: { "nested/hello.txt": "ready" },
      });
      try {
        expect((await sandbox.execute("cat nested/hello.txt")).output).toBe(
          "ready",
        );
        expect((await sandbox.execute("exit 7")).exitCode).toBe(7);
        const bytes = new Uint8Array([0, 255, 1]);
        expect(
          await sandbox.uploadFiles([["nested/odd name.bin", bytes]]),
        ).toEqual([{ path: "nested/odd name.bin", error: null }]);
        expect(await sandbox.downloadFiles(["nested/odd name.bin"])).toEqual([
          { path: "nested/odd name.bin", content: bytes, error: null },
        ]);
        expect(await sandbox.downloadFiles(["nested/missing"])).toEqual([
          { path: "nested/missing", content: null, error: "file_not_found" },
        ]);
      } finally {
        await sandbox.close();
      }
    },
    TIMEOUT,
  );
});

describe.skipIf(!LOCAL_AVAILABLE)("native Smol branch", () => {
  it(
    "branches a warmed agent workspace without sharing later writes",
    async () => {
      const parent = await SmolSandbox.create({
        image: "node:22-alpine",
        resources: { cpus: 1, memoryMb: 1024, network: true },
        machine: { branchable: true },
      });
      let child: Machine | undefined;
      try {
        expect(
          (await parent.execute("printf parent > branch-check.txt")).exitCode,
        ).toBe(0);
        child = await parent.instance.branch(`deepagents-smol-${Date.now()}`);
        expect(
          (await child.exec(["cat", "/workspace/branch-check.txt"])).stdout,
        ).toBe("parent");
        expect(
          (
            await child.exec([
              "sh",
              "-lc",
              "printf child > /workspace/branch-check.txt",
            ])
          ).exitCode,
        ).toBe(0);
        expect((await parent.execute("cat branch-check.txt")).output).toBe(
          "parent",
        );
      } finally {
        await child?.delete();
        await parent.close();
      }
    },
    TIMEOUT,
  );
});
