/**
 * Fetch deepagents-cli from PyPI
 *
 * This script downloads the specified version of deepagents-cli
 * and installs it in a virtual environment.
 */

import * as path from "node:path";
import {
  log,
  logStep,
  execWithOutput,
  execCommand,
  ensureDir,
  exists,
  getPipPath,
  formatDuration,
} from "./utils.js";

/** Minimum required Python version */
const MIN_PYTHON_VERSION = { major: 3, minor: 11 };

/**
 * PyPI package info response
 */
interface PyPIPackageInfo {
  info: {
    version: string;
    name: string;
    summary: string;
  };
  releases: Record<string, Array<{ url: string; filename: string }>>;
}

/**
 * Fetch the latest version from PyPI
 */
export async function fetchLatestVersion(): Promise<string> {
  log("info", "Fetching latest version from PyPI...");

  const response = await fetch("https://pypi.org/pypi/deepagents-cli/json");

  if (!response.ok) {
    throw new Error(
      `Failed to fetch from PyPI: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as PyPIPackageInfo;
  const version = data.info.version;

  log("success", `Latest version: ${version}`);
  return version;
}

/**
 * Get all available versions from PyPI
 */
export async function getAvailableVersions(): Promise<string[]> {
  const response = await fetch("https://pypi.org/pypi/deepagents-cli/json");

  if (!response.ok) {
    throw new Error(
      `Failed to fetch from PyPI: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as PyPIPackageInfo;
  return Object.keys(data.releases).sort();
}

/**
 * Find a suitable Python executable (3.11+)
 */
export async function findPythonExecutable(): Promise<string> {
  // List of Python executables to try, in order of preference
  const candidates = [
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
    "python",
  ];

  for (const candidate of candidates) {
    try {
      const result = await execCommand(`${candidate} --version`);
      if (result.exitCode === 0) {
        // Parse version from output like "Python 3.11.5"
        const versionMatch = result.stdout.match(/Python (\d+)\.(\d+)/);
        if (versionMatch) {
          const major = parseInt(versionMatch[1], 10);
          const minor = parseInt(versionMatch[2], 10);

          if (
            major > MIN_PYTHON_VERSION.major ||
            (major === MIN_PYTHON_VERSION.major &&
              minor >= MIN_PYTHON_VERSION.minor)
          ) {
            log("success", `Found Python ${major}.${minor} at: ${candidate}`);
            return candidate;
          }
        }
      }
    } catch {
      // Continue to next candidate
    }
  }

  throw new Error(
    `Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ is required but not found.\n` +
      `Please install Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor} or higher:\n` +
      `  macOS:   brew install python@3.11\n` +
      `  Ubuntu:  sudo apt install python3.11 python3.11-venv\n` +
      `  Windows: Download from https://python.org`,
  );
}

/**
 * Create a Python virtual environment
 */
export async function createVenv(venvDir: string): Promise<string> {
  log("info", `Creating virtual environment at ${venvDir}...`);

  const alreadyExists = await exists(venvDir);
  if (alreadyExists) {
    log("debug", "Virtual environment already exists, skipping creation");
    // Return the Python path from the existing venv
    const isWindows = process.platform === "win32";
    return isWindows
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");
  }

  // Find a suitable Python executable
  const pythonExe = await findPythonExecutable();

  await ensureDir(path.dirname(venvDir));

  const exitCode = await execWithOutput(`"${pythonExe}" -m venv "${venvDir}"`);

  if (exitCode !== 0) {
    throw new Error("Failed to create virtual environment");
  }

  log("success", "Virtual environment created");

  // Return the Python path in the venv
  const isWindows = process.platform === "win32";
  return isWindows
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Upgrade pip in the virtual environment
 */
export async function upgradePip(venvDir: string): Promise<void> {
  log("debug", "Upgrading pip...");

  const pip = getPipPath(venvDir);
  const exitCode = await execWithOutput(`"${pip}" install --upgrade pip`);

  if (exitCode !== 0) {
    log("warn", "Failed to upgrade pip, continuing with existing version");
  }
}

/**
 * Install deepagents-cli in the virtual environment
 */
export async function installCli(
  venvDir: string,
  version: string,
): Promise<void> {
  log("info", `Installing deepagents-cli==${version}...`);

  const pip = getPipPath(venvDir);
  const packageSpec = `deepagents-cli==${version}`;

  const exitCode = await execWithOutput(pip, [
    "install",
    packageSpec,
    "--no-cache-dir",
  ]);

  if (exitCode !== 0) {
    throw new Error(`Failed to install deepagents-cli==${version}`);
  }

  log("success", `Installed deepagents-cli==${version}`);
}

/**
 * Upgrade the deepagents core package to the latest version
 * This is needed because deepagents-cli may pin an older version
 */
export async function upgradeDeepagentsCore(venvDir: string): Promise<void> {
  log("info", "Upgrading deepagents core to latest version...");

  const pip = getPipPath(venvDir);

  const exitCode = await execWithOutput(pip, [
    "install",
    "--upgrade",
    "deepagents",
    "--no-cache-dir",
  ]);

  if (exitCode !== 0) {
    log(
      "warn",
      "Failed to upgrade deepagents core, continuing with installed version",
    );
    return;
  }

  // Show the installed version
  await execWithOutput(pip, ["show", "deepagents"]);
  log("success", "Upgraded deepagents core to latest version");
}

/**
 * Verify the installation
 */
export async function verifyInstallation(venvDir: string): Promise<boolean> {
  log("debug", "Verifying installation...");

  const pip = getPipPath(venvDir);
  const exitCode = await execWithOutput(pip, ["show", "deepagents-cli"]);

  return exitCode === 0;
}

/**
 * Download and install deepagents-cli
 */
export async function downloadCli(
  version: string,
  targetDir: string,
): Promise<string> {
  const startTime = Date.now();
  const venvDir = path.join(targetDir, ".venv");

  logStep(1, 5, "Creating virtual environment");
  await createVenv(venvDir);

  logStep(2, 5, "Upgrading pip");
  await upgradePip(venvDir);

  logStep(3, 5, "Installing deepagents-cli");
  await installCli(venvDir, version);

  logStep(4, 5, "Upgrading deepagents core");
  await upgradeDeepagentsCore(venvDir);

  logStep(5, 5, "Verifying installation");
  const verified = await verifyInstallation(venvDir);

  if (!verified) {
    throw new Error("Installation verification failed");
  }

  const duration = Date.now() - startTime;
  log("success", `Download complete in ${formatDuration(duration)}`);

  return venvDir;
}

/**
 * Main entry point for CLI usage
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let version: string | undefined;
  let outputDir = process.cwd();

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[i + 1];
      i++;
    } else if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    }
  }

  try {
    // Determine version
    if (!version) {
      version = await fetchLatestVersion();
    }

    console.log(`\n📦 Downloading deepagents-cli@${version}\n`);

    // Download and install
    const venvDir = await downloadCli(version, outputDir);

    console.log(`\n✅ Ready! Virtual environment: ${venvDir}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", `Failed: ${message}`);
    process.exit(1);
  }
}

// Run if executed directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
