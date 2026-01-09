/**
 * Shared utilities for build scripts
 */

import { exec, ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as nodeFs from "node:fs/promises";
import fsExtra from "fs-extra";

const execAsync = promisify(exec);

/**
 * Platform configuration for build targets
 */
export interface PlatformConfig {
  /** Platform identifier (e.g., "linux-x64") */
  name: string;
  /** Operating system */
  os: "linux" | "darwin" | "win32";
  /** CPU architecture */
  cpu: "x64" | "arm64";
  /** Binary filename */
  binaryName: string;
  /** GitHub Actions runner for this platform */
  runner: string;
  /** Python version to use */
  pythonVersion: string;
}

/**
 * All supported platforms
 */
export const PLATFORMS: PlatformConfig[] = [
  {
    name: "linux-x64",
    os: "linux",
    cpu: "x64",
    binaryName: "deepagents",
    runner: "ubuntu-latest",
    pythonVersion: "3.11",
  },
  {
    name: "linux-arm64",
    os: "linux",
    cpu: "arm64",
    binaryName: "deepagents",
    runner: "ubuntu-24.04-arm",
    pythonVersion: "3.11",
  },
  {
    name: "darwin-x64",
    os: "darwin",
    cpu: "x64",
    binaryName: "deepagents",
    runner: "macos-13",
    pythonVersion: "3.11",
  },
  {
    name: "darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binaryName: "deepagents",
    runner: "macos-14",
    pythonVersion: "3.11",
  },
  {
    name: "win32-x64",
    os: "win32",
    cpu: "x64",
    binaryName: "deepagents.exe",
    runner: "windows-latest",
    pythonVersion: "3.11",
  },
];

/**
 * Get platform config by name
 */
export function getPlatformConfig(name: string): PlatformConfig | undefined {
  return PLATFORMS.find((p) => p.name === name);
}

/**
 * Get current platform config
 */
export function getCurrentPlatformConfig(): PlatformConfig | undefined {
  const key = `${process.platform}-${process.arch}`;
  return getPlatformConfig(key);
}

/**
 * Color codes for terminal output
 */
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

/**
 * Log levels
 */
export type LogLevel = "info" | "success" | "warn" | "error" | "debug";

/**
 * Colored log output
 */
export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const prefix = {
    info: `${COLORS.blue}ℹ${COLORS.reset}`,
    success: `${COLORS.green}✓${COLORS.reset}`,
    warn: `${COLORS.yellow}⚠${COLORS.reset}`,
    error: `${COLORS.red}✗${COLORS.reset}`,
    debug: `${COLORS.dim}…${COLORS.reset}`,
  }[level];

  const coloredMessage = {
    info: message,
    success: `${COLORS.green}${message}${COLORS.reset}`,
    warn: `${COLORS.yellow}${message}${COLORS.reset}`,
    error: `${COLORS.red}${message}${COLORS.reset}`,
    debug: `${COLORS.dim}${message}${COLORS.reset}`,
  }[level];

  console.log(`${prefix} ${coloredMessage}`, ...args);
}

/**
 * Log a step in the build process
 */
export function logStep(step: number, total: number, message: string): void {
  console.log(
    `\n${COLORS.cyan}[${step}/${total}]${COLORS.reset} ${COLORS.bold}${message}${COLORS.reset}`
  );
}

/**
 * Execute a command and return the result
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execCommand(
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
      ...options,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout?.trim() ?? "",
      stderr: execError.stderr?.trim() ?? "",
      exitCode: execError.code ?? 1,
    };
  }
}

/**
 * Execute a command with streaming output
 */
export async function execWithOutput(
  command: string,
  cwd?: string
): Promise<number> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellFlag = isWindows ? "/c" : "-c";

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.on("close", (code) => {
      resolve(code ?? 0);
    });

    child.on("error", () => {
      resolve(1);
    });
  });
}

/**
 * Get Python executable path (handles venv)
 */
export function getPythonPath(venvDir: string): string {
  const isWindows = process.platform === "win32";
  return isWindows
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Get pip executable path (handles venv)
 */
export function getPipPath(venvDir: string): string {
  const isWindows = process.platform === "win32";
  return isWindows
    ? path.join(venvDir, "Scripts", "pip.exe")
    : path.join(venvDir, "bin", "pip");
}

/**
 * Get PyInstaller executable path (handles venv)
 */
export function getPyInstallerPath(venvDir: string): string {
  const isWindows = process.platform === "win32";
  return isWindows
    ? path.join(venvDir, "Scripts", "pyinstaller.exe")
    : path.join(venvDir, "bin", "pyinstaller");
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dir: string): Promise<void> {
  await fsExtra.ensureDir(dir);
}

/**
 * Remove a directory recursively
 */
export async function removeDir(dir: string): Promise<void> {
  await fsExtra.remove(dir);
}

/**
 * Copy a file or directory
 */
export async function copy(src: string, dest: string): Promise<void> {
  await fsExtra.copy(src, dest);
}

/**
 * Write JSON to a file
 */
export async function writeJson(
  filePath: string,
  data: unknown,
  spaces = 2
): Promise<void> {
  await fsExtra.writeJson(filePath, data, { spaces });
}

/**
 * Read JSON from a file
 */
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return fsExtra.readJson(filePath) as Promise<T>;
}

/**
 * Write text to a file
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  await nodeFs.writeFile(filePath, content, "utf-8");
}

/**
 * Read text from a file
 */
export async function readFile(filePath: string): Promise<string> {
  return nodeFs.readFile(filePath, "utf-8");
}

/**
 * Check if a file or directory exists
 */
export async function exists(path: string): Promise<boolean> {
  return fsExtra.pathExists(path);
}

/**
 * Set file permissions (Unix only)
 */
export async function chmod(filePath: string, mode: number): Promise<void> {
  await nodeFs.chmod(filePath, mode);
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith("--")) {
        result[key] = nextArg;
        i++;
      } else {
        result[key] = true;
      }
    }
  }

  return result;
}
