/**
 * DeepAgents CLI - Programmatic API
 *
 * This module provides utilities for locating and invoking the DeepAgents CLI binary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Platform-specific package information
 */
export interface PlatformInfo {
  /** NPM package name for this platform */
  packageName: string;
  /** Binary filename (deepagents or deepagents.exe) */
  binaryName: string;
  /** Operating system */
  os: "linux" | "darwin" | "win32";
  /** CPU architecture */
  cpu: "x64" | "arm64";
}

/**
 * Map of supported platforms to their configuration
 */
const PLATFORM_MAP: Record<string, PlatformInfo> = {
  "linux-x64": {
    packageName: "@deepagents-cli/linux-x64",
    binaryName: "deepagents",
    os: "linux",
    cpu: "x64",
  },
  "linux-arm64": {
    packageName: "@deepagents-cli/linux-arm64",
    binaryName: "deepagents",
    os: "linux",
    cpu: "arm64",
  },
  "darwin-x64": {
    packageName: "@deepagents-cli/darwin-x64",
    binaryName: "deepagents",
    os: "darwin",
    cpu: "x64",
  },
  "darwin-arm64": {
    packageName: "@deepagents-cli/darwin-arm64",
    binaryName: "deepagents",
    os: "darwin",
    cpu: "arm64",
  },
  "win32-x64": {
    packageName: "@deepagents-cli/win32-x64",
    binaryName: "deepagents.exe",
    os: "win32",
    cpu: "x64",
  },
};

/**
 * Get the current platform key (e.g., "darwin-arm64")
 */
export function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Get the platform-specific package info for the current system
 * @returns Platform info or null if the platform is not supported
 */
export function getPlatformInfo(): PlatformInfo | null {
  const key = getPlatformKey();
  return PLATFORM_MAP[key] ?? null;
}

/**
 * Get all supported platforms
 */
export function getSupportedPlatforms(): string[] {
  return Object.keys(PLATFORM_MAP);
}

/**
 * Try to resolve the binary path using various strategies
 */
function tryResolveBinaryPath(platformInfo: PlatformInfo): string | null {
  const { packageName, binaryName } = platformInfo;

  // Strategy 1: Look in node_modules relative to this package
  const searchPaths = [
    // When installed as dependency - node_modules is sibling to dist
    path.join(__dirname, "..", "node_modules", packageName, "bin", binaryName),
    // When installed globally with npm
    path.join(__dirname, "..", "..", "..", packageName, "bin", binaryName),
    // pnpm workspace layout
    path.join(__dirname, "..", "..", packageName, "bin", binaryName),
    // Local development - platforms folder
    path.join(
      __dirname,
      "..",
      "platforms",
      getPlatformKey(),
      "bin",
      binaryName,
    ),
  ];

  for (const searchPath of searchPaths) {
    try {
      const resolvedPath = path.resolve(searchPath);
      if (fs.existsSync(resolvedPath)) {
        return resolvedPath;
      }
    } catch {
      // Continue to next path
    }
  }

  // Strategy 2: Try using require.resolve (CommonJS compatibility)
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve(`${packageName}/package.json`);
    const binPath = path.join(path.dirname(packagePath), "bin", binaryName);
    if (fs.existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // Package not found via require.resolve
  }

  return null;
}

/**
 * Get the path to the deepagents binary for the current platform
 * @returns Absolute path to the binary, or null if not found/unsupported
 */
export function getBinaryPath(): string | null {
  const platformInfo = getPlatformInfo();

  if (!platformInfo) {
    return null;
  }

  return tryResolveBinaryPath(platformInfo);
}

/**
 * Check if the CLI is available for the current platform
 * @returns true if the binary exists and is accessible
 */
export function isAvailable(): boolean {
  return getBinaryPath() !== null;
}

/**
 * Get the version of the installed CLI package
 * @returns Version string or null if unable to determine
 */
export function getVersion(): string | null {
  try {
    const packageJsonPath = path.join(__dirname, "..", "package.json");
    const packageJsonContent = fs.readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };
    return packageJson.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Get detailed error message for unsupported/missing platforms
 */
export function getUnsupportedPlatformMessage(): string {
  const platformKey = getPlatformKey();
  const platformInfo = getPlatformInfo();
  const supported = getSupportedPlatforms();

  if (!platformInfo) {
    return `Platform "${platformKey}" is not supported.

Supported platforms:
${supported.map((p) => `  - ${p}`).join("\n")}

Please report this issue at:
  https://github.com/langchain-ai/deepagentsjs/issues`;
  }

  return `DeepAgents CLI binary not found for ${platformKey}.

This usually means the platform-specific package failed to install.
Try reinstalling:

  npm uninstall -g deepagents-cli
  npm install -g deepagents-cli

If the problem persists, please report at:
  https://github.com/langchain-ai/deepagentsjs/issues`;
}
