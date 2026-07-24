import { describe, expect, it } from "vitest";

import {
  ASYNC_TASK_SYSTEM_PROMPT,
  BASE_AGENT_PROMPT,
  EXECUTION_SYSTEM_PROMPT,
  TASK_SYSTEM_PROMPT,
} from "./compat.js";

describe("legacy prompt compatibility exports", () => {
  it("retains the removed prompt values for existing imports", () => {
    expect(BASE_AGENT_PROMPT).toContain("You are a Deep Agent");
    expect(TASK_SYSTEM_PROMPT).toContain("task");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("start_async_task");
    expect(EXECUTION_SYSTEM_PROMPT).toContain("execute");
  });
});
