import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockSwarmTaskTool = { name: "swarm_task" };
vi.mock("../../tools/swarm-task.js", () => ({
  createSwarmTaskTool: vi.fn(() => mockSwarmTaskTool),
}));

vi.mock("../../transform.js", () => ({
  stripTypeSyntax: vi.fn((source: string) => `/* stripped */ ${source}`),
}));

import { createSwarmTaskTool } from "../../tools/swarm-task.js";
import { swarm } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// swarm() — InterpreterLibrary shape
// ---------------------------------------------------------------------------

describe("swarm() factory", () => {
  it("returns a valid InterpreterLibrary", () => {
    const lib = swarm();

    expect(lib.name).toBe("swarm");
    expect(lib.description).toContain("table");
    expect(lib.source).toBeTruthy();
    expect(lib.instructions).toBeTruthy();
    expect(lib.files).toBeInstanceOf(Map);
  });

  it("includes swarm_task tool and standard file tools in ptcTools", () => {
    const lib = swarm();

    expect(lib.ptcTools).toContain(mockSwarmTaskTool);
    expect(lib.ptcTools).toContain("read_file");
    expect(lib.ptcTools).toContain("write_file");
    expect(lib.ptcTools).toContain("edit_file");
    expect(lib.ptcTools).toContain("glob");
  });

  it("passes a SubagentPoolRef to createSwarmTaskTool", () => {
    swarm();

    expect(createSwarmTaskTool).toHaveBeenCalledWith({
      subagentPool: expect.objectContaining({ current: null }),
    });
  });

  it("attaches subagentPool to the returned library", () => {
    const lib = swarm();

    expect(lib.subagentPool).toBeDefined();
    expect(lib.subagentPool!.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source and instructions loading
// ---------------------------------------------------------------------------

describe("source and instructions loading", () => {
  it("loads and strips swarm source files from disk", () => {
    const lib = swarm();

    expect(lib.source).toContain("/* stripped */");
    expect(lib.source.length).toBeGreaterThan(0);
  });

  it("populates files map with non-entry source modules", () => {
    const lib = swarm();

    expect(lib.files!.size).toBeGreaterThan(0);
    for (const [filename, content] of lib.files!) {
      expect(filename).toMatch(/\.(ts|js)$/);
      expect(content).toContain("/* stripped */");
    }
  });

  it("does not include .d.ts files in the files map", () => {
    const lib = swarm();

    for (const filename of lib.files!.keys()) {
      expect(filename).not.toMatch(/\.d\.ts$/);
    }
  });

  it("loads LIBRARY.md as instructions", () => {
    const lib = swarm();

    expect(lib.instructions).toContain("# Swarm");
    expect(lib.instructions).toContain("create");
    expect(lib.instructions).toContain("run");
    expect(lib.instructions).toContain("rows");
  });
});
