/**
 * AST-based code transform pipeline for the secure-exec REPL.
 *
 * Transforms TypeScript/JavaScript code into CommonJS that can be executed
 * inside a Node.js V8 isolate with proper state persistence:
 *
 * 1. Detect TypeScript via regexp heuristics
 * 2. Compile TypeScript to JS using @secure-exec/typescript (if available)
 * 3. Parse with acorn + acorn-typescript to classify top-level statements
 * 4. Classify VariableDeclaration, FunctionDeclaration, ClassDeclaration as persistent snippets
 * 5. Build fullSource: previous snippets + globals preamble + optional PTC tools + user IIFE
 * 6. Auto-export the last expression via module.exports.__result
 */

import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import type { Node } from "estree";

const TSParser = Parser.extend(
  tsPlugin() as Parameters<typeof Parser.extend>[0],
);

/** Regexp patterns that indicate TypeScript-specific syntax. */
const TS_PATTERNS = [
  /:\s*(string|number|boolean|any|unknown|never|void|null|undefined)\b/,
  /\bas\s+\w/,
  /<[A-Z]\w*>/,
  /\binterface\s+\w/,
  /\btype\s+\w+\s*=/,
  /\bimplements\s+\w/,
  /:\s*Promise</,
  /<string>/,
  /<number>/,
  /:\s*\w+\[\]/,
  /\benum\s+\w/,
];

export interface TransformResult {
  compiledCode: string;
  declarationSnippets: string[];
  wasTypeScript: boolean;
  typeErrors: string[];
}

type AcornNode = Node & { start: number; end: number };

function isTypeScript(code: string): boolean {
  return TS_PATTERNS.some((p) => p.test(code));
}

function isTSOnlyNode(node: AcornNode): boolean {
  const t = node.type as string;
  return (
    t === "TSTypeAliasDeclaration" ||
    t === "TSInterfaceDeclaration" ||
    t === "TSEnumDeclaration" ||
    t === "TSModuleDeclaration" ||
    t === "TSDeclareFunction" ||
    t.startsWith("TS")
  );
}

function parseCode(code: string): { body: AcornNode[] } | null {
  try {
    const ast = TSParser.parse(code, {
      ecmaVersion: "latest" as never,
      sourceType: "script",
      locations: true,
    });
    return ast as unknown as { body: AcornNode[] };
  } catch {
    return null;
  }
}

/**
 * Transform code for evaluation in the secure-exec V8 isolate.
 *
 * @param code - User-submitted code (JS or TS)
 * @param tsTools - TypeScript compiler tools from @secure-exec/typescript, or null
 * @param previousSnippets - Declaration snippets from prior evals (accumulated state)
 * @param ptcBridgeUrl - Optional HTTP bridge URL for PTC tool calling
 * @param ptcToolNames - camelCase tool names to expose via `tools` namespace
 */
export async function transformForEval(
  code: string,
  tsTools: {
    compileSource(options: {
      sourceText: string;
      filePath?: string;
      compilerOptions?: Record<string, unknown>;
    }): Promise<{
      success: boolean;
      outputText?: string;
      diagnostics?: Array<{ message: string }>;
    }>;
  } | null,
  previousSnippets: string[],
  ptcBridgeUrl?: string,
  ptcToolNames?: string[],
): Promise<{ fullSource: string; result: TransformResult }> {
  const wasTypeScript = isTypeScript(code);
  let compiledCode = code;
  const typeErrors: string[] = [];

  // Step 1: Compile TypeScript if needed
  if (wasTypeScript && tsTools) {
    try {
      const compileResult = await tsTools.compileSource({
        sourceText: code,
        filePath: "/sandbox/eval.ts",
        compilerOptions: { module: "commonjs", target: "es2022" },
      });

      if (compileResult.outputText) {
        compiledCode = compileResult.outputText;
      }
      if (!compileResult.success && compileResult.diagnostics) {
        for (const d of compileResult.diagnostics) {
          typeErrors.push(d.message);
        }
      }
    } catch {
      // Fall back to source-as-is if compilation throws
      compiledCode = code;
    }
  }

  // Step 2: Parse and classify top-level declarations
  const declarationSnippets: string[] = [];
  const ast = parseCode(compiledCode);

  let lastExpressionNode: AcornNode | null = null;

  if (ast) {
    for (const node of ast.body) {
      if (isTSOnlyNode(node)) continue;

      if (
        node.type === "VariableDeclaration" ||
        node.type === "FunctionDeclaration" ||
        node.type === "ClassDeclaration"
      ) {
        const snippet = compiledCode.slice(node.start, node.end);
        declarationSnippets.push(snippet);
      }

      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportDefaultDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        continue;
      }
    }

    // Find last non-TS, non-import expression statement for auto-return
    for (let i = ast.body.length - 1; i >= 0; i--) {
      const node = ast.body[i];
      if (isTSOnlyNode(node)) continue;
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportDefaultDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        continue;
      }
      if (node.type === "ExpressionStatement") {
        lastExpressionNode = node;
      }
      break;
    }
  }

  // Step 3: Build fullSource
  const parts: string[] = [];

  // Previous declaration snippets (persistent state)
  if (previousSnippets.length > 0) {
    parts.push(previousSnippets.join("\n"));
  }

  // Globals preamble: file I/O convenience wrappers
  parts.push(
    [
      "const { readFileSync, writeFileSync } = require('fs');",
      "const readFile = (p) => readFileSync(p, 'utf8');",
      "const writeFile = (p, c) => writeFileSync(p, c);",
    ].join("\n"),
  );

  // PTC tools namespace (HTTP bridge approach)
  if (ptcBridgeUrl && ptcToolNames && ptcToolNames.length > 0) {
    const toolFns = ptcToolNames.map((name) =>
      [
        `  async ${name}(input) {`,
        `    const res = await fetch(${JSON.stringify(ptcBridgeUrl)}, {`,
        `      method: 'POST',`,
        `      headers: { 'Content-Type': 'application/json' },`,
        `      body: JSON.stringify({ tool: ${JSON.stringify(name)}, input }),`,
        `    });`,
        `    const json = await res.json();`,
        `    return json.result;`,
        `  },`,
      ].join("\n"),
    );
    parts.push(`const tools = {\n${toolFns.join("\n")}\n};`);
  }

  // User code wrapped in async IIFE with auto-export of last expression
  let userCode = compiledCode;

  if (lastExpressionNode) {
    // Replace the last expression statement with module.exports assignment
    const before = compiledCode.slice(0, lastExpressionNode.start);
    const exprNode = (
      lastExpressionNode as unknown as { expression: AcornNode }
    ).expression;
    const exprCode = compiledCode.slice(exprNode.start, exprNode.end);
    const after = compiledCode.slice(lastExpressionNode.end);
    userCode = before + `module.exports = { __result: (${exprCode}) };` + after;
  }

  parts.push(`(async () => {\n${userCode}\n})()`);

  const fullSource = parts.join("\n\n");

  return {
    fullSource,
    result: {
      compiledCode,
      declarationSnippets,
      wasTypeScript,
      typeErrors,
    },
  };
}
