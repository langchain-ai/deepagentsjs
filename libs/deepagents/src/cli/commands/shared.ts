import * as path from "node:path";

/**
 * Resolves the path to the bundled `src/skills/` directory.
 *
 * The CLI binary lives at `dist/cli/index.js`, so we resolve two levels
 * up to reach the package root, then into `src/skills/`.
 */
export function resolveSkillsRoot(): string {
  const cliDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(cliDir, "..", "..", "src", "skills");
}
