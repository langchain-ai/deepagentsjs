import { describe, it, expect } from "vitest";
import { interpolateInstruction } from "./interpolate.js";

describe("interpolateInstruction", () => {
  it("returns the template unchanged when there are no placeholders", () => {
    expect(interpolateInstruction("Classify this text.", {})).toBe(
      "Classify this text.",
    );
  });

  it("substitutes a single placeholder with a string value", () => {
    expect(
      interpolateInstruction("Analyze {company}.", { company: "Acme" }),
    ).toBe("Analyze Acme.");
  });

  it("substitutes multiple placeholders in one pass", () => {
    const row = { name: "Acme", sector: "tech" };
    expect(
      interpolateInstruction("Company: {name}. Sector: {sector}.", row),
    ).toBe("Company: Acme. Sector: tech.");
  });

  it("supports dotted-path placeholders for nested values", () => {
    const row = { meta: { sector: "finance" }, revenue: 5000 };
    expect(
      interpolateInstruction("Analyze {meta.sector}. Revenue: {revenue}.", row),
    ).toBe("Analyze finance. Revenue: 5000.");
  });

  it("trims whitespace inside braces", () => {
    expect(interpolateInstruction("Hello { name }!", { name: "World" })).toBe(
      "Hello World!",
    );
  });

  it("renders null values as the string 'null'", () => {
    expect(interpolateInstruction("Result: {result}", { result: null })).toBe(
      "Result: null",
    );
  });

  it("renders numbers as their string representation", () => {
    expect(interpolateInstruction("Score: {score}", { score: 42 })).toBe(
      "Score: 42",
    );
  });

  it("renders 0 correctly", () => {
    expect(interpolateInstruction("Count: {n}", { n: 0 })).toBe("Count: 0");
  });

  it("renders booleans as their string representation", () => {
    expect(interpolateInstruction("Active: {active}", { active: true })).toBe(
      "Active: true",
    );
    expect(interpolateInstruction("Active: {active}", { active: false })).toBe(
      "Active: false",
    );
  });

  it("JSON-serializes object values", () => {
    const row = { tags: { primary: "a", secondary: "b" } };
    expect(interpolateInstruction("Tags: {tags}", row)).toBe(
      'Tags: {"primary":"a","secondary":"b"}',
    );
  });

  it("JSON-serializes array values", () => {
    const row = { items: [1, 2, 3] };
    expect(interpolateInstruction("Items: {items}", row)).toBe(
      "Items: [1,2,3]",
    );
  });

  it("handles a placeholder at the very start of the template", () => {
    expect(interpolateInstruction("{name} joined.", { name: "Alice" })).toBe(
      "Alice joined.",
    );
  });

  it("handles a placeholder at the very end of the template", () => {
    expect(interpolateInstruction("Hello, {name}", { name: "Bob" })).toBe(
      "Hello, Bob",
    );
  });

  it("handles an empty template", () => {
    expect(interpolateInstruction("", { name: "x" })).toBe("");
  });

  it("throws when a placeholder column is absent from the row", () => {
    expect(() => interpolateInstruction("Analyze {missing}.", {})).toThrow(
      "Missing column(s) in row: missing",
    );
  });

  it("throws listing all missing columns at once", () => {
    expect(() => interpolateInstruction("{a} and {b} and {c}", {})).toThrow(
      /a.*b.*c|b.*a/,
    );
  });

  it("throws only for missing columns, not present ones", () => {
    expect(() =>
      interpolateInstruction("{present} and {absent}", { present: "yes" }),
    ).toThrow("Missing column(s) in row: absent");
  });

  it("does not throw when all placeholders are satisfied", () => {
    expect(() =>
      interpolateInstruction("{a} {b}", { a: "x", b: "y" }),
    ).not.toThrow();
  });

  it("handles the same placeholder appearing multiple times", () => {
    expect(interpolateInstruction("{name} is {name}.", { name: "Alice" })).toBe(
      "Alice is Alice.",
    );
  });

  it("substitutes the inner placeholder in {{name}}, leaving outer braces", () => {
    // The regex [^{}]+ matches innermost braces first. {{name}} becomes {<value>}.
    const result = interpolateInstruction("{{name}}", { name: "x" });
    expect(result).toBe("{x}");
  });
});
