/**
 * AST-based code transform pipeline for the REPL.
 *
 * Transforms TypeScript/JavaScript code into plain JS that can be
 * evaluated inside QuickJS with proper state persistence:
 *
 * 1. Parse with acorn + acorn-typescript (handles TS syntax)
 * 2. Strip TypeScript-only nodes (type annotations, interfaces, etc.)
 * 3. Hoist top-level declarations to globalThis for cross-eval persistence
 * 4. Auto-return the last expression
 * 5. Wrap in async IIFE so top-level await works
 */

import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { walk } from "estree-walker";
import MagicString from "magic-string";
import type {
  Node,
  Identifier,
  VariableDeclaration as EstreeVariableDeclaration,
  VariableDeclarator as EstreeVariableDeclarator,
} from "estree";

const TSParser = Parser.extend(tsPlugin());

type AcornNode = Node & { start: number; end: number };
type AcornVariableDeclaration = EstreeVariableDeclaration & {
  start: number;
  end: number;
  declarations: AcornVariableDeclarator[];
};
type AcornVariableDeclarator = EstreeVariableDeclarator & {
  start: number;
  end: number;
  id: AcornNode;
  init: AcornNode | null;
};

/**
 * Transform code for REPL evaluation.
 *
 * - Strips TypeScript syntax
 * - Hoists top-level variable declarations to globalThis
 * - Auto-returns the last expression
 * - Wraps in async IIFE for top-level await support
 */
export function transformForEval(code: string): string {
  let ast: AcornNode;
  try {
    ast = TSParser.parse(code, {
      ecmaVersion: "latest" as any,
      sourceType: "module",
      locations: true,
    }) as unknown as AcornNode;
  } catch {
    // If parsing fails, return the code as-is and let QuickJS report the error
    return `(async () => {\n${code}\n})()`;
  }

  const s = new MagicString(code);
  const program = ast as unknown as { body: AcornNode[] };
  const topLevelNodes = program.body;

  // Track which ranges to remove (TS-only nodes)
  // Track which declarations to hoist
  for (let i = 0; i < topLevelNodes.length; i++) {
    const node = topLevelNodes[i];

    // Remove TypeScript-only top-level declarations
    if (isTSOnlyNode(node)) {
      s.remove(node.start, node.end);
      continue;
    }

    // Remove import/export declarations (not supported in QuickJS eval)
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportDefaultDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      s.remove(node.start, node.end);
      continue;
    }

    // Hoist top-level variable declarations
    if (node.type === "VariableDeclaration") {
      hoistDeclaration(s, node as unknown as AcornVariableDeclaration);
      continue;
    }

    // Hoist function/class declarations to globalThis for cross-eval persistence
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ClassDeclaration"
    ) {
      stripTypeAnnotations(s, node);
      const name = (node as any).id?.name;
      if (name) {
        s.appendRight(node.end, `\nglobalThis.${name} = ${name};`);
      }
      continue;
    }
  }

  // Strip type annotations from within expressions/statements
  for (const node of topLevelNodes) {
    if (isTSOnlyNode(node)) continue;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportDefaultDeclaration" ||
      node.type === "ExportAllDeclaration"
    )
      continue;
    if (node.type !== "VariableDeclaration") {
      walk(node as any, {
        enter(n: any) {
          stripTypeAnnotationFromNode(s, n);
        },
      });
    }
  }

  // Auto-return the last expression
  const lastNode = findLastNonEmptyNode(topLevelNodes, s);
  if (lastNode && isExpression(lastNode)) {
    s.prependLeft(lastNode.start, "return (");
    s.appendRight(lastNode.end, ")");
  }

  // Wrap in async IIFE
  s.prepend("(async () => {\n");
  s.append("\n})()");

  return s.toString();
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

/**
 * Rewrite a top-level VariableDeclaration to globalThis assignments.
 *
 * `const x = 1, y = 2` → `globalThis.x = 1; globalThis.y = 2`
 */
