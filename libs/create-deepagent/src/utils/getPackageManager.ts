export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Detects which package manager invoked the CLI by reading the
 * `npm_config_user_agent` env var, which npm/pnpm/yarn/bun set when
 * running a command. Falls back to "npm".
 */
export function getPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

/** Returns the install command for the detected package manager. */
export function getInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun install";
    default:
      return "npm install";
  }
}
