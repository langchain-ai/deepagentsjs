import { describe, it, expect } from "vitest";
import { transformForEval, stripTypeSyntax } from "./transform.js";

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

    it("should strip 'as' expressions in variable initializers", () => {
      const result = transformForEval(
        "const data = JSON.parse(raw) as { n: number }",
      );
      expect(result).toContain("globalThis.data = JSON.parse(raw)");
      expect(result).not.toContain("as {");
    });

    it("should strip type annotations from arrow function initializers", () => {
      const result = transformForEval(
        "const fn = (x: number): number => x + 1",
      );
      expect(result).toContain("globalThis.fn = (x) => x + 1");
      expect(result).not.toContain(": number");
    });

    it("should strip generics from call expressions in initializers", () => {
      const result = transformForEval("const arr = Array.from<number>([1, 2])");
      expect(result).toContain("globalThis.arr = Array.from([1, 2])");
      expect(result).not.toContain("<number>");
    });

    it("should strip non-null assertions in initializers", () => {
      const result = transformForEval(
        "const el = document.getElementById('x')!",
      );
      expect(result).toContain("globalThis.el = document.getElementById('x')");
      expect(result).not.toContain("!");
    });
  });

  describe("auto-return with semicolons", () => {
    it("should not wrap trailing semicolons inside return parens", () => {
      const result = transformForEval("console.log(42);");
      expect(result).toContain("return (console.log(42))");
      expect(result).not.toContain("return (console.log(42);)");
    });

    it("should handle expressions without trailing semicolons", () => {
      const result = transformForEval("console.log(42)");
      expect(result).toContain("return (console.log(42))");
    });

    it("should auto-return after declarations with semicolons", () => {
      const result = transformForEval("const x = 1;\nx;");
      expect(result).toContain("return (x)");
      expect(result).not.toContain("return (x;)");
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

describe("stripTypeSyntax", () => {
  describe("plain JS passthrough", () => {
    it("returns an empty string unchanged", () => {
      expect(stripTypeSyntax("")).toBe("");
    });

    it("returns plain JS module unchanged", () => {
      const code = `export function add(a, b) { return a + b; }`;
      expect(stripTypeSyntax(code)).toBe(code);
    });
  });

  describe("TS-only top-level forms are removed", () => {
    it("removes interface declarations", () => {
      const result = stripTypeSyntax("interface Foo { x: number }");
      expect(result).not.toContain("interface");
      expect(result.trim()).toBe("");
    });

    it("removes type aliases", () => {
      const result = stripTypeSyntax("type ID = string;");
      expect(result).not.toContain("type ID");
      expect(result.trim()).toBe("");
    });

    it("removes enum declarations", () => {
      const result = stripTypeSyntax("enum Direction { Up, Down }");
      expect(result).not.toContain("enum");
      expect(result.trim()).toBe("");
    });

    it("removes declare function", () => {
      const result = stripTypeSyntax("declare function foo(x: number): void;");
      expect(result).not.toContain("declare");
      expect(result.trim()).toBe("");
    });

    it("removes mixed TS-only and JS nodes, keeping JS", () => {
      const code = [
        "interface Foo { x: number }",
        "export function bar() { return 1; }",
      ].join("\n");
      const result = stripTypeSyntax(code);
      expect(result).not.toContain("interface");
      expect(result).toContain("export function bar");
    });
  });

  describe("type annotations stripped from expressions", () => {
    it("strips parameter types", () => {
      const result = stripTypeSyntax(
        "export function add(a: number, b: number) { return a + b; }",
      );
      expect(result).toContain("function add(a, b)");
      expect(result).not.toContain(": number");
    });

    it("strips return types", () => {
      const result = stripTypeSyntax(
        "export function id(x: string): string { return x; }",
      );
      expect(result).not.toContain("): string");
      expect(result).toContain("function id");
    });

    it("strips generics from function declarations", () => {
      const result = stripTypeSyntax(
        "export function wrap<T>(x: T): T { return x; }",
      );
      expect(result).not.toContain("<T>");
      expect(result).toContain("function wrap");
    });

    it("strips `as` type casts", () => {
      const result = stripTypeSyntax(
        "export const x = JSON.parse(raw) as { n: number };",
      );
      expect(result).toContain("JSON.parse(raw)");
      expect(result).not.toContain("as {");
    });

    it("strips non-null assertions", () => {
      const result = stripTypeSyntax(
        "export const el = document.getElementById('x')!;",
      );
      expect(result).toContain("document.getElementById('x')");
      expect(result).not.toMatch(/getElementById\('x'\)!/);
    });

    it("strips satisfies expressions", () => {
      const result = stripTypeSyntax(
        "export const cfg = { port: 8080 } satisfies Config;",
      );
      expect(result).toContain("{ port: 8080 }");
      expect(result).not.toContain("satisfies");
    });

    it("strips type annotations from variable declarations", () => {
      const result = stripTypeSyntax("const x: number = 42;");
      expect(result).toContain("const x");
      expect(result).not.toContain(": number");
    });
  });

  describe("import and export declarations survive", () => {
    it("preserves named import declarations", () => {
      const result = stripTypeSyntax(`import { foo } from "./foo.js";`);
      expect(result).toContain(`import { foo } from "./foo.js"`);
    });

    it("preserves default import declarations", () => {
      const result = stripTypeSyntax(`import bar from "./bar.js";`);
      expect(result).toContain(`import bar from "./bar.js"`);
    });

    it("preserves named export declarations", () => {
      const result = stripTypeSyntax(
        "export function greet() { return 'hi'; }",
      );
      expect(result).toContain("export function greet");
    });

    it("preserves export default", () => {
      const result = stripTypeSyntax(
        "export default function () { return 1; }",
      );
      expect(result).toContain("export default function");
    });

    it("preserves re-export declarations", () => {
      const result = stripTypeSyntax(`export { foo } from "./foo.js";`);
      expect(result).toContain(`export { foo } from "./foo.js"`);
    });

    it("strips type-only imports without leaving behind empty lines that break syntax", () => {
      const code = [
        `import type { Foo } from "./types.js";`,
        `export function bar() { return 1; }`,
      ].join("\n");
      const result = stripTypeSyntax(code);
      expect(result).toContain("export function bar");
    });
  });

  describe("parse failure fallback", () => {
    it("returns original source on invalid syntax", () => {
      const code = "{{{{invalid syntax";
      expect(stripTypeSyntax(code)).toBe(code);
    });

    it("does not throw on parse failure", () => {
      expect(() => stripTypeSyntax("}{")).not.toThrow();
    });
  });
});
