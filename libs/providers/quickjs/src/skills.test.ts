import { describe, it, expect } from "vitest";
import type {
  AnyBackendProtocol,
  FileDownloadResponse,
  SkillMetadata,
} from "deepagents";

import {
  loadSkill,
  scanSkillReferences,
  MAX_SKILL_BUNDLE_BYTES,
} from "./skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_DIR = "/skills/my-skill";
const ENTRY_ABS = `${SKILL_DIR}/index.ts`;

function makeSkillMeta(overrides?: Partial<SkillMetadata>): SkillMetadata {
  return {
    name: "my-skill",
    description: "A test skill",
    path: `${SKILL_DIR}/SKILL.md`,
    module: "index.ts",
    ...overrides,
  };
}

type GlobFn = (
  pattern: string,
  path?: string,
) => Promise<{ files?: { path: string }[]; error?: string }>;
type DownloadFn = (paths: string[]) => Promise<FileDownloadResponse[]>;

function makeBackend(overrides: {
  glob?: GlobFn;
  downloadFiles?: DownloadFn;
}): AnyBackendProtocol {
  return {
    glob: overrides.glob ?? (() => Promise.resolve({ files: [] })),
    downloadFiles: overrides.downloadFiles,
  } as unknown as AnyBackendProtocol;
}

const enc = new TextEncoder();

function src(code: string): Uint8Array {
  return enc.encode(code);
}

/** Returns a file at `absPath` for the matching extension, empty for all others. */
function globFor(absPath: string): GlobFn {
  return async (pattern) => {
    const ext = pattern.replace("**/*", "");
    if (absPath.endsWith(ext)) {
      return { files: [{ path: absPath }] };
    }
    return { files: [] };
  };
}

function downloadWith(responses: FileDownloadResponse[]): DownloadFn {
  return async () => responses;
}

function okResponse(path: string, code: string): FileDownloadResponse {
  return { path, content: src(code), error: null };
}

// ---------------------------------------------------------------------------
// loadSkill
// ---------------------------------------------------------------------------

