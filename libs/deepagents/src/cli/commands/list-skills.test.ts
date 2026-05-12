import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listSkills } from "./list-skills.js";

vi.mock("../utils.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  fatal: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
  confirm: vi.fn(),
}));

import { fatal, info } from "../utils.js";

describe("listSkills", () => {
  let skillsRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    skillsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "deepagents-list-skills-"),
    );
  });

  afterEach(() => {
    fs.rmSync(skillsRoot, { recursive: true, force: true });
  });

  /**
   * Creates a skill directory with a SKILL.md containing the given frontmatter.
   */
  function seedSkill(name: string, frontmatter: string): void {
    const dir = path.join(skillsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter);
  }

  it("should list skills with name and description from SKILL.md", async () => {
    seedSkill(
      "swarm",
      `---
name: swarm
description: Fan out work to subagents in parallel.
---

# Swarm
`,
    );

    await listSkills({ skillsRoot });

    expect(info).toHaveBeenCalledWith("Available skill modules:\n");
    expect(info).toHaveBeenCalledWith("  swarm");
    expect(info).toHaveBeenCalledWith(
      "    Fan out work to subagents in parallel.\n",
    );
    expect(info).toHaveBeenCalledWith(
      "Add a skill to your project with: deepagents add-skill <name>",
    );
  });

  it("should sort skills alphabetically", async () => {
    seedSkill("zebra", "---\nname: zebra\ndescription: Z skill.\n---\n");
    seedSkill("alpha", "---\nname: alpha\ndescription: A skill.\n---\n");

    await listSkills({ skillsRoot });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    const nameLines = calls.filter(
      (c) =>
        typeof c === "string" && c.startsWith("  ") && !c.startsWith("    "),
    );
    expect(nameLines).toEqual(["  alpha", "  zebra"]);
  });

  it("should skip directories without SKILL.md", async () => {
    const dir = path.join(skillsRoot, "no-skill-md");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.ts"), "");

    seedSkill("valid", "---\nname: valid\ndescription: A valid skill.\n---\n");

    await listSkills({ skillsRoot });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    const nameLines = calls.filter(
      (c) =>
        typeof c === "string" && c.startsWith("  ") && !c.startsWith("    "),
    );
    expect(nameLines).toEqual(["  valid"]);
  });

  it("should skip SKILL.md with missing frontmatter fields", async () => {
    seedSkill("bad", "---\nname: bad\n---\nNo description field.");

    seedSkill("good", "---\nname: good\ndescription: Works.\n---\n");

    await listSkills({ skillsRoot });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    const nameLines = calls.filter(
      (c) =>
        typeof c === "string" && c.startsWith("  ") && !c.startsWith("    "),
    );
    expect(nameLines).toEqual(["  good"]);
  });

  it("should skip plain files in the skills root", async () => {
    fs.writeFileSync(path.join(skillsRoot, "loader.ts"), "");
    seedSkill("swarm", "---\nname: swarm\ndescription: Swarm skill.\n---\n");

    await listSkills({ skillsRoot });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    const nameLines = calls.filter(
      (c) =>
        typeof c === "string" && c.startsWith("  ") && !c.startsWith("    "),
    );
    expect(nameLines).toEqual(["  swarm"]);
  });

  it("should print a message when no skills are found", async () => {
    await listSkills({ skillsRoot });

    expect(info).toHaveBeenCalledWith("No skill modules found.");
  });

  it("should call fatal when the skills root does not exist", async () => {
    const bad = path.join(skillsRoot, "nonexistent");

    await expect(listSkills({ skillsRoot: bad })).rejects.toThrow(
      "Could not read bundled skills directory",
    );
    expect(fatal).toHaveBeenCalled();
  });
});
