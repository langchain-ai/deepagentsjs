/**
 * Normalize and validate a profile registry key.
 *
 * Trims leading/trailing whitespace, then enforces the `"provider"` or
 * `"provider:model"` shape. Rejects empty strings, multiple colons, and
 * empty halves.
 *
 * @param key - The registry key to validate.
 * @returns The trimmed, validated key.
 * @throws {Error} When the key is malformed.
 *
 * @example
 * ```typescript
 * validateProfileKey("anthropic:claude-opus-4-7"); // "anthropic:claude-opus-4-7"
 * validateProfileKey("  openai  ");                 // "openai"
 * validateProfileKey("openai:");                    // throws
 * validateProfileKey("");                            // throws
 * ```
 */
export function validateProfileKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("Profile key must be a non-empty string");
  }

  if (trimmed.split(":").length > 2) {
    throw new Error(
      `Profile key "${trimmed}" has more than one ":"; expected "provider" or "provider:model"`,
    );
  }

  if (trimmed.includes(":")) {
    const [provider, model] = trimmed.split(":");
    if (!provider.trim() || !model.trim()) {
      throw new Error(
        `Profile key "${trimmed}" has an empty provider or model half; expected "provider:model"`,
      );
    }
  }

  return trimmed;
}
