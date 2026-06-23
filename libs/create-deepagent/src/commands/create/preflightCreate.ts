import path from "node:path";
import * as clack from "@clack/prompts";
import { logger } from "../../utils/logger.js";
import {
  isFolderEmpty,
  isWriteable,
  validatePkgName,
} from "../../utils/validate.js";

export interface PreflightOptions {
  projectName: string;
  force?: boolean;
}

/**
 * Post-TUI checks before scaffolding. Fails fast on:
 * - Invalid package name
 * - Target directory not empty (unless --force or user confirms)
 * - Target directory not writable
 */
export async function preflightCreate(
  options: PreflightOptions,
): Promise<string> {
  const { projectName, force } = options;

  // 1. Validate package name
  const nameErr = validatePkgName(projectName);
  if (nameErr) {
    logger.error(nameErr);
    process.exit(1);
  }

  // 2. Resolve project path
  const projectPath = path.resolve(projectName);

  // 3. Check if dir exists and is not empty
  const empty = await isFolderEmpty(projectPath);
  if (!empty && !force) {
    const proceed = await clack.confirm({
      message: `Directory "${projectName}" is not empty. Continue anyway?`,
      initialValue: false,
    });

    if (clack.isCancel(proceed) || proceed === false) {
      clack.cancel("Cancelled, exiting...");
      process.exit(0);
    }
  }

  // 4. Check if parent dir is writable
  const writeable = await isWriteable(path.dirname(projectPath));
  if (!writeable) {
    logger.error(`Cannot write to ${path.dirname(projectPath)}`);
    process.exit(1);
  }

  return projectPath;
}
