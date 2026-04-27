import type { ToolPolicy, ToolPolicyContext } from "@langchain/core/tools";
import { decidePathAccess, validatePath } from "./enforce.js";
import { FS_PERMISSIONS_RUNTIME_KEY, type PathDecider } from "./runtime.js";
import type { FilesystemOperation, FilesystemPermission } from "./types.js";

/**
 * Configuration for a {@link FilesystemPolicy}.
 *
 * @typeParam TIn - The tool's parsed input type.
 * @typeParam TOut - The tool's output type.
 *
 * @internal
 */
export interface FilesystemPolicyOptions<TIn, TOut> {
  /**
   * Whether the tool performs a `read` or `write` for the purpose of
   * matching against `FilesystemPermission.operations`.
   */
  operation: FilesystemOperation;

  /**
   * Extract zero or more paths from the tool's parsed input. Returning
   * an empty array means there is nothing to check (no path arg
   * present); the call proceeds.
   */
  paths: (args: TIn) => string[];

  /**
   * Optional: filter structured output by allowed paths. Used by tools
   * like `glob`, `grep`, and `ls` where partial denial means "remove
   * some entries" rather than "deny the whole call".
   *
   * The `decide` callback returns `"allow"` or `"deny"` for a given
   * operation + path pair. The filter implementation is responsible
   * for traversing its own output shape and removing denied entries.
   */
  filter?: (output: TOut, decide: PathDecider) => TOut;
}

/**
 * `ToolPolicy` implementation that enforces `FilesystemPermission`
 * rules against a tool's path arguments.
 *
 * Rules are read at invoke time from
 * `RunnableConfig.configurable[FS_PERMISSIONS_RUNTIME_KEY]`. When no
 * rules are present in config, the policy is a no-op — attaching it
 * to a tool has no observable effect for users who do not configure
 * permissions.
 *
 * @internal
 */
export class FilesystemPolicy<
  TIn = unknown,
  TOut = unknown,
> implements ToolPolicy<TIn, TOut> {
  private operation: FilesystemOperation;
  private paths: (args: TIn) => string[];
  private filter?: (output: TOut, decide: PathDecider) => TOut;

  constructor(options: FilesystemPolicyOptions<TIn, TOut>) {
    this.operation = options.operation;
    this.paths = options.paths;
    this.filter = options.filter;
  }

  async beforeInvoke(ctx: ToolPolicyContext<TIn>): Promise<void> {
    const { args, config } = ctx;

    const rules = this.readRules(config);
    if (rules.length === 0) {
      return;
    }

    for (const raw of this.paths(args)) {
      let canonical: string;
      try {
        canonical = validatePath(raw);
      } catch {
        continue;
      }

      if (decidePathAccess(rules, this.operation, canonical) === "deny") {
        throw new Error(
          `Error: permission denied for ${this.operation} on ${canonical}`,
        );
      }
    }
  }

  async afterInvoke(output: TOut, ctx: ToolPolicyContext<TIn>): Promise<TOut> {
    const { config } = ctx;

    if (this.filter === undefined) {
      return output;
    }

    const rules = this.readRules(config);
    if (rules.length === 0) {
      return output;
    }

    return this.filter(output, (op, path) => decidePathAccess(rules, op, path));
  }

  private readRules(
    config: { configurable?: Record<string, unknown> } | undefined,
  ): FilesystemPermission[] {
    const raw = config?.configurable?.[FS_PERMISSIONS_RUNTIME_KEY];
    if (Array.isArray(raw)) {
      return raw;
    }
    return [];
  }
}
