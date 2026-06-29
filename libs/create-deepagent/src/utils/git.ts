import { execSync } from "node:child_process";

/** Initialize a git repo and make an initial commit. Silently ignores failures. */
export function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: "ignore" as const };
  try {
    execSync("git init", opts);
    execSync("git add -A", opts);
    execSync('git commit -m "Initial commit"', opts);
  } catch {
    /* This is fine */
  }
}
