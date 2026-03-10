import { describe, it, expect } from "vitest";
import { transformForEval } from "./transform.js";

describe("transformForEval", () => {
  describe("basic wrapping", () => {
    it("should wrap code in async IIFE", () => {
      const { code } = transformForEval("42");
      expect(code).toContain("(async () => {");
      expect(code).toContain("})()");
    });

    it("should auto-return the last expression", () => {
      const { code } = transformForEval("1 + 2");
      expect(code).toContain("return (1 + 2)");
    });

    it("should not return declarations", () => {
      const { code } = transformForEval("const x = 42");
      expect(code).not.toContain("return");
    });
  });

  describe("declaration hoisting", () => {
    it("should hoist const to globalThis", () => {
      const { code } = transformForEval("const x = 42");
      expect(code).toContain("globalThis.x = 42");
      expect(code).not.toContain("const x");
    });

    it("should hoist let to globalThis", () => {
      const { code } = transformForEval("let items = [1, 2]");
      expect(code).toContain("globalThis.items = [1, 2]");
    });

    it("should hoist var to globalThis", () => {
      const { code } = transformForEval("var count = 0");
      expect(code).toContain("globalThis.count = 0");
    });

    it("should hoist multiple declarators", () => {
      const { code } = transformForEval("const a = 1, b = 2");
      expect(code).toContain("globalThis.a = 1");
      expect(code).toContain("globalThis.b = 2");
    });

    it("should hoist function declarations", () => {
      const { code } = transformForEval("function add(a, b) { return a + b }");
      expect(code).toContain("function add(a, b)");
      expect(code).toContain("globalThis.add = add");
    });

    it("should hoist class declarations", () => {
      const { code } = transformForEval("class Foo { bar() {} }");
      expect(code).toContain("class Foo");
      expect(code).toContain("globalThis.Foo = Foo");
    });
  });

  describe("TypeScript stripping", () => {
    it("should strip type annotations from variables", () => {
      const { code } = transformForEval("const x: number = 42");
      expect(code).toContain("globalThis.x = 42");
      expect(code).not.toContain(": number");
    });

    it("should strip interfaces", () => {
      const { code } = transformForEval(
        "interface Foo { x: number }\nconst f: Foo = { x: 1 }",
      );
      expect(code).not.toContain("interface");
      expect(code).toContain("globalThis.f =");
    });

    it("should strip type aliases", () => {
      const { code } = transformForEval(
        "type ID = string\nconst id: ID = 'abc'\nid",
      );
      expect(code).not.toContain("type ID");
      expect(code).toContain("globalThis.id =");
    });

    it("should strip function parameter types and return types", () => {
      const { code } = transformForEval(
        "function add(a: number, b: number): number { return a + b }",
      );
      expect(code).toContain("function add(a, b)");
      expect(code).not.toContain(": number");
    });

    it("should strip 'as' expressions in variable initializers", () => {
      const { code } = transformForEval(
        "const data = JSON.parse(raw) as { n: number }",
      );
      expect(code).toContain("globalThis.data = JSON.parse(raw)");
      expect(code).not.toContain("as {");
    });

    it("should strip type annotations from arrow function initializers", () => {
      const { code } = transformForEval(
        "const fn = (x: number): number => x + 1",
      );
      expect(code).toContain("globalThis.fn = (x) => x + 1");
      expect(code).not.toContain(": number");
    });

    it("should strip generics from call expressions in initializers", () => {
      const { code } = transformForEval(
        "const arr = Array.from<number>([1, 2])",
      );
      expect(code).toContain("globalThis.arr = Array.from([1, 2])");
      expect(code).not.toContain("<number>");
    });

    it("should strip non-null assertions in initializers", () => {
      const { code } = transformForEval(
        "const el = document.getElementById('x')!",
      );
      expect(code).toContain("globalThis.el = document.getElementById('x')");
      expect(code).not.toContain("!");
    });
  });

  describe("auto-return with semicolons", () => {
    it("should not wrap trailing semicolons inside return parens", () => {
      const { code } = transformForEval("console.log(42);");
      expect(code).toContain("return (console.log(42))");
      expect(code).not.toContain("return (console.log(42);)");
    });

    it("should handle expressions without trailing semicolons", () => {
      const { code } = transformForEval("console.log(42)");
      expect(code).toContain("return (console.log(42))");
    });

    it("should auto-return after declarations with semicolons", () => {
      const { code } = transformForEval("const x = 1;\nx;");
      expect(code).toContain("return (x)");
      expect(code).not.toContain("return (x;)");
    });
  });

  describe("top-level await", () => {
    it("should support await expressions", () => {
      const { code } = transformForEval(
        'const data = await readFile("/f.txt")\ndata',
      );
      expect(code).toContain("globalThis.data = await readFile");
      expect(code).toContain("return (data)");
    });

    it("should support Promise.all", () => {
      const { code } = transformForEval(
        "const [a, b] = await Promise.all([p1, p2])",
      );
      expect(code).toContain("await Promise.all");
    });
  });

  describe("declaredNames tracking", () => {
    it("should collect variable names", () => {
      const { declaredNames } = transformForEval("const x = 1\nlet y = 2");
      expect(declaredNames).toEqual(["x", "y"]);
    });

    it("should collect function names", () => {
      const { declaredNames } = transformForEval(
        "function add(a, b) { return a + b }",
      );
      expect(declaredNames).toEqual(["add"]);
    });

    it("should collect class names", () => {
      const { declaredNames } = transformForEval("class Foo { bar() {} }");
      expect(declaredNames).toEqual(["Foo"]);
    });

    it("should collect destructured binding names", () => {
      const { declaredNames } = transformForEval(
        "const { a, b } = obj\nconst [c, d] = arr",
      );
      expect(declaredNames).toEqual(["a", "b", "c", "d"]);
    });

    it("should return empty array on parse errors", () => {
      const { declaredNames } = transformForEval("{{{{invalid syntax");
      expect(declaredNames).toEqual([]);
    });
  });

  describe("error recovery", () => {
    it("should fall back to raw wrapping on parse errors", () => {
      const { code } = transformForEval("{{{{invalid syntax");
      expect(code).toContain("(async () => {");
      expect(code).toContain("{{{{invalid syntax");
    });
  });
});
