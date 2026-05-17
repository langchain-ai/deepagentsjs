import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { FilesystemBackend } from "../backends/filesystem.js";

import type { SkillMetadata } from "./discovery.js";
import type { LoadedSkill, SkillProvider } from "./provider.js";
import { SkillRegistry } from "./registry.js";

/**
 * Tests for `SkillRegistry`. Focus on the behaviors the rest of the
 * design depends on: lazy discovery, last-wins collision, the shared
 * `load` cache (including concurrent dedup and failure eviction),
 * provider-failure isolation in `safeList`, and the missing-backend
 * error when a string entry is passed without a configured backend.
 */

interface StubProviderOpts {
  id?: string;
  skills: Array<{ name: string; description?: string; body?: string }>;
  loadCounter?: { count: number };
  failingLoad?: boolean;
  failingList?: boolean;
}

/**
 * Build an in-memory `SkillProvider` used by the unit tests. Tracks the
 * number of times `load` runs (via `loadCounter`) so assertions about
 * caching and dedup are straightforward, and supports synthetic failures
 * on either `list` or `load` for the isolation tests.
 */
function stubProvider(opts: StubProviderOpts): SkillProvider {
  return {
    id: opts.id ?? "stub",
    async list(): Promise<SkillMetadata[]> {
      if (opts.failingList) {
        throw new Error(`list failed in '${opts.id ?? "stub"}'`);
      }
      return opts.skills.map((s) => ({
        name: s.name,
        description: s.description ?? `desc ${s.name}`,
        path: `<${opts.id ?? "stub"}>/${s.name}/SKILL.md`,
      }));
    },
    async load(name: string): Promise<LoadedSkill> {
      if (opts.loadCounter !== undefined) {
        opts.loadCounter.count++;
      }
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

describe("SkillRegistry", () => {
  describe("list", () => {
    it("returns the merged metadata across every configured provider", async () => {
      const a = stubProvider({ id: "a", skills: [{ name: "alpha" }] });
      const b = stubProvider({ id: "b", skills: [{ name: "beta" }] });

      const registry = new SkillRegistry({ skills: [a, b] });
      const skills = await registry.list();
      expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    });

    it("is idempotent — repeated calls share one discovery pass", async () => {
      const counter = { count: 0 };
      const provider: SkillProvider = {
        id: "counted",
        async list() {
          counter.count++;
          return [
            {
              name: "x",
              description: "x",
              path: "<counted>/x/SKILL.md",
            },
          ];
        },
        async load() {
          throw new Error("unused");
        },
      };

      const registry = new SkillRegistry({ skills: [provider] });
      await registry.list();
      await registry.list();
      await registry.list();
      expect(counter.count).toBe(1);
    });

    it("dedups concurrent first-time callers onto one discovery promise", async () => {
      const counter = { count: 0 };
      const provider: SkillProvider = {
        id: "racey",
        async list() {
          counter.count++;
          await new Promise((r) => setTimeout(r, 5));
          return [{ name: "x", description: "x", path: "x" }];
        },
        async load() {
          throw new Error("unused");
        },
      };

      const registry = new SkillRegistry({ skills: [provider] });
      const [a, b, c] = await Promise.all([
        registry.list(),
        registry.list(),
        registry.list(),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(counter.count).toBe(1);
    });

    it("applies last-wins collision resolution across providers", async () => {
      const earlier = stubProvider({
        id: "earlier",
        skills: [{ name: "shared", description: "from earlier" }],
      });
      const later = stubProvider({
        id: "later",
        skills: [{ name: "shared", description: "from later" }],
      });

      const registry = new SkillRegistry({ skills: [earlier, later] });
      const skills = await registry.list();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe("from later");
    });

    it("isolates per-provider list failures from the rest of discovery", async () => {
      const good = stubProvider({ id: "good", skills: [{ name: "good" }] });
      const bad = stubProvider({ id: "bad", skills: [], failingList: true });
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      try {
        const registry = new SkillRegistry({ skills: [good, bad] });
        const skills = await registry.list();
        expect(skills.map((s) => s.name)).toEqual(["good"]);
        expect(debug).toHaveBeenCalledWith(
          expect.stringContaining("provider 'bad' failed to list"),
          expect.any(Error),
        );
      } finally {
        debug.mockRestore();
      }
    });

    it("wraps string entries with the configured backend on first list", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-strs-"));
      try {
        const skillsDir = path.join(tempDir, "skills");
        fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
        fs.writeFileSync(
          path.join(skillsDir, "alpha", "SKILL.md"),
          "---\nname: alpha\ndescription: a\n---\n",
        );

        const registry = new SkillRegistry({
          skills: [skillsDir],
          backend: new FilesystemBackend({ rootDir: tempDir }),
        });
        const skills = await registry.list();
        expect(skills.map((s) => s.name)).toEqual(["alpha"]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects when a string entry is passed and no backend is configured", async () => {
      const registry = new SkillRegistry({ skills: ["/skills/"] });
      await expect(registry.list()).rejects.toThrow(/no backend is configured/);
    });
  });

  describe("load", () => {
    it("returns the LoadedSkill for the requested skill", async () => {
      const provider = stubProvider({
        skills: [{ name: "swarm", body: "swarm body" }],
      });
      const registry = new SkillRegistry({ skills: [provider] });
      const loaded = await registry.load("swarm");
      expect(loaded.body).toBe("swarm body");
    });

    it("triggers discovery implicitly when load is called first", async () => {
      const provider = stubProvider({ skills: [{ name: "a", body: "ok" }] });
      const registry = new SkillRegistry({ skills: [provider] });
      const loaded = await registry.load("a");
      expect(loaded.body).toBe("ok");
    });

    it("caches successful loads — second call is a no-op on the provider", async () => {
      const counter = { count: 0 };
      const provider = stubProvider({
        skills: [{ name: "swarm" }],
        loadCounter: counter,
      });
      const registry = new SkillRegistry({ skills: [provider] });

      await registry.load("swarm");
      await registry.load("swarm");
      await registry.load("swarm");
      expect(counter.count).toBe(1);
    });

    it("dedups concurrent load calls for the same skill onto one fetch", async () => {
      const counter = { count: 0 };
      const provider = stubProvider({
        skills: [{ name: "swarm" }],
        loadCounter: counter,
      });
      const registry = new SkillRegistry({ skills: [provider] });

      const [a, b, c] = await Promise.all([
        registry.load("swarm"),
        registry.load("swarm"),
        registry.load("swarm"),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(counter.count).toBe(1);
    });

    it("throws when no provider exposes the requested name", async () => {
      const provider = stubProvider({ skills: [{ name: "alpha" }] });
      const registry = new SkillRegistry({ skills: [provider] });
      await expect(registry.load("missing")).rejects.toThrow(
        /no provider exposes a skill named 'missing'/,
      );
    });

    it("evicts failed loads from the cache so a later attempt can succeed", async () => {
      let shouldFail = true;
      const provider: SkillProvider = {
        id: "flaky",
        async list() {
          return [{ name: "flaky", description: "x", path: "x" }];
        },
        async load(name) {
          if (shouldFail) {
            throw new Error("transient");
          }
          return {
            metadata: { name, description: "x", path: "x" },
            body: "recovered",
            files: new Map(),
          };
        },
      };

      const registry = new SkillRegistry({ skills: [provider] });
      await expect(registry.load("flaky")).rejects.toThrow(/transient/);

      shouldFail = false;
      const loaded = await registry.load("flaky");
      expect(loaded.body).toBe("recovered");
    });

    it("routes loads to the provider that owns the name", async () => {
      const a = stubProvider({
        id: "a",
        skills: [{ name: "alpha", body: "from a" }],
      });
      const b = stubProvider({
        id: "b",
        skills: [{ name: "beta", body: "from b" }],
      });
      const registry = new SkillRegistry({ skills: [a, b] });

      const alpha = await registry.load("alpha");
      const beta = await registry.load("beta");
      expect(alpha.body).toBe("from a");
      expect(beta.body).toBe("from b");
    });

    it("routes loads to the later provider on name collision (last-wins)", async () => {
      const earlier = stubProvider({
        id: "earlier",
        skills: [{ name: "shared", body: "from earlier" }],
      });
      const later = stubProvider({
        id: "later",
        skills: [{ name: "shared", body: "from later" }],
      });
      const registry = new SkillRegistry({ skills: [earlier, later] });

      const loaded = await registry.load("shared");
      expect(loaded.body).toBe("from later");
    });
  });
});
