/**
 * Integration test for the Harbor runner.
 *
 * Spawns runner.ts as a child process and plays the Python side of the
 * JSON-RPC protocol: sends init, handles exec_request/exec_response,
 * and verifies the done message + clean exit.
 *
 * Requires ANTHROPIC_API_KEY (or the key for whichever model is used).
 * Run with:  vitest run --mode int
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { describe, it, expect, afterEach } from "vitest";

/** Path to the runner source (executed via tsx) */
const RUNNER_PATH = path.resolve(__dirname, "runner.ts");

/** Find the tsx binary – prefer local node_modules/.bin, fall back to npx */
function getTsxCommand(): { cmd: string; args: string[] } {
  // Use npx tsx so we don't need to resolve the binary path ourselves
  return { cmd: "npx", args: ["tsx", RUNNER_PATH] };
}

/** Send an NDJSON message to the child's stdin */
function send(child: ChildProcess, msg: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

/**
 * Collect lines from a readable stream via readline.
 * Each line is parsed as JSON and pushed to the provided array.
 * Returns the readline interface so it can be closed in cleanup.
 */
function collectJsonLines(
  child: ChildProcess,
): { messages: Record<string, unknown>[]; rl: ReadlineInterface } {
  const messages: Record<string, unknown>[] = [];
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines (shouldn't happen, but be safe)
    }
  });
  return { messages, rl };
}

describe("Harbor runner (end-to-end)", () => {
  let child: ChildProcess | undefined;
  let rl: ReadlineInterface | undefined;

  afterEach(() => {
    rl?.close();
    if (child && child.exitCode === null) {
      child.kill();
    }
  });

  it("should complete a simple agent run via the JSON-RPC bridge", async () => {
    const { cmd, args } = getTsxCommand();

    child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure Node doesn't buffer stdout (not strictly needed for pipes
        // but good practice)
        NODE_NO_WARNINGS: "1",
      },
    });

    const { messages, rl: stdoutRl } = collectJsonLines(child);
    rl = stdoutRl;

    // Collect stderr for debugging
    const stderrChunks: string[] = [];
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // Step 1: Send init message
    send(child, {
      type: "init",
      instruction:
        "Write the text 'hello harbor' to a file called /app/test.txt using a single echo command.",
      sessionId: "int-test-session",
      model: "anthropic:claude-sonnet-4-5-20250929",
      systemPrompt:
        "You are an autonomous agent. Execute commands in the sandbox. Your working directory is /app.",
    });

    // Step 2: Run the bridge loop – handle exec_requests, wait for done/error
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Runner timed out after 90s.\nstderr:\n${stderrChunks.join("")}`,
            ),
          );
        }, 90_000);

        // Poll for messages from the runner
        const interval = setInterval(() => {
          while (messages.length > 0) {
            const msg = messages.shift()!;
            const msgType = msg.type as string;

            if (msgType === "exec_request") {
              // Simulate executing the command – we just return a mock success
              const command = msg.command as string;
              let output = "";
              let exitCode = 0;

              // Provide realistic responses for common commands
              if (command.includes("echo") && command.includes(">")) {
                // File write via echo redirect
                output = "";
                exitCode = 0;
              } else if (command.includes("cat ")) {
                output = "hello harbor";
                exitCode = 0;
              } else if (command.includes("pwd")) {
                output = "/app";
                exitCode = 0;
              } else if (command.includes("ls")) {
                output = "test.txt";
                exitCode = 0;
              } else if (command.includes("base64")) {
                // File upload/download via base64 – just succeed
                output = "";
                exitCode = 0;
              } else {
                // Default: succeed with empty output
                output = "";
                exitCode = 0;
              }

              send(child!, {
                type: "exec_response",
                id: msg.id,
                output,
                exitCode,
              });
            } else if (msgType === "done" || msgType === "error") {
              clearTimeout(timeout);
              clearInterval(interval);
              resolve(msg);
              return;
            }
          }
        }, 50);
      },
    );

    // Step 3: Verify the result
    expect(result.type).toBe("done");

    const resultMessages = result.messages as Array<Record<string, unknown>>;
    expect(resultMessages).toBeDefined();
    expect(resultMessages.length).toBeGreaterThan(0);

    // Should contain at least a human message and an AI message
    const roles = resultMessages.map((m) => m.role);
    expect(roles).toContain("human");
    expect(roles).toContain("ai");

    // Step 4: Wait for clean exit
    const exitCode = await new Promise<number | null>((resolve) => {
      if (child!.exitCode !== null) {
        resolve(child!.exitCode);
        return;
      }
      child!.on("exit", (code) => resolve(code));
      // Give it a few seconds to exit cleanly
      setTimeout(() => resolve(child!.exitCode), 5_000);
    });

    expect(exitCode).toBe(0);
  }, 100_000); // 100s timeout for the full test
});
