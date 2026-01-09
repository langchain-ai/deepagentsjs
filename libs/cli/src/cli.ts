#!/usr/bin/env node
/**
 * DeepAgents CLI Entry Point
 *
 * This script locates and invokes the platform-specific DeepAgents binary,
 * forwarding all arguments and environment variables.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  getBinaryPath,
  getUnsupportedPlatformMessage,
  getPlatformKey,
} from "./index.js";

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const binaryPath = getBinaryPath();

  if (!binaryPath) {
    console.error(`Error: Could not find deepagents binary for your platform.`);
    console.error(`Platform: ${getPlatformKey()}`);
    console.error("");
    console.error(getUnsupportedPlatformMessage());
    process.exit(1);
  }

  // Forward all arguments to the binary (skip node and script path)
  const args = process.argv.slice(2);

  // Spawn the binary with inherited stdio for interactive use
  const child: ChildProcess = spawn(binaryPath, args, {
    stdio: "inherit",
    env: process.env,
    // On Windows, use shell to handle .exe properly
    shell: process.platform === "win32",
  });

  // Handle spawn errors
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      console.error(`Error: Binary not found at ${binaryPath}`);
      console.error("The CLI binary may have been removed or corrupted.");
      console.error("Try reinstalling: npm install -g deepagents-cli");
    } else if (error.code === "EACCES") {
      console.error(`Error: Permission denied executing ${binaryPath}`);
      console.error("Try: chmod +x " + binaryPath);
    } else {
      console.error(`Error starting deepagents: ${error.message}`);
    }
    process.exit(1);
  });

  // Forward the exit code from the child process
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal) {
      // Process was killed by a signal
      process.exit(
        128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1),
      );
    }
    process.exit(code ?? 0);
  });

  // Forward signals to the child process for clean shutdown
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  // Handle parent process disconnect (e.g., when run via npx)
  process.on("disconnect", () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
}

// Run main and handle any unexpected errors
main().catch((error: Error) => {
  console.error("Unexpected error:", error.message);
  process.exit(1);
});
