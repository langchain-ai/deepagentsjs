import { describe, expect, it } from "vitest";
import {
  appendManifest,
  initializeManifest,
  ManifestNotFoundError,
  ManifestParseError,
  parseManifestContent,
  readManifest,
  serializeManifest,
} from "./manifest.js";
import { manifestPath } from "./layout.js";
import { createInMemoryBackend } from "./test-utils.js";
import type { ManifestEntry } from "./types.js";

const RUN_DIR = "swarm_runs/test-run";

function entry(
  id: string,
  subagentType?: string,
): ManifestEntry {
  return subagentType
    ? { id, descriptionPath: `tasks/${id}.txt`, subagentType }
    : { id, descriptionPath: `tasks/${id}.txt` };
}

describe("parseManifestContent", () => {
  it("returns an empty array for an empty file", () => {
    expect(parseManifestContent(RUN_DIR, "")).toEqual([]);
  });

  it("ignores blank lines", () => {
    const content = `\n${JSON.stringify(entry("a"))}\n\n${JSON.stringify(entry("b"))}\n`;
    expect(parseManifestContent(RUN_DIR, content)).toEqual([
      entry("a"),
      entry("b"),
    ]);
  });

  it("parses well-formed entries", () => {
    const entries = [entry("alpha", "researcher"), entry("beta")];
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    expect(parseManifestContent(RUN_DIR, content)).toEqual(entries);
  });

  it("throws ManifestParseError with line numbers on invalid JSON", () => {
    const content = `${JSON.stringify(entry("a"))}\n{not json}\n`;
    try {
      parseManifestContent(RUN_DIR, content);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestParseError);
      const parseErr = err as ManifestParseError;
      expect(parseErr.lineErrors).toHaveLength(1);
      expect(parseErr.lineErrors[0]).toEqual({
        line: 2,
        message: "invalid JSON",
      });
    }
  });

  it("throws ManifestParseError when an entry fails schema validation", () => {
    // missing descriptionPath
    const bad = JSON.stringify({ id: "a" });
    try {
      parseManifestContent(RUN_DIR, bad);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestParseError);
      const parseErr = err as ManifestParseError;
      expect(parseErr.lineErrors[0].line).toBe(1);
      expect(parseErr.lineErrors[0].message).toContain("descriptionPath");
    }
  });

  it("throws ManifestParseError on duplicate ids", () => {
    const content = [JSON.stringify(entry("dup")), JSON.stringify(entry("dup"))]
      .join("\n");
    try {
      parseManifestContent(RUN_DIR, content);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestParseError);
      const parseErr = err as ManifestParseError;
      expect(parseErr.lineErrors[0].line).toBe(2);
      expect(parseErr.lineErrors[0].message).toContain("duplicate task id");
    }
  });

  it("collects multiple errors before throwing", () => {
    const content = [
      "{not json}",
      JSON.stringify({ id: "a" }), // missing descriptionPath
      JSON.stringify(entry("b")),
    ].join("\n");
    try {
      parseManifestContent(RUN_DIR, content);
      throw new Error("expected to throw");
    } catch (err) {
      const parseErr = err as ManifestParseError;
      expect(parseErr.lineErrors).toHaveLength(2);
      expect(parseErr.lineErrors.map((e) => e.line)).toEqual([1, 2]);
    }
  });
});

describe("serializeManifest", () => {
  it("returns an empty string for no entries", () => {
    expect(serializeManifest([])).toBe("");
  });

  it("emits one JSON object per line with a trailing newline", () => {
    const entries = [entry("a"), entry("b", "researcher")];
    const out = serializeManifest(entries);
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entries[0]);
    expect(JSON.parse(lines[1])).toEqual(entries[1]);
  });
});

describe("readManifest", () => {
  it("throws ManifestNotFoundError when the file does not exist", async () => {
    const backend = createInMemoryBackend();
    await expect(readManifest(backend, RUN_DIR)).rejects.toBeInstanceOf(
      ManifestNotFoundError,
    );
  });

  it("returns parsed entries when the file exists", async () => {
    const entries = [entry("a"), entry("b", "researcher")];
    const backend = createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest(entries),
    });
    const result = await readManifest(backend, RUN_DIR);
    expect(result).toEqual(entries);
  });

  it("returns an empty array for an initialized but empty manifest", async () => {
    const backend = createInMemoryBackend({ [manifestPath(RUN_DIR)]: "" });
    expect(await readManifest(backend, RUN_DIR)).toEqual([]);
  });

  it("propagates non-not-found errors as generic Errors", async () => {
    const backend = createInMemoryBackend({ [manifestPath(RUN_DIR)]: "" });
    backend.failReadFor.add(manifestPath(RUN_DIR));
    await expect(readManifest(backend, RUN_DIR)).rejects.toThrow(
      /failed to read manifest/,
    );
  });
});

describe("initializeManifest", () => {
  it("creates an empty manifest file at the expected path", async () => {
    const backend = createInMemoryBackend();
    await initializeManifest(backend, RUN_DIR);
    expect(backend.files.get(manifestPath(RUN_DIR))).toBe("");
  });

  it("propagates write failures as Errors", async () => {
    const backend = createInMemoryBackend();
    backend.failWriteFor.add(manifestPath(RUN_DIR));
    await expect(initializeManifest(backend, RUN_DIR)).rejects.toThrow(
      /failed to initialize manifest/,
    );
  });
});

describe("appendManifest", () => {
  it("does nothing when given an empty entry list", async () => {
    const backend = createInMemoryBackend({ [manifestPath(RUN_DIR)]: "" });
    await appendManifest(backend, RUN_DIR, []);
    expect(backend.files.get(manifestPath(RUN_DIR))).toBe("");
  });

  it("appends new entries while preserving existing ones", async () => {
    const backend = createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest([entry("a")]),
    });
    await appendManifest(backend, RUN_DIR, [entry("b"), entry("c")]);
    const after = await readManifest(backend, RUN_DIR);
    expect(after.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("throws if the run directory has not been initialized", async () => {
    const backend = createInMemoryBackend();
    await expect(appendManifest(backend, RUN_DIR, [entry("a")]))
      .rejects.toBeInstanceOf(ManifestNotFoundError);
  });

  it("throws if a new entry collides with an existing id", async () => {
    const backend = createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest([entry("a")]),
    });
    await expect(
      appendManifest(backend, RUN_DIR, [entry("a")]),
    ).rejects.toThrow(/already exists/);
  });
});
