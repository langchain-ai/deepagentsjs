import type { AgentMiddleware } from "langchain";
import type { HarnessProfile, GeneralPurposeSubagentConfig } from "./types.js";
import { resolveMiddleware } from "./types.js";
import { createHarnessProfile } from "./create.js";

/**
 * Merge two middleware sequences by `.name`.
 *
 * When the override has a middleware whose `.name` already appears in
 * the base, the override instance replaces the base instance at the
 * same position. Novel names from the override are appended. If the
 * base has duplicates of the same name, only the first is replaced;
 * later duplicates are dropped.
 *
 * Returns a factory to ensure fresh resolution on each call.
 */
function mergeMiddleware(
  base: AgentMiddleware[] | (() => AgentMiddleware[]),
  override: AgentMiddleware[] | (() => AgentMiddleware[]),
): (() => AgentMiddleware[]) | AgentMiddleware[] {
  const baseArr = resolveMiddleware(base);
  const overrideArr = resolveMiddleware(override);

  if (baseArr.length === 0) {
    return override;
  }

  if (overrideArr.length === 0) {
    return base;
  }

  return (): AgentMiddleware[] => {
    const baseSeq = resolveMiddleware(base);
    const overrideSeq = resolveMiddleware(override);
    const overrideByName = new Map(overrideSeq.map((m) => [m.name, m]));
    const merged: AgentMiddleware[] = [];
    const replaced = new Set<string>();

    for (const entry of baseSeq) {
      const replacement = overrideByName.get(entry.name);
      if (replacement) {
        if (!replaced.has(entry.name)) {
          merged.push(replacement);
          replaced.add(entry.name);
        }
      } else {
        merged.push(entry);
      }
    }

    for (const entry of overrideSeq) {
      if (!replaced.has(entry.name)) {
        merged.push(entry);
      }
    }

    return merged;
  };
}

/**
 * Merge two GP subagent configs field-wise.
 *
 * Override wins per sub-field when not `undefined`; unset fields
 * inherit from base. Returns `undefined` only when both inputs are
 * `undefined`.
 */
function mergeGeneralPurposeSubagentConfigs(
  base?: GeneralPurposeSubagentConfig,
  override?: GeneralPurposeSubagentConfig,
): GeneralPurposeSubagentConfig | undefined {
  if (base === undefined) {
    return override;
  }

  if (override === undefined) {
    return base;
  }

  return {
    enabled: override.enabled ?? base.enabled,
    description: override.description ?? base.description,
    systemPrompt: override.systemPrompt ?? base.systemPrompt,
  };
}

/**
 * Merge two harness profiles, layering `override` on top of `base`.
 *
 * Merge semantics per field:
 *
 * | Field | Strategy |
 * |-------|----------|
 * | `baseSystemPrompt` | Override wins if not `undefined` |
 * | `systemPromptSuffix` | Override wins if not `undefined` |
 * | `toolDescriptionOverrides` | Object spread merge; override wins per key |
 * | `excludedTools` | Set union |
 * | `excludedMiddleware` | Set union |
 * | `extraMiddleware` | Merge by `.name`; override instance replaces base at same position; novel names appended |
 * | `generalPurposeSubagent` | Field-wise merge; override wins per sub-field |
 *
 * @param base - Lower-priority profile (e.g., provider-wide).
 * @param override - Higher-priority profile (e.g., exact model).
 * @returns A new merged profile.
 */
export function mergeProfiles(
  base: HarnessProfile,
  override: HarnessProfile,
): HarnessProfile {
  return createHarnessProfile({
    baseSystemPrompt: override.baseSystemPrompt ?? base.baseSystemPrompt,
    systemPromptSuffix: override.systemPromptSuffix ?? base.systemPromptSuffix,
    toolDescriptionOverrides: {
      ...base.toolDescriptionOverrides,
      ...override.toolDescriptionOverrides,
    },
    excludedTools: [...base.excludedTools, ...override.excludedTools],
    excludedMiddleware: [
      ...base.excludedMiddleware,
      ...override.excludedMiddleware,
    ],
    extraMiddleware: mergeMiddleware(
      base.extraMiddleware,
      override.extraMiddleware,
    ),
    generalPurposeSubagent: mergeGeneralPurposeSubagentConfigs(
      base.generalPurposeSubagent,
      override.generalPurposeSubagent,
    ),
  });
}
