/**
 * Error codes for {@link ConfigurationError}.
 *
 * Each code represents a distinct misconfiguration that can be detected at
 * agent-construction time. Add new codes here as new validations are added.
 */
export type ConfigurationErrorCode = "TOOL_NAME_COLLISION";

const CONFIGURATION_ERROR_SYMBOL = Symbol.for("deepagents.configuration_error");

/**
 * Thrown when `createDeepAgent` receives invalid configuration.
 *
 * Follows the same pattern as {@link SandboxError}: a human-readable
 * `message`, a structured `code` for programmatic handling, and a
 * static `isInstance` guard that works across realms.
 *
 * @example
 * ```typescript
 * try {
 *   createDeepAgent({ tools: [myTool] });
 * } catch (error) {
 *   if (ConfigurationError.isInstance(error)) {
 *     switch (error.code) {
 *       case "TOOL_NAME_COLLISION":
 *         console.error("Rename your tool:", error.message);
 *         break;
 *     }
 *   }
 * }
 * ```
 */
export class ConfigurationError extends Error {
  [CONFIGURATION_ERROR_SYMBOL] = true as const;

  override readonly name: string = "ConfigurationError";

  constructor(
    message: string,
    public readonly code: ConfigurationErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }

  static isInstance(error: unknown): error is ConfigurationError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[CONFIGURATION_ERROR_SYMBOL] === true
    );
  }
}
