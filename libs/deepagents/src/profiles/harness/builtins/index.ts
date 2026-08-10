import { snapshotBuiltinKeys } from "../registry.js";

import { register as registerAnthropicOpus47 } from "./anthropic-opus-4-7.js";
import { register as registerAnthropicSonnet46 } from "./anthropic-sonnet-4-6.js";
import { register as registerAnthropicHaiku45 } from "./anthropic-haiku-4-5.js";
import { register as registerOpenaiCodex } from "./openai-codex.js";

/**
 * Register all built-in harness profiles and snapshot the resulting
 * registry keys as the builtin baseline.
 *
 * Called once during lazy bootstrap by `ensureBuiltinsLoaded()`.
 * Uses `registerHarnessProfileImpl` internally (not the public
 * `registerHarnessProfile`) to avoid triggering re-entrant bootstrap.
 *
 * @internal
 */
export function loadBuiltinProfiles(): void {
  registerAnthropicOpus47();
  registerAnthropicSonnet46();
  registerAnthropicHaiku45();
  registerOpenaiCodex();

  snapshotBuiltinKeys();
}
