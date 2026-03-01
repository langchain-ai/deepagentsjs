import { describe, it, expect } from "vitest";
import { transformForEval } from "./transform.js";

describe("transformForEval", () => {
  describe("basic wrapping", () => {
    it("should wrap code in async IIFE", () => {
      const result = transformForEval("42");
      expect(result).toContain("(async () => {");
      expect(result).toContain("})()");
    });

    it("should auto-return the last expression", () => {
      const result = transformForEval("1 + 2");
      expect(result).toContain("return (1 + 2)");
    });

    it("should not return declarations", () => {
      const result = transformForEval("const x = 42");
      expect(result).not.toContain("return");
    });
  });

  describe("declaration hoisting", () => {
    it("should hoist const to globalThis", () => {
      const result = transformForEval("const x = 42");
      expect(result).toContain("globalThis.x = 42");
      expect(result).not.toContain("const x");
    });

    it("should hoist let to globalThis", () => {
      const result = transformForEval("let items = [1, 2]");
      expect(result).toContain("globalThis.items = [1, 2]");
    });

    it("should hoist var to globalThis", () => {
      const result = transformForEval("var count = 0");
      expect(result).toContain("globalThis.count = 0");
    });

    it("should hoist multiple declarators", () => {
      const result = transformForEval("const a = 1, b = 2");
      expect(result).toContain("globalThis.a = 1");
      expect(result).toContain("globalThis.b = 2");
    });

    it("should hoist function declarations", () => {
      const result = transformForEval("function add(a, b) { return a + b }");
      expect(result).toContain("function add(a, b)");
      expect(result).toContain("globalThis.add = add");
    });

    it("should hoist class declarations", () => {
      const result = transformForEval("class Foo { bar() {} }");
      expect(result).toContain("class Foo");
      expect(result).toContain("globalThis.Foo = Foo");
    });
  });

  describe("TypeScript stripping", () => {
    it("should strip type annotations from variables", () => {
      const result = transformForEval("const x: number = 42");
      expect(result).toContain("globalThis.x = 42");
      expect(result).not.toContain(": number");
    });

    it("should strip interfaces", () => {
      const result = transformForEval(
        "interface Foo { x: number }\nconst f: Foo = { x: 1 }",
      );
      expect(result).not.toContain("interface");
      expect(result).toContain("globalThis.f =");
    });

    it("should strip type aliases", () => {
      const result = transformForEval(
        "type ID = string\nconst id: ID = 'abc'\nid",
      );
      expect(result).not.toContain("type ID");
      expect(result).toContain("globalThis.id =");
    });

    it("should strip function parameter types and return types", () => {
      const result = transformForEval(
        "function add(a: number, b: number): number { return a + b }",
      );
      expect(result).toContain("function add(a, b)");
      expect(result).not.toContain(": number");
    });
  });

  describe("top-level await", () => {
    it("should support await expressions", () => {
      const result = transformForEval(
        'const data = await readFile("/f.txt")\ndata',
      );
      expect(result).toContain("globalThis.data = await readFile");
      expect(result).toContain("return (data)");
    });

    it("should support Promise.all", () => {
      const result = transformForEval(
        "const [a, b] = await Promise.all([p1, p2])",
      );
      expect(result).toContain("await Promise.all");
    });
  });

  describe("error recovery", () => {
    it("should fall back to raw wrapping on parse errors", () => {
      const result = transformForEval("{{{{invalid syntax");
      expect(result).toContain("(async () => {");
      expect(result).toContain("{{{{invalid syntax");
    });
  });
});
