#!/usr/bin/env tsx
/**
 * Main build orchestrator for deepagents-cli npm package
 *
 * This script coordinates the entire build pipeline:
 * 1. Fetch latest version from PyPI (or use override)
 * 2. Download and install deepagents-cli in a venv
 * 3. Bundle into standalone binary with PyInstaller
 * 4. Create platform-specific npm packages
 * 5. Update main package.json version
 *
 * Usage:
 *   pnpm run build:cli                          # Build for current platform
 *   pnpm run build:cli --platform darwin-arm64  # Build for specific platform
 *   pnpm run build:cli --version 0.0.12         # Build specific version
 *   pnpm run build:cli --skip-download          # Use existing venv
 */

import * as path from "node:path";
import {
  log,
  logStep,
  parseArgs,
  ensureDir,
  removeDir,
  exists,
  readJson,
  writeJson,
  formatDuration,
  PLATFORMS,
  getCurrentPlatformConfig,
  getPlatformConfig,
} from "./utils.js";
import { fetchLatestVersion, downloadCli } from "./fetch-cli.js";
import { bundleBinary } from "./bundle-binary.js";
import { createPlatformPackage } from "./create-platform-packages.js";

/**
 * Build options
 */
interface BuildOptions {
  /** Override version (defaults to latest from PyPI) */
  version?: string;
  /** Specific platform to build (defaults to current) */
  platform?: string;
  /** Output directory */
  outputDir?: string;
  /** Skip downloading (use existing venv) */
  skipDownload?: boolean;
  /** Clean build directory first */
  clean?: boolean;
}

/**
 * Parse command line arguments into build options
 */
function parseBuildOptions(): BuildOptions {
  const args = parseArgs(process.argv.slice(2));

  return {
    version: typeof args.version === "string" ? args.version : undefined,
    platform: typeof args.platform === "string" ? args.platform : undefined,
    outputDir: typeof args["output-dir"] === "string" ? args["output-dir"] : undefined,
    skipDownload: args["skip-download"] === true,
    clean: args.clean === true,
  };
}

/**
 * Update the main package.json with the new version
 */
async function updateMainPackageVersion(
  packageJsonPath: string,
  version: string
): Promise<void> {
  const packageJson = await readJson<Record<string, unknown>>(packageJsonPath);
  packageJson.version = version;

  // Update optional dependencies to match version
  const optionalDeps: Record<string, string> = {};
  for (const platform of PLATFORMS) {
    optionalDeps[`@deepagents-cli/${platform.name}`] = version;
  }
  packageJson.optionalDependencies = optionalDeps;

  await writeJson(packageJsonPath, packageJson);
  log("success", `Updated package.json to version ${version}`);
}

/**
 * Main build function
 */
async function build(options: BuildOptions = {}): Promise<void> {
  const startTime = Date.now();
  const cliDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const outputDir = options.outputDir ?? path.join(cliDir, "dist");
  const buildDir = path.join(outputDir, ".build");
  const platformsDir = path.join(outputDir, "platforms");

  console.log("\n🚀 DeepAgents CLI Build Pipeline\n");
  console.log("━".repeat(50));

  // Determine target platform
  const targetPlatformName = options.platform ?? `${process.platform}-${process.arch}`;
  const targetPlatform = getPlatformConfig(targetPlatformName);

  if (!targetPlatform) {
    const currentConfig = getCurrentPlatformConfig();
    if (options.platform) {
      log("error", `Unknown platform: ${targetPlatformName}`);
      log("info", "Available platforms:");
      for (const p of PLATFORMS) {
        log("info", `  - ${p.name}`);
      }
      process.exit(1);
    } else if (!currentConfig) {
      log("error", `Current platform ${targetPlatformName} is not supported`);
      process.exit(1);
    }
  }

  const platform = targetPlatform ?? getCurrentPlatformConfig()!;
  log("info", `Target platform: ${platform.name}`);

  // Clean if requested
  if (options.clean) {
    logStep(1, 6, "Cleaning build directory");
    await removeDir(buildDir);
    log("success", "Build directory cleaned");
  }

  // Create directories
  await ensureDir(buildDir);
  await ensureDir(platformsDir);

  // Step 1: Determine version
  logStep(1, 6, "Determining version");
  let version: string;
  if (options.version) {
    version = options.version;
    log("info", `Using specified version: ${version}`);
  } else {
    version = await fetchLatestVersion();
  }
  console.log(`\n📌 Version: ${version}\n`);

  // Step 2: Download CLI (unless skipped)
  const venvDir = path.join(buildDir, ".venv");
  if (!options.skipDownload) {
    logStep(2, 6, "Downloading deepagents-cli");
    await downloadCli(version, buildDir);
  } else {
    logStep(2, 6, "Skipping download (using existing venv)");
    const venvExists = await exists(venvDir);
    if (!venvExists) {
      log("error", "Venv not found. Remove --skip-download flag.");
      process.exit(1);
    }
    log("info", `Using existing venv at ${venvDir}`);
  }

  // Step 3: Bundle binary
  logStep(3, 6, `Building binary for ${platform.name}`);
  const platformBuildDir = path.join(buildDir, platform.name);
  await ensureDir(platformBuildDir);

  const binaryPath = await bundleBinary({
    venvDir,
    outputDir: platformBuildDir,
    platform,
    useUpx: true,
    oneFile: true,
  });

  // Step 4: Create platform package
  logStep(4, 6, "Creating platform package");
  await createPlatformPackage(platform, version, binaryPath, platformsDir);

  // Step 5: Update main package.json
  logStep(5, 6, "Updating main package.json");
  const mainPackageJsonPath = path.join(cliDir, "package.json");
  await updateMainPackageVersion(mainPackageJsonPath, version);

  // Step 6: Summary
  logStep(6, 6, "Build complete");
  const duration = Date.now() - startTime;

  console.log("\n" + "━".repeat(50));
  console.log("\n✅ Build Summary\n");
  console.log(`   Version:   ${version}`);
  console.log(`   Platform:  ${platform.name}`);
  console.log(`   Binary:    ${binaryPath}`);
  console.log(`   Package:   ${path.join(platformsDir, platform.name)}`);
  console.log(`   Duration:  ${formatDuration(duration)}`);
  console.log("\n" + "━".repeat(50) + "\n");
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
DeepAgents CLI Build Script

Usage:
  pnpm run build:cli [options]

Options:
  --version <version>     Specify version to build (default: latest from PyPI)
  --platform <platform>   Target platform (default: current platform)
  --output-dir <dir>      Output directory (default: dist/)
  --skip-download         Skip downloading, use existing venv
  --clean                 Clean build directory before building
  --help                  Show this help message

Platforms:
  linux-x64               Linux x64 (Ubuntu, Debian, etc.)
  linux-arm64             Linux ARM64 (Raspberry Pi, AWS Graviton)
  darwin-x64              macOS Intel
  darwin-arm64            macOS Apple Silicon
  win32-x64               Windows x64

Examples:
  # Build for current platform with latest version
  pnpm run build:cli

  # Build specific version for macOS ARM64
  pnpm run build:cli --version 0.0.12 --platform darwin-arm64

  # Rebuild without re-downloading
  pnpm run build:cli --skip-download

  # Clean build
  pnpm run build:cli --clean
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  try {
    const options = parseBuildOptions();
    await build(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Build failed: ${message}\n`);

    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }

    process.exit(1);
  }
}

// Run if executed directly
main();
