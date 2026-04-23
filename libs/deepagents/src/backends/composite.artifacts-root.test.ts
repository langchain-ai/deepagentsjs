import { describe, it, expect } from "vitest";

import { CompositeBackend } from "./composite.js";
import { StateBackend } from "./state.js";

describe("CompositeBackend artifactsRoot", () => {
  it("should default artifactsRoot to '/'", () => {
    const backend = new CompositeBackend(new StateBackend(), {});
    expect(backend.artifactsRoot).toBe("/");
  });

  it("should accept a custom artifactsRoot", () => {
    const backend = new CompositeBackend(
      new StateBackend(),
      {},
      {
        artifactsRoot: "/workspace",
      },
    );
    expect(backend.artifactsRoot).toBe("/workspace");
  });

  it("should accept artifactsRoot with trailing slash", () => {
    const backend = new CompositeBackend(
      new StateBackend(),
      {},
      {
        artifactsRoot: "/workspace/",
      },
    );
    expect(backend.artifactsRoot).toBe("/workspace/");
  });
});
