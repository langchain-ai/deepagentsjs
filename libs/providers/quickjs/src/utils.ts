import { compile } from "json-schema-to-typescript";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import dedent from "dedent";
import type { ReplResult } from "./types.js";

/**
 * Convert a snake_case or kebab-case string to camelCase.
 */
export function toCamelCase(name: string): string {
  return name.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively collect all string values from an object, array, or primitive.
 */
export function collectStrings(obj: unknown): string[] {
  const result: string[] = [];
  function walk(val: unknown) {
    if (typeof val === "string") {
      result.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) walk(item);
    } else if (typeof val === "object" && val !== null) {
      for (const v of Object.values(val)) walk(v);
    }
  }
  walk(obj);
  return result;
}

/**
 * Format the result of a REPL evaluation for the agent.
 */
export function formatReplResult(result: ReplResult): string {
  const parts: string[] = [];

  if (result.logs.length > 0) {
    let logsText = result.logs.join("\n");
    if (result.logsDroppedChars > 0) {
      logsText += `\n[truncated ${result.logsDroppedChars} chars]`;
    }
    parts.push(logsText);
  }

  if (result.ok) {
    if (result.value !== undefined) {
      const formatted =
        typeof result.value === "string"
          ? result.value
          : JSON.stringify(result.value, null, 2);
      parts.push(`→ ${formatted}`);
    }
  } else if (result.error) {
    const errName = result.error.name || "Error";
    const errMsg = result.error.message || "Unknown error";
    parts.push(`${errName}: ${errMsg}`);
    if (result.error.stack) {
      parts.push(result.error.stack);
    }
  }

  return parts.join("\n") || "(no output)";
}

export function safeToJsonSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  try {
    return toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

async function schemaToInterface(
  jsonSchema: Record<string, unknown>,
  interfaceName: string,
): Promise<string> {
  const compiled = await compile(
    { ...jsonSchema, additionalProperties: false },
    interfaceName,
    { bannerComment: "", additionalProperties: false },
  );
  return compiled.replace(/^export /, "").trimEnd();
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function toolToTypeSignature(
  name: string,
  description: string,
  jsonSchema: Record<string, unknown> | undefined,
): Promise<string> {
  const inputType = `${capitalize(name)}Input`;

  if (!jsonSchema || !jsonSchema.properties) {
    return dedent`
      /**
       * ${description}
       */
      async tools.${name}(input: Record<string, unknown>): Promise<string>
    `;
  }

  const iface = await schemaToInterface(jsonSchema, inputType);
  return dedent`
    ${iface}

    /**
     * ${description}
     */
    async tools.${name}(input: ${inputType}): Promise<string>
  `;
}

/**
 * Render a pre-eval error when referenced skills are not available on the agent.
 */
export function formatSkillNotAvailable(missing: readonly string[]): string {
  const list = [...missing].sort().join(", ");
  return `Skills unavailable: ${list}`;
}
