/**
 * Centralized model defaults for Deep Agents.
 *
 * Override at runtime via the `DEEPAGENTS_DEFAULT_MODEL` environment variable.
 */

const BUILTIN_DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";

export const DEFAULT_MODEL: string =
  process.env.DEEPAGENTS_DEFAULT_MODEL || BUILTIN_DEFAULT_MODEL;