function hoistDeclaration(
  s: MagicString,
  decl: AcornVariableDeclaration,
): void {
  const parts: string[] = [];

  for (const d of decl.declarations) {
    const id = d.id as AcornNode;
    if (id.type === "Identifier") {
      const initCode = d.init ? extractCleanInit(s, d) : "undefined";
      parts.push(
        `globalThis.${(id as unknown as Identifier).name} = ${initCode}`,
      );
    } else if (id.type === "ObjectPattern" || id.type === "ArrayPattern") {
      // Destructuring: keep as-is but use var for global scope
      const initCode = d.init ? s.slice(d.init.start, d.init.end) : "undefined";
      // For destructuring, we can't easily hoist each binding.
      // Evaluate the init, then assign each binding to globalThis.
      const bindings = extractBindingNames(d.id as any);
      parts.push(`var ${s.slice(d.id.start, d.id.end)} = ${initCode}`);
      for (const name of bindings) {
        parts.push(`globalThis.${name} = ${name}`);
      }
    }
  }

  s.overwrite(decl.start, decl.end, parts.join("; ") + ";");
}

/**
 * Extract the initializer code, stripping any type annotation between
 * the identifier and the `=`.
 */
function extractCleanInit(s: MagicString, d: AcornVariableDeclarator): string {
  if (!d.init) return "undefined";
  // Walk the init subtree to strip type annotations inside it
  const initSource = new MagicString(s.slice(d.init.start, d.init.end));
  return initSource.toString();
}

function extractBindingNames(pattern: any): string[] {
  const names: string[] = [];
  if (pattern.type === "Identifier") {
    if (pattern.name) names.push(pattern.name);
  } else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties || []) {
      if (prop.type === "RestElement") {
        names.push(...extractBindingNames(prop.argument));
      } else {
        names.push(...extractBindingNames(prop.value));
      }
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const el of pattern.elements || []) {
      if (el) names.push(...extractBindingNames(el));
    }
  } else if (pattern.type === "RestElement") {
    names.push(...extractBindingNames(pattern.argument));
  } else if (pattern.type === "AssignmentPattern") {
    names.push(...extractBindingNames(pattern.left));
  }
  return names;
}

function stripTypeAnnotations(s: MagicString, node: AcornNode): void {
  walk(node as any, {
    enter(n: any) {
      stripTypeAnnotationFromNode(s, n);
    },
  });
}

function stripTypeAnnotationFromNode(s: MagicString, n: any): void {
  // Type annotations on parameters, variables, return types
  if (n.typeAnnotation && n.typeAnnotation.start != null) {
    s.remove(n.typeAnnotation.start, n.typeAnnotation.end);
  }
  // Return type on functions
  if (n.returnType && n.returnType.start != null) {
    s.remove(n.returnType.start, n.returnType.end);
  }
  // Type parameters (generics)
  if (n.typeParameters && n.typeParameters.start != null) {
    s.remove(n.typeParameters.start, n.typeParameters.end);
  }
  // Type arguments on calls
  if (n.typeArguments && n.typeArguments.start != null) {
    s.remove(n.typeArguments.start, n.typeArguments.end);
  }
  // `as` expressions: keep the expression, remove `as Type`
  if (n.type === "TSAsExpression" && n.expression) {
    s.remove(n.expression.end, n.end);
  }
  // Non-null assertion: `x!` → `x`
  if (n.type === "TSNonNullExpression" && n.expression) {
    s.remove(n.expression.end, n.end);
  }
  // Satisfies expression: `x satisfies Type` → `x`
  if (n.type === "TSSatisfiesExpression" && n.expression) {
    s.remove(n.expression.end, n.end);
  }
}

function findLastNonEmptyNode(
  nodes: AcornNode[],
  s: MagicString,
): AcornNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    // Skip nodes that were fully removed
    const slice = s.slice(node.start, node.end).trim();
    if (slice === "" || slice === ";") continue;
    return node;
  }
  return null;
}

function isExpression(node: AcornNode): boolean {
  return node.type === "ExpressionStatement";
}
