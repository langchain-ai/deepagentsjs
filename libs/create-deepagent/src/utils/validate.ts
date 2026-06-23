import fs from "node:fs";

/** Check if a path exists and is a directory. */
export async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dir);
    return stat.isDirectory();
  } catch (e) {
    return false;
  }
}

/** Check if an existing directory is empty. Throws if the dir cannot be read. */
export async function isDirEmpty(dir: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dir);
  return entries.length === 0;
}

/** Check if a directory is writable. */
export async function isWriteable(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ensure a directory exists, creating it if necessary. */
export async function makeDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Validate a npm package name. Returns an error message or null if valid. */
export function validatePkgName(name: string): string | null {
  if (!name) return "Project name is required";
  if (name.length > 214) return "Project name must be 214 characters or less";
  if (name.startsWith(".") || name.startsWith("_"))
    return "Project name must not start with . or _";
  if (name.toLowerCase() !== name) return "Project name must be lowercase";
  if (/\s/.test(name)) return "Project name must not contain spaces";
  // Per npm naming rules
  if (!/^[a-z0-9._-]+$/.test(name))
    return "Project name may only contain lowercase letters, numbers, ., _, and -";
  return null;
}
