import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { afterEach, describe, it, expect, vi } from "vitest";
import type { Client } from "langsmith";
import type { Entry } from "langsmith/schemas";

import { ContextHubBackend } from "./context-hub.js";
import { CompositeBackend } from "./composite.js";
import { FilesystemBackend } from "./filesystem.js";

const COMMIT_HASH = "abcd1234".repeat(8);
const COMMIT_URL = commitUrl("ef567890");

function commitUrl(hash: string, targetName = "test-agent"): string {
  return `https://host/context/${targetName}/${hash.slice(0, 8)}?organizationId=org-id`;
}

function makeContext(
  commitHash: string,
  files: Record<string, Entry> = {},
): {
  commit_id: string;
  commit_hash: string;
  files: Record<string, Entry>;
} {
  return {
    commit_id: "00000000-0000-0000-0000-000000000000",
    commit_hash: commitHash,
    files,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

async function advanceMutationWindow(): Promise<void> {
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(50);
  await flushMicrotasks();
}

function makeLangSmithError(
  message: string,
  options: { name?: string; status?: number } = {},
): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  if (options.name) {
    Object.defineProperty(error, "name", { value: options.name });
  }
  if (options.status !== undefined) {
    error.status = options.status;
  }
  return error;
}

function makeBackend(
  files: Record<string, Entry> = {},
  identifier = "-/test-agent",
): {
  backend: ContextHubBackend;
  client: {
    pullAgent: ReturnType<typeof vi.fn>;
    pushAgent: ReturnType<typeof vi.fn>;
  };
} {
  const client = {
    pullAgent: vi.fn().mockResolvedValue(makeContext(COMMIT_HASH, files)),
    pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
  };

  const backend = new ContextHubBackend(identifier, {
    client: client as unknown as Client,
  });
  return { backend, client };
}

describe("ContextHubBackend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("read returns file content", async () => {
    const { backend } = makeBackend({
      "AGENTS.md": { type: "file", content: "# hi\nworld" },
    });

    const result = await backend.read("/AGENTS.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("# hi\nworld");
    expect(result.mimeType).toBe("text/plain");
  });

  it("read missing file returns not found", async () => {
    const { backend } = makeBackend();
    const result = await backend.read("/missing.md");
    expect(result.error).toBe("File '/missing.md' not found");
    expect(result.content).toBeUndefined();
  });

  it("read applies offset and limit", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "1\n2\n3\n4\n5" },
    });

    const result = await backend.read("/a.md", 1, 2);
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("2\n3\n");
  });

  it("read offset beyond file length returns an error", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "1\n2" },
    });

    const result = await backend.read("/a.md", 5, 10);
    expect(result.error).toBe("Line offset 5 exceeds file length (2 lines)");
    expect(result.content).toBeUndefined();
  });

  it("pull runs once for repeated reads", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });

    await backend.read("/a.md");
    await backend.read("/a.md");
    await backend.ls("/");
    expect(client.pullAgent).toHaveBeenCalledTimes(1);
  });

  it("pull 404 is treated as an empty repo", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("not found", {
          name: "LangSmithNotFoundError",
          status: 404,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/new-agent", {
      client: client as unknown as Client,
    });

    const result = await backend.read("/any.md");
    expect(result.error).toBe("File '/any.md' not found");
  });

  it("pull non-404 LangSmith failures surface as hub errors", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("hub 5xx", {
          name: "LangSmithAPIError",
          status: 500,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const result = await backend.read("/anything");
    expect(result.error).toContain("Hub unavailable");
    expect(result.error).toContain("hub 5xx");
  });

  it("unexpected non-LangSmith pull failures propagate", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(new Error("boom")),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    await expect(backend.read("/anything")).rejects.toThrow("boom");
  });

  it("hasPriorCommits is false for missing repo", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("not found", {
          name: "LangSmithNotFoundError",
          status: 404,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/fresh", {
      client: client as unknown as Client,
    });

    await expect(backend.hasPriorCommits()).resolves.toBe(false);
  });

  it("hasPriorCommits is true for an existing repo", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    await expect(backend.hasPriorCommits()).resolves.toBe(true);
  });

  it("hasPriorCommits flips true after first write", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("not found", {
          name: "LangSmithNotFoundError",
          status: 404,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(commitUrl("ef567890", "fresh")),
    };
    const backend = new ContextHubBackend("-/fresh", {
      client: client as unknown as Client,
    });

    expect(await backend.hasPriorCommits()).toBe(false);
    await backend.write("/seed.md", "hello");
    expect(await backend.hasPriorCommits()).toBe(true);
  });

  it("write commits file content", async () => {
    const { backend, client } = makeBackend();
    const result = await backend.write("/notes.md", "# hi");

    expect(result.error).toBeUndefined();
    expect(result.path).toBe("/notes.md");
    expect(client.pushAgent).toHaveBeenCalledTimes(1);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files).toHaveProperty("notes.md");
    expect(options.files["notes.md"]).toEqual({
      type: "file",
      content: "# hi",
    });
  });

  it("write sends parent commit from pull", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    await backend.read("/a.md");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.parentCommit).toBe(COMMIT_HASH);
  });

  it("write updates commit hash from the current push URL shape", async () => {
    const { backend, client } = makeBackend();
    await backend.write("/a.md", "a");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[1];
    expect(options.parentCommit).toBe("ef567890");
  });

  it("write normalizes a bare target name for the current URL shape", async () => {
    const { backend, client } = makeBackend({}, "test-agent");
    client.pushAgent.mockResolvedValueOnce(commitUrl("deadbeef"));

    await backend.write("/a.md", "a");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[1];
    expect(options.parentCommit).toBe("deadbeef");
  });

  it("write updates commit hash from the legacy push URL shape", async () => {
    const { backend, client } = makeBackend();
    client.pushAgent.mockResolvedValueOnce(
      "https://host/hub/-/test-agent:deadbeef",
    );

    await backend.write("/a.md", "a");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[1];
    expect(options.parentCommit).toBe("deadbeef");
  });

  it("write matches the owner in a legacy push URL", async () => {
    const { backend, client } = makeBackend({}, "owner/test-agent");
    client.pushAgent.mockResolvedValueOnce(
      "https://host/hub/owner/test-agent:deadbeef",
    );

    await backend.write("/a.md", "a");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[1];
    expect(options.parentCommit).toBe("deadbeef");
  });

  it("write ignores an identifier version when matching a legacy URL", async () => {
    const { backend, client } = makeBackend({}, "owner/test-agent:version");
    client.pushAgent.mockResolvedValueOnce(
      "https://host/hub/owner/test-agent:deadbeef",
    );

    await backend.write("/a.md", "a");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[1];
    expect(options.parentCommit).toBe("deadbeef");
  });

  it.each([
    [
      "a prefixed context path",
      "https://host/prefix/context/test-agent/deadbeef",
    ],
    ["a non-hub colon suffix", "https://host/not-hub/test-agent:deadbeef"],
    ["an arbitrary colon suffix", "https://host/arbitrary:deadbeef"],
    ["a different current target", "https://host/context/other-agent/deadbeef"],
    [
      "a different legacy owner",
      "https://host/hub/other-owner/test-agent:deadbeef",
    ],
    ["a different legacy target", "https://host/hub/-/other-agent:deadbeef"],
    [
      "a multi-segment current target",
      "https://host/context/owner/test-agent/deadbeef",
    ],
    ["an uppercase hash", "https://host/context/test-agent/DEADBEEF"],
    ["a 9-character hash", "https://host/context/test-agent/deadbeef0"],
    [
      "a 64-character legacy hash",
      `https://host/hub/-/test-agent:${"deadbeef".repeat(8)}`,
    ],
    ["a trailing slash", "https://host/context/test-agent/deadbeef/"],
    ["a trailing legacy slash", "https://host/hub/-/test-agent:deadbeef/"],
    ["a malformed URL", "not a valid URL"],
  ])("reloads after %s", async (_description, invalidUrl) => {
    vi.useFakeTimers();
    const { backend, client } = makeBackend();
    client.pullAgent
      .mockReset()
      .mockResolvedValueOnce(makeContext("base0000"))
      .mockResolvedValueOnce(
        makeContext("authoritative1", {
          "remote.md": { type: "file", content: "remote value" },
        }),
      );
    client.pushAgent.mockResolvedValueOnce(invalidUrl);

    const firstWrite = backend.write("/local.md", "local value");
    await advanceMutationWindow();
    await expect(firstWrite).resolves.toMatchObject({ path: "/local.md" });

    expect(client.pullAgent).toHaveBeenCalledTimes(2);
    await expect(backend.read("/remote.md")).resolves.toMatchObject({
      content: "remote value",
    });

    const secondWrite = backend.write("/next.md", "next value");
    await advanceMutationWindow();
    await expect(secondWrite).resolves.toMatchObject({ path: "/next.md" });
    expect(client.pushAgent.mock.calls[1][1].parentCommit).toBe(
      "authoritative1",
    );
  });

  it("write updates cache after commit", async () => {
    const { backend } = makeBackend();
    await backend.write("/a.md", "hello");

    const result = await backend.read("/a.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("hello");
  });

  it("write allows sibling paths under linked entries", async () => {
    const { backend, client } = makeBackend({
      "skills/code-reviewer": { type: "skill", repo_handle: "code-reviewer" },
    });

    const result = await backend.write("/skills/code-reviewer.md", "sibling");
    expect(result.error).toBeUndefined();
    expect(client.pushAgent).toHaveBeenCalledTimes(1);
  });

  describe("mutation concurrency", () => {
    it("coalesces eight concurrent writes after one cold pull and settles after durability", async () => {
      vi.useFakeTimers();
      const pushed = deferred<string>();
      const { backend, client } = makeBackend();
      client.pushAgent.mockReturnValue(pushed.promise);

      const settled = Array.from({ length: 8 }, () => false);
      const writes = Array.from({ length: 8 }, (_, index) => {
        const write = backend.write(`/file-${index}.md`, `value-${index}`);
        void write.then(() => {
          settled[index] = true;
        });
        return write;
      });

      await advanceMutationWindow();

      expect(client.pullAgent).toHaveBeenCalledTimes(1);
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      const [, options] = client.pushAgent.mock.calls[0];
      expect(Object.keys(options.files).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `file-${index}.md`),
      );
      expect(settled).toEqual(Array.from({ length: 8 }, () => false));

      pushed.resolve(commitUrl("11111111"));
      const results = await Promise.all(writes);

      expect(results.every((result) => result.error === undefined)).toBe(true);
      expect(settled).toEqual(Array.from({ length: 8 }, () => true));
      expect(vi.getTimerCount()).toBe(0);
    });

    it("fans out one failed cold pull to concurrent mutations and lets a new burst recover", async () => {
      vi.useFakeTimers();
      const failedPull = deferred<ReturnType<typeof makeContext>>();
      const { backend, client } = makeBackend();
      client.pullAgent.mockReset().mockReturnValue(failedPull.promise);

      const writes = Array.from({ length: 4 }, (_, index) =>
        backend.write(`/file-${index}.md`, `value-${index}`),
      );
      await flushMicrotasks();
      expect(client.pullAgent).toHaveBeenCalledTimes(1);

      failedPull.reject(
        makeLangSmithError("pull failed", {
          name: "LangSmithAPIError",
          status: 500,
        }),
      );
      const results = await Promise.all(writes);

      expect(
        results.every((result) => result.error?.includes("Hub unavailable")),
      ).toBe(true);
      expect(client.pullAgent).toHaveBeenCalledTimes(1);
      expect(client.pushAgent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      client.pullAgent.mockResolvedValueOnce(makeContext("recovery0"));
      client.pushAgent.mockResolvedValueOnce(commitUrl("11111111"));
      const recovered = backend.write("/recovered.md", "yes");
      await advanceMutationWindow();

      await expect(recovered).resolves.toMatchObject({
        path: "/recovered.md",
      });
      expect(client.pullAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
    });

    it("coalesces mixed write, edit, delete, and upload operations", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend({
        "edit.md": { type: "file", content: "hello world" },
        "delete.md": { type: "file", content: "remove me" },
      });
      await backend.read("/edit.md");

      const write = backend.write("/write.md", "written");
      const edit = backend.edit("/edit.md", "world", "earth");
      const deletion = backend.delete("/delete.md");
      const upload = backend.uploadFiles([
        ["/upload-a.md", new TextEncoder().encode("alpha")],
        ["/upload-b.md", new TextEncoder().encode("beta")],
      ]);

      await advanceMutationWindow();
      const [writeResult, editResult, deleteResult, uploadResult] =
        await Promise.all([write, edit, deletion, upload]);

      expect(writeResult.error).toBeUndefined();
      expect(editResult.error).toBeUndefined();
      expect(deleteResult.error).toBeUndefined();
      expect(uploadResult.every((result) => result.error === null)).toBe(true);
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      const [, options] = client.pushAgent.mock.calls[0];
      expect(options.files).toEqual({
        "write.md": { type: "file", content: "written" },
        "edit.md": { type: "file", content: "hello earth" },
        "delete.md": null,
        "upload-a.md": { type: "file", content: "alpha" },
        "upload-b.md": { type: "file", content: "beta" },
      });
    });

    it("serializes a queued follow-on batch behind an in-flight push", async () => {
      vi.useFakeTimers();
      const firstPush = deferred<string>();
      const secondPush = deferred<string>();
      const { backend, client } = makeBackend();
      client.pushAgent
        .mockImplementationOnce(() => firstPush.promise)
        .mockImplementationOnce(() => secondPush.promise);

      const firstWrite = backend.write("/first.md", "first");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      const secondWrite = backend.write("/second.md", "second");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      firstPush.resolve(commitUrl("11111111"));
      await flushMicrotasks();

      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      const [, secondOptions] = client.pushAgent.mock.calls[1];
      expect(secondOptions.parentCommit).toBe("11111111");
      expect(secondOptions.files).toEqual({
        "second.md": { type: "file", content: "second" },
      });

      secondPush.resolve(commitUrl("22222222"));
      await expect(firstWrite).resolves.toMatchObject({ path: "/first.md" });
      await expect(secondWrite).resolves.toMatchObject({ path: "/second.md" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("exposes pending writes and deletes to read, list, search, and download", async () => {
      vi.useFakeTimers();
      const pushed = deferred<string>();
      const { backend, client } = makeBackend({
        "delete.md": { type: "file", content: "old content" },
      });
      client.pushAgent.mockReturnValue(pushed.promise);
      await backend.read("/delete.md");

      const write = backend.write("/nested/new.md", "pending needle");
      const deletion = backend.delete("/delete.md");
      await flushMicrotasks();

      expect(client.pushAgent).not.toHaveBeenCalled();
      await expect(backend.read("/nested/new.md")).resolves.toMatchObject({
        content: "pending needle",
      });
      await expect(backend.read("/delete.md")).resolves.toMatchObject({
        error: "File '/delete.md' not found",
      });

      const listed = await backend.ls("/");
      expect(listed.files).toContainEqual({ path: "/nested", is_dir: true });
      const grepped = await backend.grep("needle");
      expect(grepped.matches).toContainEqual({
        path: "/nested/new.md",
        line: 1,
        text: "pending needle",
      });
      const globbed = await backend.glob("*.md");
      expect(globbed.files).toContainEqual({
        path: "/nested/new.md",
        is_dir: false,
      });
      const downloaded = await backend.downloadFiles(["/nested/new.md"]);
      expect(new TextDecoder().decode(downloaded[0].content!)).toBe(
        "pending needle",
      );

      await advanceMutationWindow();
      pushed.resolve(commitUrl("11111111"));
      await Promise.all([write, deletion]);
    });

    it("fails in-flight and queued waiters together without an unhandled worker rejection, then recovers", async () => {
      vi.useFakeTimers();
      const failedPush = deferred<string>();
      const { backend, client } = makeBackend();
      client.pushAgent.mockImplementationOnce(() => failedPush.promise);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const firstWrite = backend.write("/first.md", "first");
        await advanceMutationWindow();
        expect(client.pushAgent).toHaveBeenCalledTimes(1);

        const queuedWrite = backend.write("/queued.md", "queued");
        let queuedObserved = false;
        const queuedObservation = queuedWrite.then((result) => {
          queuedObserved = true;
          return result;
        });
        await flushMicrotasks();
        failedPush.reject(
          makeLangSmithError("server failed", {
            name: "LangSmithAPIError",
            status: 500,
          }),
        );

        const firstResult = await firstWrite;
        expect(firstResult.error).toContain("Hub unavailable");
        expect(client.pushAgent).toHaveBeenCalledTimes(1);
        expect(queuedObserved).toBe(false);

        client.pullAgent.mockResolvedValueOnce(
          makeContext("recovery0", {
            "remote.md": { type: "file", content: "remote" },
          }),
        );
        client.pushAgent.mockResolvedValueOnce(commitUrl("33333333"));
        const recovered = backend.write("/recovered.md", "yes");

        const queuedResult = await queuedObservation;
        expect(queuedResult.error).toContain("Hub unavailable");

        await vi.runAllTimersAsync();
        await flushMicrotasks();
        expect(unhandled).toEqual([]);

        await expect(recovered).resolves.toMatchObject({
          path: "/recovered.md",
        });
        expect(client.pullAgent).toHaveBeenCalledTimes(2);
        expect(client.pushAgent).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("re-pulls before accepting a mutation whose preload was invalidated while it waited for its turn", async () => {
      vi.useFakeTimers();
      const failedPush = deferred<string>();
      const { backend, client } = makeBackend({
        "base.md": { type: "file", content: "base" },
      });
      client.pushAgent
        .mockImplementationOnce(() => failedPush.promise)
        .mockResolvedValueOnce(commitUrl("33333333"));
      await backend.read("/base.md");

      const firstWrite = backend.write("/first.md", "first");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      client.pullAgent.mockResolvedValueOnce(
        makeContext("recovery0", {
          "base.md": { type: "file", content: "base" },
        }),
      );
      const failedFollower = backend.write("/failed-follower.md", "failed");
      const survivor = backend.write("/survivor.md", "survivor");

      for (let index = 0; index < 3; index += 1) {
        await Promise.resolve();
      }
      failedPush.reject(
        makeLangSmithError("server failed", {
          name: "LangSmithAPIError",
          status: 500,
        }),
      );
      await flushMicrotasks();

      const [firstResult, followerResult] = await Promise.all([
        firstWrite,
        failedFollower,
      ]);
      expect(firstResult.error).toContain("Hub unavailable");
      expect(followerResult.error).toContain("Hub unavailable");

      await advanceMutationWindow();
      await expect(survivor).resolves.toMatchObject({ path: "/survivor.md" });
      expect(client.pullAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent.mock.calls[1][1]).toMatchObject({
        parentCommit: "recovery0",
        files: {
          "survivor.md": { type: "file", content: "survivor" },
        },
      });
    });

    it("reloads and reapplies the local full-file delta after a 409 conflict", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend();
      client.pullAgent
        .mockReset()
        .mockResolvedValueOnce(
          makeContext("base0000", {
            "shared.md": { type: "file", content: "base" },
          }),
        )
        .mockResolvedValueOnce(
          makeContext("remote01", {
            "shared.md": { type: "file", content: "remote version" },
            "remote.md": { type: "file", content: "unrelated" },
          }),
        );
      client.pushAgent
        .mockReset()
        .mockRejectedValueOnce(
          makeLangSmithError("conflict", {
            name: "LangSmithConflictError",
            status: 409,
          }),
        )
        .mockResolvedValueOnce(commitUrl("22222222"));

      const write = backend.write("/shared.md", "local wins");
      await advanceMutationWindow();
      await expect(write).resolves.toMatchObject({ path: "/shared.md" });

      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent.mock.calls[0][1].parentCommit).toBe("base0000");
      expect(client.pushAgent.mock.calls[1][1]).toMatchObject({
        parentCommit: "remote01",
        files: {
          "shared.md": { type: "file", content: "local wins" },
        },
      });
      await expect(backend.read("/shared.md")).resolves.toMatchObject({
        content: "local wins",
      });
      await expect(backend.read("/remote.md")).resolves.toMatchObject({
        content: "unrelated",
      });
    });

    it("stops after four conflicting pushes and allows the next burst to recover", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend();
      const conflict = makeLangSmithError("conflict", {
        name: "LangSmithConflictError",
        status: 409,
      });
      client.pullAgent
        .mockReset()
        .mockResolvedValueOnce(makeContext("base0000"))
        .mockResolvedValueOnce(makeContext("remote01"))
        .mockResolvedValueOnce(makeContext("remote02"))
        .mockResolvedValueOnce(makeContext("remote03"));
      client.pushAgent.mockReset().mockRejectedValue(conflict);

      const failed = backend.write("/local.md", "local");
      await advanceMutationWindow();
      const failedResult = await failed;

      expect(failedResult.error).toContain("Hub unavailable");
      expect(client.pushAgent).toHaveBeenCalledTimes(4);
      expect(
        client.pushAgent.mock.calls.map(([, options]) => options.parentCommit),
      ).toEqual(["base0000", "remote01", "remote02", "remote03"]);
      expect(client.pullAgent).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);

      client.pullAgent.mockResolvedValueOnce(
        makeContext("recover0", {
          "remote.md": { type: "file", content: "still here" },
        }),
      );
      client.pushAgent.mockResolvedValueOnce(commitUrl("44444444"));
      const recovered = backend.write("/next.md", "next");
      await advanceMutationWindow();

      await expect(recovered).resolves.toMatchObject({ path: "/next.md" });
      expect(client.pullAgent).toHaveBeenCalledTimes(5);
      expect(client.pushAgent).toHaveBeenCalledTimes(5);
    });

    it("uses the last enqueued value for the same path", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend();

      const first = backend.write("/same.md", "first");
      const second = backend.write("/same.md", "second");
      await advanceMutationWindow();
      await Promise.all([first, second]);

      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      expect(client.pushAgent.mock.calls[0][1].files).toEqual({
        "same.md": { type: "file", content: "second" },
      });
      await expect(backend.read("/same.md")).resolves.toMatchObject({
        content: "second",
      });
    });

    it("computes an edit from an in-flight write and commits it in the next batch", async () => {
      vi.useFakeTimers();
      const firstPush = deferred<string>();
      const secondPush = deferred<string>();
      const { backend, client } = makeBackend({
        "same.md": { type: "file", content: "base" },
      });
      client.pushAgent
        .mockImplementationOnce(() => firstPush.promise)
        .mockImplementationOnce(() => secondPush.promise);
      await backend.read("/same.md");

      const write = backend.write("/same.md", "first version");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      const edit = backend.edit("/same.md", "first", "second");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      await expect(backend.read("/same.md")).resolves.toMatchObject({
        content: "second version",
      });

      firstPush.resolve(commitUrl("11111111"));
      await flushMicrotasks();

      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent.mock.calls[1][1]).toMatchObject({
        parentCommit: "11111111",
        files: {
          "same.md": { type: "file", content: "second version" },
        },
      });
      secondPush.resolve(commitUrl("22222222"));

      await expect(write).resolves.toMatchObject({ path: "/same.md" });
      await expect(edit).resolves.toMatchObject({
        path: "/same.md",
        occurrences: 1,
      });
    });

    it("reloads authoritative state after a hashless success without replaying the older batch", async () => {
      vi.useFakeTimers();
      const firstPush = deferred<string>();
      const secondPush = deferred<string>();
      const authoritativePull = deferred<ReturnType<typeof makeContext>>();
      const { backend, client } = makeBackend();
      client.pullAgent
        .mockReset()
        .mockResolvedValueOnce(
          makeContext("base0000", {
            "shared.md": { type: "file", content: "v0" },
          }),
        )
        .mockImplementationOnce(() => authoritativePull.promise);
      client.pushAgent
        .mockReset()
        .mockImplementationOnce(() => firstPush.promise)
        .mockImplementationOnce(() => secondPush.promise);
      await backend.read("/shared.md");

      const firstWrite = backend.write("/shared.md", "older local value");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      const pendingWrite = backend.write("/pending.md", "pending value");
      await advanceMutationWindow();
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      await expect(backend.read("/pending.md")).resolves.toMatchObject({
        content: "pending value",
      });

      firstPush.resolve(
        "https://host/context/test-agent?organizationId=org-id",
      );
      let firstSettled = false;
      void firstWrite.then(() => {
        firstSettled = true;
      });
      await flushMicrotasks();

      expect(client.pullAgent).toHaveBeenCalledTimes(2);
      expect(firstSettled).toBe(false);
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      const readAfterAuthoritativePull = authoritativePull.promise.then(() =>
        backend.read("/shared.md"),
      );
      authoritativePull.resolve(
        makeContext("authoritative1", {
          "shared.md": { type: "file", content: "newer remote value" },
          "remote.md": { type: "file", content: "remote addition" },
        }),
      );
      await expect(readAfterAuthoritativePull).resolves.toMatchObject({
        content: "newer remote value",
      });
      await expect(firstWrite).resolves.toMatchObject({ path: "/shared.md" });
      await flushMicrotasks();

      expect(firstSettled).toBe(true);
      await expect(backend.read("/shared.md")).resolves.toMatchObject({
        content: "newer remote value",
      });
      await expect(backend.read("/remote.md")).resolves.toMatchObject({
        content: "remote addition",
      });
      await expect(backend.read("/pending.md")).resolves.toMatchObject({
        content: "pending value",
      });
      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent.mock.calls[1][1]).toMatchObject({
        parentCommit: "authoritative1",
        files: {
          "pending.md": { type: "file", content: "pending value" },
        },
      });

      secondPush.resolve(commitUrl("33333333"));
      await expect(pendingWrite).resolves.toMatchObject({
        path: "/pending.md",
      });
      await expect(backend.read("/shared.md")).resolves.toMatchObject({
        content: "newer remote value",
      });
    });

    it("rejects a hashless success when its authoritative reload has no commit", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend();
      client.pullAgent
        .mockReset()
        .mockResolvedValueOnce(makeContext("base0000"))
        .mockRejectedValueOnce(
          makeLangSmithError("missing after push", {
            name: "LangSmithNotFoundError",
            status: 404,
          }),
        )
        .mockResolvedValueOnce(
          makeContext("recovery0", {
            "durable.md": { type: "file", content: "durable" },
          }),
        );
      client.pushAgent
        .mockReset()
        .mockResolvedValueOnce("not a valid URL")
        .mockResolvedValueOnce(commitUrl("44444444"));

      const unresolved = backend.write("/durable.md", "durable");
      const unresolvedExpectation = expect(unresolved).rejects.toThrow(
        "Context Hub commit succeeded but its hash could not be resolved",
      );
      await advanceMutationWindow();

      await unresolvedExpectation;
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      expect(client.pullAgent).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);

      const recovered = backend.write("/next.md", "next");
      await advanceMutationWindow();
      await expect(recovered).resolves.toMatchObject({ path: "/next.md" });

      expect(client.pullAgent).toHaveBeenCalledTimes(3);
      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent.mock.calls[1][1]).toMatchObject({
        parentCommit: "recovery0",
        files: {
          "next.md": { type: "file", content: "next" },
        },
      });
    });

    it("does not replay a durable hashless push when its authoritative reload conflicts", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend();
      client.pullAgent
        .mockReset()
        .mockResolvedValueOnce(makeContext("base0000"))
        .mockRejectedValueOnce(
          makeLangSmithError("reload conflict", {
            name: "LangSmithConflictError",
            status: 409,
          }),
        )
        .mockResolvedValueOnce(
          makeContext("recovery0", {
            "durable.md": { type: "file", content: "durable" },
          }),
        );
      client.pushAgent
        .mockReset()
        .mockResolvedValueOnce(
          "https://host/context/test-agent?organizationId=org-id",
        )
        .mockResolvedValueOnce(commitUrl("44444444"));

      const durableWrite = backend.write("/durable.md", "durable");
      await advanceMutationWindow();
      const durableResult = await durableWrite;

      expect(durableResult.error).toContain("Hub unavailable");
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      expect(client.pullAgent).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);

      const recovered = backend.write("/next.md", "next");
      await advanceMutationWindow();
      await expect(recovered).resolves.toMatchObject({ path: "/next.md" });

      expect(client.pullAgent).toHaveBeenCalledTimes(3);
      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(client.pushAgent.mock.calls[1][1]).toMatchObject({
        parentCommit: "recovery0",
        files: {
          "next.md": { type: "file", content: "next" },
        },
      });
    });

    it("leaves no timer after draining and starts a new burst cleanly", async () => {
      vi.useFakeTimers();
      const { backend, client } = makeBackend();

      const first = backend.write("/first.md", "first");
      await advanceMutationWindow();
      await first;

      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.pushAgent).toHaveBeenCalledTimes(1);

      const second = backend.write("/second.md", "second");
      await advanceMutationWindow();
      await second;

      expect(client.pushAgent).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("commit failures invalidate cache and re-pull on next read", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("500", { name: "LangSmithAPIError", status: 500 }),
    );

    const result = await backend.write("/b.md", "b");
    expect(result.error).toContain("Hub unavailable");

    await backend.read("/a.md");
    expect(client.pullAgent).toHaveBeenCalledTimes(2);
  });

  it("delete commits a null entry", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "bye" },
    });

    const result = await backend.delete("/a.md");

    expect(result.error).toBeUndefined();
    expect(result.path).toBe("/a.md");
    expect(client.pushAgent).toHaveBeenCalledTimes(1);
    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files).toHaveProperty("a.md");
    expect(options.files["a.md"]).toBeNull();
    expect(options.parentCommit).toBe(COMMIT_HASH);
  });

  it("delete returns not found without committing when target file is missing", async () => {
    const { backend, client } = makeBackend();

    const result = await backend.delete("/ghost.md");

    expect(result.path).toBeUndefined();
    expect(result.error).toContain("not found");
    expect(client.pushAgent).not.toHaveBeenCalled();
  });

  it("delete updates cache after commit", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "bye" },
    });

    expect((await backend.read("/a.md")).error).toBeUndefined();
    await backend.delete("/a.md");

    expect((await backend.read("/a.md")).error).toContain("not found");
  });

  it("delete failures invalidate cache and re-pull on next read", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("500", { name: "LangSmithAPIError", status: 500 }),
    );

    const result = await backend.delete("/a.md");
    expect(result.error).toContain("Hub unavailable");

    await backend.read("/a.md");
    expect(client.pullAgent).toHaveBeenCalledTimes(2);
  });

  it("edit replaces a single occurrence", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "hello world" },
    });

    const result = await backend.edit("/a.md", "world", "earth");
    expect(result.error).toBeUndefined();
    expect(result.occurrences).toBe(1);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files["a.md"]).toEqual({
      type: "file",
      content: "hello earth",
    });
  });

  it("edit returns not found when target file does not exist", async () => {
    const { backend } = makeBackend();
    const result = await backend.edit("/missing.md", "x", "y");
    expect(result.error).toContain("not found");
  });

  it("edit returns ambiguity error when replaceAll is false", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "x x x" },
    });

    const result = await backend.edit("/a.md", "x", "y");
    expect(result.error).toContain("multiple occurrences");
  });

  it("edit with replaceAll replaces all matches", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "x x x" },
    });

    const result = await backend.edit("/a.md", "x", "y", true);
    expect(result.error).toBeUndefined();
    expect(result.occurrences).toBe(3);
  });

  it("ls supports flat and nested repos", async () => {
    const { backend } = makeBackend({
      "AGENTS.md": { type: "file", content: "a" },
      "memories/day1.md": { type: "file", content: "m1" },
      "memories/day2.md": { type: "file", content: "m2" },
    });

    const root = await backend.ls("/");
    const rootPaths = new Set((root.files ?? []).map((file) => file.path));
    expect(rootPaths.has("/AGENTS.md")).toBe(true);
    expect(rootPaths.has("/memories")).toBe(true);

    const nested = await backend.ls("/memories");
    const nestedPaths = (nested.files ?? []).map((file) => file.path).sort();
    expect(nestedPaths).toEqual(["/memories/day1.md", "/memories/day2.md"]);
  });

  it("ls surfaces pull errors", async () => {
    const client = {
      pullAgent: vi
        .fn()
        .mockRejectedValue(
          makeLangSmithError("5xx", { name: "LangSmithAPIError", status: 500 }),
        ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const result = await backend.ls("/");
    expect(result.error).toContain("Hub unavailable");
  });

  it("grep finds matches and supports path prefixes", async () => {
    const { backend } = makeBackend({
      "memories/a.md": { type: "file", content: "hello" },
      "AGENTS.md": { type: "file", content: "hello" },
    });

    const result = await backend.grep("hello", "/memories");
    const paths = new Set((result.matches ?? []).map((match) => match.path));
    expect(paths).toEqual(new Set(["/memories/a.md"]));
  });

  it("grep treats regex metacharacters as literal text", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "literal [unclosed\nother line" },
    });

    const result = await backend.grep("[unclosed");
    expect(result.error).toBeUndefined();
    expect(result.matches).toEqual([
      { path: "/a.md", line: 1, text: "literal [unclosed" },
    ]);
  });

  it("glob matches file patterns", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "x" },
      "b.txt": { type: "file", content: "y" },
      "c.md": { type: "file", content: "z" },
    });

    const result = await backend.glob("*.md");
    const paths = (result.files ?? []).map((file) => file.path).sort();
    expect(paths).toEqual(["/a.md", "/c.md"]);
  });

  it("glob ignores path argument and matches nested files like Python fnmatch", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "a" },
      "nested/b.md": { type: "file", content: "b" },
      "nested/c.txt": { type: "file", content: "c" },
    });

    const result = await backend.glob("*.md", "/nested");
    const paths = (result.files ?? []).map((file) => file.path).sort();
    expect(paths).toEqual(["/a.md", "/nested/b.md"]);
  });

  it("grep glob follows Python fnmatch semantics for nested paths", async () => {
    const { backend } = makeBackend({
      "root.md": { type: "file", content: "hello" },
      "nested/a.md": { type: "file", content: "hello" },
      "nested/b.txt": { type: "file", content: "hello" },
    });

    const result = await backend.grep("hello", null, "*.md");
    const paths = new Set((result.matches ?? []).map((match) => match.path));
    expect(paths).toEqual(new Set(["/nested/a.md", "/root.md"]));
  });

  it("upload supports partial success and single-commit batching", async () => {
    const { backend, client } = makeBackend();

    const responses = await backend.uploadFiles([
      ["/ok.md", new TextEncoder().encode("hello")],
      ["/bad.bin", new Uint8Array([0x80])],
      ["/also-ok.md", new TextEncoder().encode("world")],
    ]);

    expect(responses[0].error).toBeNull();
    expect(responses[1].error).toBe("invalid_path");
    expect(responses[2].error).toBeNull();
    expect(client.pushAgent).toHaveBeenCalledTimes(1);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(new Set(Object.keys(options.files))).toEqual(
      new Set(["ok.md", "also-ok.md"]),
    );
  });

  it("upload commit failures propagate to valid files", async () => {
    const { backend, client } = makeBackend();
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("503", { name: "LangSmithAPIError", status: 503 }),
    );

    const responses = await backend.uploadFiles([
      ["/a.md", new TextEncoder().encode("alpha")],
      ["/b.md", new TextEncoder().encode("beta")],
      ["/bad.bin", new Uint8Array([0x80])],
    ]);

    expect(responses[0].error).toBe("invalid_path");
    expect(responses[1].error).toBe("invalid_path");
    expect(responses[2].error).toBe("invalid_path");
    expect(client.pushAgent).toHaveBeenCalledTimes(1);
  });

  it("upload commit permission failures map to permission_denied", async () => {
    const { backend, client } = makeBackend();
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("forbidden", {
        name: "LangSmithAuthError",
        status: 403,
      }),
    );

    const responses = await backend.uploadFiles([
      ["/a.md", new TextEncoder().encode("alpha")],
      ["/b.md", new TextEncoder().encode("beta")],
    ]);

    expect(responses[0].error).toBe("permission_denied");
    expect(responses[1].error).toBe("permission_denied");
  });

  it("upload duplicate path keeps last write", async () => {
    const { backend, client } = makeBackend();
    await backend.uploadFiles([
      ["/dup.md", new TextEncoder().encode("first")],
      ["/dup.md", new TextEncoder().encode("second")],
    ]);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files["dup.md"]).toEqual({
      type: "file",
      content: "second",
    });
  });

  it("download returns bytes for existing files and file_not_found for missing", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "hi" },
    });

    const responses = await backend.downloadFiles(["/a.md", "/nope.md"]);
    expect(new TextDecoder().decode(responses[0].content!)).toBe("hi");
    expect(responses[0].error).toBeNull();
    expect(responses[1].error).toBe("file_not_found");
  });

  it("download propagates pull failures", async () => {
    const client = {
      pullAgent: vi
        .fn()
        .mockRejectedValue(
          makeLangSmithError("5xx", { name: "LangSmithAPIError", status: 500 }),
        ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const responses = await backend.downloadFiles(["/a.md"]);
    expect(responses[0].error).toBe("invalid_path");
  });

  it("download permission failures map to permission_denied", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("forbidden", {
          name: "LangSmithAuthError",
          status: 403,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const responses = await backend.downloadFiles(["/a.md", "/b.md"]);
    expect(responses[0].error).toBe("permission_denied");
    expect(responses[1].error).toBe("permission_denied");
  });

  it("getLinkedEntries returns linked repo handles", async () => {
    const { backend } = makeBackend({
      "skills/reviewer": { type: "skill", repo_handle: "reviewer" },
      "subagents/planner": { type: "agent", repo_handle: "planner" },
      "AGENTS.md": { type: "file", content: "a" },
    });

    await expect(backend.getLinkedEntries()).resolves.toEqual({
      "skills/reviewer": "reviewer",
      "subagents/planner": "planner",
    });
  });

  it("files expanded under linked paths remain readable", async () => {
    const { backend } = makeBackend({
      "skills/s": { type: "skill", repo_handle: "s" },
      "skills/s/skill.md": { type: "file", content: "expanded" },
    });

    const result = await backend.read("/skills/s/skill.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("expanded");
  });

  it("composite routing strips and restores route prefixes", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "deepagents-context-hub-composite-"),
    );
    try {
      const { backend: hubBackend, client } = makeBackend();
      const defaultBackend = new FilesystemBackend({
        rootDir: tempDir,
        virtualMode: true,
      });
      const composite = new CompositeBackend(defaultBackend, {
        "/memories/": hubBackend,
      });

      await composite.write("/memories/notes.md", "hello hub");
      const [, options] = client.pushAgent.mock.calls[0];
      expect(options.files["notes.md"]).toEqual({
        type: "file",
        content: "hello hub",
      });

      const read = await composite.read("/memories/notes.md");
      expect(read.error).toBeUndefined();
      expect(read.content).toContain("hello hub");

      await composite.write("/fs-only.txt", "default side");
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      expect(
        await fs.readFile(path.join(tempDir, "fs-only.txt"), "utf-8"),
      ).toBe("default side");

      const lsMem = await composite.ls("/memories/");
      expect(
        lsMem.files?.some((file) => file.path === "/memories/notes.md"),
      ).toBe(true);

      const grepMem = await composite.grep("hello", "/memories");
      expect(
        grepMem.matches?.some((match) => match.path === "/memories/notes.md"),
      ).toBe(true);

      const globMem = await composite.glob("*.md", "/memories");
      expect(
        globMem.files?.some((file) => file.path === "/memories/notes.md"),
      ).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
