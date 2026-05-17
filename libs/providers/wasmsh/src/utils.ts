import type { ReplEnvelope } from "./types.js";

/** Convert `kebab-case` or `snake_case` to `snake_case`. */
export function toSnakeCase(name: string): string {
  return name.replace(/-/g, "_");
}

/** Validate the snake form as a legal Python identifier. */
export function isValidPythonIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Format the launcher envelope into a single string for the agent. */
export function formatEnvelope(
  env: ReplEnvelope,
  maxResultChars: number,
): string {
  const parts: string[] = [];
  const block = (label: string, body: string) => {
    const trimmed =
      body.length > maxResultChars
        ? `${body.slice(0, Math.max(0, maxResultChars - 1))}…`
        : body;
    parts.push(`<${label}>\n${trimmed}\n</${label}>`);
  };
  if (env.stdout) block("stdout", env.stdout);
  if (env.stderr) block("stderr", env.stderr);
  if (env.ok) {
    if (env.value !== undefined && env.value !== null) {
      const rendered =
        typeof env.value === "string"
          ? env.value
          : JSON.stringify(env.value, null, 2);
      block("value", rendered);
    }
    if (parts.length === 0) parts.push("<no output>");
  } else {
    const label = `error ${env.error ?? "Error"}`;
    const body = env.traceback
      ? `${env.message ?? ""}\n\n${env.traceback}`.trim()
      : (env.message ?? "");
    block(label, body);
  }
  return parts.join("\n\n");
}
