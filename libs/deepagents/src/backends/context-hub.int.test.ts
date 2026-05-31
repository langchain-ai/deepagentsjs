import { randomUUID } from "node:crypto";

import { Client } from "langsmith";
import { describe, expect, it, vi } from "vitest";

import { ContextHubBackend } from "./context-hub.js";

const hasCredentials = !!process.env.LANGSMITH_API_KEY;
const describeWithLangSmith = hasCredentials ? describe : describe.skip;

function makeIdentifier(): string {
  return `-/deepagents-ctx-hub-test-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function safeDeleteAgent(identifier: string): Promise<void> {
  try {
    await new Client().deleteAgent(identifier);
  } catch {
    // Cleanup best effort in integration tests.
  }
}

describeWithLangSmith(
  "ContextHubBackend integration",
  { timeout: 180_000 },
  () => {
    it("lazy-creates repos on first write", async () => {
      const identifier = makeIdentifier();
      const backend = new ContextHubBackend(identifier, {
        client: new Client(),
      });
      try {
        const missing = await backend.read("/notes.md");
        expect(missing.error).toBeDefined();

        const write = await backend.write("/notes.md", "# hi");
        expect(write.error).toBeUndefined();
        expect(write.path).toBe("/notes.md");

        const read = await backend.read("/notes.md");
        expect(read.error).toBeUndefined();
        expect(read.content).toBe("# hi");
      } finally {
        await safeDeleteAgent(identifier);
      }
    });

    it("supports CRUD + search operations", async () => {
      const identifier = makeIdentifier();
      const backend = new ContextHubBackend(identifier, {
        client: new Client(),
      });
      try {
        expect(
          (await backend.write("/a.md", "hello\nworld")).error,
        ).toBeUndefined();
        expect(
          (await backend.write("/b.md", "hello again")).error,
        ).toBeUndefined();
        expect(
          (await backend.write("/notes/day1.md", "first note")).error,
        ).toBeUndefined();

        const lsRoot = await backend.ls("/");
        const rootPaths = new Set(
          (lsRoot.files ?? []).map((file) => file.path),
        );
        expect(rootPaths.has("/a.md")).toBe(true);
        expect(rootPaths.has("/b.md")).toBe(true);
        expect(rootPaths.has("/notes")).toBe(true);

        const lsNested = await backend.ls("/notes");
        expect(
          new Set((lsNested.files ?? []).map((file) => file.path)),
        ).toEqual(new Set(["/notes/day1.md"]));

        const grep = await backend.grep("hello");
        expect(
          new Set((grep.matches ?? []).map((match) => match.path)),
        ).toEqual(new Set(["/a.md", "/b.md"]));

        const glob = await backend.glob("*.md");
        const globPaths = new Set((glob.files ?? []).map((file) => file.path));
        expect(globPaths.has("/a.md")).toBe(true);
        expect(globPaths.has("/b.md")).toBe(true);

        const edit = await backend.edit("/a.md", "world", "earth");
        expect(edit.error).toBeUndefined();
        expect(edit.occurrences).toBe(1);

        const updated = await backend.read("/a.md");
        expect(updated.error).toBeUndefined();
        expect(updated.content).toContain("earth");
      } finally {
        await safeDeleteAgent(identifier);
      }
    });

    it("downloadFiles returns bytes for existing files and errors for missing paths", async () => {
      const identifier = makeIdentifier();
      const backend = new ContextHubBackend(identifier, {
        client: new Client(),
      });
      try {
        expect(
          (await backend.write("/blob.txt", "payload")).error,
        ).toBeUndefined();

        const responses = await backend.downloadFiles([
          "/blob.txt",
          "/missing.txt",
        ]);
        expect(responses).toHaveLength(2);
        expect(responses[0].path).toBe("/blob.txt");
        expect(new TextDecoder().decode(responses[0].content!)).toBe("payload");
        expect(responses[0].error).toBeNull();
        expect(responses[1].path).toBe("/missing.txt");
        expect(responses[1].error).toBe("file_not_found");
      } finally {
        await safeDeleteAgent(identifier);
      }
    });

    it("uploadFiles supports partial success and persists valid UTF-8 files", async () => {
      const identifier = makeIdentifier();
      const backend = new ContextHubBackend(identifier, {
        client: new Client(),
      });
      try {
        const responses = await backend.uploadFiles([
          ["/u1.md", new TextEncoder().encode("one")],
          ["/u2.md", new TextEncoder().encode("two")],
          ["/bad.bin", new Uint8Array([0x80, 0xff])],
        ]);

        expect(responses[0].error).toBeNull();
        expect(responses[1].error).toBeNull();
        expect(responses[2].error).toBe("invalid_path");

        const first = await backend.read("/u1.md");
        expect(first.error).toBeUndefined();
        expect(first.content).toBe("one");

        const second = await backend.read("/u2.md");
        expect(second.error).toBeUndefined();
        expect(second.content).toBe("two");
      } finally {
        await safeDeleteAgent(identifier);
      }
    });

    it("persists data across backend instances for the same identifier", async () => {
      const identifier = makeIdentifier();
      const backend = new ContextHubBackend(identifier, {
        client: new Client(),
      });
      try {
        expect(
          (await backend.write("/persist.md", "original")).error,
        ).toBeUndefined();

        const second = new ContextHubBackend(identifier, {
          client: new Client(),
        });
        const result = await second.read("/persist.md");
        expect(result.error).toBeUndefined();
        expect(result.content).toBe("original");
      } finally {
        await safeDeleteAgent(identifier);
      }
    });

    it("surfaces parent-commit conflicts on stale writers", async () => {
      const identifier = makeIdentifier();
      const backend = new ContextHubBackend(identifier, {
        client: new Client(),
      });
      try {
        expect((await backend.write("/shared.md", "v0")).error).toBeUndefined();

        const stale = new ContextHubBackend(identifier, {
          client: new Client(),
        });
        await stale.read("/shared.md");

        expect((await backend.write("/shared.md", "v1")).error).toBeUndefined();

        const staleWrite = await stale.write("/other.md", "should-fail");
        expect(staleWrite.error).toContain("Hub unavailable");
      } finally {
        await safeDeleteAgent(identifier);
      }
    });

    it("uses a single commit for uploadFiles batches", async () => {
      const identifier = makeIdentifier();
      const client = new Client();
      const pushSpy = vi.spyOn(client, "pushAgent");
      const backend = new ContextHubBackend(identifier, { client });

      try {
        const responses = await backend.uploadFiles([
          ["/batch/a.md", new TextEncoder().encode("alpha")],
          ["/batch/b.md", new TextEncoder().encode("beta")],
          ["/batch/c.md", new TextEncoder().encode("gamma")],
          ["/batch/d.md", new TextEncoder().encode("delta")],
        ]);

        expect(responses.every((response) => response.error === null)).toBe(
          true,
        );
        expect(pushSpy).toHaveBeenCalledTimes(1);

        const [, options] = pushSpy.mock.calls[0];
        expect(new Set(Object.keys(options.files))).toEqual(
          new Set(["batch/a.md", "batch/b.md", "batch/c.md", "batch/d.md"]),
        );

        const pulled = await new Client().pullAgent(identifier);
        const pulledPaths = new Set(Object.keys(pulled.files));
        expect(pulledPaths.has("batch/a.md")).toBe(true);
        expect(pulledPaths.has("batch/b.md")).toBe(true);
        expect(pulledPaths.has("batch/c.md")).toBe(true);
        expect(pulledPaths.has("batch/d.md")).toBe(true);
      } finally {
        pushSpy.mockRestore();
        await safeDeleteAgent(identifier);
      }
    });
  },
);