describe("loadSkill", () => {
  describe("validation", () => {
    it("throws on a non-kebab-case skill name", async () => {
      const meta = makeSkillMeta({ name: "MySkill" });
      await expect(loadSkill(meta, makeBackend({}))).rejects.toThrow(
        "not a valid kebab-case",
      );
    });

    it("throws when module is undefined", async () => {
      const meta = makeSkillMeta({ module: undefined });
      await expect(loadSkill(meta, makeBackend({}))).rejects.toThrow(
        "no 'module' frontmatter key",
      );
    });

    it("throws when backend has no downloadFiles", async () => {
      const meta = makeSkillMeta();
      const backend = makeBackend({ downloadFiles: undefined });
      await expect(loadSkill(meta, backend)).rejects.toThrow(
        "backend does not implement downloadFiles",
      );
    });
  });

  describe("glob failures", () => {
    it("throws when glob returns an error", async () => {
      const backend = makeBackend({
        glob: async () => ({ error: "permission denied" }),
        downloadFiles: downloadWith([]),
      });
      await expect(loadSkill(makeSkillMeta(), backend)).rejects.toThrow(
        "failed to list",
      );
    });

    it("throws when no JS/TS files are found under the skill directory", async () => {
      const backend = makeBackend({
        glob: async () => ({ files: [] }),
        downloadFiles: downloadWith([]),
      });
      await expect(loadSkill(makeSkillMeta(), backend)).rejects.toThrow(
        "no JS/TS files",
      );
    });
  });

  describe("download failures", () => {
    it("throws when a file download returns an error", async () => {
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS),
        downloadFiles: downloadWith([
          { path: ENTRY_ABS, content: null, error: "file_not_found" },
        ]),
      });
      await expect(loadSkill(makeSkillMeta(), backend)).rejects.toThrow(
        "failed to download",
      );
    });

    it("throws when file content is not valid UTF-8", async () => {
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS),
        downloadFiles: downloadWith([
          {
            path: ENTRY_ABS,
            content: new Uint8Array([0xff, 0xfe, 0x00]),
            error: null,
          },
        ]),
      });
      await expect(loadSkill(makeSkillMeta(), backend)).rejects.toThrow(
        "not valid UTF-8",
      );
    });

    it("throws when the total bundle size exceeds the limit", async () => {
      const bigCode = "x".repeat(MAX_SKILL_BUNDLE_BYTES + 1);
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS),
        downloadFiles: downloadWith([okResponse(ENTRY_ABS, bigCode)]),
      });
      await expect(loadSkill(makeSkillMeta(), backend)).rejects.toThrow(
        "bundle exceeds",
      );
    });
  });

  describe("file map failures", () => {
    it("throws when the declared entrypoint is not in the enumerated files", async () => {
      const meta = makeSkillMeta({ module: "missing.ts" });
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS), // returns index.ts, not missing.ts
        downloadFiles: downloadWith([
          okResponse(ENTRY_ABS, "export const x = 1;"),
        ]),
      });
      await expect(loadSkill(meta, backend)).rejects.toThrow(
        "did not match any file",
      );
    });

    it("throws when a file path escapes the skill directory", async () => {
      const escapePath = "/other-skills/sneaky.ts";
      const backend = makeBackend({
        glob: async (pattern) => {
          if (pattern.endsWith(".ts")) {
            return { files: [{ path: escapePath }] };
          }
          return { files: [] };
        },
        downloadFiles: downloadWith([
          okResponse(escapePath, "export const x = 1;"),
        ]),
      });
      await expect(loadSkill(makeSkillMeta(), backend)).rejects.toThrow(
        "is not under",
      );
    });
  });

  describe("happy path", () => {
    it("returns a LoadedSkill with the correct shape", async () => {
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS),
        downloadFiles: downloadWith([
          okResponse(ENTRY_ABS, "export const x = 1;"),
        ]),
      });

      const loaded = await loadSkill(makeSkillMeta(), backend);

      expect(loaded.name).toBe("my-skill");
      expect(loaded.specifier).toBe("@/skills/my-skill");
      expect(loaded.entryRel).toBe("index.ts");
    });

    it("keys files by relative POSIX path, not absolute path", async () => {
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS),
        downloadFiles: downloadWith([
          okResponse(ENTRY_ABS, "export const x = 1;"),
        ]),
      });

      const loaded = await loadSkill(makeSkillMeta(), backend);

      expect(loaded.files.has("index.ts")).toBe(true);
      expect(loaded.files.has(ENTRY_ABS)).toBe(false);
    });

    it("strips TypeScript syntax from file sources", async () => {
      const tsCode =
        "export function greet(name: string): string { return name; }";
      const backend = makeBackend({
        glob: globFor(ENTRY_ABS),
        downloadFiles: downloadWith([okResponse(ENTRY_ABS, tsCode)]),
      });

      const loaded = await loadSkill(makeSkillMeta(), backend);

      const stripped = loaded.files.get("index.ts")!;
      expect(stripped).toContain("function greet");
      expect(stripped).not.toContain(": string");
    });

    it("handles a skill with multiple files", async () => {
      const helperAbs = `${SKILL_DIR}/lib/helper.ts`;
      const backend = makeBackend({
        glob: async (pattern) => {
          if (pattern.endsWith(".ts")) {
            return { files: [{ path: ENTRY_ABS }, { path: helperAbs }] };
          }
          return { files: [] };
        },
        downloadFiles: downloadWith([
          okResponse(ENTRY_ABS, "export { greet } from './lib/helper.js';"),
          okResponse(helperAbs, "export function greet() { return 'hi'; }"),
        ]),
      });

      const loaded = await loadSkill(makeSkillMeta(), backend);

      expect(loaded.files.size).toBe(2);
      expect(loaded.files.has("index.ts")).toBe(true);
      expect(loaded.files.has("lib/helper.ts")).toBe(true);
    });

    it("accepts a multi-segment kebab-case skill name", async () => {
      const dir = "/skills/pdf-extract";
      const entry = `${dir}/index.ts`;
      const meta = makeSkillMeta({
        name: "pdf-extract",
        path: `${dir}/SKILL.md`,
        module: "index.ts",
      });
      const backend = makeBackend({
        glob: globFor(entry),
        downloadFiles: downloadWith([okResponse(entry, "export const x = 1;")]),
      });

      const loaded = await loadSkill(meta, backend);

      expect(loaded.specifier).toBe("@/skills/pdf-extract");
    });
  });
});

// ---------------------------------------------------------------------------
// scanSkillReferences
// ---------------------------------------------------------------------------

describe("scanSkillReferences", () => {
  it("returns an empty set for empty source", () => {
    expect(scanSkillReferences("")).toEqual(new Set());
  });

  it("returns an empty set when no skill references are present", () => {
    expect(scanSkillReferences("const x = 1;")).toEqual(new Set());
  });

  it("detects a double-quoted skill reference", () => {
    expect(scanSkillReferences(`import("@/skills/foo")`)).toEqual(
      new Set(["foo"]),
    );
  });

  it("detects a single-quoted skill reference", () => {
    expect(scanSkillReferences(`import('@/skills/bar')`)).toEqual(
      new Set(["bar"]),
    );
  });

  it("detects multiple distinct skill references", () => {
    const code = `
      const a = await import("@/skills/pdf-extract");
      const b = await import("@/skills/csv-parser");
    `;
    expect(scanSkillReferences(code)).toEqual(
      new Set(["pdf-extract", "csv-parser"]),
    );
  });

  it("deduplicates repeated references to the same skill", () => {
    const code = `import("@/skills/foo"); import("@/skills/foo");`;
    expect(scanSkillReferences(code)).toEqual(new Set(["foo"]));
  });

  it("does not detect template literal specifiers", () => {
    expect(scanSkillReferences("import(`@/skills/foo`)")).toEqual(new Set());
  });

  it("does not match a bare @/skills/ prefix with no name", () => {
    expect(scanSkillReferences(`"@/skills/"`)).toEqual(new Set());
  });
});
