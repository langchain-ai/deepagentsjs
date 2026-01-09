/**
 * Create platform-specific npm packages
 *
 * Each platform package contains the binary for a specific OS/arch combination.
 */

import * as path from "node:path";
import {
  log,
  logStep,
  ensureDir,
  exists,
  copy,
  chmod,
  writeJson,
  writeFile,
  PLATFORMS,
  type PlatformConfig,
} from "./utils.js";

/**
 * Package.json template for platform packages
 */
interface PlatformPackageJson {
  name: string;
  version: string;
  description: string;
  license: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  os: string[];
  cpu: string[];
  main: string;
  files: string[];
  engines: {
    node: string;
  };
  publishConfig?: {
    access: string;
  };
}

/**
 * Generate package.json for a platform package
 */
function generatePackageJson(
  platform: PlatformConfig,
  version: string
): PlatformPackageJson {
  return {
    name: `@deepagents-cli/${platform.name}`,
    version,
    description: `DeepAgents CLI binary for ${platform.name}`,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/langchain-ai/deepagentsjs.git",
      directory: `libs/cli/platforms/${platform.name}`,
    },
    os: [platform.os],
    cpu: [platform.cpu],
    main: `bin/${platform.binaryName}`,
    files: ["bin/"],
    engines: {
      node: ">=18",
    },
    publishConfig: {
      access: "public",
    },
  };
}

/**
 * Generate README for a platform package
 */
function generateReadme(platform: PlatformConfig): string {
  return `# @deepagents-cli/${platform.name}

This package contains the DeepAgents CLI binary for ${platform.name}.

## Important

**This package is not meant to be installed directly.**

Install \`deepagents-cli\` instead:

\`\`\`bash
npm install -g deepagents-cli
\`\`\`

The main package will automatically install the correct platform-specific binary.

## Platform

| Property | Value |
|----------|-------|
| OS | ${platform.os} |
| CPU | ${platform.cpu} |
| Binary | \`bin/${platform.binaryName}\` |
| Runner | ${platform.runner} |

## Binary Location

After installation, the binary is located at:

\`\`\`
node_modules/@deepagents-cli/${platform.name}/bin/${platform.binaryName}
\`\`\`

## License

MIT - see [LICENSE](https://github.com/langchain-ai/deepagentsjs/blob/main/LICENSE)
`;
}

/**
 * Create a single platform package
 */
export async function createPlatformPackage(
  platform: PlatformConfig,
  version: string,
  binaryPath: string,
  outputDir: string
): Promise<string> {
  const packageDir = path.join(outputDir, platform.name);
  const binDir = path.join(packageDir, "bin");

  log("info", `Creating package for ${platform.name}...`);

  // Verify binary exists
  const binaryExists = await exists(binaryPath);
  if (!binaryExists) {
    throw new Error(`Binary not found: ${binaryPath}`);
  }

  // Create directory structure
  await ensureDir(binDir);

  // Copy binary
  const destBinaryPath = path.join(binDir, platform.binaryName);
  await copy(binaryPath, destBinaryPath);
  log("debug", `Copied binary to ${destBinaryPath}`);

  // Set executable permissions on Unix
  if (platform.os !== "win32") {
    await chmod(destBinaryPath, 0o755);
    log("debug", "Set executable permissions");
  }

  // Generate package.json
  const packageJson = generatePackageJson(platform, version);
  await writeJson(path.join(packageDir, "package.json"), packageJson);

  // Generate README
  const readme = generateReadme(platform);
  await writeFile(path.join(packageDir, "README.md"), readme);

  log("success", `Created @deepagents-cli/${platform.name}`);

  return packageDir;
}

/**
 * Create all platform packages from built binaries
 */
export async function createAllPlatformPackages(
  version: string,
  binariesDir: string,
  outputDir: string
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const total = PLATFORMS.length;
  let current = 0;

  console.log(`\n📦 Creating ${total} platform packages\n`);

  for (const platform of PLATFORMS) {
    current++;
    logStep(current, total, `Creating @deepagents-cli/${platform.name}`);

    const binaryPath = path.join(
      binariesDir,
      platform.name,
      "dist",
      platform.binaryName
    );

    // Check if binary exists for this platform
    const binaryExists = await exists(binaryPath);
    if (!binaryExists) {
      log("warn", `Binary not found for ${platform.name}, skipping`);
      continue;
    }

    try {
      const packageDir = await createPlatformPackage(
        platform,
        version,
        binaryPath,
        outputDir
      );
      results.set(platform.name, packageDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", `Failed to create package for ${platform.name}: ${message}`);
    }
  }

  console.log(`\n✅ Created ${results.size}/${total} platform packages\n`);

  return results;
}

/**
 * Validate a platform package
 */
export async function validatePlatformPackage(
  packageDir: string
): Promise<boolean> {
  const checks = [
    { path: "package.json", type: "file" },
    { path: "README.md", type: "file" },
    { path: "bin", type: "dir" },
  ];

  for (const check of checks) {
    const fullPath = path.join(packageDir, check.path);
    const pathExists = await exists(fullPath);
    if (!pathExists) {
      log("error", `Missing ${check.type}: ${check.path}`);
      return false;
    }
  }

  return true;
}
