import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const mockError = vi.fn();
const mockBreak = vi.fn();

vi.mock("./logger.js", () => ({
  logger: {
    error: (...args: unknown[]) => mockError(...args),
    break: () => mockBreak(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
  },
}));

import { handleError } from "./handleError.js";

const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

describe("handleError", () => {
  beforeEach(() => {
    mockError.mockClear();
    mockBreak.mockClear();
  });

  it("prints generic messages for a plain Error", () => {
    handleError(new Error("something broke"));
    expect(mockError).toHaveBeenCalledWith("something broke");
  });

  it("prints field errors for a real ZodError", () => {
    const result = userSchema.safeParse({ name: "", email: "not-an-email" });
    handleError(result.error);

    const calls = mockError.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.startsWith("- name:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("- email:"))).toBe(true);
  });

  it("prints only generic messages for a non-error primitive", () => {
    handleError("oops");
    expect(mockError).not.toHaveBeenCalledWith("oops");
  });
});
