import { describe, it, expect, vi } from "vitest";
import { transformForEval } from "./transform.js";

function makeTsTools(overrides: {
  compileSource?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    compileSource:
      overrides.compileSource ??
      vi.fn().mockImplementation(async ({ sourceText }: { sourceText: string }) => ({
        success: true,
        outputText: sourceText,
        diagnostics: [],
      })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("transformForEval", () => {
  describe("TypeScript detection", () => {
    it("does not call compileSource for plain JavaScript", async () => {
      const tsTools = makeTsTools();
      const { result } = await transformForEval(
        'const x = 1;\nconsole.log(x);',
        tsTools,
        [],
      );
      expect(tsTools.compileSource).not.toHaveBeenCalled();
      expect(result.wasTypeScript).toBe(false);
    });

    it("calls compileSource when TypeScript syntax is detected", async () => {
      const tsTools = makeTsTools();
      const { result } = await transformForEval(
        'const x: number = 42;',
        tsTools,
        [],
      );
      expect(tsTools.compileSource).toHaveBeenCalledOnce();
      expect(result.wasTypeScript).toBe(true);
    });

    it("detects TypeScript interface declaration", async () => {
      const tsTools = makeTsTools();
      const { result } = await transformForEval(
        'interface Foo { bar: string }',
        tsTools,
        [],
      );
      expect(result.wasTypeScript).toBe(true);
    });

    it("detects TypeScript type alias", async () => {
      const tsTools = makeTsTools();
      const { result } = await transformForEval(
        'type Foo = string | number;',
        tsTools,
        [],
      );
      expect(result.wasTypeScript).toBe(true);
    });

    it("includes type errors in result but still executes", async () => {
      const tsTools = makeTsTools({
        compileSource: vi.fn().mockResolvedValue({
          success: false,
          outputText: "const x = 42;",
          diagnostics: [{ message: "Type 'string' is not assignable to type 'number'" }],
        }),
      });
      const { result } = await transformForEval(
        'const x: number = "hello";',
        tsTools,
        [],
      );
      expect(result.typeErrors).toHaveLength(1);
      expect(result.typeErrors[0]).toContain("not assignable");
      // compiledCode should still be set (from outputText)
      expect(result.compiledCode).toBe("const x = 42;");
    });

    it("falls back to source-as-is when compileSource throws", async () => {
      const tsTools = makeTsTools({
        compileSource: vi.fn().mockRejectedValue(new Error("compiler crashed")),
      });
      const originalCode = 'const x: number = 42;';
      const { result } = await transformForEval(originalCode, tsTools, []);
      expect(result.compiledCode).toBe(originalCode);
    });

    it("skips tsTools when null, even for TS-looking code", async () => {
      const { result } = await transformForEval(
        'const x: number = 42;',
        null,
        [],
      );
      expect(result.wasTypeScript).toBe(true);
      // compiledCode stays as original when tsTools is null
      expect(result.compiledCode).toBe('const x: number = 42;');
    });
  });

  describe("declaration classification", () => {
    it("classifies const declaration as a snippet", async () => {
      const { result } = await transformForEval(
        'const x = 42;',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(1);
      expect(result.declarationSnippets[0]).toContain("const x = 42");
    });

    it("classifies let declaration as a snippet", async () => {
      const { result } = await transformForEval(
        'let y = "hello";',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(1);
      expect(result.declarationSnippets[0]).toContain("let y");
    });

    it("classifies var declaration as a snippet", async () => {
      const { result } = await transformForEval(
        'var z = true;',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(1);
    });

    it("classifies function declaration as a snippet", async () => {
      const { result } = await transformForEval(
        'function add(a, b) { return a + b; }',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(1);
      expect(result.declarationSnippets[0]).toContain("function add");
    });

    it("classifies class declaration as a snippet", async () => {
      const { result } = await transformForEval(
        'class MyClass { constructor() {} }',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(1);
      expect(result.declarationSnippets[0]).toContain("class MyClass");
    });

    it("does NOT classify expression statements as snippets", async () => {
      const { result } = await transformForEval(
        'console.log("hello");',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(0);
    });

    it("does NOT classify import statements as snippets", async () => {
      const { result } = await transformForEval(
        'import fs from "fs";',
        null,
        [],
      );
      expect(result.declarationSnippets).toHaveLength(0);
    });

    it("does NOT classify export statements as snippets", async () => {
      const { result } = await transformForEval(
        'export const x = 1;',
        null,
        [],
      );
      // ExportNamedDeclaration is skipped
      expect(result.declarationSnippets).toHaveLength(0);
    });
  });

  describe("preamble injection", () => {
    it("prepends previous snippets", async () => {
      const { fullSource } = await transformForEval(
        'console.log(x);',
        null,
        ['const x = 10;'],
      );
      expect(fullSource.indexOf("const x = 10;")).toBeLessThan(
        fullSource.indexOf("console.log(x)"),
      );
    });

    it("injects readFile and writeFile globals", async () => {
      const { fullSource } = await transformForEval(
        'const x = 1;',
        null,
        [],
      );
      expect(fullSource).toContain("const readFile =");
      expect(fullSource).toContain("const writeFile =");
      expect(fullSource).toContain("readFileSync");
      expect(fullSource).toContain("writeFileSync");
    });

    it("injects tools namespace when ptcToolNames provided", async () => {
      const { fullSource } = await transformForEval(
        'const x = 1;',
        null,
        [],
        "http://127.0.0.1:9999",
        ["myTool", "anotherTool"],
      );
      expect(fullSource).toContain("const tools = {");
      expect(fullSource).toContain("async myTool(input)");
      expect(fullSource).toContain("async anotherTool(input)");
      expect(fullSource).toContain("http://127.0.0.1:9999");
    });

    it("does not inject tools namespace when ptcToolNames not provided", async () => {
      const { fullSource } = await transformForEval(
        'const x = 1;',
        null,
        [],
      );
      expect(fullSource).not.toContain("const tools = {");
    });

    it("wraps user code in async IIFE", async () => {
      const { fullSource } = await transformForEval(
        'console.log("test");',
        null,
        [],
      );
      expect(fullSource).toContain("(async () => {");
      expect(fullSource).toContain("})()");
    });

    it("exports last expression via module.exports.__result", async () => {
      const { fullSource } = await transformForEval(
        '1 + 2',
        null,
        [],
      );
      expect(fullSource).toContain("module.exports = { __result:");
      expect(fullSource).toContain("1 + 2");
    });

    it("does not add module.exports when last statement is not an expression", async () => {
      const { fullSource } = await transformForEval(
        'const x = 42;',
        null,
        [],
      );
      expect(fullSource).not.toContain("module.exports = { __result:");
    });
  });
});
