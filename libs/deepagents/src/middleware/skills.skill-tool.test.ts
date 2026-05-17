import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { FilesystemBackend } from "../backends/filesystem.js";
import type { SkillMetadata } from "../skills/discovery.js";
import type { LoadedSkill, SkillProvider } from "../skills/provider.js";

import { createSkillsMiddleware } from "./skills.js";

/**
 * Tests for the Phase 4 changes to `SkillsMiddleware`: the `skill(name)`
 * activation tool, registry-driven discovery for provider-sourced
 * skills, and the system prompt that teaches the tool. The legacy
 * `{ backend, sources }` shape is covered separately in `skills.test.ts`.
 */

/**
 * Build an in-memory `SkillProvider` for tests. Configurable to throw
 * on `load` so error-propagation paths are exercisable without touching
 * any real I/O.
 */
function stubProvider(opts: {
  id?: string;
  skills: Array<{ name: string; description?: string; body?: string }>;
  failingLoad?: boolean;
}): SkillProvider {
  return {
    id: opts.id ?? "stub",
    async list(): Promise<SkillMetadata[]> {
      return opts.skills.map((s) => ({
        name: s.name,
        description: s.description ?? `desc ${s.name}`,
        path: `<${opts.id ?? "stub"}>/${s.name}/SKILL.md`,
      }));
    },
    async load(name: string): Promise<LoadedSkill> {
      if (opts.failingLoad) {
        throw new Error(`boom: ${name}`);
      }
      const match = opts.skills.find((s) => s.name === name);
      if (match === undefined) {
        throw new Error(`unknown skill in stub: ${name}`);
      }
      return {
        metadata: {
          name: match.name,
          description: match.description ?? `desc ${match.name}`,
          path: `<${opts.id ?? "stub"}>/${match.name}/SKILL.md`,
        },
        body: match.body ?? "body",
        files: new Map(),
      };
    },
  };
}

interface SkillToolHandle {
  name: string;
  invoke: (input: { name: string }) => Promise<unknown>;
}

/**
 * Pull the `skill` tool off the middleware. The middleware's tool array
 * isn't part of its public TypeScript surface, but accessing it for tests
 * is the same pattern `createDeepAgent` uses internally to wire tools
 * into the agent.
 */
function extractSkillTool(
  middleware: ReturnType<typeof createSkillsMiddleware>,
): SkillToolHandle {
  const tools = (middleware as unknown as { tools?: unknown[] }).tools ?? [];
  for (const t of tools) {
    const candidate = t as { name?: unknown; invoke?: unknown };
    if (candidate.name === "skill" && typeof candidate.invoke === "function") {
      return candidate as SkillToolHandle;
    }
  }
  throw new Error("skill tool not found on SkillsMiddleware");
}

/**
 * Drive the middleware's `beforeAgent` lifecycle hook so `loadedSkills`
 * is populated. The skill tool depends on that state to disambiguate
 * known vs unknown skill names.
 */
async function runBeforeAgent(
  middleware: ReturnType<typeof createSkillsMiddleware>,
  state: { skillsMetadata?: SkillMetadata[] } = {},
): Promise<void> {
  const hook = (
    middleware as unknown as {
      beforeAgent?: (s: unknown) => Promise<unknown>;
    }
  ).beforeAgent;
  if (typeof hook !== "function") {
    throw new Error("SkillsMiddleware has no beforeAgent");
  }
  await hook(state);
}

describe("SkillsMiddleware `skill` tool", () => {
  let tempDir: string;
  let backend: FilesystemBackend;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tool-"));
    backend = new FilesystemBackend({ rootDir: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the SKILL.md body for a provider-sourced skill", async () => {
    const provider = stubProvider({
      skills: [{ name: "swarm", body: "# Swarm body\n\nUse this skill." }],
    });
    const middleware = createSkillsMiddleware({
      backend,
      sources: [provider],
    });

    await runBeforeAgent(middleware);
    const result = await extractSkillTool(middleware).invoke({ name: "swarm" });
    expect(result).toBe("# Swarm body\n\nUse this skill.");
  });

  it("returns a useful message when the skill name is unknown", async () => {
    const provider = stubProvider({ skills: [{ name: "alpha" }] });
    const middleware = createSkillsMiddleware({
      backend,
      sources: [provider],
    });

    await runBeforeAgent(middleware);
    const result = await extractSkillTool(middleware).invoke({
      name: "missing",
    });
    expect(String(result)).toContain("not available");
    expect(String(result)).toContain("alpha");
  });

  it("lists `(none)` in the unknown-skill message when no skills are configured", async () => {
    const middleware = createSkillsMiddleware({
      backend,
      sources: [],
    });

    await runBeforeAgent(middleware);
    const result = await extractSkillTool(middleware).invoke({
      name: "anything",
    });
    expect(String(result)).toContain("Available skills: (none)");
  });

  it("propagates registry load errors as a tool-facing message", async () => {
    const provider = stubProvider({
      skills: [{ name: "broken" }],
      failingLoad: true,
    });
    const middleware = createSkillsMiddleware({
      backend,
      sources: [provider],
    });

    await runBeforeAgent(middleware);
    const result = await extractSkillTool(middleware).invoke({
      name: "broken",
    });
    expect(String(result)).toContain("Failed to load skill 'broken'");
    expect(String(result)).toContain("boom: broken");
  });

  it("loads body for legacy string-sourced skills through the backend", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "fs-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "fs-skill", "SKILL.md"),
      "---\nname: fs-skill\ndescription: from disk\n---\n\n# FS body",
    );

    const middleware = createSkillsMiddleware({
      backend,
      sources: [skillsDir],
    });

    await runBeforeAgent(middleware);
    const result = await extractSkillTool(middleware).invoke({
      name: "fs-skill",
    });
    expect(String(result)).toContain("# FS body");
  });

  it("registers exactly one tool named `skill`", () => {
    const middleware = createSkillsMiddleware({
      backend,
      sources: [],
    });
    const tools = (middleware as unknown as { tools?: unknown[] }).tools ?? [];
    const skillTools = tools.filter(
      (t): t is { name: string } =>
        typeof (t as { name?: unknown }).name === "string" &&
        (t as { name: string }).name === "skill",
    );
    expect(skillTools).toHaveLength(1);
  });
});

describe("SkillsMiddleware system prompt", () => {
  it("teaches the `skill` tool instead of `read_file` activation", () => {
    const middleware = createSkillsMiddleware({
      backend: new FilesystemBackend({ rootDir: os.tmpdir() }),
      sources: [],
    });

    // Drive `wrapModelCall` through a minimal stub `request` to capture
    // the system message the middleware injects. The shape of the call
    // here mirrors how langchain invokes `wrapModelCall` at runtime.
    let captured: string | undefined;
    const wrap = (
      middleware as unknown as {
        wrapModelCall?: (
          req: { systemMessage: { concat(s: string): string } },
          next: (r: { systemMessage: string }) => Promise<void>,
        ) => Promise<void>;
      }
    ).wrapModelCall;
    if (typeof wrap !== "function") {
      throw new Error("SkillsMiddleware has no wrapModelCall");
    }

    return wrap(
      {
        systemMessage: {
          concat(more: string) {
            return `BASE${more}`;
          },
        },
      },
      async ({ systemMessage }) => {
        captured = systemMessage;
      },
    ).then(() => {
      expect(captured).toBeDefined();
      expect(captured).toContain('Call `skill({ name: "<skill-name>" })`');
      expect(captured).not.toContain("Use `read_file`");
    });
  });
});
