import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { FilesystemBackend } from "../backends/filesystem.js";
import {
  MAX_SKILL_COMPATIBILITY_LENGTH,
  MAX_SKILL_FILE_SIZE,
  listSkillsFromBackend,
  parseSkillMetadataFromContent,
  validateMetadata,
  validateModulePath,
  validateSkillName,
  type SkillMetadata,
} from "./discovery.js";

/**
 * Tests for the discovery primitives. These cover the pure parsing,
 * validation, and listing functions that the `SkillsMiddleware` and the
 * provider implementations rely on. Middleware-level integration tests
 * (covering how these primitives flow through `createSkillsMiddleware`)
 * live in `../middleware/skills.test.ts`.
 */

describe("validateSkillName", () => {
  it("should accept valid ASCII lowercase names", () => {
    const result = validateSkillName("web-research", "web-research");
    expect(result.valid).toBe(true);
    expect(result.error).toBe("");
  });

  it("should accept unicode lowercase alphanumeric characters", () => {
    const result1 = validateSkillName("café", "café");
    expect(result1.valid).toBe(true);

    const result2 = validateSkillName("über-tool", "über-tool");
    expect(result2.valid).toBe(true);
  });

  it("should reject unicode uppercase characters", () => {
    const result = validateSkillName("Café", "Café");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("should reject CJK characters", () => {
    const result = validateSkillName("中文", "中文");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("should reject emoji characters", () => {
    const result = validateSkillName("tool-😀", "tool-😀");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("should reject empty name", () => {
    const result = validateSkillName("", "dir");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("name is required");
  });

  it("should reject name exceeding 64 characters", () => {
    const longName = "a".repeat(65);
    const result = validateSkillName(longName, longName);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("64 characters");
  });

  it("should reject name starting with hyphen", () => {
    const result = validateSkillName("-tool", "-tool");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("should reject name ending with hyphen", () => {
    const result = validateSkillName("tool-", "tool-");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("should reject consecutive hyphens", () => {
    const result = validateSkillName("my--tool", "my--tool");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("lowercase");
  });

  it("should reject name not matching directory", () => {
    const result = validateSkillName("my-tool", "other-dir");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("must match directory name");
  });
});

describe("parseSkillMetadataFromContent", () => {
  it("should parse valid frontmatter", () => {
    const content = `---
name: test-skill
description: A test skill
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe("test-skill");
    expect(result?.description).toBe("A test skill");
  });

  it("returns null when content exceeds the file size cap", () => {
    const oversized = "x".repeat(MAX_SKILL_FILE_SIZE + 1);
    expect(parseSkillMetadataFromContent(oversized, "/p", "p")).toBeNull();
  });

  it("returns null when no frontmatter is present", () => {
    const result = parseSkillMetadataFromContent(
      "# Just a body, no frontmatter",
      "/p",
      "p",
    );
    expect(result).toBeNull();
  });

  it("should reject whitespace-only description", () => {
    const content = `---
name: test-skill
description: "   "
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).toBeNull();
  });

  it("should reject whitespace-only name", () => {
    const content = `---
name: "   "
description: A test skill
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).toBeNull();
  });

  it("should handle allowed-tools as YAML list", () => {
    const content = `---
name: test-skill
description: A test skill
allowed-tools:
  - Bash
  - Read
  - Write
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.allowedTools).toEqual(["Bash", "Read", "Write"]);
  });

  it("should handle multiple consecutive spaces in allowed-tools string", () => {
    const content = `---
name: test-skill
description: A test skill
allowed-tools: Bash  Read   Write
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.allowedTools).toEqual(["Bash", "Read", "Write"]);
  });

  it("should coerce boolean license to string", () => {
    const content = `---
name: test-skill
description: A test skill
license: true
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.license).toBe("true");
  });

  it("should handle non-dict metadata gracefully", () => {
    const content = `---
name: test-skill
description: A test skill
metadata: some-text
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.metadata).toEqual({});
  });

  it("should truncate compatibility exceeding 500 chars", () => {
    const longCompat = "x".repeat(600);
    const content = `---
name: test-skill
description: A test skill
compatibility: ${longCompat}
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.compatibility).not.toBeNull();
    expect(result?.compatibility?.length).toBe(MAX_SKILL_COMPATIBILITY_LENGTH);
  });

  it("should return null for empty compatibility", () => {
    const content = `---
name: test-skill
description: A test skill
compatibility: ""
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.compatibility).toBeNull();
  });

  it("should coerce metadata values to strings", () => {
    const content = `---
name: test-skill
description: A test skill
metadata:
  count: 42
  active: true
---

Content
`;
    const result = parseSkillMetadataFromContent(
      content,
      "/skills/test-skill/SKILL.md",
      "test-skill",
    );
    expect(result).not.toBeNull();
    expect(result?.metadata).toEqual({ count: "42", active: "true" });
  });
});

describe("parseSkillMetadataFromContent module field", () => {
  function makeContent(extra = ""): string {
    return `---\nname: my-skill\ndescription: A skill\n${extra}---\n\nContent\n`;
  }

  it("sets module when a valid path is provided", () => {
    const result = parseSkillMetadataFromContent(
      makeContent("module: index.ts\n"),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBe("index.ts");
  });

  it("strips leading ./ from module path", () => {
    const result = parseSkillMetadataFromContent(
      makeContent("module: ./src/entry.ts\n"),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBe("src/entry.ts");
  });

  it("sets module to undefined when module key is absent", () => {
    const result = parseSkillMetadataFromContent(
      makeContent(),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBeUndefined();
  });

  it("sets module to undefined for a non-string value", () => {
    const result = parseSkillMetadataFromContent(
      makeContent("module: 42\n"),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBeUndefined();
  });

  it("sets module to undefined for an unsupported extension", () => {
    const result = parseSkillMetadataFromContent(
      makeContent("module: index.py\n"),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBeUndefined();
  });

  it("sets module to undefined for a traversal path", () => {
    const result = parseSkillMetadataFromContent(
      makeContent("module: ../escape.ts\n"),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBeUndefined();
  });

  it("sets module to undefined for an empty string", () => {
    const result = parseSkillMetadataFromContent(
      makeContent('module: ""\n'),
      "/skills/my-skill/SKILL.md",
      "my-skill",
    );
    expect(result?.module).toBeUndefined();
  });
});

describe("validateMetadata", () => {
  it("should return empty dict for non-dict input", () => {
    const result = validateMetadata("not a dict", "/skills/s/SKILL.md");
    expect(result).toEqual({});
  });

  it("should return empty dict for list input", () => {
    const result = validateMetadata(["a", "b"], "/skills/s/SKILL.md");
    expect(result).toEqual({});
  });

  it("should return empty dict for null input", () => {
    const result = validateMetadata(null, "/skills/s/SKILL.md");
    expect(result).toEqual({});
  });

  it("should return empty dict for falsy input without warning", () => {
    const result = validateMetadata(undefined, "/skills/s/SKILL.md");
    expect(result).toEqual({});
  });

  it("should coerce non-string values to strings", () => {
    const result = validateMetadata(
      { count: 42, active: true },
      "/skills/s/SKILL.md",
    );
    expect(result).toEqual({ count: "42", active: "true" });
  });

  it("should pass through valid dict[str, str]", () => {
    const result = validateMetadata({ author: "acme" }, "/skills/s/SKILL.md");
    expect(result).toEqual({ author: "acme" });
  });
});

describe("validateModulePath", () => {
  describe("absent / empty values", () => {
    it("returns undefined for null", () => {
      expect(validateModulePath(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(validateModulePath(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(validateModulePath("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
      expect(validateModulePath("   ")).toBeUndefined();
    });
  });

  describe("non-string values", () => {
    it("returns undefined for number", () => {
      expect(validateModulePath(42)).toBeUndefined();
    });

    it("returns undefined for boolean", () => {
      expect(validateModulePath(true)).toBeUndefined();
    });

    it("returns undefined for object", () => {
      expect(validateModulePath({ path: "index.ts" })).toBeUndefined();
    });

    it("returns undefined for array", () => {
      expect(validateModulePath(["index.ts"])).toBeUndefined();
    });
  });

  describe("valid paths", () => {
    it("returns 'index.ts' for 'index.ts'", () => {
      expect(validateModulePath("index.ts")).toBe("index.ts");
    });

    it("strips leading ./ from './entry.ts'", () => {
      expect(validateModulePath("./entry.ts")).toBe("entry.ts");
    });

    it("strips leading ./ from './lib/util.js'", () => {
      expect(validateModulePath("./lib/util.js")).toBe("lib/util.js");
    });

    it("passes through a path without ./ prefix", () => {
      expect(validateModulePath("lib/entry.js")).toBe("lib/entry.js");
    });

    it("accepts .mjs extension", () => {
      expect(validateModulePath("index.mjs")).toBe("index.mjs");
    });

    it("accepts .cjs extension", () => {
      expect(validateModulePath("index.cjs")).toBe("index.cjs");
    });

    it("accepts .jsx extension", () => {
      expect(validateModulePath("ui.jsx")).toBe("ui.jsx");
    });

    it("accepts .tsx extension", () => {
      expect(validateModulePath("component.tsx")).toBe("component.tsx");
    });

    it("accepts .mts extension", () => {
      expect(validateModulePath("index.mts")).toBe("index.mts");
    });

    it("accepts .cts extension", () => {
      expect(validateModulePath("index.cts")).toBe("index.cts");
    });

    it("trims surrounding whitespace before validating", () => {
      expect(validateModulePath("  index.ts  ")).toBe("index.ts");
    });
  });

  describe("absolute paths", () => {
    it("returns undefined for '/foo.ts'", () => {
      expect(validateModulePath("/foo.ts")).toBeUndefined();
    });

    it("returns undefined for '/absolute/path/index.ts'", () => {
      expect(validateModulePath("/absolute/path/index.ts")).toBeUndefined();
    });

    it("returns undefined for './' that normalizes to an absolute after stripping", () => {
      expect(validateModulePath("/./index.ts")).toBeUndefined();
    });
  });

  describe("path traversal", () => {
    it("returns undefined for '..'", () => {
      expect(validateModulePath("..")).toBeUndefined();
    });

    it("returns undefined for '../foo.ts'", () => {
      expect(validateModulePath("../foo.ts")).toBeUndefined();
    });

    it("returns undefined for 'lib/../foo.ts'", () => {
      expect(validateModulePath("lib/../foo.ts")).toBeUndefined();
    });

    it("returns undefined for 'a/b/../../foo.ts'", () => {
      expect(validateModulePath("a/b/../../foo.ts")).toBeUndefined();
    });

    it("returns undefined for 'foo/..' (trailing traversal without extension)", () => {
      expect(validateModulePath("foo/..")).toBeUndefined();
    });

    it("returns undefined for './../../escape.ts'", () => {
      expect(validateModulePath("./../../escape.ts")).toBeUndefined();
    });
  });

  describe("bad extensions", () => {
    it("returns undefined for '.json'", () => {
      expect(validateModulePath("data.json")).toBeUndefined();
    });

    it("returns undefined for '.md'", () => {
      expect(validateModulePath("README.md")).toBeUndefined();
    });

    it("returns undefined for no extension", () => {
      expect(validateModulePath("index")).toBeUndefined();
    });

    it("returns undefined for '.py'", () => {
      expect(validateModulePath("script.py")).toBeUndefined();
    });

    it("returns undefined for '.d.ts' (type declaration only)", () => {
      expect(validateModulePath("index.d.ts")).toBeUndefined();
    });
  });
});

describe("listSkillsFromBackend", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-listing-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns an empty list when the source directory does not exist", async () => {
    const backend = new FilesystemBackend({ rootDir: tempDir });
    const result = await listSkillsFromBackend(
      backend,
      path.join(tempDir, "missing"),
    );
    expect(result).toEqual([]);
  });

  it("discovers a single well-formed skill", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: a skill\n---\n\nbody",
    );

    const backend = new FilesystemBackend({ rootDir: tempDir });
    const result = await listSkillsFromBackend(backend, skillsDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("alpha");
  });

  it("silently skips directories missing a SKILL.md", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "with-md"), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, "without-md"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "with-md", "SKILL.md"),
      "---\nname: with-md\ndescription: x\n---\n",
    );

    const backend = new FilesystemBackend({ rootDir: tempDir });
    const result = await listSkillsFromBackend(backend, skillsDir);
    expect(result.map((s) => s.name)).toEqual(["with-md"]);
  });

  it("ignores files at the source root (only subdirectories count)", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "loose.md"), "not a skill");
    fs.mkdirSync(path.join(skillsDir, "real"));
    fs.writeFileSync(
      path.join(skillsDir, "real", "SKILL.md"),
      "---\nname: real\ndescription: x\n---\n",
    );

    const backend = new FilesystemBackend({ rootDir: tempDir });
    const result = await listSkillsFromBackend(backend, skillsDir);
    expect(result.map((s) => s.name)).toEqual(["real"]);
  });

  it("returns metadata across multiple subdirectories", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, "beta"));
    fs.writeFileSync(
      path.join(skillsDir, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: a\n---\n",
    );
    fs.writeFileSync(
      path.join(skillsDir, "beta", "SKILL.md"),
      "---\nname: beta\ndescription: b\n---\n",
    );

    const backend = new FilesystemBackend({ rootDir: tempDir });
    const result = await listSkillsFromBackend(backend, skillsDir);
    expect(result.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });
});

// Silence unused-import warning if no test below references the type.
const _typeOnlyAnchor: SkillMetadata | undefined = undefined;
void _typeOnlyAnchor;
