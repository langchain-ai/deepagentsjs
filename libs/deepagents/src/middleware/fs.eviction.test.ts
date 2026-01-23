import { describe, it, expect } from "vitest";
import {
  createContentPreview,
  TOOLS_EXCLUDED_FROM_EVICTION,
  NUM_CHARS_PER_TOKEN,
} from "./fs.js";

describe("TOOLS_EXCLUDED_FROM_EVICTION", () => {
  it("should contain the expected tools", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("ls");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("glob");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("grep");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("read_file");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("edit_file");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("write_file");
  });

  it("should not contain execute tool", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).not.toContain("execute");
  });

  it("should be a readonly array", () => {
    // This is a type-level check, but we can verify it's an array
    expect(Array.isArray(TOOLS_EXCLUDED_FROM_EVICTION)).toBe(true);
    expect(TOOLS_EXCLUDED_FROM_EVICTION.length).toBe(6);
  });
});

describe("NUM_CHARS_PER_TOKEN", () => {
  it("should be 4", () => {
    expect(NUM_CHARS_PER_TOKEN).toBe(4);
  });
});

describe("createContentPreview", () => {
  it("should show all lines for small content", () => {
    const content = "line1\nline2\nline3";
    const preview = createContentPreview(content, 5, 5);

    expect(preview).toContain("line1");
    expect(preview).toContain("line2");
    expect(preview).toContain("line3");
    expect(preview).not.toContain("truncated");
  });

  it("should show head and tail with truncation marker for large content", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content, 5, 5);

    // Should contain head lines
    expect(preview).toContain("line1");
    expect(preview).toContain("line5");

    // Should contain truncation marker
    expect(preview).toContain("truncated");
    expect(preview).toContain("10 lines truncated");

    // Should contain tail lines
    expect(preview).toContain("line16");
    expect(preview).toContain("line20");
  });

  it("should use default head/tail values", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content);

    // Default is 5 head + 5 tail = 10, so 15 lines should show truncation
    expect(preview).toContain("truncated");
    expect(preview).toContain("5 lines truncated");
  });

  it("should truncate long lines to 1000 chars", () => {
    const longLine = "x".repeat(2000);
    const content = longLine;
    const preview = createContentPreview(content, 5, 5);

    // Should be truncated
    expect(preview.length).toBeLessThan(2000);
  });

  it("should include line numbers", () => {
    const content = "line1\nline2\nline3";
    const preview = createContentPreview(content);

    // Line numbers are right-padded with tab
    expect(preview).toMatch(/\d+\s+line1/);
    expect(preview).toMatch(/\d+\s+line2/);
    expect(preview).toMatch(/\d+\s+line3/);
  });

  it("should handle custom head and tail sizes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content, 3, 3);

    // Head should have 3 lines
    expect(preview).toContain("line1");
    expect(preview).toContain("line3");

    // Truncation should show 24 lines
    expect(preview).toContain("24 lines truncated");

    // Tail should have 3 lines
    expect(preview).toContain("line28");
    expect(preview).toContain("line30");
  });

  it("should handle exactly head + tail lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content, 5, 5);

    // Should show all lines without truncation
    expect(preview).not.toContain("truncated");
    expect(preview).toContain("line1");
    expect(preview).toContain("line10");
  });

  it("should handle empty content", () => {
    const preview = createContentPreview("");
    // Empty string splits into a single empty line, which gets formatted with a line number
    expect(preview).toContain("1");
  });

  it("should handle single line content", () => {
    const content = "single line";
    const preview = createContentPreview(content);

    expect(preview).toContain("single line");
    expect(preview).not.toContain("truncated");
  });
});
