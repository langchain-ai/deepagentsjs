import type { FileOperationError } from "deepagents";

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toInitialFiles(
  files: Record<string, string | Uint8Array> | undefined,
): Array<{ path: string; content: Uint8Array }> {
  if (!files) {
    return [];
  }
  return Object.entries(files).map(([path, content]) => ({
    path,
    content:
      typeof content === "string" ? new TextEncoder().encode(content) : content,
  }));
}

/** Extract a diagnostic error message from wasmsh protocol events. */
export function getDiagnosticError(
  events: unknown[] | undefined,
): string | undefined {
  if (!events) {
    return undefined;
  }
  for (const event of events) {
    if (
      event &&
      typeof event === "object" &&
      "Diagnostic" in event &&
      Array.isArray((event as { Diagnostic: unknown[] }).Diagnostic)
    ) {
      const [, message] = (event as { Diagnostic: [string, string] })
        .Diagnostic;
      return message;
    }
  }
  return undefined;
}

export function mapDownloadError(
  message: string | undefined,
): FileOperationError {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("not found")) {
    return "file_not_found";
  }
  if (normalized.includes("directory")) {
    return "is_directory";
  }
  if (normalized.includes("permission")) {
    return "permission_denied";
  }
  return "invalid_path";
}
